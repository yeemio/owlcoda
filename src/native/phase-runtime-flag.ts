/**
 * Internal phase-aware runtime flag.
 *
 * This is intentionally separate from OWLCODA_GATE_V2 while the phase runtime
 * is dogfooded. Default behavior remains unchanged unless explicitly enabled.
 */

export function isPhaseRuntimeEnabled(): boolean {
  const raw = process.env['OWLCODA_PHASE_RUNTIME']
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
