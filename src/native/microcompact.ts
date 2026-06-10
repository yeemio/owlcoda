/**
 * Microcompact (shadow phase) — no-LLM identification of superseded tool reads.
 *
 * A `Read` result is a snapshot of a file at a point in time. Once a LATER turn
 * re-reads or edits that same path, the earlier snapshot is stale: the later
 * read/edit is the live anchor, so the earlier read's content is redundant and
 * could be stripped to free context tokens — at zero API cost, every turn.
 *
 * This module only ANALYZES (measures the opportunity). It never strips. By
 * construction the latest read of each path is never a candidate, so the live
 * anchor is always preserved. Actual stripping is a later, cache-aware phase:
 * on a cloud endpoint with a hot cached prefix, removing already-cached content
 * forces a cache MISS downstream (cacheWrite ~= 10x cacheRead), so a naive strip
 * can cost more than it saves; that split is deferred to enforcement.
 */
import type { ConversationTurn } from './protocol/types.js'
import type { AnthropicToolResultBlock, AnthropicToolUseBlock } from '../types.js'
import { estimateTokens } from './usage.js'
import {
  buildTelemetryEventEnvelope,
  recordTelemetryEnvelope,
  type TelemetryEventEnvelope,
} from './telemetry-envelope.js'
import { readEnvelopeEvents } from './envelope-ledger.js'

const MICROCOMPACT_SHADOW_EVENT_TYPE = 'microcompact_shadow'

// Tools whose result is a path-keyed file snapshot.
const READ_TOOLS = new Set(['Read', 'read'])
// Tools that invalidate a path's snapshot.
const MUTATING_TOOLS = new Set(['Edit', 'edit', 'Write', 'write', 'NotebookEdit', 'notebook_edit'])

export interface MicrocompactCandidate {
  path: string
  toolUseId: string
  turnIndex: number
  tokens: number
  reason: 'superseded_by_read' | 'superseded_by_edit'
}

export interface MicrocompactAnalysis {
  totalReads: number
  supersededReads: number
  strippableTokens: number
  candidates: MicrocompactCandidate[]
}

function toolResultText(block: AnthropicToolResultBlock): string {
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(b => (b.type === 'text' ? b.text : '')).join('')
  return ''
}

function blockPath(block: AnthropicToolUseBlock): string | undefined {
  const p = (block.input as { path?: unknown }).path
  return typeof p === 'string' ? p : undefined
}

/**
 * Identify reads whose snapshot is superseded by a later read/edit of the same
 * path, and measure how many tokens stripping them would free. Pure.
 */
export function analyzeMicrocompact(turns: readonly ConversationTurn[]): MicrocompactAnalysis {
  // tool_use_id -> the text of its tool_result (results arrive in a later turn).
  const resultText = new Map<string, string>()
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === 'tool_result') resultText.set(block.tool_use_id, toolResultText(block))
    }
  }

  const reads: Array<{ path: string; toolUseId: string; turnIndex: number }> = []
  // Per path: turn indices that read or mutate it.
  const pathEvents = new Map<string, Array<{ turnIndex: number; kind: 'read' | 'edit' }>>()

  turns.forEach((turn, turnIndex) => {
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      const path = blockPath(block)
      if (path === undefined) continue
      const isRead = READ_TOOLS.has(block.name)
      const isMutate = MUTATING_TOOLS.has(block.name)
      if (!isRead && !isMutate) continue
      if (isRead) reads.push({ path, toolUseId: block.id, turnIndex })
      const arr = pathEvents.get(path) ?? []
      arr.push({ turnIndex, kind: isRead ? 'read' : 'edit' })
      pathEvents.set(path, arr)
    }
  })

  const candidates: MicrocompactCandidate[] = []
  for (const r of reads) {
    const events = pathEvents.get(r.path) ?? []
    const laterEdit = events.some(e => e.turnIndex > r.turnIndex && e.kind === 'edit')
    const laterRead = events.some(e => e.turnIndex > r.turnIndex && e.kind === 'read')
    if (!laterEdit && !laterRead) continue // latest snapshot of this path — keep as anchor
    candidates.push({
      path: r.path,
      toolUseId: r.toolUseId,
      turnIndex: r.turnIndex,
      tokens: estimateTokens(resultText.get(r.toolUseId) ?? ''),
      reason: laterEdit ? 'superseded_by_edit' : 'superseded_by_read',
    })
  }

  return {
    totalReads: reads.length,
    supersededReads: candidates.length,
    strippableTokens: candidates.reduce((sum, c) => sum + c.tokens, 0),
    candidates,
  }
}

/** Opt-in (default OFF). Shadow phase changes nothing until explicitly enabled. */
export function isMicrocompactShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_MICROCOMPACT_SHADOW']
  if (raw === undefined) return false
  return new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']).has(raw.trim().toLowerCase())
}

/** Behavior-neutral envelope reporting the strip opportunity. Pure — no IO. */
export function buildMicrocompactShadowEvent(analysis: MicrocompactAnalysis): TelemetryEventEnvelope {
  return buildTelemetryEventEnvelope({
    eventType: MICROCOMPACT_SHADOW_EVENT_TYPE,
    surface: 'telemetry',
    subject: 'conversation',
    origin: 'runtime',
    severity: 'info',
    decision: 'observe',
    reasonCode: `superseded_${analysis.supersededReads}`,
    attributes: {
      totalReads: analysis.totalReads,
      supersededReads: analysis.supersededReads,
      strippableTokens: analysis.strippableTokens,
    },
  })
}

/**
 * Record one shadow sample of the microcompact opportunity. No-op unless
 * OWLCODA_MICROCOMPACT_SHADOW is enabled, and skips conversations with no reads
 * (nothing to measure). NEVER strips — this only observes. Fire-and-forget.
 */
export function recordMicrocompactShadow(
  turns: readonly ConversationTurn[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isMicrocompactShadowEnabled(env)) return
  const analysis = analyzeMicrocompact(turns)
  if (analysis.totalReads === 0) return
  recordTelemetryEnvelope(buildMicrocompactShadowEvent(analysis), env)
}

export interface MicrocompactShadowSummary {
  samples: number
  totalStrippableTokens: number
  avgStrippableTokens: number
  totalSupersededReads: number
  totalReads: number
  filesRead: string[]
}

/** Pure tally over already-parsed envelopes (ignores non-microcompact types). */
export function summarizeMicrocompactShadow(
  events: readonly TelemetryEventEnvelope[],
): Omit<MicrocompactShadowSummary, 'filesRead'> {
  let samples = 0
  let totalStrippableTokens = 0
  let totalSupersededReads = 0
  let totalReads = 0
  for (const e of events) {
    if (e.eventType !== MICROCOMPACT_SHADOW_EVENT_TYPE) continue
    const a = (e.attributes ?? {}) as {
      strippableTokens?: unknown
      supersededReads?: unknown
      totalReads?: unknown
    }
    samples++
    if (typeof a.strippableTokens === 'number') totalStrippableTokens += a.strippableTokens
    if (typeof a.supersededReads === 'number') totalSupersededReads += a.supersededReads
    if (typeof a.totalReads === 'number') totalReads += a.totalReads
  }
  return {
    samples,
    totalStrippableTokens,
    avgStrippableTokens: samples > 0 ? Math.round(totalStrippableTokens / samples) : 0,
    totalSupersededReads,
    totalReads,
  }
}

/** Read microcompact_shadow events from the unified ledger and tally. */
export function buildMicrocompactShadowSummary(
  options: { home?: string; maxFiles?: number } = {},
): MicrocompactShadowSummary {
  const { events, filesRead } = readEnvelopeEvents(options)
  return { ...summarizeMicrocompactShadow(events), filesRead }
}
