import type { ModelAvailability } from '../api/types'
import { availabilityTone } from '../lib/availability'

const GLYPH: Record<ModelAvailability['kind'], string> = {
  ok: '●',
  missing_key: '⚠',
  endpoint_down: '✕',
  router_missing: '⚠',
  orphan_discovered: '○',
  alias_conflict: '✕',
  warming: '◐',
  unknown: '?',
}

export function StatusIcon({ availability }: { availability: ModelAvailability }) {
  const tone = availabilityTone(availability)
  return <span className={`tone-${tone}`} aria-hidden>{GLYPH[availability.kind]}</span>
}
