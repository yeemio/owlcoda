/**
 * 0.13.98 Batch B — bounded LLM-based conversation compaction.
 *
 * Replaces auto-compact's truncation-only strategy with a bounded
 * LLM-summary-first / truncation-fallback-always pipeline.
 *
 * Design contract (locked after user review of /tmp/owl-bounded-compact-design.md):
 *
 *   1. Bounded input — compactor never sees raw oversized conversation.
 *      buildCompactionRequest() composes a 7-segment prompt capped at
 *      `compactionInputMaxTokens` (default 8000). Sections are dropped
 *      in priority order when over cap; system + latest_user_goal are
 *      load-bearing and never dropped.
 *
 *   2. ONE attempt per trigger — tryCompact() does NOT retry. Failure
 *      → fallback to truncation. Callers (threshold / hard_limit /
 *      context_exceeded) call tryCompact ONCE, never twice.
 *
 *   3. Heap-pressure path NEVER calls LLM — V8 heap at 75% means we're
 *      already memory-constrained; allocating buffers / Promises for an
 *      LLM round-trip risks OOM. heap-pressure stays sync truncation.
 *
 *   4. 3-strike session disable — tracked on
 *      `conversation.options.llmCompactFailureCount`. After 3
 *      consecutive failures, this session goes straight to truncation.
 *      A successful compact resets the counter to 0 (not a permanent
 *      penalty — just protection against persistent provider trouble).
 *
 *   5. Output validation — LLM output MUST contain all 4 structured
 *      headers (Current goal / Preserved evidence / Recent actions /
 *      Open risks), be 50-8000 chars, and contain no tool_use markers.
 *      Any validation failure → treated as compact failure → fallback.
 *
 *   6. No transcript pollution — failure surfaces only via onAutoCompact
 *      callback (footer notice path) and `conversation.options.compactionLog`
 *      telemetry ring buffer. Never appendTranscript, never retry, never
 *      block the main turn.
 *
 *   7. Compactor model call has hard limits:
 *      max_tokens=1500, temperature=0, tools=undefined, stream=false,
 *      AbortSignal.timeout=15s. Prevents the compactor itself from
 *      becoming a long task.
 *
 * Slice scope (B1 only). Slice B2 (evidence ledger) and B3 (batch
 * synthesis) are explicitly out — see /tmp/owl-preflight-research.md §5.
 */

import { createHash } from 'node:crypto'
import type {
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from '../types.js'
import { recordGateEvent, type GateEvent } from './gate-telemetry.js'
import type { CompactionLogEntry, Conversation, ConversationTurn } from './protocol/types.js'
import { estimateTokens } from './usage.js'

// ─── 7-section bounded input shape ─────────────────────────────────────

/** Default token budget for the compactor's INPUT. The compactor itself
 *  emits ≤ 1500 max_tokens. Total compactor round-trip token cost is
 *  bounded at ~9.5K — well under any model's context window. */
export const DEFAULT_COMPACTION_INPUT_MAX_TOKENS = 8000

/** Number of most-recent turns kept verbatim in BOTH the compactor input
 *  AND the post-compact conversation. Deliberate redundancy: the LLM
 *  summary references these turns; they survive in keptTurns so the
 *  reference is stable. */
const RECENT_TURNS_VERBATIM_COUNT = 4

/** Per-section token caps. Sum to 7800; leave 200 for prompt scaffold. */
const SECTION_CAPS = {
  system: 2000,
  latestUserGoal: 1500,
  recentTurnsVerbatim: 2500,
  toolCallSummary: 1000,
  errorEvidence: 500,
  filePathsTouched: 300,
} as const

/** Cap on per-section item counts to prevent pathological inputs. */
const TOOL_CALL_SUMMARY_MAX_LINES = 50
const FILE_PATHS_MAX = 80
const ERROR_EVIDENCE_MAX_LINES = 30

// ─── extractors ────────────────────────────────────────────────────────

/** Find the most recent NON-meta user text turn. Skips:
 *   - "继续" / "continue" / pure punctuation (recovery-shape inputs)
 *   - `[Runtime ...]` framed system-injected user turns
 *   - tool_result-only user turns (no plain text content)
 *  Returns null when no eligible turn found. */
export function findLatestNonMetaUserText(turns: readonly ConversationTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!turn || turn.role !== 'user') continue
    const text = turn.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map(b => b.text.trim())
      .filter(Boolean)
      .join('\n')
    if (text === '') continue
    if (/^[\s?？!！。…]+$/.test(text)) continue
    if (/^\[Runtime [^\]]+\]/i.test(text)) continue
    if (/^(?:继续|续跑|接着|continue|resume)$/i.test(text.trim())) continue
    return text
  }
  return null
}

/** Serialize a list of turns for verbatim inclusion. Format:
 *    [user] text...
 *    [assistant] text... (tool_use: name) (tool_use: name)
 *    [tool_result] (id=abc) ok: first 200 chars
 *  Caps total at maxTokens. When over, drops oldest turns first. */
export function serializeTurnsForCompactor(
  turns: readonly ConversationTurn[],
  maxTokens: number,
): string {
  const parts: string[] = []
  for (const turn of turns) {
    parts.push(formatTurnLine(turn))
  }
  let serialized = parts.join('\n')
  while (estimateTokens(serialized) > maxTokens && parts.length > 1) {
    parts.shift()
    serialized = parts.join('\n')
  }
  // If single remaining turn still over cap, hard-truncate it.
  if (parts.length === 1 && estimateTokens(serialized) > maxTokens) {
    const charBudget = maxTokens * 4 // estimateTokens uses ~4 chars/token
    serialized = serialized.slice(0, charBudget) + '\n…[turn truncated]'
  }
  return serialized
}

function formatTurnLine(turn: ConversationTurn): string {
  const role = turn.role === 'user' ? 'user' : 'assistant'
  const lines: string[] = []
  for (const block of turn.content) {
    if (block.type === 'text') {
      const text = block.text.trim()
      if (text) lines.push(`[${role}] ${text}`)
    } else if (block.type === 'tool_use') {
      const briefInput = JSON.stringify(block.input).slice(0, 120)
      lines.push(`[${role}] (tool_use: ${block.name}(${briefInput}))`)
    } else if (block.type === 'tool_result') {
      const out = toolResultToBriefString(block, 200)
      const tag = block.is_error ? 'tool_error' : 'tool_result'
      lines.push(`[${role}] (${tag}: ${out})`)
    } else if (block.type === 'thinking') {
      // thinking blocks intentionally skipped — too large, low signal for compaction
    }
  }
  return lines.join('\n')
}

function toolResultToBriefString(block: AnthropicToolResultBlock, max: number): string {
  const content = block.content
  if (typeof content === 'string') {
    return content.slice(0, max).replace(/\s+/g, ' ').trim()
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map(b => b.text)
      .join(' ')
    return text.slice(0, max).replace(/\s+/g, ' ').trim()
  }
  return ''
}

/** Extract per-tool-call summary lines from "dropped" turns:
 *    `Read({"path":"src/foo.ts"}) → ok: 1024 chars`
 *    `Bash({"cmd":"npm test"}) → err: timeout after 30s`
 *  Each line ≤ ~150 chars. Caps at TOOL_CALL_SUMMARY_MAX_LINES (50).
 *  When over the line cap, keeps the MOST RECENT 50 (most-recent-N tail). */
export function extractToolCallSummary(
  turns: readonly ConversationTurn[],
  maxLines: number = TOOL_CALL_SUMMARY_MAX_LINES,
): string {
  // Build (tool_use → following tool_result) pairs by id.
  const toolUses = new Map<string, AnthropicToolUseBlock>()
  const lines: string[] = []
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === 'tool_use') {
        toolUses.set(block.id, block)
      } else if (block.type === 'tool_result') {
        const use = toolUses.get(block.tool_use_id)
        if (!use) continue
        const briefInput = JSON.stringify(use.input).slice(0, 80)
        const briefOutput = toolResultToBriefString(block, 80)
        const status = block.is_error ? 'err' : 'ok'
        lines.push(`${use.name}(${briefInput}) → ${status}: ${briefOutput}`)
        toolUses.delete(block.tool_use_id)
      }
    }
  }
  return lines.slice(-maxLines).join('\n')
}

/** Extract error evidence: is_error tool_results, [Runtime ...] warnings,
 *  timeout / failure messages from text. Each line ≤ ~120 chars. */
export function extractErrorEvidence(
  turns: readonly ConversationTurn[],
  maxLines: number = ERROR_EVIDENCE_MAX_LINES,
): string {
  const lines: string[] = []
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === 'tool_result' && block.is_error) {
        const out = toolResultToBriefString(block, 100)
        lines.push(`tool_error: ${out}`)
      } else if (block.type === 'text') {
        const text = block.text
        // Runtime nudges
        const runtimeMatch = text.match(/\[Runtime [^\]]+\][^\n]{0,200}/)
        if (runtimeMatch) lines.push(`runtime: ${runtimeMatch[0].slice(0, 120)}`)
        // explicit timeout / failure phrasing
        const timeoutMatch = text.match(/(?:timeout|timed out|stream.{0,30}interrupted|context.{0,30}exceeded)[^\n]{0,100}/i)
        if (timeoutMatch) lines.push(`failure: ${timeoutMatch[0].slice(0, 120)}`)
      }
    }
  }
  // Dedup adjacent identical lines (Runtime nudges often repeat).
  const deduped: string[] = []
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line)
  }
  return deduped.slice(-maxLines).join('\n')
}

/** Extract file paths from tool_use inputs across the dropped turns.
 *  Heuristic: any string input value containing `/`, no whitespace, no
 *  shell metachars. Dedup; cap to FILE_PATHS_MAX (80). */
export function extractFilePaths(
  turns: readonly ConversationTurn[],
  maxPaths: number = FILE_PATHS_MAX,
): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      collectPathsFromValue(block.input, seen, order)
    }
  }
  return order.slice(-maxPaths)
}

function collectPathsFromValue(
  value: unknown,
  seen: Set<string>,
  order: string[],
): void {
  if (typeof value === 'string') {
    if (looksLikePath(value) && !seen.has(value)) {
      seen.add(value)
      order.push(value)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectPathsFromValue(item, seen, order)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectPathsFromValue(v, seen, order)
    }
  }
}

function looksLikePath(s: string): boolean {
  if (s.length < 3 || s.length > 256) return false
  if (!s.includes('/')) return false
  if (/\s/.test(s)) return false
  if (/[<>{}|&;`$"']/.test(s)) return false // shell metachars
  return true
}

// ─── 7-section request builder ─────────────────────────────────────────

export interface CompactionRequest {
  prompt: string
  estimatedTokens: number
  droppedTurns: ConversationTurn[]
  keptTurns: ConversationTurn[]
}

export interface BuildCompactionRequestOptions {
  inputMaxTokens?: number
  recentTurnsCount?: number
}

/** Build the bounded compactor input. Returns null if there's nothing to
 *  compact (≤ recentTurnsCount turns total → all are kept verbatim, no
 *  drop, no summary needed). */
export function buildCompactionRequest(
  conv: Conversation,
  options: BuildCompactionRequestOptions = {},
): CompactionRequest | null {
  const recentN = options.recentTurnsCount ?? RECENT_TURNS_VERBATIM_COUNT
  const totalCap = options.inputMaxTokens ?? DEFAULT_COMPACTION_INPUT_MAX_TOKENS
  const turns = conv.turns
  if (turns.length <= recentN) return null

  const splitIdx = turns.length - recentN
  const droppedTurns = turns.slice(0, splitIdx)
  const keptTurns = turns.slice(splitIdx)

  // Section 1 — system, capped at SECTION_CAPS.system. Over-cap is
  // truncated with a hash marker so the compactor knows full system
  // exists in real conversation but isn't visible here. Real conversation
  // system is unchanged — this cap is local to the compactor input.
  const systemSection = capWithHashMarker(conv.system ?? '', SECTION_CAPS.system, 'system')

  // Section 2 — latest user goal (cap, plain truncate).
  const goalRaw = findLatestNonMetaUserText(keptTurns)
    ?? findLatestNonMetaUserText(droppedTurns)
    ?? '(no recent user goal found)'
  const latestUserGoal = capWithHashMarker(goalRaw, SECTION_CAPS.latestUserGoal, 'goal')

  // Section 3 — recent turns verbatim.
  const recentVerbatim = serializeTurnsForCompactor(keptTurns, SECTION_CAPS.recentTurnsVerbatim)

  // Section 4 — tool call summary (dropped only).
  const toolCallSummary = extractToolCallSummary(droppedTurns)

  // Section 5 — error evidence (dropped only).
  const errorEvidence = extractErrorEvidence(droppedTurns)

  // Section 6 — file paths (dropped only).
  const filePaths = extractFilePaths(droppedTurns)
  const filePathsBlock = filePaths.join('\n')

  // Compose. Then check total estimated tokens; if over cap, drop in
  // priority order: file_paths → tool_call_summary tail → error_evidence
  // (must keep at least 5 lines) → recent_turns_verbatim tail.
  // system + latest_user_goal NEVER dropped (load-bearing).
  let prompt = composeCompactorPrompt({
    systemSection,
    latestUserGoal,
    recentVerbatim,
    toolCallSummary,
    errorEvidence,
    filePathsBlock,
  })
  let estimated = estimateTokens(prompt)

  if (estimated > totalCap) {
    prompt = composeCompactorPrompt({
      systemSection,
      latestUserGoal,
      recentVerbatim,
      toolCallSummary,
      errorEvidence,
      filePathsBlock: '(omitted to fit input budget)',
    })
    estimated = estimateTokens(prompt)
  }
  if (estimated > totalCap) {
    const halved = toolCallSummary.split('\n').slice(-Math.floor(TOOL_CALL_SUMMARY_MAX_LINES / 2)).join('\n')
    prompt = composeCompactorPrompt({
      systemSection,
      latestUserGoal,
      recentVerbatim,
      toolCallSummary: halved,
      errorEvidence,
      filePathsBlock: '(omitted to fit input budget)',
    })
    estimated = estimateTokens(prompt)
  }
  // If still over cap, hard-truncate recent_turns_verbatim from the head.
  if (estimated > totalCap) {
    const recentHalved = serializeTurnsForCompactor(
      keptTurns.slice(-Math.max(2, Math.floor(recentN / 2))),
      SECTION_CAPS.recentTurnsVerbatim,
    )
    prompt = composeCompactorPrompt({
      systemSection,
      latestUserGoal,
      recentVerbatim: recentHalved,
      toolCallSummary: '(omitted to fit input budget)',
      errorEvidence,
      filePathsBlock: '(omitted to fit input budget)',
    })
    estimated = estimateTokens(prompt)
  }

  return { prompt, estimatedTokens: estimated, droppedTurns, keptTurns }
}

/** Truncate `text` to `maxTokens`-equivalent chars, append a hash marker
 *  showing the omitted-length and SHA-256-prefix when truncation occurred.
 *  When at-or-under cap, returns text verbatim (no marker). */
function capWithHashMarker(text: string, maxTokens: number, label: string): string {
  if (estimateTokens(text) <= maxTokens) return text
  const charBudget = maxTokens * 4 // estimateTokens approximation
  const head = text.slice(0, charBudget)
  const omittedLength = text.length - head.length
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 7)
  return `${head}\n[${label} truncated: ${omittedLength} chars omitted, sha256:${hash}]`
}

interface ComposeArgs {
  systemSection: string
  latestUserGoal: string
  recentVerbatim: string
  toolCallSummary: string
  errorEvidence: string
  filePathsBlock: string
}

function composeCompactorPrompt(args: ComposeArgs): string {
  return `[system]
${args.systemSection}

[latest_user_goal]
${args.latestUserGoal}

[recent_turns_verbatim]
${args.recentVerbatim}

[tool_call_summary]
${args.toolCallSummary || '(none)'}

[error_evidence]
${args.errorEvidence || '(none)'}

[file_paths_touched]
${args.filePathsBlock || '(none)'}
`
}

// ─── output validation ────────────────────────────────────────────────

const REQUIRED_HEADERS = [
  'Current goal',
  'Preserved evidence',
  'Recent actions',
  'Open risks',
] as const

const OUTPUT_MIN_CHARS = 50
const OUTPUT_MAX_CHARS = 8000

const TOOL_USE_PATTERN = /<tool_use\b|"type"\s*:\s*"tool_use"/

export interface ValidationResult {
  ok: boolean
  reason?:
    | 'too_short'
    | 'too_long'
    | 'missing_header'
    | 'tool_use_marker'
    | 'empty'
}

/** Validate compactor LLM output against locked contract:
 *   - 50 ≤ length ≤ 8000 chars
 *   - all 4 required headers present (case-insensitive substring match)
 *   - no `<tool_use>` or `"type":"tool_use"` markers (compactor must not
 *     hallucinate tool calls — they'd cascade into the post-compact turn) */
export function validateCompactionOutput(text: string): ValidationResult {
  if (!text) return { ok: false, reason: 'empty' }
  const trimmed = text.trim()
  if (trimmed.length < OUTPUT_MIN_CHARS) return { ok: false, reason: 'too_short' }
  if (trimmed.length > OUTPUT_MAX_CHARS) return { ok: false, reason: 'too_long' }
  if (TOOL_USE_PATTERN.test(trimmed)) return { ok: false, reason: 'tool_use_marker' }
  const lower = trimmed.toLowerCase()
  for (const header of REQUIRED_HEADERS) {
    if (!lower.includes(header.toLowerCase())) {
      return { ok: false, reason: 'missing_header' }
    }
  }
  return { ok: true }
}

export interface BuildCompactionFidelityEventsOptions {
  summary: string
  conversationId: string
  iteration: number
  lastToolSignatures?: string[]
  model?: string
  maxFacts?: number
}

const COMPACTION_FIDELITY_MAX_FACTS = 40

interface CompactionPathFact {
  path: string
  sourceTurnId: string
}

/** Build shadow-only exact-match facts for compaction fidelity audits.
 *  This intentionally prefers precision over recall: it only asks whether
 *  concrete path strings present in dropped tool inputs survived verbatim in
 *  the LLM summary. No semantic inference, no gating, no authority changes. */
export function buildCompactionFidelityEvents(
  droppedTurns: readonly ConversationTurn[],
  opts: BuildCompactionFidelityEventsOptions,
): GateEvent[] {
  const facts = extractCompactionPathFacts(droppedTurns, opts.maxFacts ?? COMPACTION_FIDELITY_MAX_FACTS)
  return facts.map((fact): GateEvent => {
    const afterMatch = containsExactCompactionFact(opts.summary, fact.path)
    const reason = afterMatch ? 'kept' : 'dropped'
    return {
      ts: Date.now(),
      kind: 'fidelity_compaction_fact_observed',
      conversationId: opts.conversationId,
      iteration: opts.iteration,
      lastToolSignatures: opts.lastToolSignatures ?? [],
      factType: 'path',
      target: fact.path,
      sourceTurnId: fact.sourceTurnId,
      beforeHash: hashCompactionFact('path', fact.path),
      afterMatch,
      preserved: afterMatch,
      reason,
      compactionFactReason: reason,
      model: opts.model,
      phase: 'compact',
    }
  })
}

function extractCompactionPathFacts(
  droppedTurns: readonly ConversationTurn[],
  maxFacts: number,
): CompactionPathFact[] {
  const seen = new Set<string>()
  const facts: CompactionPathFact[] = []
  for (let i = 0; i < droppedTurns.length; i += 1) {
    const turn = droppedTurns[i]
    if (!turn) continue
    const paths = extractFilePaths([turn], maxFacts)
    for (const path of paths) {
      if (seen.has(path)) continue
      seen.add(path)
      facts.push({ path, sourceTurnId: `dropped:${i}` })
      if (facts.length >= maxFacts) return facts
    }
  }
  return facts
}

function hashCompactionFact(factType: string, value: string): string {
  const hash = createHash('sha256')
    .update(factType)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 12)
  return `sha256:${hash}`
}

const COMPACTION_FACT_TOKEN_CHAR = /[A-Za-z0-9._~+:/@%-]/

function containsExactCompactionFact(text: string, fact: string): boolean {
  let start = 0
  while (start < text.length) {
    const idx = text.indexOf(fact, start)
    if (idx < 0) return false
    const before = idx > 0 ? text[idx - 1] : ''
    const after = text[idx + fact.length] ?? ''
    if (
      !COMPACTION_FACT_TOKEN_CHAR.test(before)
      && !COMPACTION_FACT_TOKEN_CHAR.test(after)
    ) {
      return true
    }
    start = idx + fact.length
  }
  return false
}

// ─── compactor LLM call ───────────────────────────────────────────────

const COMPACTION_TIMEOUT_MS = 15_000
const COMPACTION_MAX_OUTPUT_TOKENS = 1500

const COMPACTOR_SYSTEM_PROMPT = `You are a conversation compressor for an in-progress coding session.
Output a structured summary preserving essential context for continuing the conversation.
Be factual and dense. Skip pleasantries and meta-commentary.

Required output structure (use these exact section headers):

Current goal:
<one or two sentences stating what the user is trying to do RIGHT NOW>

Preserved evidence:
<bulleted facts: key file paths, decisions, numbers, configuration choices, derived results>

Recent actions:
<bulleted recent tool calls and their material outcomes; one line each>

Open risks:
<bulleted unresolved errors, blocked paths, expired assumptions, things still pending>

Output ONLY the summary. No XML tags, no code blocks, no preface.
Maximum 1500 tokens.`

const COMPACTOR_USER_PROMPT_PREFIX = `Compress the following conversation snapshot into the structured summary defined in your system prompt.

CONVERSATION SNAPSHOT:
`

export interface ConversationLoopOptionsLike {
  apiBaseUrl: string
  apiKey?: string
}

export interface CompactViaLLMResult {
  ok: boolean
  summary?: string
  error?: string
  validationReason?: ValidationResult['reason']
  ms: number
}

export interface CompactViaLLMOptions extends ConversationLoopOptionsLike {
  model: string
  /** Override the system prompt. Default is COMPACTOR_SYSTEM_PROMPT. Tests
   *  use this to verify the prompt contract; production should not set it. */
  compactorSystemPrompt?: string
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch
}

export async function compactViaLLM(
  request: CompactionRequest,
  opts: CompactViaLLMOptions,
): Promise<CompactViaLLMResult> {
  const startMs = Date.now()
  const fetchFn = opts.fetchImpl ?? fetch
  const userPrompt = COMPACTOR_USER_PROMPT_PREFIX + request.prompt

  try {
    const resp = await fetchFn(`${opts.apiBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey ?? 'owlcoda-internal',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: COMPACTION_MAX_OUTPUT_TOKENS,
        temperature: 0,
        stream: false,
        // tools: undefined — compactor must NOT have tool access (would cascade)
        system: opts.compactorSystemPrompt ?? COMPACTOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
    })

    if (!resp.ok) {
      return { ok: false, error: `compactor http ${resp.status}`, ms: Date.now() - startMs }
    }
    const body = await resp.json() as { content?: Array<{ type?: string; text?: string }> }
    const summary = body.content?.find(b => b.type === 'text')?.text ?? ''
    const validation = validateCompactionOutput(summary)
    if (!validation.ok) {
      return { ok: false, validationReason: validation.reason, ms: Date.now() - startMs }
    }
    return { ok: true, summary: summary.trim(), ms: Date.now() - startMs }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: errMsg, ms: Date.now() - startMs }
  }
}

// ─── tryCompact: orchestrates LLM-first / truncation-fallback ─────────

/** The reasons surfaced to onAutoCompact callback. Subset extends the
 *  pre-0.13.98 reason enum. */
export type CompactReason =
  | 'threshold'
  | 'hard_limit'
  | 'context_exceeded'
  | 'heap_pressure'

export type CompactMethod =
  | 'llm_summary'
  | 'truncation'
  | 'no_op'

export interface CompactResult {
  method: CompactMethod
  reason: CompactReason
  /** Why we ended up at truncation if LLM was attempted. Omitted when
   *  method='llm_summary' or when LLM was never tried. */
  fallbackReason?:
    | 'llm_compact_failed'
    | 'llm_compact_disabled_3strikes'
    | 'heap_pressure_skip_llm'
    | 'no_llm_opts'
  before: number
  after: number
  beforeTokens: number
  afterTokens: number
  /** ms taken by the LLM attempt (when attempted). 0 otherwise. */
  llmMs?: number
}

/** Maximum consecutive LLM-compact failures before this session disables
 *  LLM and goes straight to truncation. Reset to 0 on first success. */
export const MAX_CONSECUTIVE_LLM_COMPACT_FAILURES = 3

/** Ring buffer cap for compactionLog telemetry on conversation.options. */
export const COMPACTION_LOG_MAX_ENTRIES = 5

export interface TryCompactOptions {
  reason: CompactReason
  /** Conversation context — must be the same Conversation that runs in the
   *  loop. tryCompact mutates conv.turns AND conv.options. */
  apiBaseUrl?: string
  apiKey?: string
  /** Compactor model override. Defaults to conv.model when undefined.
   *  Resolved from middleware.compactionModel by the caller. */
  compactionModel?: string
  /** Bounded input cap override. Defaults to
   *  DEFAULT_COMPACTION_INPUT_MAX_TOKENS. */
  inputMaxTokens?: number
  /** Truncation keep-count (turns to retain after fallback). Caller
   *  computes from contextWindow. */
  truncationKeepCount: number
  /** Optional shadow telemetry for evidence-ledger fidelity audits. */
  fidelityTelemetry?: Omit<BuildCompactionFidelityEventsOptions, 'summary'>
  /** Test override for fetch. */
  fetchImpl?: typeof fetch
}

/** Single attempt to compact. Returns a fully-populated CompactResult.
 *  Never throws — all errors converted to truncation-path results.
 *
 *  Mutates:
 *   - conv.turns (replaces with [summary turn, ...keptTurns] on success or
 *     truncated tail on fallback)
 *   - conv.options.llmCompactFailureCount (incremented on failure, reset
 *     to 0 on success)
 *   - conv.options.compactionLog (ring buffer telemetry, up to 5 entries) */
export async function tryCompact(
  conv: Conversation,
  opts: TryCompactOptions,
): Promise<CompactResult> {
  const before = conv.turns.length
  const beforeTokens = estimateConvTokensSafe(conv)

  // Hard rule: heap-pressure NEVER calls LLM. Allocating buffers / Promise
  // chains for an LLM round-trip while V8 heap is at 75% risks OOM.
  if (opts.reason === 'heap_pressure') {
    truncateInPlace(conv, opts.truncationKeepCount)
    return finishWithTruncation(conv, opts.reason, 'heap_pressure_skip_llm', before, beforeTokens)
  }

  // No LLM transport configured (apiBaseUrl missing) → straight truncation.
  if (!opts.apiBaseUrl) {
    truncateInPlace(conv, opts.truncationKeepCount)
    return finishWithTruncation(conv, opts.reason, 'no_llm_opts', before, beforeTokens)
  }

  // 3-strike disable: if this session has hit MAX_CONSECUTIVE_... LLM
  // failures already, don't try again — go straight to truncation.
  const failureCount = conv.options?.llmCompactFailureCount ?? 0
  if (failureCount >= MAX_CONSECUTIVE_LLM_COMPACT_FAILURES) {
    truncateInPlace(conv, opts.truncationKeepCount)
    return finishWithTruncation(conv, opts.reason, 'llm_compact_disabled_3strikes', before, beforeTokens)
  }

  // Build bounded compactor input. Returns null when conversation is
  // smaller than the verbatim-keep tail — nothing to compact.
  const request = buildCompactionRequest(conv, {
    inputMaxTokens: opts.inputMaxTokens,
  })
  if (!request) {
    return {
      method: 'no_op',
      reason: opts.reason,
      before,
      after: before,
      beforeTokens,
      afterTokens: beforeTokens,
    }
  }

  // Attempt LLM compact. ONE attempt only — no retry.
  const llmResult = await compactViaLLM(request, {
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    model: opts.compactionModel ?? conv.model,
    fetchImpl: opts.fetchImpl,
  })

  if (llmResult.ok && llmResult.summary) {
    // Success path: replace droppedTurns with single synthetic user turn
    // carrying the structured summary, prepended to keptTurns.
    const summaryTurn: ConversationTurn = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Conversation compacted: ${request.droppedTurns.length} turn(s) summarized via LLM]\n\n${llmResult.summary}`,
      }],
      timestamp: Date.now(),
    }
    conv.turns = [summaryTurn, ...request.keptTurns]
    if (!conv.options) conv.options = {}
    conv.options.llmCompactFailureCount = 0  // reset on success
    appendCompactionLog(conv, {
      reason: opts.reason,
      method: 'llm_summary',
      ms: llmResult.ms,
      at: Date.now(),
    })
    recordCompactionFidelityTelemetry(request.droppedTurns, llmResult.summary, opts.fidelityTelemetry)
    const afterTokens = estimateConvTokensSafe(conv)
    return {
      method: 'llm_summary',
      reason: opts.reason,
      before,
      after: conv.turns.length,
      beforeTokens,
      afterTokens,
      llmMs: llmResult.ms,
    }
  }

  // LLM failure path: fallback to truncation. Bump strike counter.
  if (!conv.options) conv.options = {}
  conv.options.llmCompactFailureCount = failureCount + 1
  truncateInPlace(conv, opts.truncationKeepCount)
  return finishWithTruncation(conv, opts.reason, 'llm_compact_failed', before, beforeTokens, llmResult.ms)
}

function recordCompactionFidelityTelemetry(
  droppedTurns: readonly ConversationTurn[],
  summary: string,
  opts: TryCompactOptions['fidelityTelemetry'],
): void {
  if (!opts) return
  const events = buildCompactionFidelityEvents(droppedTurns, { ...opts, summary })
  for (const event of events) recordGateEvent(event)
}

function truncateInPlace(conv: Conversation, keepCount: number): void {
  const tail = Math.max(2, keepCount)
  if (conv.turns.length <= tail) return
  conv.turns = conv.turns.slice(-tail)
}

function finishWithTruncation(
  conv: Conversation,
  reason: CompactReason,
  fallbackReason: CompactResult['fallbackReason'],
  before: number,
  beforeTokens: number,
  llmMs?: number,
): CompactResult {
  appendCompactionLog(conv, {
    reason,
    method: 'truncation',
    fallbackReason,
    ms: llmMs,
    at: Date.now(),
  })
  return {
    method: 'truncation',
    reason,
    fallbackReason,
    before,
    after: conv.turns.length,
    beforeTokens,
    afterTokens: estimateConvTokensSafe(conv),
    llmMs,
  }
}

function appendCompactionLog(conv: Conversation, entry: CompactionLogEntry): void {
  if (!conv.options) conv.options = {}
  const existing = conv.options.compactionLog ?? []
  const next = [...existing, entry]
  while (next.length > COMPACTION_LOG_MAX_ENTRIES) next.shift()
  conv.options.compactionLog = next
}

/** Wrap estimateConversationTokens against any throws (tool_result with
 *  weird content shape used to throw in early versions; defensive). */
function estimateConvTokensSafe(conv: Conversation): number {
  try {
    // Local re-import to avoid circular: we import estimateTokens at top,
    // reuse it on the serialized conversation when stable estimator
    // unavailable. estimateConversationTokens already imported here.
    return estimateTokens(JSON.stringify({
      system: conv.system,
      turns: conv.turns,
    }))
  } catch {
    return 0
  }
}

// ─── re-exports for tests ─────────────────────────────────────────────

export {
  RECENT_TURNS_VERBATIM_COUNT,
  SECTION_CAPS,
  COMPACTION_TIMEOUT_MS,
  COMPACTION_MAX_OUTPUT_TOKENS,
  COMPACTOR_SYSTEM_PROMPT,
  REQUIRED_HEADERS,
}
