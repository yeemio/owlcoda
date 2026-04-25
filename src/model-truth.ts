/**
 * Model truth aggregator — merges config + runtime + discovery + catalog.
 * This is the Phase A read-side source of truth.
 */

import type { OwlCodaConfig, ConfiguredModel } from './config.js'
import { listConfiguredModels } from './config.js'
import { probeRuntimeSurface, type PlatformVisibilityInfo, type RuntimeProbeResult } from './runtime-probe.js'
import type { DiscoveredModel, DiscoveryResult, BackendConfig } from './backends/types.js'
import { discoverBackends } from './backends/discovery.js'
import { loadCatalog, type PlatformCatalog } from './models/catalog.js'

export type AvailabilityKind =
  | 'ok'
  | 'missing_key'
  | 'endpoint_down'
  | 'router_missing'
  | 'orphan_discovered'
  | 'alias_conflict'
  | 'warming'
  | 'unknown'

export type ModelAvailability =
  | { kind: 'ok' }
  | { kind: 'missing_key'; envName?: string }
  | { kind: 'endpoint_down'; url: string; reason: string }
  | {
      kind: 'router_missing'
      reason?: string
      visibilityRule?: string
      gateStatus?: string
      blockReason?: string
      truthSurface?: string
      diagnosticSurface?: string
      loadedInventorySurface?: string
      deprecatedFallback?: boolean
    }
  | { kind: 'orphan_discovered' }
  | { kind: 'alias_conflict'; with: string }
  | { kind: 'warming' }
  | { kind: 'unknown'; reason: string }

export interface ModelStatus {
  id: string
  label: string
  providerKind: 'local' | 'cloud' | 'unknown'
  isDefault: boolean
  role?: string
  presentIn: {
    config: boolean
    router: boolean
    discovered: boolean
    catalog: boolean
  }
  availability: ModelAvailability
  raw: {
    config?: ConfiguredModel
    discovered?: DiscoveredModel
    catalogEntry?: PlatformCatalog['models'][number]
    routerEntry?: string[]
  }
}

export interface ModelTruthState {
  refreshedAt: number
  ttlMs: number
  cacheHit: boolean
}

export interface ModelTruthSnapshot extends ModelTruthState {
  statuses: ModelStatus[]
  byModelId: Record<string, ModelStatus>
  runtimeOk: boolean
  runtimeSource: RuntimeProbeResult['source'] | null
  runtimeLocalProtocol: RuntimeProbeResult['localRuntimeProtocol'] | null
  runtimeProbeDetail: string
  runtimeModelCount: number
  platformVisibility?: PlatformVisibilityInfo | null
}

export interface ModelTruthDeps {
  getConfig: () => OwlCodaConfig
  probeRuntimeSurface: (routerUrl: string, timeoutMs: number) => Promise<RuntimeProbeResult>
  discoverBackends: (configs?: BackendConfig[], timeoutMs?: number) => Promise<DiscoveryResult>
  loadCatalog: () => PlatformCatalog | null
  now: () => number
}

export interface ModelTruthOptions {
  ttlMs?: number
  routerProbeTimeoutMs?: number
  discoveryTimeoutMs?: number
  deps?: Partial<ModelTruthDeps>
}

interface SeedModel {
  id: string
  label: string
  aliases: string[]
  role?: string
  isDefault: boolean
  endpoint?: string
  apiKey?: string
  apiKeyEnv?: string
  backendModel: string
  config?: ConfiguredModel
  discovered?: DiscoveredModel
  catalogEntry?: PlatformCatalog['models'][number]
}

interface CacheEntry {
  state: ModelTruthState
  snapshot: Omit<ModelTruthSnapshot, keyof ModelTruthState>
}

function defaultDeps(): ModelTruthDeps {
  return {
    getConfig: () => {
      throw new Error('model truth aggregator requires a config provider')
    },
    probeRuntimeSurface: (routerUrl, timeoutMs) => probeRuntimeSurface(routerUrl, timeoutMs),
    discoverBackends: (configs, timeoutMs) => discoverBackends(configs, timeoutMs),
    loadCatalog: () => loadCatalog(),
    now: () => Date.now(),
  }
}

export class ModelTruthAggregator {
  private readonly deps: ModelTruthDeps
  private readonly ttlMs: number
  private readonly routerProbeTimeoutMs: number
  private readonly discoveryTimeoutMs: number
  private cache: CacheEntry | null = null

  constructor(configProvider: () => OwlCodaConfig, options: ModelTruthOptions = {}) {
    const mergedDeps = defaultDeps()
    this.deps = {
      ...mergedDeps,
      ...options.deps,
      getConfig: configProvider,
    }
    this.ttlMs = options.ttlMs ?? 5_000
    this.routerProbeTimeoutMs = options.routerProbeTimeoutMs ?? 5_000
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 5_000
  }

  invalidate(): void {
    this.cache = null
  }

  getStatusByModelId(modelId: string): ModelStatus | undefined {
    return this.cache?.snapshot.byModelId[modelId]
  }

  async getSnapshot(options: { skipCache?: boolean } = {}): Promise<ModelTruthSnapshot> {
    const now = this.deps.now()
    const cached = this.cache
    const isFresh = !!cached && now - cached.state.refreshedAt < cached.state.ttlMs
    if (!options.skipCache && isFresh) {
      return {
        ...cached.snapshot,
        cacheHit: true,
        refreshedAt: cached.state.refreshedAt,
        ttlMs: cached.state.ttlMs,
      }
    }

    const snapshot = await this.buildSnapshot()
    const state: ModelTruthState = {
      refreshedAt: now,
      ttlMs: this.ttlMs,
      cacheHit: false,
    }
    this.cache = {
      state,
      snapshot: {
        ...snapshot,
      },
    }
    return {
      ...snapshot,
      cacheHit: false,
      refreshedAt: state.refreshedAt,
      ttlMs: state.ttlMs,
    }
  }

  private async buildSnapshot(): Promise<Omit<ModelTruthSnapshot, keyof ModelTruthState>> {
    const config = this.deps.getConfig()
    const configuredModels = listConfiguredModels(config)
    const exposeCatalogOnlyRows = configuredModels.length === 0

    const [runtimeResult, discoveryResult, catalog] = await Promise.all([
      this.deps.probeRuntimeSurface(config.routerUrl, this.routerProbeTimeoutMs),
      this.deps.discoverBackends(config.backends, this.discoveryTimeoutMs),
      Promise.resolve(this.deps.loadCatalog()),
    ])

    const routerModelIds = new Set(runtimeResult.modelIds)
    const discoveredModels = discoveryResult.models
    const catalogModels = buildCatalogModelsMap(catalog)
    const entries = new Map<string, SeedModel>()

    // config entries first (highest precedence)
    for (const model of configuredModels) {
      const seeded = entries.get(model.id)
      if (seeded) {
        seeded.config = model
        seeded.endpoint = seeded.endpoint ?? model.endpoint
      } else {
        entries.set(model.id, {
          id: model.id,
          label: model.label,
          aliases: model.aliases ?? [],
          role: model.role,
          isDefault: model.default === true,
          endpoint: model.endpoint,
          apiKey: model.apiKey,
          apiKeyEnv: model.apiKeyEnv,
          backendModel: model.backendModel,
          config: model,
        })
      }
    }

    // discovered models supplement config
    for (const discovered of discoveredModels) {
      const seeded = findSeedModelForDiscovered(entries, discovered.id)
      if (seeded) {
        seeded.discovered = discovered
      } else {
        entries.set(discovered.id, {
          id: discovered.id,
          label: discovered.id,
          aliases: [],
          isDefault: false,
          backendModel: discovered.id,
          discovered,
        })
      }
    }

    // Catalog metadata enriches configured and discovered entries.
    // Only add catalog-only rows when OwlCoda has no explicit configured models;
    // otherwise the workbench turns into a stale aspiration list instead of the
    // current runtime surface the user actually maintains.
    for (const [id, catalogEntry] of catalogModels.entries()) {
      const aliases = catalogAliasesForModel(id, catalog?.aliases ?? {})
      const seeded = entries.get(id)
      if (seeded) {
        seeded.catalogEntry = catalogEntry
        for (const alias of aliases) {
          if (!seeded.aliases.includes(alias)) seeded.aliases.push(alias)
        }
        if (!seeded.role && catalogEntry.priority_role) seeded.role = catalogEntry.priority_role
      } else if (exposeCatalogOnlyRows) {
        entries.set(id, {
          id,
          label: catalogEntry.id,
          aliases,
          isDefault: catalog?.default_model === id,
          backendModel: catalogEntry.backend,
          catalogEntry,
          role: catalogEntry.priority_role,
          endpoint: undefined,
        })
      }
    }

    // default model in legacy form.
    if (!hasDefaultModel(entries)) {
      const legacyDefault = config.defaultModel
      if (legacyDefault && entries.has(legacyDefault)) {
        const defaultEntry = entries.get(legacyDefault)
        if (defaultEntry) defaultEntry.isDefault = true
      }
    }

    const aliasConflicts = detectAliasConflicts(entries)
    const statuses: ModelStatus[] = []

    for (const status of entries.values()) {
      const presentIn = {
        config: Boolean(status.config),
        discovered: Boolean(status.discovered),
        catalog: Boolean(status.catalogEntry),
        router: isInRouter(status, routerModelIds),
      }

      const availability = resolveAvailability(status, presentIn.router, runtimeResult, aliasConflicts)
      const providerKind = resolveProviderKind(status.endpoint, presentIn.config ? status.config?.backendModel : status.backendModel)

      statuses.push({
        id: status.id,
        label: status.label || status.id,
        providerKind,
        isDefault: status.isDefault,
        role: status.role,
        presentIn,
        availability,
        raw: {
          config: status.config,
          discovered: status.discovered,
          catalogEntry: status.catalogEntry,
          routerEntry: runtimeResult.ok ? runtimeResult.modelIds : [],
        },
      })
    }

    const byModelId = statuses.reduce<Record<string, ModelStatus>>((acc, status) => {
      acc[status.id] = status
      return acc
    }, {})

    return {
      statuses,
      byModelId,
      runtimeOk: runtimeResult.ok,
      runtimeSource: runtimeResult.source ?? null,
      runtimeLocalProtocol: runtimeResult.localRuntimeProtocol ?? null,
      runtimeProbeDetail: runtimeResult.detail ?? '',
      runtimeModelCount: typeof runtimeResult.modelCount === 'number' ? runtimeResult.modelCount : runtimeResult.modelIds.length,
      platformVisibility: runtimeResult.platformVisibility ?? null,
    }
  }
}

function findSeedModelForDiscovered(entries: Map<string, SeedModel>, discoveredId: string): SeedModel | undefined {
  const direct = entries.get(discoveredId)
  if (direct) return direct

  for (const seeded of entries.values()) {
    if (seeded.backendModel === discoveredId) return seeded
  }

  return undefined
}

function resolveAvailability(
  model: SeedModel,
  inRouter: boolean,
  runtime: RuntimeProbeResult,
  aliasConflicts: Record<string, string>,
): ModelAvailability {
  if (model.endpoint) {
    if (!model.apiKey) {
      return model.apiKeyEnv ? { kind: 'missing_key', envName: model.apiKeyEnv } : { kind: 'missing_key' }
    }
    return { kind: 'ok' }
  }

  if (aliasConflicts[model.id]) {
    return { kind: 'alias_conflict', with: aliasConflicts[model.id]! }
  }

  if (!runtime.ok) {
    return { kind: 'unknown', reason: 'local runtime unavailable' }
  }

  if (!inRouter) {
    if (model.discovered && !model.config) {
      return { kind: 'orphan_discovered' }
    }
    if (model.config) {
      if (runtime.source === 'loaded_inventory_only') {
        const truthSurface = runtime.platformVisibility?.formalSurfaceEndpoint ?? '/v1/openai/models'
        return {
          kind: 'unknown',
          reason: `Loaded inventory is reachable, but formal visibility surface ${truthSurface} is unavailable`,
        }
      }

      const platformVisibility = runtime.platformVisibility
      const visibilityRule = platformVisibility?.rule ?? undefined
      const gateStatus = platformVisibility?.gateStatus ?? undefined
      if (platformVisibility?.source === 'owlmlx_runtime_model_visibility') {
        const visibilityEntry = findVisibilityEntry(platformVisibility, model)
        const blockReason = visibilityEntry?.blockReason ?? undefined
        const truthSurface = platformVisibility.formalSurfaceEndpoint ?? '/v1/openai/models'
        const diagnosticSurface = platformVisibility.diagnosticSurfaceEndpoint ?? '/v1/runtime/model-visibility'
        const loadedInventorySurface = platformVisibility.loadedInventoryEndpoint ?? '/v1/models'
        let reason = `Not visible in owlmlx ${truthSurface} yet; waiting for runtime visibility gate`
        if (blockReason) {
          reason = `Not visible in owlmlx ${truthSurface} yet; runtime visibility gate blocked (${blockReason})`
        } else if (!visibilityEntry) {
          reason = `Not registered in owlmlx runtime visibility contract (${truthSurface})`
        }
        return {
          kind: 'router_missing',
          reason,
          visibilityRule,
          blockReason,
          truthSurface,
          diagnosticSurface,
          loadedInventorySurface,
        }
      }
      if (platformVisibility?.source === 'legacy_router_platform_model_visibility') {
        const truthSurface = platformVisibility.formalSurfaceEndpoint ?? '/v1/models'
        const diagnosticSurface = platformVisibility.diagnosticSurfaceEndpoint ?? '/v1/platform/model-visibility'
        if (gateStatus && gateStatus !== 'ready') {
          return {
            kind: 'router_missing',
            reason: `Deprecated router fallback gate unavailable (${gateStatus})`,
            visibilityRule,
            gateStatus,
            truthSurface,
            diagnosticSurface,
            deprecatedFallback: true,
          }
        }
        return {
          kind: 'router_missing',
          reason: 'Not visible on deprecated router fallback yet; waiting for platform visibility gate',
          visibilityRule,
          gateStatus,
          truthSurface,
          diagnosticSurface,
          deprecatedFallback: true,
        }
      }
      if (runtime.source === 'runtime_status') {
        return {
          kind: 'unknown',
          reason: 'Runtime status is reachable, but no formal visibility surface is available',
        }
      }
      if (runtime.source === 'healthz') {
        return {
          kind: 'unknown',
          reason: 'Runtime liveness is reachable, but no visibility surface is available',
        }
      }
      return {
        kind: 'router_missing',
        reason: 'Not visible in the runtime visibility list',
      }
    }
    return { kind: 'unknown', reason: 'not present in config or runtime visibility' }
  }

  return { kind: 'ok' }
}

function findVisibilityEntry(platformVisibility: PlatformVisibilityInfo, model: SeedModel): PlatformVisibilityInfo['entriesByModelId'][string] | undefined {
  return platformVisibility.entriesByModelId[model.backendModel]
    ?? platformVisibility.entriesByModelId[model.id]
}

function isInRouter(model: SeedModel, routerIds: Set<string>): boolean {
  const allAliases = new Set(model.aliases)
  if (model.config?.id) allAliases.add(model.config.id)
  if (model.backendModel) allAliases.add(model.backendModel)

  if (routerIds.has(model.id)) return true
  if (routerIds.has(model.backendModel)) return true

  for (const alias of allAliases) {
    if (routerIds.has(alias)) return true
    for (const routerId of routerIds) {
      if (routerId.startsWith(`${alias}-`)) return true
    }
  }
  return false
}

function hasDefaultModel(entries: Map<string, SeedModel>): boolean {
  for (const entry of entries.values()) {
    if (entry.isDefault) return true
  }
  return false
}

function resolveProviderKind(endpoint: string | undefined, backendModel: string | undefined): 'local' | 'cloud' | 'unknown' {
  if (endpoint) return 'cloud'
  if (backendModel) return 'local'
  return 'unknown'
}

type CatalogModelRecord = PlatformCatalog['models'][number]

function buildCatalogModelsMap(catalog: PlatformCatalog | null): Map<string, CatalogModelRecord> {
  const map = new Map<string, CatalogModelRecord>()
  if (!catalog?.models) return map

  for (const model of catalog.models) {
    map.set(model.id, model)
  }
  return map
}

function catalogAliasesForModel(modelId: string, aliasesRecord: PlatformCatalog['aliases']): string[] {
  const aliases: string[] = []
  for (const [alias, def] of Object.entries(aliasesRecord ?? {})) {
    if (def?.target === modelId) aliases.push(alias)
  }
  return aliases
}

function detectAliasConflicts(entries: Map<string, SeedModel>): Record<string, string> {
  const owner = new Map<string, string>()
  const conflicts = new Map<string, string>()

  for (const model of entries.values()) {
    const keys = new Set<string>([...model.aliases])
    keys.add(model.id)
    if (model.backendModel) keys.add(model.backendModel)

    for (const alias of keys) {
      const existing = owner.get(alias)
      if (!existing) {
        owner.set(alias, model.id)
        continue
      }
      if (existing !== model.id) {
        conflicts.set(existing, alias)
        conflicts.set(model.id, alias)
      }
    }
  }

  return Object.fromEntries(conflicts.entries())
}
