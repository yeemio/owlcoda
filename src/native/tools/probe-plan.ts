/**
 * OwlCoda Native ProbePlan Tool
 *
 * Background — issue #7 (private):
 *   Two consecutive hostile-QA prompt revisions (delivery-quality-v2
 *   and v2.1) failed to make the testing LLMs actually emit Group A's
 *   `A0` write probe. Both DeepSeek and Kimi pattern-matched the
 *   prompt text saying "A0 may be denied" → predicted denial → skipped
 *   the tool call entirely → reported P with no transcript evidence.
 *
 *   The v2.1 patch added rule 9 ("evidence must be a real tool_use
 *   block") and rule 10 ("probes are unconditional") to the prompt
 *   itself, but a prompt-only fix has no enforcement. The runtime
 *   has to verify probes were actually emitted before allowing a
 *   final summary — otherwise the rules are advisory.
 *
 * What this tool does:
 *   - Registers a "probe plan" — a list of `{id, tool, mustContain,
 *     description}` entries — into `conversation.options.probePlans`.
 *   - Each subsequent tool execution is checked against unsatisfied
 *     probes by `markProbesSatisfied` (called from the conversation
 *     loop after `executeTools` returns). A probe is satisfied when a
 *     tool call's name === probe.tool AND `mustContain` appears as a
 *     substring of any string-valued leaf in the tool input (walked
 *     recursively — see `inputContainsString`). Walking values rather
 *     than `JSON.stringify(input)` was the 0.13.53 fix: bash commands
 *     containing literal double quotes (`echo "edited via bash"`) get
 *     their quotes escaped during stringify (`echo \"edited via
 *     bash\"`), making substring matches against the unescaped
 *     mustContain fail.
 *   - The conversation loop's final-text hook injects a
 *     `[Runtime probe-coverage check]` notice when the assistant
 *     attempts to summarize a group with unsatisfied probes (similar
 *     pattern to the 0.13.44 delivery-check hook).
 *
 * What this tool does NOT do:
 *   - Run the probes itself. The model still emits each tool call.
 *     This tool is the registration + runtime tracking layer.
 *   - Validate that the probe was the right shape semantically — only
 *     that a tool call matching `tool` + `mustContain` happened. False
 *     positives are tolerable; the prompt is the authoritative spec.
 *   - Block the final summary outright. The hook injects a notice and
 *     the model can re-emit. A persistent refusal can still get
 *     through — but it will be visible in the transcript as repeated
 *     coverage-check injects.
 */

import type { NativeToolDef, ToolResult } from './types.js'
import type {
  Conversation,
  ProbeExpectedOutcome,
  ProbePlanProbe,
  ProbePlanState,
} from '../protocol/types.js'

const VALID_OUTCOMES: ProbeExpectedOutcome[] = ['success', 'intentGuardBlocked']

export interface ProbePlanInput {
  /** User-supplied group label, e.g. "A". Re-registering the same id replaces. */
  groupId: string
  probes: Array<{
    id: string
    tool: string
    mustContain: string
    description?: string
    /**
     * Optional; defaults to 'success'. Set to 'intentGuardBlocked' for
     * negative probes that must actually be emitted but expected to be
     * refused by the analysis-intent / allowlist guard. The probe is
     * only marked satisfied when both the tool_use fires and the
     * resulting tool_result carries `metadata.intentGuardBlocked === true`.
     */
    expectedOutcome?: ProbeExpectedOutcome
  }>
}

export interface ProbePlanDeps {
  /**
   * Live accessor for the active `Conversation`. Wired by the REPL
   * the same way `liveApproveState` was wired in 0.13.40, so the
   * tool can mutate `conversation.options.probePlans` without
   * conversation.ts having to thread the conversation into every
   * dispatcher call.
   */
  getConversation?: () => Conversation | null
}

export function createProbePlanTool(deps: ProbePlanDeps = {}): NativeToolDef<ProbePlanInput> {
  return {
    name: 'ProbePlan',
    description:
      'Register a hostile-QA probe plan: a list of tool calls (each with id, ' +
      'expected tool name, and a substring matcher) that the conversation ' +
      'loop will track satisfaction for. When the model later attempts a ' +
      'final summary while any registered probe is unsatisfied, the runtime ' +
      'auto-injects a [Runtime probe-coverage check] notice listing the ' +
      'missing probes — closing the "predicted-denied-so-skipped" escape ' +
      'that prompt-only QA discipline rules cannot enforce. Call this once ' +
      'at the start of each QA group; subsequent ProbePlan calls with the ' +
      'same groupId replace the prior plan.',
    maturity: 'beta' as const,

    async execute(input: ProbePlanInput, _context): Promise<ToolResult> {
      const conversation = deps.getConversation?.() ?? null
      if (!conversation) {
        return {
          output:
            'ProbePlan: no live conversation available — this tool is REPL-only ' +
            'and cannot register a plan from a headless dispatcher invocation.',
          isError: true,
          metadata: { mode: 'no-conversation' },
        }
      }
      if (!input.groupId || typeof input.groupId !== 'string') {
        return { output: 'Error: groupId is required.', isError: true }
      }
      if (!Array.isArray(input.probes) || input.probes.length === 0) {
        return { output: 'Error: probes must be a non-empty array.', isError: true }
      }
      for (const p of input.probes) {
        if (!p.id || typeof p.id !== 'string') {
          return { output: `Error: each probe needs an id (got ${JSON.stringify(p)}).`, isError: true }
        }
        if (!p.tool || typeof p.tool !== 'string') {
          return { output: `Error: probe ${p.id} missing tool name.`, isError: true }
        }
        if (typeof p.mustContain !== 'string') {
          return { output: `Error: probe ${p.id} mustContain must be a string.`, isError: true }
        }
        if (p.expectedOutcome !== undefined && !VALID_OUTCOMES.includes(p.expectedOutcome)) {
          return {
            output:
              `Error: probe ${p.id} expectedOutcome must be one of ` +
              `${VALID_OUTCOMES.join(', ')} (got ${JSON.stringify(p.expectedOutcome)}).`,
            isError: true,
          }
        }
      }

      const now = new Date().toISOString()
      const probes: ProbePlanProbe[] = input.probes.map((p) => ({
        id: p.id,
        tool: p.tool,
        mustContain: p.mustContain,
        description: p.description ?? '',
        expectedOutcome: p.expectedOutcome ?? 'success',
        satisfiedAt: null,
      }))
      const plan: ProbePlanState = {
        groupId: input.groupId,
        probes,
        registeredAt: now,
      }

      if (!conversation.options) conversation.options = {}
      const existing = conversation.options.probePlans ?? []
      const filtered = existing.filter((pp) => pp.groupId !== input.groupId)
      filtered.push(plan)
      conversation.options.probePlans = filtered

      return {
        output:
          `Registered probe plan for group "${input.groupId}" with ${probes.length} probe(s):\n` +
          probes.map((p) => `  - ${p.id} (tool=${p.tool}, mustContain=${JSON.stringify(p.mustContain)})`).join('\n') +
          '\n\nThe conversation loop will now track satisfaction. Emit each probe before summarizing this group.',
        isError: false,
        metadata: {
          groupId: input.groupId,
          probesRegistered: probes.length,
          plan,
        },
      }
    },
  }
}

/**
 * Pure check: does this tool call match an unsatisfied registered
 * **positive** probe? Used by `evaluateIntentGuard` (0.13.52) as a
 * probe-consent override — when the user's intent is `analysis` (or
 * the conversation is in allowlist mode) but the call matches a probe
 * they explicitly registered via `ProbePlan`, the registration itself
 * counts as implementation consent for THAT specific probe, so the
 * guard lets it through.
 *
 * 0.13.56 change: this function now skips probes whose
 * `expectedOutcome !== 'success'`. Negative probes (i.e.
 * `expectedOutcome: 'intentGuardBlocked'`) are explicitly waiting for
 * the intent guard to refuse them — letting them bypass the guard
 * via probe-consent would defeat the whole point of the negative
 * probe. Without this filter, A_LEAK in v2.5 hostile-QA matched
 * mustContain → probe-consent override fired → intent guard returned
 * null → call fell through to operator approval instead of being
 * caught by the structured guard.
 */
export function findMatchingUnsatisfiedProbe(
  conversation: Conversation,
  toolName: string,
  toolInput: Record<string, unknown>,
): { groupId: string; probe: ProbePlanProbe } | null {
  const plans = conversation.options?.probePlans
  if (!plans || plans.length === 0) return null
  for (const plan of plans) {
    for (const probe of plan.probes) {
      if (probe.satisfiedAt !== null) continue
      if (probe.tool !== toolName) continue
      // 0.13.56: only positive probes can use probe-consent override.
      const expected = probe.expectedOutcome ?? 'success'
      if (expected !== 'success') continue
      if (!probeInputContainsString(toolName, toolInput, probe.mustContain)) continue
      return { groupId: plan.groupId, probe }
    }
  }
  return null
}

/**
 * Outcome of an executed tool call as observed by the runtime. The
 * matcher uses this to evaluate `expectedOutcome` semantics. Pass null
 * (or omit) for callers that haven't actually executed yet — those
 * cases only match probes whose expectedOutcome is 'success'.
 */
export interface ProbeToolOutcome {
  /** True if the tool_result was returned with isError: true. */
  isError: boolean
  /** Structured metadata returned alongside the tool_result, if any. */
  metadata?: Record<string, unknown>
}

/**
 * Walk the active probe plans and mark a probe satisfied if the tool
 * call (by name + value-tree input) matches an unsatisfied probe's
 * matcher AND the executed outcome matches the probe's expectedOutcome.
 *
 *  - 'success' (default): satisfied iff outcome.isError === false.
 *  - 'intentGuardBlocked' (0.13.54): satisfied iff outcome.isError ===
 *    true AND outcome.metadata.intentGuardBlocked === true. Closes the
 *    "predicted-denied → skipped → fabricated guard evidence" escape
 *    that DeepSeek + Kimi both showed in v2.4 hostile-QA on A_LEAK.
 *
 * Idempotent: already-satisfied probes stay satisfied. Returns the
 * list of probe ids that were freshly marked.
 */
export function markProbesSatisfied(
  conversation: Conversation,
  toolName: string,
  toolInput: Record<string, unknown>,
  outcome?: ProbeToolOutcome,
): string[] {
  const plans = conversation.options?.probePlans
  if (!plans || plans.length === 0) return []
  const now = new Date().toISOString()
  const newlySatisfied: string[] = []
  for (const plan of plans) {
    for (const probe of plan.probes) {
      if (probe.satisfiedAt !== null) continue
      if (probe.tool !== toolName) continue
      if (!probeInputContainsString(toolName, toolInput, probe.mustContain)) continue
      if (!outcomeMatches(probe.expectedOutcome ?? 'success', outcome)) continue
      probe.satisfiedAt = now
      newlySatisfied.push(`${plan.groupId}:${probe.id}`)
    }
  }
  return newlySatisfied
}

/** Probes still unsatisfied across all active plans. Returns one
 *  flat list of `{groupId, probe}` for inject-message rendering. */
export function unsatisfiedProbes(
  conversation: Conversation,
): Array<{ groupId: string; probe: ProbePlanProbe }> {
  const out: Array<{ groupId: string; probe: ProbePlanProbe }> = []
  const plans = conversation.options?.probePlans
  if (!plans) return out
  for (const plan of plans) {
    for (const probe of plan.probes) {
      if (probe.satisfiedAt === null) {
        out.push({ groupId: plan.groupId, probe })
      }
    }
  }
  return out
}

/**
 * Build the runtime-injected nudge that fires when an assistant final
 * text response attempts to summarize while probes remain unsatisfied.
 * Same shape as buildTaskContinuePrompt / buildDeliveryCheckPrompt
 * (single user-role message body).
 */
export function buildProbeCoverageCheckPrompt(
  unsatisfied: Array<{ groupId: string; probe: ProbePlanProbe }>,
): string {
  const lines: string[] = ['[Runtime probe-coverage check]']
  lines.push(
    `Your last message looks like a group summary, but ${unsatisfied.length} ` +
    `registered probe(s) have not actually been emitted in this conversation:`,
  )
  for (const { groupId, probe } of unsatisfied) {
    const desc = probe.description ? ` — ${probe.description}` : ''
    const outcome = probe.expectedOutcome && probe.expectedOutcome !== 'success'
      ? `, expected outcome=${probe.expectedOutcome}`
      : ''
    lines.push(
      `  • ${groupId}:${probe.id}  expected tool=${probe.tool} containing ` +
      `${JSON.stringify(probe.mustContain)}${outcome}${desc}`,
    )
  }
  lines.push('')
  lines.push(
    'Predicting an outcome ("denied" / "would fail") and skipping the tool ' +
    'call is rule-9 / rule-10 violation per the QA prompt. Negative probes ' +
    '(expectedOutcome=intentGuardBlocked) MUST also be emitted — the runtime ' +
    'only marks them satisfied when both the tool_use fires AND the resulting ' +
    'tool_result carries intentGuardBlocked metadata. You cannot satisfy them ' +
    'by skipping and writing a summary describing what would have happened. ' +
    'Emit the missing probes now (one tool call each, no retries on the same ' +
    'input). After they fire, the runtime tracks satisfaction automatically ' +
    'and you can re-issue the summary table.',
  )
  return lines.join('\n')
}

/**
 * Decide whether an executed tool call's outcome matches the probe's
 * declared expectation.
 *
 *  - 'success' (default + back-compat): outcome.isError === false. If
 *    no outcome was passed (callers that haven't observed a result),
 *    treat as a match — the legacy markProbesSatisfied(conv, name,
 *    input) call shape predates this field and was always 'success'.
 *  - 'intentGuardBlocked' (0.13.54): outcome.isError === true AND
 *    metadata.intentGuardBlocked === true. Without an outcome this
 *    cannot be confirmed, so it does not match.
 */
function outcomeMatches(
  expected: ProbeExpectedOutcome,
  outcome: ProbeToolOutcome | undefined,
): boolean {
  if (expected === 'success') {
    if (!outcome) return true
    return outcome.isError === false
  }
  if (expected === 'intentGuardBlocked') {
    if (!outcome) return false
    if (!outcome.isError) return false
    const meta = outcome.metadata ?? {}
    return meta['intentGuardBlocked'] === true
  }
  return false
}

function probeInputContainsString(
  toolName: string,
  toolInput: Record<string, unknown>,
  needle: string,
): boolean {
  if (toolName !== 'bash') return inputContainsString(toolInput, needle)

  const command = typeof toolInput['command'] === 'string'
    ? toolInput['command']
    : ''
  if (!command) return inputContainsString(toolInput, needle)
  if (!command.includes(needle)) return false
  return bashCommandContainsArtifactBoundNeedle(command, needle)
}

function bashCommandContainsArtifactBoundNeedle(command: string, needle: string): boolean {
  const chunks = splitShellCommandForProbe(command)
  for (const chunk of chunks) {
    if (!chunk.includes(needle)) continue
    if (isStdoutOnlyEchoProbeChunk(chunk)) continue
    return true
  }
  return false
}

function isStdoutOnlyEchoProbeChunk(chunk: string): boolean {
  const trimmed = chunk.trim()
  if (!/^(?:echo|printf)\b/.test(trimmed)) return false
  return !hasArtifactWriteSink(trimmed)
}

function hasArtifactWriteSink(chunk: string): boolean {
  return /\btee\b/.test(chunk)
    || /(?:^|\s)\d?>{1,2}\s*(?!&)(?!\/dev\/null\b)\S+/.test(chunk)
}

function splitShellCommandForProbe(input: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let backtickDepth = 0
  let i = 0

  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (!inSingle && !inDouble && parenDepth === 0 && backtickDepth === 0) {
      if (ch === ';') { flush(); i++; continue }
      if (ch === '|' && next !== '|') { flush(); i++; continue }
      if (ch === '|' && next === '|') { flush(); i += 2; continue }
      if (ch === '&' && next === '&') { flush(); i += 2; continue }
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) backtickDepth = backtickDepth === 0 ? 1 : 0
    else if (ch === '$' && next === '(' && !inSingle) { parenDepth++; buf += ch; i++; continue }
    else if (ch === ')' && !inSingle && parenDepth > 0) parenDepth--
    buf += ch
    i++
  }
  flush()
  return out.filter(s => s.length > 0)

  function flush() {
    const s = buf.trim()
    buf = ''
    if (s) out.push(s)
  }
}

/**
 * Walk the tool input value tree and check whether `needle` appears as
 * a substring of any string-typed leaf. Used by the probe matcher
 * (0.13.53 fix): the previous implementation matched `needle` against
 * `JSON.stringify(input)`, which escapes embedded double quotes — so a
 * probe `mustContain: 'echo "edited via bash"'` would never match a
 * bash input `{command: 'echo "edited via bash" > x'}` because the
 * stringified form contained `echo \"edited via bash\"`. Walking the
 * actual values matches against the unescaped strings.
 */
function inputContainsString(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) {
    for (const item of value) if (inputContainsString(item, needle)) return true
    return false
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (inputContainsString(v, needle)) return true
    }
    return false
  }
  return false
}
