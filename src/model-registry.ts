/**
 * Model Registry — types and functions for model resolution, availability, and routing.
 * Extracted from config.ts for modularity.
 */

import { probeRuntimeSurface } from './runtime-probe.js'
import { resolveEffectiveContextWindow } from './model-capabilities.js'

// ─── Types ───

export interface ConfiguredModel {
  id: string
  label: string
  backendModel: string
  aliases: string[]
  tier: string
  default?: boolean
  channel?: string
  role?: string
  availability?: 'available' | 'unavailable' | 'unknown'
  endpoint?: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  contextWindow?: number
  timeoutMs?: number
}

export type ResponseModelStyle = 'platform' | 'requested'
export type LocalRuntimeProtocol = 'auto' | 'openai_chat' | 'anthropic_messages'

export interface ResolvedModel {
  id: string
  label: string
  backendModel: string
  endpoint?: string
  apiKey?: string
  headers?: Record<string, string>
  contextWindow?: number
  timeoutMs?: number
}

export interface ModelRoute {
  backendModel: string
  endpointUrl: string
  headers: Record<string, string>
  translate: boolean
  timeoutMs?: number
}

export class LocalRuntimeProtocolUnresolvedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalRuntimeProtocolUnresolvedError'
  }
}

// ─── Normalization ───

export function normalizeModel(raw: Record<string, unknown>): ConfiguredModel {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : ''
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv ? raw.apiKeyEnv : undefined
  const envApiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined
  let customHeaders: Record<string, string> | undefined
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    customHeaders = {}
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof value === 'string') customHeaders[key] = value
    }
    if (Object.keys(customHeaders).length === 0) customHeaders = undefined
  }
  return {
    id,
    label: typeof raw.label === 'string' && raw.label ? raw.label : id,
    backendModel: typeof raw.backendModel === 'string' && raw.backendModel ? raw.backendModel : id,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string') : [],
    tier: typeof raw.tier === 'string' && raw.tier ? raw.tier : 'general',
    default: raw.default === true ? true : undefined,
    channel: typeof raw.channel === 'string' ? raw.channel : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : envApiKey,
    apiKeyEnv,
    headers: customHeaders,
    contextWindow: resolveEffectiveContextWindow({
      id,
      label: typeof raw.label === 'string' && raw.label ? raw.label : id,
      backendModel: typeof raw.backendModel === 'string' && raw.backendModel ? raw.backendModel : id,
      aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string') : [],
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
      contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined,
    }),
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
  }
}

// ─── Resolution ───

/** Config-like interface needed by model functions */
export interface ModelRegistryConfig {
  models: ConfiguredModel[]
  routerUrl: string
  localRuntimeProtocol?: LocalRuntimeProtocol
  responseModelStyle: ResponseModelStyle
  modelMap: Record<string, string>
  defaultModel: string
  reverseMapInResponse: boolean
}

function toResolved(m: ConfiguredModel): ResolvedModel {
  return {
    id: m.id,
    label: m.label,
    backendModel: m.backendModel,
    endpoint: m.endpoint,
    apiKey: m.apiKey,
    headers: m.headers,
    contextWindow: m.contextWindow,
    timeoutMs: m.timeoutMs,
  }
}

function isOpenAICompatibleEndpoint(endpoint: string): boolean {
  return /\/chat\/completions\/?$/.test(endpoint)
}

export function isInteractiveChatModelName(name: string): boolean {
  const lower = name.toLowerCase()
  return !lower.includes('embedding') && !lower.includes('rerank')
}

export function isInteractiveChatModel(model: Pick<ConfiguredModel, 'id' | 'backendModel' | 'tier'>): boolean {
  return isInteractiveChatModelName(model.id)
    && isInteractiveChatModelName(model.backendModel)
    && isInteractiveChatModelName(model.tier)
}

export function resolveConfiguredModel(config: ModelRegistryConfig, requestModel: string): ResolvedModel {
  for (const m of config.models) {
    if (m.id === requestModel) return toResolved(m)
  }
  for (const m of config.models) {
    if (m.aliases.includes(requestModel)) return toResolved(m)
  }
  for (const m of config.models) {
    if (m.backendModel === requestModel) return toResolved(m)
  }
  const withoutDate = requestModel.replace(/-\d{8}$/, '')
  if (withoutDate !== requestModel) {
    for (const m of config.models) {
      if (m.id === withoutDate || m.aliases.includes(withoutDate)) {
        return toResolved(m)
      }
    }
  }
  const lower = requestModel.toLowerCase()
  for (const m of config.models) {
    if (m.id.toLowerCase().includes(lower)) {
      return toResolved(m)
    }
  }
  const def = getDefaultConfiguredModel(config)
  if (def) return def
  return { id: requestModel, label: requestModel, backendModel: requestModel }
}

export function getDefaultConfiguredModel(config: ModelRegistryConfig): ResolvedModel | null {
  const def = config.models.find(m => m.default) ?? config.models[0]
  if (!def) return null
  return toResolved(def)
}

export function getPreferredInteractiveConfiguredModel(config: ModelRegistryConfig): ResolvedModel | null {
  const interactive = config.models.filter(isInteractiveChatModel)
  const preferred = interactive.find(m => m.default) ?? interactive[0]
  if (preferred) return toResolved(preferred)
  return getDefaultConfiguredModel(config)
}

export function listConfiguredModels(config: ModelRegistryConfig): ConfiguredModel[] {
  return config.models
}

export function hasResolvedLocalRuntimeProtocol(config: ModelRegistryConfig): boolean {
  return config.localRuntimeProtocol === 'openai_chat' || config.localRuntimeProtocol === 'anthropic_messages'
}

export function requiresResolvedLocalRuntimeProtocol(config: ModelRegistryConfig, requestModel: string): boolean {
  const resolved = resolveConfiguredModel(config, requestModel)
  return !resolved.endpoint && !hasResolvedLocalRuntimeProtocol(config)
}

// ─── Router Probing ───

export async function probeRouterModels(routerUrl: string, timeoutMs: number = 3000): Promise<Set<string>> {
  const result = await probeRuntimeSurface(routerUrl, timeoutMs)
  return new Set(result.modelIds)
}

// ─── Availability Overlay ───

export function overlayAvailability(config: ModelRegistryConfig, routerModelIds: Set<string>): void {
  if (routerModelIds.size === 0) {
    for (const m of config.models) m.availability = 'unknown'
    return
  }

  const routerIds = Array.from(routerModelIds)

  for (const m of config.models) {
    if (m.endpoint) {
      m.availability = 'available'
      continue
    }
    if (routerModelIds.has(m.id) || routerModelIds.has(m.backendModel)) {
      m.availability = 'available'
      continue
    }
    if (m.aliases.some(a => routerModelIds.has(a))) {
      m.availability = 'available'
      continue
    }
    const prefixMatch = m.aliases.some(alias =>
      routerIds.some(rm => rm.startsWith(alias + '-'))
    )
    if (prefixMatch) {
      m.availability = 'available'
      continue
    }
    m.availability = 'unavailable'
  }
}

// ─── Response Model Name ───

export function responseModelName(config: ModelRegistryConfig, requestModel: string): string {
  const resolved = resolveConfiguredModel(config, requestModel)
  switch (config.responseModelStyle) {
    case 'platform':
      return resolved.id
    case 'requested':
      return requestModel
    default:
      return resolved.id
  }
}

export function resolveModelContextWindow(config: ModelRegistryConfig, requestModel: string): number {
  const resolved = resolveConfiguredModel(config, requestModel)
  return resolveEffectiveContextWindow({
    id: resolved.id,
    label: resolved.label,
    backendModel: resolved.backendModel,
    endpoint: resolved.endpoint,
    contextWindow: resolved.contextWindow,
  })
}

// ─── Model Routing ───

export function resolveModelRoute(config: ModelRegistryConfig, requestModel: string): ModelRoute {
  const resolved = resolveConfiguredModel(config, requestModel)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(resolved.headers ?? {}),
  }

  if (resolved.endpoint) {
    const normalizedEndpoint = resolved.endpoint.replace(/\/+$/, '')
    if (isOpenAICompatibleEndpoint(normalizedEndpoint)) {
      if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`
      }
      return {
        backendModel: resolved.backendModel,
        endpointUrl: normalizedEndpoint,
        headers,
        translate: true,
        timeoutMs: resolved.timeoutMs,
      }
    }
    if (resolved.apiKey) {
      headers['x-api-key'] = resolved.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
    return {
      backendModel: resolved.backendModel,
      endpointUrl: `${normalizedEndpoint}/v1/messages`,
      headers,
      translate: false,
      timeoutMs: resolved.timeoutMs,
    }
  }

  if (config.localRuntimeProtocol === 'anthropic_messages') {
    return {
      backendModel: resolved.backendModel,
      endpointUrl: `${config.routerUrl}/v1/messages`,
      headers,
      translate: false,
      timeoutMs: resolved.timeoutMs,
    }
  }

  if (!resolved.endpoint && config.localRuntimeProtocol === 'auto') {
    throw new LocalRuntimeProtocolUnresolvedError(
      `Local runtime protocol unresolved for model "${requestModel}". ` +
      'Expose /v1/openai/models (owlmlx) or /v1/models (generic OpenAI runtimes) on the local runtime, or set localRuntimeProtocol explicitly.',
    )
  }

  return {
    backendModel: resolved.backendModel,
    endpointUrl: `${config.routerUrl}/v1/chat/completions`,
    headers,
    translate: true,
    timeoutMs: resolved.timeoutMs,
  }
}

// ─── Legacy Helpers ───

export function resolveModel(config: ModelRegistryConfig, requestModel: string): string {
  if (config.models.length > 0) {
    return resolveConfiguredModel(config, requestModel).backendModel
  }
  if (config.modelMap[requestModel]) return config.modelMap[requestModel]
  const withoutDate = requestModel.replace(/-\d{8}$/, '')
  if (withoutDate !== requestModel && config.modelMap[withoutDate]) return config.modelMap[withoutDate]
  const localModels = new Set(Object.values(config.modelMap))
  if (localModels.has(requestModel)) return requestModel
  return config.defaultModel
}

export function reverseModel(config: ModelRegistryConfig, requestModel: string): string {
  if (config.models.length > 0) {
    return responseModelName(config, requestModel)
  }
  if (!config.reverseMapInResponse) return requestModel
  if (requestModel in config.modelMap) return requestModel
  for (const [key, value] of Object.entries(config.modelMap)) {
    if (value === requestModel) return key
  }
  return requestModel
}
