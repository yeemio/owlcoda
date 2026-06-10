/**
 * Gate lifecycle registry + flag-debt detection (ADR-025 P2).
 *
 * Flag debt — a toggle left on opt-in long past its review window — is a named
 * industry anti-pattern (OSS studies find ~75% of toggles linger <=49 weeks).
 * owlcoda's cutover criteria are quantified (S4 readout) but nothing forces a
 * decision, so a gate can sit in shadow forever. This registry pairs each opt-in
 * gate with a review-by date; the `owlcoda doctor` flag-debt section turns an
 * overdue gate into a visible "decide: cutover or kill" warning.
 *
 * A shipped default with a kill-switch escape hatch (e.g. OWLCODA_MODES=0) is
 * NOT debt: those gates are stage 'default' and are never flagged. The escape
 * hatch is permanent by design.
 */

export type GateLifecycleStage = 'shadow' | 'canary' | 'default' | 'retired'

export interface GateRegistryEntry {
  id: string
  envVar: string
  stage: GateLifecycleStage
  /** ISO date the gate was introduced (best-effort from the commit timeline). */
  openedDate: string
  /** ISO date by which a cutover-or-kill decision is owed. */
  reviewBy: string
}

export interface FlagDebtEntry {
  id: string
  envVar: string
  stage: GateLifecycleStage
  reviewBy: string
  overdueDays: number
}

const MS_PER_DAY = 86_400_000

/**
 * Opt-in gates that ship behind an env flag and owe a cutover-or-kill decision.
 * Dates are best-effort from the commit timeline; the maintainer adjusts them
 * when a decision slips or a gate advances a stage.
 */
export const GATE_REGISTRY: readonly GateRegistryEntry[] = [
  { id: 'modes', envVar: 'OWLCODA_MODES', stage: 'default', openedDate: '2026-04-18', reviewBy: '2026-05-02' },
  { id: 'gate_v2', envVar: 'OWLCODA_GATE_V2', stage: 'shadow', openedDate: '2026-05-05', reviewBy: '2026-05-25' },
  { id: 'provenance', envVar: 'OWLCODA_GATE_PROVENANCE', stage: 'shadow', openedDate: '2026-05-27', reviewBy: '2026-06-10' },
  { id: 'routing_shadow', envVar: 'OWLCODA_ROUTING_SHADOW', stage: 'shadow', openedDate: '2026-06-06', reviewBy: '2026-06-20' },
  { id: 'output_repetition', envVar: 'OWLCODA_OUTPUT_REPETITION_GUARD', stage: 'shadow', openedDate: '2026-06-08', reviewBy: '2026-06-22' },
]

/**
 * Opt-in gates (stage shadow/canary) whose reviewBy date has passed. Settled
 * gates (default/retired) are never debt. Pure — the caller injects `nowMs`
 * (Date.now() in production) so the decision is deterministic in tests.
 */
export function findFlagDebt(
  registry: readonly GateRegistryEntry[],
  nowMs: number,
): FlagDebtEntry[] {
  const out: FlagDebtEntry[] = []
  for (const e of registry) {
    if (e.stage === 'default' || e.stage === 'retired') continue
    const reviewMs = Date.parse(e.reviewBy)
    if (Number.isNaN(reviewMs)) continue
    if (nowMs > reviewMs) {
      out.push({
        id: e.id,
        envVar: e.envVar,
        stage: e.stage,
        reviewBy: e.reviewBy,
        overdueDays: Math.floor((nowMs - reviewMs) / MS_PER_DAY),
      })
    }
  }
  return out
}
