/**
 * Unified readout for the opt-in shadow levers that write to the envelope ledger
 * (events-*.jsonl): difficulty-routing (S11) and microcompact (S5). Complements
 * cutover-status (which reads the gate-events ledger). Both shadows are default
 * OFF, so this is the command you run after enabling a flag to see what the
 * shadow has measured — turning write-only telemetry into a decision the user
 * can read.
 */
import { buildRoutingShadowSummary, type RoutingShadowSummary } from './routing-shadow-summary.js'
import { buildMicrocompactShadowSummary, type MicrocompactShadowSummary } from './microcompact.js'

export interface ShadowStatus {
  routing: RoutingShadowSummary
  microcompact: MicrocompactShadowSummary
}

export function buildShadowStatus(options: { home?: string; maxFiles?: number } = {}): ShadowStatus {
  return {
    routing: buildRoutingShadowSummary(options),
    microcompact: buildMicrocompactShadowSummary(options),
  }
}

export function formatShadowStatus(status: ShadowStatus): string {
  const r = status.routing
  const m = status.microcompact
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  const lines = [
    `Routing shadow (OWLCODA_ROUTING_SHADOW): ${r.total} samples`,
    `  difficulty: simple ${r.byDifficulty.simple} (${pct(r.simpleShare)}) · moderate ${r.byDifficulty.moderate} · hard ${r.byDifficulty.hard}`,
    `  would-differ: ${r.wouldDiffer} (${pct(r.wouldDifferShare)})`,
    `Microcompact shadow (OWLCODA_MICROCOMPACT_SHADOW): ${m.samples} samples`,
    `  strippable: ${m.totalStrippableTokens} tokens total · ${m.avgStrippableTokens} avg/compaction · ${m.totalSupersededReads} superseded reads`,
  ]
  if (r.total === 0 && m.samples === 0) {
    lines.push('(both shadows are opt-in and default OFF — enable the flags above to collect data)')
  }
  return lines.join('\n')
}
