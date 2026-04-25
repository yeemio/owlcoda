/**
 * Types mirror the Phase α admin API envelope shape.
 * We intentionally do NOT import from server sources — the wire contract is
 * the source of truth and the client is decoupled from server-internal types.
 *
 * IMPORTANT: this module declares wire shapes only. It does NOT compute
 * availability — the API returns pre-computed ModelStatus from the aggregator.
 */

export const ADMIN_API_SCHEMA_VERSION = 1

export type LocalRuntimeProtocol = 'auto' | 'openai_chat' | 'anthropic_messages'
export type ProviderProbeMode = 'models' | 'chat' | 'messages'

// ─── Availability (mirror of src/model-truth.ts) ─────────────────────

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
  gateStatus: string | null
  gateReason: string | null
  gateOwner: string | null
  gateKind: string | null
  statusRegistry: string | null
  requiresBackendAdvertisement: boolean
  modelsRoot: string | null
  formalSurfaceEndpoint: string | null
  diagnosticSurfaceEndpoint: string | null
  loadedInventoryEndpoint: string | null
  loadedInventorySemanticRole: string | null
  deprecatedFallback: boolean
  visibleModelIds: string[]
  blockedModelIds: string[]
  entriesByModelId: Record<string, PlatformVisibilityEntryInfo>
}

// Sanitized config shape: apiKey replaced with { set: boolean }
export interface SanitizedConfiguredModel {
  id: string
  label: string
  backendModel: string
  aliases: string[]
  tier?: string
  default?: boolean
  role?: string
  endpoint?: string
  apiKey?: { set: boolean }
  apiKeyEnv?: string
  headers?: Record<string, string>
  contextWindow?: number
  timeoutMs?: number
}

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
    config?: SanitizedConfiguredModel
    discovered?: {
      id: string
      label: string
      backend: string
      baseUrl: string
      quantization?: string
      parameterSize?: string
      contextWindow?: number
    }
    catalogEntry?: unknown
    routerEntry?: string[]
  }
}

export interface ModelTruthSnapshot {
  refreshedAt: number
  ttlMs: number
  cacheHit: boolean
  runtimeOk: boolean
  runtimeSource: string | null
  runtimeLocalProtocol: string | null
  runtimeProbeDetail: string
  runtimeModelCount: number
  platformVisibility?: PlatformVisibilityInfo | null
  statuses: ModelStatus[]
  byModelId: Record<string, ModelStatus>
}

// ─── API response envelopes ──────────────────────────────────────────

export interface SnapshotResponse {
  schemaVersion: number
  snapshot: ModelTruthSnapshot
}

export interface ConfigResponse {
  schemaVersion: number
  config: {
    models: SanitizedConfiguredModel[]
    routerUrl: string
    localRuntimeProtocol: LocalRuntimeProtocol
    port: number
    [key: string]: unknown
  }
}

export interface ProviderTemplate {
  id: string
  provider: string
  label: string
  endpoint?: string
  headers?: Record<string, string>
  testPath?: string
  testMode?: ProviderProbeMode
  family?: 'single-model' | 'multi-model'
  description?: string
  endpointHint?: string
  backendModelHint?: string
  requiresBackendModel?: boolean
  featured?: boolean
  docs?: string
}

export interface ProvidersResponse {
  schemaVersion: number
  providers: ProviderTemplate[]
}

export interface CatalogResponse {
  schemaVersion: number
  items: Array<{ id: string; backend?: string; priority_role?: string; [key: string]: unknown }>
  aliases: Record<string, { target: string }>
  defaultModel: string | null
  catalogVersion: string | null
}

export interface AdminApiError {
  schemaVersion: number
  ok: false
  error: { code: string; message: string; details?: unknown }
}

// ─── Write payload + result shapes ───────────────────────────────────

export interface UpdateModelFieldsPatch {
  label?: string
  aliases?: string[]
  backendModel?: string
  endpoint?: string
  headers?: Record<string, string>
  contextWindow?: number
  role?: string
  timeoutMs?: number
}

export interface UpdateRuntimeSettingsPatch {
  routerUrl?: string
  localRuntimeProtocol?: LocalRuntimeProtocol
}

export interface CreateEndpointModelPatch {
  id: string
  label?: string
  aliases?: string[]
  backendModel?: string
  endpoint: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  contextWindow?: number
  role?: string
  timeoutMs?: number
}

export interface ApiKeyPayload {
  apiKey?: string
  apiKeyEnv?: string
}

export interface DryRunProbePayload {
  provider?: string
  id?: string
  label?: string
  backendModel?: string
  aliases?: string[]
  endpoint?: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  timeoutMs?: number
  role?: string
  contextWindow?: number
  testPath?: string
  testMode?: ProviderProbeMode
}

export interface ProviderProbeResult {
  ok: boolean
  status: number
  latencyMs: number
  detail: string
}

export interface MutationResponse {
  schemaVersion: number
  ok: boolean
  results?: Array<{ id: string; ok: boolean; error?: { code: string; message: string } }>
  snapshot?: ModelTruthSnapshot
}

export interface ProbeResponse {
  schemaVersion: number
  result: ProviderProbeResult
}

// ─── Bulk (Phase δ) ──────────────────────────────────────────────────

export interface BulkPatchItem {
  id: string
  patch: UpdateModelFieldsPatch
}

export interface BulkBindItem {
  discoveredId: string
  patch?: {
    id?: string
    label?: string
    aliases?: string[]
    role?: string
    tier?: string
    backendModel?: string
    endpoint?: string
    contextWindow?: number
    timeoutMs?: number
    headers?: Record<string, string>
  }
}

export interface BulkCreateItem {
  model: CreateEndpointModelPatch
}

export interface BatchResultItem {
  id: string
  ok: boolean
  error?: { code: string; message: string }
}

export interface BatchResponse {
  schemaVersion: number
  ok: boolean
  results: BatchResultItem[]
  snapshot?: ModelTruthSnapshot
}
