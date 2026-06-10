// Output-repetition degeneration detector.
//
// Complements the turn-level narration-loop guard (conversation.ts): that one
// fires when the model repeats the SAME WHOLE text-only reply across turns.
// This one catches the WITHIN-ONE-REPLY case — a model (esp. a weaker one under
// a large context) degenerating into a loop that spams the same line or cycles
// a few lines dozens of times inside a single reply. Observed in a 0.14.59
// dogfood (kimi-code) whose root-cause report committed "• …无新消息" and a
// divider dozens of times, jumbled.
//
// Pure + side-effect free. Gating/telemetry/intervention live in the caller.

import { stringWidth } from '../ink/stringWidth.js'
import {
  buildTelemetryEventEnvelope,
  type TelemetryEventEnvelope,
} from './telemetry-envelope.js'

export type OutputRepetitionKind = 'exact_line' | 'low_diversity'

export interface OutputRepetitionVerdict {
  kind: OutputRepetitionKind
  /** Human-facing reason (surfaced to the user / telemetry). */
  reason: string
  /** A representative repeated line. */
  sample: string
  /** Repeat count (exact_line) or substantive-line count (low_diversity). */
  count: number
  /** Distinct substantive lines (low_diversity only). */
  unique?: number
}

// A single substantive line repeated this many times is degenerate. A real
// reply almost never repeats a full sentence-length line ≥6×.
const MAX_LINE_REPEATS = 6
// Low-diversity (cycle) guard only engages once there's a real volume of
// substantive lines, so short replies with a couple repeats never trip it.
const MIN_DIVERSITY_LINES = 20
// …and only when at most a third of those lines are distinct.
const DIVERSITY_UNIQUE_RATIO = 1 / 3
// Minimum display width (cells) for a line to count as "substantive". Filters
// out `}`, `---`, list bullets, table separators — the legitimately-repeated
// trivia that would otherwise dominate a code/table reply.
const MIN_SUBSTANTIVE_CELLS = 8

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u

function normalizeLine(line: string): string {
  return line.replace(ANSI_RE, '').trim().replace(/\s+/g, ' ')
}

/** Substantive, non-code lines — the population repetition is measured over.
 *  Skips fenced code blocks entirely (legit code repeats `}`/imports), blank
 *  lines, short lines, and pure-symbol lines (dividers, table separators). */
function extractSubstantiveLines(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of text.split('\n')) {
    const trimmed = raw.replace(ANSI_RE, '').trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const norm = normalizeLine(raw)
    if (norm.length === 0) continue
    if (!HAS_LETTER_OR_NUMBER.test(norm)) continue
    if (stringWidth(norm) < MIN_SUBSTANTIVE_CELLS) continue
    out.push(norm)
  }
  return out
}

function truncate(s: string, n = 40): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/** Detect within-reply repetition degeneration. Returns a verdict, or null when
 *  the reply looks healthy. Pure. */
export function detectOutputRepetition(text: string): OutputRepetitionVerdict | null {
  const lines = extractSubstantiveLines(text)
  if (lines.length === 0) return null

  const counts = new Map<string, number>()
  let topLine = ''
  let topCount = 0
  for (const l of lines) {
    const c = (counts.get(l) ?? 0) + 1
    counts.set(l, c)
    if (c > topCount) { topCount = c; topLine = l }
  }

  // Signal 1 — exact line spammed past the repeat ceiling.
  if (topCount >= MAX_LINE_REPEATS) {
    return {
      kind: 'exact_line',
      reason: `output repetition loop: the line "${truncate(topLine)}" was repeated ${topCount} times in one reply`,
      sample: topLine,
      count: topCount,
    }
  }

  // Signal 2 — a wall of substantive lines with very few distinct values
  // (a short cycle repeated many times, where no single line hits Signal 1).
  if (
    lines.length >= MIN_DIVERSITY_LINES &&
    counts.size <= Math.floor(lines.length * DIVERSITY_UNIQUE_RATIO)
  ) {
    return {
      kind: 'low_diversity',
      reason: `output repetition loop: ${lines.length} substantive lines but only ${counts.size} distinct (the reply is cycling)`,
      sample: topLine,
      count: lines.length,
      unique: counts.size,
    }
  }

  return null
}

// ─── Gating + telemetry (default OFF — zero behavior change) ───────────────
//
// Two independent opt-in flags, mirroring the repo's shadow→cutover idiom:
//   OWLCODA_OUTPUT_REPETITION_SHADOW — detect + emit a telemetry envelope,
//     no behavior change (used to measure precision before enforcing).
//   OWLCODA_OUTPUT_REPETITION_GUARD  — actually intervene (soft-stop the turn).
// Neither set → the caller skips detection entirely, so the byte stream is
// identical to today.

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled'])

export function isOutputRepetitionShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_OUTPUT_REPETITION_SHADOW']
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase())
}

export function isOutputRepetitionGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_OUTPUT_REPETITION_GUARD']
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase())
}

export const OUTPUT_REPETITION_EVENT_TYPE = 'output_repetition'

/** Behavior-neutral telemetry envelope for one detected repetition. Pure. */
export function buildOutputRepetitionEvent(verdict: OutputRepetitionVerdict): TelemetryEventEnvelope {
  return buildTelemetryEventEnvelope({
    eventType: OUTPUT_REPETITION_EVENT_TYPE,
    surface: 'telemetry',
    subject: 'conversation',
    origin: 'runtime',
    severity: 'warn',
    decision: 'observe',
    reasonCode: verdict.kind,
    attributes: {
      kind: verdict.kind,
      count: verdict.count,
      ...(verdict.unique !== undefined ? { unique: verdict.unique } : {}),
      sample: verdict.sample.slice(0, 80),
    },
  })
}

export type OutputRepetitionAction =
  | { action: 'none' }
  | { action: 'shadow'; verdict: OutputRepetitionVerdict }
  | { action: 'guard'; verdict: OutputRepetitionVerdict; reason: string }

/** Pure wiring decision for the conversation loop. Returns `none` (do nothing —
 *  the default, byte-identical to today), `shadow` (record telemetry only), or
 *  `guard` (soft-stop the turn with the given reason). Detection runs ONLY when
 *  a flag is set, so the no-flag path costs nothing. */
export function decideOutputRepetition(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): OutputRepetitionAction {
  const guard = isOutputRepetitionGuardEnabled(env)
  const shadow = isOutputRepetitionShadowEnabled(env)
  if (!guard && !shadow) return { action: 'none' }
  const verdict = detectOutputRepetition(text)
  if (!verdict) return { action: 'none' }
  if (guard) {
    return {
      action: 'guard',
      verdict,
      reason: `task stuck in ${verdict.reason}. Use /retry, switch the model with /model, or send a more specific prompt.`,
    }
  }
  return { action: 'shadow', verdict }
}
