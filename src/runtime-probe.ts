export interface PlatformVisibilityEntryInfo {
  modelId: string
  visible: boolean
  blockReason: string | null
}

export interface PlatformVisibilityInfo {
  endpoint: string
  source: 'owlmlx_runtime_model_visibility' | 'legacy_router_platform_model_visibility'
  rule: string | null
  contractVersion: string | null
  formalSurfaceEndpoint: string | null
  diagnosticSurfaceEndpoint: string | null
  loadedInventoryEndpoint: string | null
  loadedInventorySemanticRole: string | null
  gateOwner: string | null
  gateKind: string | null
  gateStatus: string | null
  gateReason: string | null
  statusRegistry: string | null
  requiresBackendAdvertisement: boolean
  modelsRoot: string | null
  deprecatedFallback: boolean
  visibleModelIds: string[]
  blockedModelIds: string[]
  entriesByModelId: Record<string, PlatformVisibilityEntryInfo>
}

export interface RuntimeProbeResult {
  ok: boolean
  source: 'openai_models' | 'models' | 'deprecated_router_models' | 'loaded_inventory_only' | 'runtime_status' | 'healthz' | 'none'
  detail: string
  modelIds: string[]
  loadedModelIds: string[]
  modelCount?: number
  loadedModelCount?: number
  readiness?: string
  backendHealthy?: boolean
  localRuntimeProtocol?: 'openai_chat' | 'anthropic_messages'
  platformVisibility?: PlatformVisibilityInfo | null
}

interface LoadedInventoryProbe {
  loadedModelIds: string[]
  loadedModelCount: number
  semanticRole: string | null
}

function withTimeout(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

async function parseJsonSafe(res: Response): Promise<any | null> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function parseOpenAiModelIds(body: any): string[] | null {
  if (!Array.isArray(body?.data)) return null
  return body.data
    .map((item: { id?: unknown }) => item?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
}

function parseLoadedInventory(body: any): LoadedInventoryProbe | null {
  if (!body?.inventory || !Array.isArray(body.inventory.entries)) return null
  const loadedModelIds = body.inventory.entries
    .map((entry: { model_id?: unknown }) => entry?.model_id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  const loadedModelCount = typeof body.inventory.model_count === 'number'
    ? body.inventory.model_count
    : loadedModelIds.length
  const semanticRole = typeof body?.visibility_contract?.loaded_inventory_surface?.semantic_role === 'string'
    ? body.visibility_contract.loaded_inventory_surface.semantic_role
    : null
  return {
    loadedModelIds,
    loadedModelCount,
    semanticRole,
  }
}

async function probeOwmlxRuntimeVisibility(apiBaseUrl: string, timeoutMs: number): Promise<PlatformVisibilityInfo | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/runtime/model-visibility`, {
      signal: withTimeout(timeoutMs),
    })
    if (!res.ok) return null

    const body = await parseJsonSafe(res) as {
      rule?: unknown
      contract_version?: unknown
      formal_surface?: { endpoint?: unknown }
      diagnostic_surface?: { endpoint?: unknown }
      loaded_inventory_surface?: { endpoint?: unknown, semantic_role?: unknown }
      gate?: {
        owner?: unknown
        kind?: unknown
        models_root?: unknown
      }
      visible_model_ids?: unknown[]
      blocked_model_ids?: unknown[]
      entries?: Array<{
        model_id?: unknown
        visible?: unknown
        block_reason?: unknown
      }>
    } | null

    const entriesByModelId: Record<string, PlatformVisibilityEntryInfo> = {}
    for (const entry of body?.entries ?? []) {
      const modelId = typeof entry?.model_id === 'string' ? entry.model_id : null
      if (!modelId) continue
      entriesByModelId[modelId] = {
        modelId,
        visible: entry?.visible === true,
        blockReason: typeof entry?.block_reason === 'string' ? entry.block_reason : null,
      }
    }

    return {
      endpoint: '/v1/runtime/model-visibility',
      source: 'owlmlx_runtime_model_visibility',
      rule: typeof body?.rule === 'string' ? body.rule : null,
      contractVersion: typeof body?.contract_version === 'string' ? body.contract_version : null,
      formalSurfaceEndpoint: typeof body?.formal_surface?.endpoint === 'string' ? body.formal_surface.endpoint : null,
      diagnosticSurfaceEndpoint: typeof body?.diagnostic_surface?.endpoint === 'string'
        ? body.diagnostic_surface.endpoint
        : '/v1/runtime/model-visibility',
      loadedInventoryEndpoint: typeof body?.loaded_inventory_surface?.endpoint === 'string'
        ? body.loaded_inventory_surface.endpoint
        : null,
      loadedInventorySemanticRole: typeof body?.loaded_inventory_surface?.semantic_role === 'string'
        ? body.loaded_inventory_surface.semantic_role
        : null,
      gateOwner: typeof body?.gate?.owner === 'string' ? body.gate.owner : null,
      gateKind: typeof body?.gate?.kind === 'string' ? body.gate.kind : null,
      gateStatus: null,
      gateReason: null,
      statusRegistry: null,
      requiresBackendAdvertisement: false,
      modelsRoot: typeof body?.gate?.models_root === 'string' ? body.gate.models_root : null,
      deprecatedFallback: false,
      visibleModelIds: Array.isArray(body?.visible_model_ids)
        ? body.visible_model_ids.filter((id): id is string => typeof id === 'string')
        : [],
      blockedModelIds: Array.isArray(body?.blocked_model_ids)
        ? body.blocked_model_ids.filter((id): id is string => typeof id === 'string')
        : [],
      entriesByModelId,
    }
  } catch {
    return null
  }
}

async function probeLegacyPlatformVisibility(apiBaseUrl: string, timeoutMs: number): Promise<PlatformVisibilityInfo | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/platform/model-visibility`, {
      signal: withTimeout(timeoutMs),
    })
    if (!res.ok) return null

    const body = await parseJsonSafe(res) as {
      rule?: unknown
      formal_surface?: { endpoint?: unknown }
      gate?: {
        status?: unknown
        status_reason?: unknown
        status_registry?: unknown
        requires_backend_advertisement?: unknown
      }
    } | null

    return {
      endpoint: '/v1/platform/model-visibility',
      source: 'legacy_router_platform_model_visibility',
      rule: typeof body?.rule === 'string' ? body.rule : null,
      contractVersion: null,
      formalSurfaceEndpoint: typeof body?.formal_surface?.endpoint === 'string'
        ? body.formal_surface.endpoint
        : '/v1/models',
      diagnosticSurfaceEndpoint: '/v1/platform/model-visibility',
      loadedInventoryEndpoint: null,
      loadedInventorySemanticRole: null,
      gateOwner: 'llm_router',
      gateKind: null,
      gateStatus: typeof body?.gate?.status === 'string' ? body.gate.status : null,
      gateReason: typeof body?.gate?.status_reason === 'string' ? body.gate.status_reason : null,
      statusRegistry: typeof body?.gate?.status_registry === 'string' ? body.gate.status_registry : null,
      requiresBackendAdvertisement: body?.gate?.requires_backend_advertisement === true,
      modelsRoot: null,
      deprecatedFallback: true,
      visibleModelIds: [],
      blockedModelIds: [],
      entriesByModelId: {},
    }
  } catch {
    return null
  }
}

async function probeLoadedInventory(apiBaseUrl: string, timeoutMs: number): Promise<LoadedInventoryProbe | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/models`, {
      signal: withTimeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await parseJsonSafe(res)
    return parseLoadedInventory(body)
  } catch {
    return null
  }
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export async function probeRuntimeSurface(apiBaseUrl: string, timeoutMs: number = 5000): Promise<RuntimeProbeResult> {
  let runtimeStatusResult: RuntimeProbeResult | null = null

  try {
    const runtimeRes = await fetch(`${apiBaseUrl}/v1/runtime/status`, {
      signal: withTimeout(timeoutMs),
    })
    if (runtimeRes.ok) {
      const body = await parseJsonSafe(runtimeRes) as {
        inventory?: { model_count?: number; entries?: Array<{ model_id?: string }> }
        health?: { readiness?: string }
        backend?: { healthy?: boolean; loaded_models?: Array<{ model_id?: string }> }
      } | null
      const inventoryIds = (body?.inventory?.entries ?? [])
        .map(item => item.model_id)
        .filter((id): id is string => typeof id === 'string')
      const backendIds = (body?.backend?.loaded_models ?? [])
        .map(item => item.model_id)
        .filter((id): id is string => typeof id === 'string')
      const loadedModelIds = Array.from(new Set([...inventoryIds, ...backendIds]))
      const readiness = typeof body?.health?.readiness === 'string' ? body.health.readiness : undefined
      const backendHealthy = typeof body?.backend?.healthy === 'boolean' ? body.backend.healthy : undefined
      const loadedModelCount = typeof body?.inventory?.model_count === 'number'
        ? body.inventory.model_count
        : loadedModelIds.length
      const readinessText = readiness ?? 'unknown'
      runtimeStatusResult = {
        ok: true,
        source: 'runtime_status',
        detail: `/v1/runtime/status responded (${readinessText}; ${pluralize(loadedModelCount, 'loaded model')})`,
        modelIds: [],
        loadedModelIds,
        modelCount: 0,
        loadedModelCount,
        readiness,
        backendHealthy,
        localRuntimeProtocol: 'anthropic_messages',
      }
    }
  } catch {
    // Fall through.
  }

  try {
    const openAiModelsRes = await fetch(`${apiBaseUrl}/v1/openai/models`, {
      signal: withTimeout(timeoutMs),
    })
    if (openAiModelsRes.ok) {
      const body = await parseJsonSafe(openAiModelsRes)
      const modelIds = parseOpenAiModelIds(body)
      if (modelIds) {
        const platformVisibility = await probeOwmlxRuntimeVisibility(apiBaseUrl, timeoutMs)
        const loadedInventory = await probeLoadedInventory(apiBaseUrl, timeoutMs)
        const detailParts = [`/v1/openai/models responded (${pluralize(modelIds.length, 'visible model')})`]
        if (loadedInventory) {
          detailParts.push(`/v1/models loaded inventory ${pluralize(loadedInventory.loadedModelCount, 'model')}`)
        }
        if (runtimeStatusResult?.readiness) {
          detailParts.push(`runtime status ${runtimeStatusResult.readiness}`)
        }
        return {
          ok: true,
          source: 'openai_models',
          detail: detailParts.join('; '),
          modelIds,
          loadedModelIds: loadedInventory?.loadedModelIds ?? runtimeStatusResult?.loadedModelIds ?? [],
          modelCount: modelIds.length,
          loadedModelCount: loadedInventory?.loadedModelCount ?? runtimeStatusResult?.loadedModelCount,
          readiness: runtimeStatusResult?.readiness,
          backendHealthy: runtimeStatusResult?.backendHealthy,
          localRuntimeProtocol: 'openai_chat',
          platformVisibility,
        }
      }
    }
  } catch {
    // Fall through.
  }

  try {
    const modelsRes = await fetch(`${apiBaseUrl}/v1/models`, {
      signal: withTimeout(timeoutMs),
    })
    if (modelsRes.ok) {
      const body = await parseJsonSafe(modelsRes)
      const openAiModelIds = parseOpenAiModelIds(body)
      if (openAiModelIds) {
        const legacyVisibility = await probeLegacyPlatformVisibility(apiBaseUrl, timeoutMs)
        const detailParts = [`/v1/models responded (${pluralize(openAiModelIds.length, 'model')})`]
        if (legacyVisibility) {
          detailParts.push('deprecated router fallback')
        }
        if (runtimeStatusResult?.readiness) {
          detailParts.push(`runtime status ${runtimeStatusResult.readiness}`)
        }
        return {
          ok: true,
          source: legacyVisibility ? 'deprecated_router_models' : 'models',
          detail: detailParts.join('; '),
          modelIds: openAiModelIds,
          loadedModelIds: runtimeStatusResult?.loadedModelIds ?? [],
          modelCount: openAiModelIds.length,
          loadedModelCount: runtimeStatusResult?.loadedModelCount,
          readiness: runtimeStatusResult?.readiness,
          backendHealthy: runtimeStatusResult?.backendHealthy,
          localRuntimeProtocol: 'openai_chat',
          platformVisibility: legacyVisibility,
        }
      }

      const loadedInventory = parseLoadedInventory(body)
      if (loadedInventory) {
        const platformVisibility = await probeOwmlxRuntimeVisibility(apiBaseUrl, timeoutMs)
        const detailParts = [`/v1/models exposed loaded inventory only (${pluralize(loadedInventory.loadedModelCount, 'loaded model')})`]
        if (platformVisibility?.formalSurfaceEndpoint) {
          detailParts.push(`formal visibility ${platformVisibility.formalSurfaceEndpoint} unavailable`)
        }
        if (runtimeStatusResult?.readiness) {
          detailParts.push(`runtime status ${runtimeStatusResult.readiness}`)
        }
        return {
          ok: true,
          source: 'loaded_inventory_only',
          detail: detailParts.join('; '),
          modelIds: [],
          loadedModelIds: loadedInventory.loadedModelIds,
          modelCount: 0,
          loadedModelCount: loadedInventory.loadedModelCount,
          readiness: runtimeStatusResult?.readiness,
          backendHealthy: runtimeStatusResult?.backendHealthy,
          localRuntimeProtocol: platformVisibility?.source === 'owlmlx_runtime_model_visibility' ? 'openai_chat' : runtimeStatusResult?.localRuntimeProtocol,
          platformVisibility,
        }
      }
    }
  } catch {
    // Fall through.
  }

  if (runtimeStatusResult) {
    const platformVisibility = await probeOwmlxRuntimeVisibility(apiBaseUrl, timeoutMs)
      ?? await probeLegacyPlatformVisibility(apiBaseUrl, timeoutMs)
    return {
      ...runtimeStatusResult,
      localRuntimeProtocol: platformVisibility?.source === 'owlmlx_runtime_model_visibility'
        ? 'openai_chat'
        : runtimeStatusResult.localRuntimeProtocol,
      platformVisibility,
    }
  }

  try {
    const healthRes = await fetch(`${apiBaseUrl}/healthz`, {
      signal: withTimeout(timeoutMs),
    })
    if (healthRes.ok) {
      const platformVisibility = await probeOwmlxRuntimeVisibility(apiBaseUrl, timeoutMs)
        ?? await probeLegacyPlatformVisibility(apiBaseUrl, timeoutMs)
      return {
        ok: true,
        source: 'healthz',
        detail: `/healthz responded`,
        modelIds: [],
        loadedModelIds: [],
        platformVisibility,
        localRuntimeProtocol: platformVisibility?.source === 'owlmlx_runtime_model_visibility' ? 'openai_chat' : undefined,
      }
    }
  } catch {
    // Unreachable.
  }

  return {
    ok: false,
    source: 'none',
    detail: 'unreachable via /v1/openai/models, /v1/models, /v1/runtime/status, or /healthz',
    modelIds: [],
    loadedModelIds: [],
  }
}
