import type { ModelStatus, ModelTruthSnapshot } from '../src/api/types'

export function mkStatus(partial: Partial<ModelStatus> & Pick<ModelStatus, 'id'>): ModelStatus {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    providerKind: partial.providerKind ?? 'cloud',
    isDefault: partial.isDefault ?? false,
    role: partial.role,
    presentIn: partial.presentIn ?? { config: true, router: true, discovered: false, catalog: false },
    availability: partial.availability ?? { kind: 'ok' },
    raw: partial.raw ?? {},
  }
}

export function mkSnapshot(statuses: ModelStatus[]): ModelTruthSnapshot {
  const byModelId = statuses.reduce<Record<string, ModelStatus>>((acc, s) => {
    acc[s.id] = s
    return acc
  }, {})
  return {
    refreshedAt: Date.now(),
    ttlMs: 5000,
    cacheHit: false,
    runtimeOk: true,
    runtimeSource: null,
    runtimeLocalProtocol: null,
    runtimeProbeDetail: '',
    runtimeModelCount: statuses.length,
    statuses,
    byModelId,
  }
}
