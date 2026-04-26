import { describe, it, expect, vi } from 'vitest'
import {
  widthTier,
  availabilityPhrase,
  availabilityFixHints,
  browserRouteForStatus,
  workbenchHandoffContext,
  renderBrowserHandoffHint,
  sortedStatuses,
  overviewCounts,
  renderOverview,
  renderModelRowLabel,
  renderModelRowDescription,
  renderDetails,
  renderIssuesDump,
  runModelsWorkbench,
} from '../src/native/models-workbench.js'
import type { ModelStatus, ModelTruthSnapshot } from '../src/model-truth.js'

function status(overrides: Partial<ModelStatus> & Pick<ModelStatus, 'id'>): ModelStatus {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    providerKind: overrides.providerKind ?? 'cloud',
    isDefault: overrides.isDefault ?? false,
    role: overrides.role,
    presentIn: overrides.presentIn ?? { config: true, router: true, discovered: false, catalog: false },
    availability: overrides.availability ?? { kind: 'ok' },
    raw: overrides.raw ?? {},
  }
}

function snapshot(statuses: ModelStatus[], overrides: Partial<ModelTruthSnapshot> = {}): ModelTruthSnapshot {
  const byModelId = statuses.reduce<Record<string, ModelStatus>>((acc, s) => {
    acc[s.id] = s
    return acc
  }, {})
  return {
    statuses,
    byModelId,
    refreshedAt: Date.now(),
    ttlMs: 5000,
    cacheHit: false,
    runtimeOk: true,
    runtimeSource: null,
    runtimeLocalProtocol: null,
    runtimeProbeDetail: '',
    runtimeModelCount: statuses.length,
    ...overrides,
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

describe('widthTier', () => {
  it('classifies narrow / mid / wide', () => {
    expect(widthTier(60)).toBe('narrow')
    expect(widthTier(69)).toBe('narrow')
    expect(widthTier(70)).toBe('mid')
    expect(widthTier(129)).toBe('mid')
    expect(widthTier(130)).toBe('wide')
    expect(widthTier(200)).toBe('wide')
  })
})

describe('availabilityPhrase / fixHints', () => {
  it('covers all availability kinds', () => {
    const kinds = [
      { kind: 'ok' as const },
      { kind: 'missing_key' as const },
      { kind: 'missing_key' as const, envName: 'OPENAI_API_KEY' },
      { kind: 'endpoint_down' as const, url: 'http://x', reason: 'timeout' },
      { kind: 'router_missing' as const },
      { kind: 'orphan_discovered' as const },
      { kind: 'alias_conflict' as const, with: 'kimi' },
      { kind: 'warming' as const },
      { kind: 'unknown' as const, reason: 'router unavailable' },
    ]
    for (const a of kinds) {
      expect(availabilityPhrase(a)).toBeTruthy()
      const hints = availabilityFixHints(a)
      expect(Array.isArray(hints)).toBe(true)
    }
  })

  it('surfaces envName in missing_key phrase when present', () => {
    const phrase = availabilityPhrase({ kind: 'missing_key', envName: 'KIMI_API_KEY' })
    expect(phrase).toContain('KIMI_API_KEY')
  })

  it('ok has no fix hints', () => {
    expect(availabilityFixHints({ kind: 'ok' })).toEqual([])
  })
})

describe('sortedStatuses', () => {
  it('places default first, then ok, then blocked, then orphan', () => {
    const input = [
      status({ id: 'orphan', availability: { kind: 'orphan_discovered' } }),
      status({ id: 'blocked', availability: { kind: 'missing_key' } }),
      status({ id: 'ok-b' }),
      status({ id: 'default', isDefault: true, availability: { kind: 'missing_key' } }),
      status({ id: 'ok-a' }),
    ]
    const ids = sortedStatuses(input).map(s => s.id)
    expect(ids).toEqual(['default', 'ok-a', 'ok-b', 'blocked', 'orphan'])
  })
})

describe('overviewCounts', () => {
  it('counts providerKind + availability buckets', () => {
    const counts = overviewCounts([
      status({ id: '1', providerKind: 'cloud' }),
      status({ id: '2', providerKind: 'local' }),
      status({ id: '3', providerKind: 'cloud', availability: { kind: 'missing_key' } }),
      status({ id: '4', providerKind: 'local', availability: { kind: 'orphan_discovered' } }),
    ])
    expect(counts).toEqual({ total: 4, available: 2, blocked: 1, orphan: 1, local: 2, cloud: 2 })
  })
})

describe('renderOverview', () => {
  it('shows default + counts + top issues', () => {
    const s = [
      status({ id: 'claude', providerKind: 'cloud', isDefault: true }),
      status({ id: 'kimi', providerKind: 'cloud', availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' } }),
      status({ id: 'llama', providerKind: 'local', availability: { kind: 'orphan_discovered' } }),
    ]
    const out = stripAnsi(renderOverview(snapshot(s), 'mid').join('\n'))
    expect(out).toContain('Model Workstation')
    expect(out).toContain('default')
    expect(out).toContain('claude')
    expect(out).toContain('top issues')
    expect(out).toContain('kimi')
    expect(out).toContain('missing key')
    expect(out).toContain('refreshed')
  })

  it('compresses counts line on narrow width', () => {
    const s = [status({ id: 'a' }), status({ id: 'b', availability: { kind: 'missing_key' } })]
    const narrow = renderOverview(snapshot(s), 'narrow').join('\n')
    expect(stripAnsi(narrow)).toContain('2 models · 1 ok · 1 blocked')
  })
})

describe('renderModelRowLabel', () => {
  it('stays within tier label budget (no overflow for truncation)', () => {
    const longLabel = 'A'.repeat(200)
    const narrow = stripAnsi(renderModelRowLabel(status({ id: 'x', label: longLabel }), 'narrow', 60))
    const mid = stripAnsi(renderModelRowLabel(status({ id: 'x', label: longLabel }), 'mid', 100))
    const wide = stripAnsi(renderModelRowLabel(status({ id: 'x', label: longLabel }), 'wide', 160))
    // ends with ellipsis when truncated
    expect(narrow).toMatch(/…$/)
    expect(mid).toMatch(/…$/)
    expect(wide).toMatch(/…$/)
    // visible length reasonable: status-icon + space + star-or-space + space + label budget + ellipsis
    expect(narrow.length).toBeLessThanOrEqual(34)
    expect(mid.length).toBeLessThanOrEqual(40)
    expect(wide.length).toBeLessThanOrEqual(50)
  })

  it('marks default with star', () => {
    const s = status({ id: 'x', isDefault: true })
    expect(renderModelRowLabel(s, 'mid', 100)).toContain('★')
  })

  it('no role or phrase inline — those go in description/preview', () => {
    const s = status({
      id: 'messages-vendor-3',
      label: 'Messages Vendor 3',
      role: 'balanced',
      availability: { kind: 'missing_key' },
    })
    const row = stripAnsi(renderModelRowLabel(s, 'wide', 160))
    expect(row).not.toContain('balanced')
    expect(row).not.toContain('missing API key')
    expect(row).toContain('Messages Vendor 3')
  })
})

describe('renderModelRowDescription', () => {
  it('ok models show providerKind only on narrow, with role on wider', () => {
    const ok = status({ id: 'x', providerKind: 'cloud', role: 'coding' })
    expect(stripAnsi(renderModelRowDescription(ok, 'narrow'))).toBe('cloud')
    expect(stripAnsi(renderModelRowDescription(ok, 'mid'))).toBe('cloud · coding')
  })

  it('non-ok uses short status tag, not the full phrase', () => {
    const s = status({ id: 'x', providerKind: 'local', availability: { kind: 'alias_conflict', with: 'foo' } })
    const desc = stripAnsi(renderModelRowDescription(s, 'mid'))
    expect(desc).toContain('local')
    expect(desc).toContain('alias-conflict')
    expect(desc).not.toContain('"foo"')
  })

  it('description stays under 40 visible chars (picker truncates at 40)', () => {
    const s = status({
      id: 'x',
      providerKind: 'cloud',
      role: 'heavy_synthesis_primary_interim',
      availability: { kind: 'router_missing' },
    })
    expect(stripAnsi(renderModelRowDescription(s, 'wide')).length).toBeLessThanOrEqual(40)
  })
})

describe('renderDetails', () => {
  it('includes presence map, availability phrase and fix hints for issue', () => {
    const s = status({
      id: 'kimi',
      label: 'Kimi K2',
      providerKind: 'cloud',
      availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' },
      presentIn: { config: true, router: false, discovered: false, catalog: true },
    })
    const out = stripAnsi(renderDetails(s).join('\n'))
    expect(out).toContain('Kimi K2')
    expect(out).toContain('kimi')
    expect(out).toContain('missing key')
    expect(out).toContain('KIMI_API_KEY')
    expect(out).toContain('present in')
    expect(out).toContain('config:✓')
    expect(out).toContain('visibility:–')
    expect(out).toContain('catalog:✓')
    expect(out).toContain('next steps')
    expect(out).toContain('browser')
    expect(out).toContain('owlcoda ui --route models --select kimi')
  })

  it('omits next steps when availability is ok', () => {
    const s = status({ id: 'ok', availability: { kind: 'ok' } })
    const out = stripAnsi(renderDetails(s).join('\n'))
    expect(out).not.toContain('next steps')
  })
})

describe('browser handoff helpers', () => {
  it('maps alias conflicts and orphans to browser routes', () => {
    expect(browserRouteForStatus(status({ id: 'a', availability: { kind: 'alias_conflict', with: 'b' } }))).toBe('aliases')
    expect(browserRouteForStatus(status({ id: 'o', availability: { kind: 'orphan_discovered' } }))).toBe('orphans')
    expect(browserRouteForStatus(status({ id: 'm', availability: { kind: 'missing_key' } }))).toBe('models')
  })

  it('builds workbench handoff context for mode and selected model', () => {
    const issue = status({ id: 'kimi', availability: { kind: 'missing_key' } })
    expect(workbenchHandoffContext('issues', issue)).toEqual({ route: 'models', select: 'kimi', view: 'issues' })
    expect(workbenchHandoffContext('overview')).toEqual({ route: 'models', view: 'overview' })
  })

  it('renders a CLI browser handoff hint', () => {
    expect(renderBrowserHandoffHint({ route: 'catalog' })).toBe('owlcoda ui --route catalog')
    expect(renderBrowserHandoffHint({ route: 'models', select: 'claude', view: 'issues' })).toBe(
      'owlcoda ui --route models --select claude --view issues',
    )
  })
})

describe('renderIssuesDump', () => {
  it('lists only non-ok, marks default-blocker', () => {
    const s = [
      status({ id: 'ok-model' }),
      status({ id: 'blocker', isDefault: true, availability: { kind: 'missing_key' } }),
      status({ id: 'other', availability: { kind: 'endpoint_down', url: 'http://x', reason: 'timeout' } }),
    ]
    const out = stripAnsi(renderIssuesDump(snapshot(s), 'mid').join('\n'))
    expect(out).toContain('Model Issues')
    expect(out).toContain('blocker')
    expect(out).toContain('blocks default')
    expect(out).toContain('other')
    expect(out).not.toContain('ok-model')
  })

  it('shows all-clear state when no issues', () => {
    const out = stripAnsi(renderIssuesDump(snapshot([status({ id: 'a' })]), 'mid').join('\n'))
    expect(out).toContain('no issues')
  })
})

describe('runModelsWorkbench handoff behavior', () => {
  it('opens browser handoff for selected model rows', async () => {
    const s = snapshot([
      status({ id: 'messages-vendor', label: 'Messages Vendor', isDefault: true }),
      status({ id: 'kimi', label: 'Kimi', availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' } }),
    ])
    const onBrowserHandoff = vi.fn()

    await runModelsWorkbench({
      aggregator: { getSnapshot: async () => s } as any,
      picker: async ({ items }) => ({
        item: items.find(item => item.value.kind === 'inspect' && item.value.status.id === 'kimi') ?? null,
        cancelled: false,
      }),
      onBrowserHandoff,
      stream: { write() { return true }, columns: 120 } as any,
    })

    expect(onBrowserHandoff).toHaveBeenCalledWith({
      context: { route: 'models', select: 'kimi', view: undefined },
      explicitOpen: true,
    })
  })

  it('opens browser handoff for overview selection', async () => {
    const s = snapshot([status({ id: 'messages-vendor', label: 'Messages Vendor', isDefault: true })])
    const onBrowserHandoff = vi.fn()

    await runModelsWorkbench({
      aggregator: { getSnapshot: async () => s } as any,
      picker: async ({ items }) => ({
        item: items.find(item => item.value.kind === 'overview') ?? null,
        cancelled: false,
      }),
      onBrowserHandoff,
      stream: { write() { return true }, columns: 120 } as any,
    })

    expect(onBrowserHandoff).toHaveBeenCalledWith({
      context: { route: 'models', view: 'overview' },
      explicitOpen: true,
    })
  })
})
