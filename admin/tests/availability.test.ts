import { describe, expect, it } from 'vitest'
import {
  availabilityFixHints,
  availabilityPhrase,
  availabilityShortTag,
  availabilityTone,
  filterIssues,
  overviewCounts,
  sortStatuses,
} from '../src/lib/availability'
import type { ModelAvailability } from '../src/api/types'
import { mkStatus } from './fixtures'

describe('availability display', () => {
  const kinds: ModelAvailability[] = [
    { kind: 'ok' },
    { kind: 'missing_key' },
    { kind: 'missing_key', envName: 'KIMI_API_KEY' },
    { kind: 'endpoint_down', url: 'http://x', reason: 'timeout' },
    { kind: 'router_missing' },
    { kind: 'orphan_discovered' },
    { kind: 'alias_conflict', with: 'kimi' },
    { kind: 'warming' },
    { kind: 'unknown', reason: 'router unavailable' },
  ]

  it('maps every kind to a non-empty phrase + short tag + tone', () => {
    for (const a of kinds) {
      expect(availabilityPhrase(a)).toBeTruthy()
      expect(availabilityShortTag(a)).toBeTruthy()
      expect(availabilityTone(a)).toMatch(/ok|warn|err|info|muted/)
    }
  })

  it('surfaces envName in missing_key phrase', () => {
    expect(availabilityPhrase({ kind: 'missing_key', envName: 'X_KEY' })).toContain('X_KEY')
  })

  it('ok has no fix hints; non-ok have at least one', () => {
    expect(availabilityFixHints({ kind: 'ok' })).toEqual([])
    expect(availabilityFixHints({ kind: 'missing_key' }).length).toBeGreaterThan(0)
    expect(availabilityFixHints({ kind: 'alias_conflict', with: 'kimi' })[0]).toContain('kimi')
  })

  it('renders platform visibility gate messaging for router_missing when the contract is known', () => {
    const availability: ModelAvailability = {
      kind: 'router_missing',
      reason: 'Not visible in owlmlx /v1/openai/models yet; runtime visibility gate blocked (base_model_config_missing)',
      visibilityRule: 'runtime_gate_required_before_visible',
      blockReason: 'base_model_config_missing',
      truthSurface: '/v1/openai/models',
      diagnosticSurface: '/v1/runtime/model-visibility',
      loadedInventorySurface: '/v1/models',
    }
    expect(availabilityPhrase(availability)).toContain('/v1/openai/models')
    expect(availabilityShortTag(availability)).toBe('owlmlx-gate')
    expect(availabilityFixHints(availability)[0]).toContain('base_model_config_missing')
  })
})

describe('sortStatuses', () => {
  it('places default first, then ok, then blocked, then orphan', () => {
    const ordered = sortStatuses([
      mkStatus({ id: 'orphan', availability: { kind: 'orphan_discovered' } }),
      mkStatus({ id: 'blocked', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'okB' }),
      mkStatus({ id: 'default', isDefault: true, availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'okA' }),
    ]).map(s => s.id)
    expect(ordered).toEqual(['default', 'okA', 'okB', 'blocked', 'orphan'])
  })
})

describe('filterIssues / overviewCounts', () => {
  it('filterIssues excludes ok only', () => {
    const res = filterIssues([
      mkStatus({ id: 'a' }),
      mkStatus({ id: 'b', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'c', availability: { kind: 'orphan_discovered' } }),
    ])
    expect(res.map(s => s.id)).toEqual(['b', 'c'])
  })

  it('overviewCounts buckets blocked vs orphan vs ok and local/cloud', () => {
    const c = overviewCounts([
      mkStatus({ id: '1', providerKind: 'cloud' }),
      mkStatus({ id: '2', providerKind: 'local' }),
      mkStatus({ id: '3', providerKind: 'cloud', availability: { kind: 'missing_key' } }),
      mkStatus({ id: '4', providerKind: 'local', availability: { kind: 'orphan_discovered' } }),
    ])
    expect(c).toEqual({ total: 4, ok: 2, blocked: 1, orphan: 1, local: 2, cloud: 2 })
  })
})
