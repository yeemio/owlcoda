/**
 * Readout for the model_routing_shadow ledger — the first reader over the
 * unified telemetry envelope sink (events-*.jsonl), parallel to
 * fidelity-telemetry-summary.ts which reads the gate-events ledger.
 *
 * A shadow with no readout is the exact "expensive 80%, missing cheap 20%"
 * anti-pattern: criteria get quantified but the distribution is never read back,
 * so the flag stays opt-in forever. This tallies the accumulated difficulty
 * distribution and the "would route differently" share so the decision to
 * enforce difficulty routing can be made from data, not a self-report.
 */
import type { TelemetryEventEnvelope } from './telemetry-envelope.js'
import type { TurnDifficulty } from '../difficulty-router.js'
import { readEnvelopeEvents } from './envelope-ledger.js'

const ROUTING_SHADOW_EVENT_TYPE = 'model_routing_shadow'

export interface RoutingShadowSummary {
  total: number
  byDifficulty: Record<TurnDifficulty, number>
  wouldDiffer: number
  /** simple / total (0 when total is 0). */
  simpleShare: number
  /** wouldDiffer / total (0 when total is 0). */
  wouldDifferShare: number
  filesRead: string[]
}

export interface RoutingShadowSummaryOptions {
  home?: string
  maxFiles?: number
}

function emptyByDifficulty(): Record<TurnDifficulty, number> {
  return { simple: 0, moderate: 0, hard: 0 }
}

/** Pure tally over already-parsed envelopes. Ignores non-routing event types. */
export function summarizeRoutingShadow(
  events: readonly TelemetryEventEnvelope[],
): RoutingShadowSummary {
  const byDifficulty = emptyByDifficulty()
  let total = 0
  let wouldDiffer = 0
  for (const e of events) {
    if (e.eventType !== ROUTING_SHADOW_EVENT_TYPE) continue
    const attrs = (e.attributes ?? {}) as { difficulty?: unknown; wouldDiffer?: unknown }
    const difficulty = attrs.difficulty
    if (difficulty !== 'simple' && difficulty !== 'moderate' && difficulty !== 'hard') continue
    total++
    byDifficulty[difficulty]++
    if (attrs.wouldDiffer === true) wouldDiffer++
  }
  return {
    total,
    byDifficulty,
    wouldDiffer,
    simpleShare: total > 0 ? byDifficulty.simple / total : 0,
    wouldDifferShare: total > 0 ? wouldDiffer / total : 0,
    filesRead: [],
  }
}

/** Read model_routing_shadow events from the unified envelope ledger and tally. */
export function buildRoutingShadowSummary(
  options: RoutingShadowSummaryOptions = {},
): RoutingShadowSummary {
  const { events, filesRead } = readEnvelopeEvents(options)
  return { ...summarizeRoutingShadow(events), filesRead }
}
