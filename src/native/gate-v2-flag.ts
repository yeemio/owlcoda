/**
 * Internal dogfood flag for the event-derived progress gates.
 *
 * Default-off. No release artifact should set this until the Slice 3 cutover.
 */
const TRUTHY = new Set(['1', 'true', 'yes'])

export function isGateV2Enabled(): boolean {
  const raw = process.env['OWLCODA_GATE_V2']
  if (typeof raw !== 'string') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}
