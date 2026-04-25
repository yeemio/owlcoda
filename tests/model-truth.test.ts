import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OwlCodaConfig, ConfiguredModel } from '../src/config.js'
import type { PlatformCatalog } from '../src/models/catalog.js'
import type { DiscoveryResult } from '../src/backends/types.js'
import { ModelTruthAggregator } from '../src/model-truth.js'

function makeModel(overrides: Partial<ConfiguredModel>): ConfiguredModel {
  return {
    id: 'model-id',
    label: 'Model',
    backendModel: 'model-id',
    aliases: [],
    tier: 'general',
    default: false,
    contextWindow: 32768,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<OwlCodaConfig> = {}): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    localRuntimeProtocol: 'auto',
    routerTimeoutMs: 5000,
    models: [],
    responseModelStyle: 'platform',
    logLevel: 'error',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}

describe('ModelTruthAggregator', () => {
  let now: number
  let config: OwlCodaConfig
  let probeCalls: number
  let discoverCalls: number
  let catalogCalls: number

  beforeEach(() => {
    now = 1_000
    probeCalls = 0
    discoverCalls = 0
    catalogCalls = 0
  })

  function createAggregator(configFactory: () => OwlCodaConfig, deps: {
    probeRuntime?: () => { ok: boolean, modelIds: string[], loadedModelIds?: string[], source?: string },
    discover?: () => DiscoveryResult,
    catalog?: () => PlatformCatalog | null,
  } = {}) {
    const probeRuntime = deps.probeRuntime ?? (() => ({ ok: true, modelIds: [] }))
    const discover = deps.discover ?? (() => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }))
    const catalog = deps.catalog ?? (() => null)

    return new ModelTruthAggregator(configFactory, {
      ttlMs: 5_000,
      deps: {
        getConfig: configFactory,
        now: () => now,
        probeRuntimeSurface: async () => {
          probeCalls += 1
          const result = probeRuntime()
          return {
            ok: result.ok,
            source: (result.source ?? 'none') as 'openai_models' | 'models' | 'deprecated_router_models' | 'loaded_inventory_only' | 'runtime_status' | 'healthz' | 'none',
            detail: '',
            modelIds: result.modelIds,
            loadedModelIds: result.loadedModelIds ?? [],
            modelCount: result.modelIds.length,
            loadedModelCount: (result.loadedModelIds ?? []).length,
          }
        },
        discoverBackends: async () => {
          discoverCalls += 1
          return discover()
        },
        loadCatalog: () => {
          catalogCalls += 1
          return catalog()
        },
      },
    })
  }

  it('caches snapshots within ttl', async () => {
    config = makeConfig({
      models: [makeModel({ id: 'configured-local' })],
    })

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['configured-local'] }),
      discover: () => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }),
    })

    const first = await agg.getSnapshot()
    expect(first.cacheHit).toBe(false)
    expect(first.statuses).toHaveLength(1)
    expect(probeCalls).toBe(1)
    expect(discoverCalls).toBe(1)
    expect(catalogCalls).toBe(1)

    now = 4_000
    const second = await agg.getSnapshot()
    expect(second.cacheHit).toBe(true)
    expect(probeCalls).toBe(1)
    expect(discoverCalls).toBe(1)

    now = 7_000
    const third = await agg.getSnapshot()
    expect(third.cacheHit).toBe(false)
    expect(probeCalls).toBe(2)
    expect(discoverCalls).toBe(2)
  })

  it('maps presentIn across config/discovered/router and enriches configured rows from catalog', async () => {
    config = makeConfig({
      models: [
        makeModel({ id: 'configured-local', backendModel: 'configured-local', aliases: ['cfg'] }),
        makeModel({ id: 'configured-cloud', endpoint: 'https://api.example.com', apiKey: 'k' }),
      ],
    })

    const catalog = {
      version: 1,
      default_model: 'catalog-only',
      intent_defaults: {},
      models: [
        {
          id: 'catalog-only',
          channel: 'stable',
          backend: 'catalog-backend',
          priority_role: 'planner',
        },
      ],
      aliases: {
        cat: { target: 'catalog-only' },
      },
    } as PlatformCatalog

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['configured-local', 'cat'] }),
      discover: () => ({
        models: [{ id: 'discovered-only', label: 'Discovered', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
        reachableBackends: ['ollama'],
        unreachableBackends: [],
        durationMs: 5,
      } as DiscoveryResult),
      catalog: () => catalog,
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    const configured = snapshot.byModelId['configured-local']
    const discovered = snapshot.byModelId['discovered-only']
    const cloud = snapshot.byModelId['configured-cloud']

    expect(configured.presentIn).toEqual({
      config: true,
      router: true,
      discovered: false,
      catalog: false,
    })
    expect(cloud.providerKind).toBe('cloud')
    expect(discovered.presentIn).toEqual({
      config: false,
      router: false,
      discovered: true,
      catalog: false,
    })
    expect(discovered.availability.kind).toBe('orphan_discovered')
    expect(snapshot.byModelId['catalog-only']).toBeUndefined()
  })

  it('surfaces catalog-only rows when no explicit config models exist', async () => {
    config = makeConfig({ models: [] })

    const catalog = {
      version: 1,
      default_model: 'catalog-only',
      intent_defaults: {},
      models: [
        {
          id: 'catalog-only',
          channel: 'stable',
          backend: 'catalog-backend',
          priority_role: 'planner',
        },
      ],
      aliases: {
        cat: { target: 'catalog-only' },
      },
    } as PlatformCatalog

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['cat'] }),
      catalog: () => catalog,
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    const catalogStatus = snapshot.byModelId['catalog-only']

    expect(catalogStatus.presentIn).toEqual({
      config: false,
      router: true,
      discovered: false,
      catalog: true,
    })
    expect(catalogStatus.availability.kind).toBe('ok')
  })

  it('prioritizes alias conflict over router availability', async () => {
    config = makeConfig({
      models: [
        makeModel({ id: 'a', aliases: ['dup'] }),
        makeModel({ id: 'b', aliases: ['dup'] }),
      ],
    })

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['a', 'b'] }),
      discover: () => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }),
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['a'].availability.kind).toBe('alias_conflict')
    expect(snapshot.byModelId['b'].availability.kind).toBe('alias_conflict')
    expect(snapshot.byModelId['a'].availability.kind).not.toBe('ok')
  })

  it('reports missing_key and ok for endpoint models', async () => {
    config = makeConfig({
      models: [
        makeModel({
          id: 'missing-key',
          endpoint: 'https://missing.example.com',
          apiKeyEnv: 'MISSING_KEY_ENV',
        }),
        makeModel({
          id: 'with-key',
          endpoint: 'https://with-key.example.com',
          apiKey: 'abc',
        }),
      ],
    })

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: [] }),
      discover: () => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }),
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['missing-key'].availability).toEqual({
      kind: 'missing_key',
      envName: 'MISSING_KEY_ENV',
    })
    expect(snapshot.byModelId['with-key'].availability).toEqual({ kind: 'ok' })
  })

  it('matches discovered models onto configured entries via exact backendModel', async () => {
    config = makeConfig({
      models: [
        makeModel({
          id: 'saved-local',
          label: 'Saved Local',
          backendModel: 'local-a',
          aliases: ['local-alias'],
        }),
      ],
    })

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['local-a'] }),
      discover: () => ({
        models: [
          { id: 'local-a', label: 'Local A', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
        ],
        reachableBackends: ['ollama'],
        unreachableBackends: [],
        durationMs: 1,
      } as DiscoveryResult),
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['saved-local'].presentIn.discovered).toBe(true)
    expect(snapshot.byModelId['saved-local'].availability).toEqual({ kind: 'ok' })
    expect(snapshot.byModelId['local-a']).toBeUndefined()
  })

  it('does not attach discovered models by alias-only coincidence', async () => {
    config = makeConfig({
      models: [
        makeModel({
          id: 'saved-local',
          label: 'Saved Local',
          backendModel: 'different-backend',
          aliases: ['local-a'],
        }),
      ],
    })

    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: true, modelIds: ['different-backend', 'local-a'] }),
      discover: () => ({
        models: [
          { id: 'local-a', label: 'Local A', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
        ],
        reachableBackends: ['ollama'],
        unreachableBackends: [],
        durationMs: 1,
      } as DiscoveryResult),
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['saved-local'].presentIn.discovered).toBe(false)
    expect(snapshot.byModelId['saved-local'].raw.discovered).toBeUndefined()
    expect(snapshot.byModelId['local-a'].presentIn.discovered).toBe(true)
    expect(snapshot.byModelId['local-a'].presentIn.config).toBe(false)
    expect(snapshot.byModelId['local-a'].availability.kind).not.toBe('ok')
  })

  it('returns unknown when router is unreachable and model is not endpoint', async () => {
    config = makeConfig({
      models: [makeModel({ id: 'local-no-router' })],
    })
    const agg = createAggregator(() => config, {
      probeRuntime: () => ({ ok: false, modelIds: [] }),
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['local-no-router'].availability).toEqual({
      kind: 'unknown',
      reason: 'local runtime unavailable',
    })
  })

  it('annotates router_missing with owlmlx runtime visibility context when owlmlx is the truth source', async () => {
    config = makeConfig({
      models: [makeModel({ id: 'qwen36', backendModel: 'Qwen3.6-27B' })],
    })

    const agg = new ModelTruthAggregator(() => config, {
      ttlMs: 5_000,
      deps: {
        getConfig: () => config,
        now: () => now,
        probeRuntimeSurface: async () => ({
          ok: true,
          source: 'openai_models',
          detail: '/v1/openai/models responded (0 visible models)',
          modelIds: [],
          loadedModelIds: [],
          modelCount: 0,
          localRuntimeProtocol: 'openai_chat',
          platformVisibility: {
            endpoint: '/v1/runtime/model-visibility',
            source: 'owlmlx_runtime_model_visibility',
            rule: 'runtime_gate_required_before_visible',
            contractVersion: 'runtime-owned-2',
            gateStatus: null,
            gateReason: null,
            gateOwner: 'owlmlx',
            gateKind: 'registered_base_model_config_present',
            statusRegistry: null,
            requiresBackendAdvertisement: false,
            modelsRoot: '/var/lib/local-runtime/models',
            formalSurfaceEndpoint: '/v1/openai/models',
            diagnosticSurfaceEndpoint: '/v1/runtime/model-visibility',
            loadedInventoryEndpoint: '/v1/models',
            loadedInventorySemanticRole: 'currently_loaded_inventory_only',
            deprecatedFallback: false,
            visibleModelIds: [],
            blockedModelIds: ['Qwen3.6-27B'],
            entriesByModelId: {
              'Qwen3.6-27B': {
                modelId: 'Qwen3.6-27B',
                visible: false,
                blockReason: 'base_model_config_missing',
              },
            },
          },
        }),
        discoverBackends: async () => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }),
        loadCatalog: () => null,
      },
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.platformVisibility?.rule).toBe('runtime_gate_required_before_visible')
    expect(snapshot.byModelId['qwen36'].availability).toEqual({
      kind: 'router_missing',
      reason: 'Not visible in owlmlx /v1/openai/models yet; runtime visibility gate blocked (base_model_config_missing)',
      visibilityRule: 'runtime_gate_required_before_visible',
      blockReason: 'base_model_config_missing',
      truthSurface: '/v1/openai/models',
      diagnosticSurface: '/v1/runtime/model-visibility',
      loadedInventorySurface: '/v1/models',
    })
  })

  it('marks loaded-inventory-only runtimes as unknown instead of visible', async () => {
    config = makeConfig({
      models: [makeModel({ id: 'qwen36', backendModel: 'Qwen3.6-27B' })],
    })

    const agg = new ModelTruthAggregator(() => config, {
      ttlMs: 5_000,
      deps: {
        getConfig: () => config,
        now: () => now,
        probeRuntimeSurface: async () => ({
          ok: true,
          source: 'loaded_inventory_only',
          detail: '/v1/models exposed loaded inventory only (1 loaded model); formal visibility /v1/openai/models unavailable',
          modelIds: [],
          loadedModelIds: ['Qwen3.6-27B'],
          modelCount: 0,
          loadedModelCount: 1,
          localRuntimeProtocol: 'openai_chat',
          platformVisibility: {
            endpoint: '/v1/runtime/model-visibility',
            source: 'owlmlx_runtime_model_visibility',
            rule: 'runtime_gate_required_before_visible',
            contractVersion: 'runtime-owned-2',
            gateStatus: null,
            gateReason: null,
            gateOwner: 'owlmlx',
            gateKind: 'registered_base_model_config_present',
            statusRegistry: null,
            requiresBackendAdvertisement: false,
            modelsRoot: '/var/lib/local-runtime/models',
            formalSurfaceEndpoint: '/v1/openai/models',
            diagnosticSurfaceEndpoint: '/v1/runtime/model-visibility',
            loadedInventoryEndpoint: '/v1/models',
            loadedInventorySemanticRole: 'currently_loaded_inventory_only',
            deprecatedFallback: false,
            visibleModelIds: ['Qwen3.6-27B'],
            blockedModelIds: [],
            entriesByModelId: {},
          },
        }),
        discoverBackends: async () => ({ models: [], reachableBackends: [], unreachableBackends: [], durationMs: 0 }),
        loadCatalog: () => null,
      },
    })

    const snapshot = await agg.getSnapshot({ skipCache: true })
    expect(snapshot.byModelId['qwen36'].availability).toEqual({
      kind: 'unknown',
      reason: 'Loaded inventory is reachable, but formal visibility surface /v1/openai/models is unavailable',
    })
  })
})
