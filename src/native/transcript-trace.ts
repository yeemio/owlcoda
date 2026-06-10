/**
 * Golden-transcript trace-diff (S7 primitive).
 *
 * The benchmark harness already replays scripted model responses and diffs the
 * OUTCOME (artifacts, final status, verification). What it does not catch is a
 * change in the tool-call ORCHESTRATION — the same scripted responses producing
 * a different sequence of tool executions (a dispatch/loop regression) that
 * happens to land the same final artifacts. This extracts the deterministic
 * tool-call trace from a conversation and diffs it against a golden trace, so
 * such regressions surface position-by-position. Pure — no IO, no live model.
 */
import type { ConversationTurn } from './protocol/types.js'
import type { AnthropicToolUseBlock } from '../types.js'

export interface ToolCallTraceEntry {
  name: string
  input: Record<string, unknown>
}

/**
 * The ordered sequence of (toolName, input) the model invoked across the turns.
 * `normalize` canonicalizes volatile input (e.g. workspace paths) so a trace is
 * comparable across runs.
 */
export function traceFromTurns(
  turns: readonly ConversationTurn[],
  normalize?: (input: Record<string, unknown>) => Record<string, unknown>,
): ToolCallTraceEntry[] {
  const trace: ToolCallTraceEntry[] = []
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      const tu = block as AnthropicToolUseBlock
      trace.push({ name: tu.name, input: normalize ? normalize(tu.input) : tu.input })
    }
  }
  return trace
}

/** Deterministic serialization with sorted keys, so input comparison is
 *  independent of property order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export interface TraceDiffEntry {
  index: number
  kind: 'name_mismatch' | 'input_mismatch' | 'missing_in_actual' | 'extra_in_actual'
  golden?: ToolCallTraceEntry
  actual?: ToolCallTraceEntry
}

/** Compare a golden trace against an actual trace, position by position. */
export function diffTrace(
  golden: readonly ToolCallTraceEntry[],
  actual: readonly ToolCallTraceEntry[],
): TraceDiffEntry[] {
  const diffs: TraceDiffEntry[] = []
  const max = Math.max(golden.length, actual.length)
  for (let i = 0; i < max; i++) {
    const g = golden[i]
    const a = actual[i]
    if (g && !a) {
      diffs.push({ index: i, kind: 'missing_in_actual', golden: g })
    } else if (!g && a) {
      diffs.push({ index: i, kind: 'extra_in_actual', actual: a })
    } else if (g && a) {
      if (g.name !== a.name) {
        diffs.push({ index: i, kind: 'name_mismatch', golden: g, actual: a })
      } else if (stableStringify(g.input) !== stableStringify(a.input)) {
        diffs.push({ index: i, kind: 'input_mismatch', golden: g, actual: a })
      }
    }
  }
  return diffs
}

/** True iff the actual trace matches the golden trace exactly. */
export function traceMatches(
  golden: readonly ToolCallTraceEntry[],
  actual: readonly ToolCallTraceEntry[],
): boolean {
  return diffTrace(golden, actual).length === 0
}
