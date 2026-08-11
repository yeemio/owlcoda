/**
 * Model Registry — types and functions for model resolution, availability, and routing.
 * Extracted from config.ts for modularity.
 */

import { probeRuntimeSurface } from './runtime-probe.js'
import {
  isDefaultModelEligible,
  resolveEffectiveContextWindow,
  resolveModelCapabilities,
  type ModelContextCapability,
  type ModelCapabilities,
} from './model-capabilities.js'
import { normalizeProviderKind } from './provider-kind.js'
import { normalizeRouterBaseUrl } from './url-normalize.js'

// ─── Types ───

export type ModelExecutorKind = 'kimi-cli' | 'cursor-agent' | 'codex-cli'

export interface ModelExecutorConfig {
  kind: ModelExecutorKind
  executable?: string
  timeoutMs?: number
  killGraceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface ConfiguredModel {
  id: string
  label: string
  backendModel: string
  aliases: string[]
  tier: string
  provider?: string
  default?: boolean
  channel?: string
  role?: string
  availability?: 'available' | 'unavailable' | 'unknown'
  endpoint?: string
  apiKey?: string
  apiKeyEnv?: string
  apiKeySource?: 'env' | 'config' | 'unset'
  headers?: Record<string, string>
  contextWindow?: number
  supportsImages?: boolean
  supportsStructuredOutput?: boolean
  supportsStreaming?: boolean
  maxOutputTokens?: number
  timeoutMs?: number
  executor?: ModelExecutorConfig
}

export type ResponseModelStyle = 'platform' | 'requested'
export type LocalRuntimeProtocol = 'auto' | 'openai_chat' | 'anthropic_messages'

export interface ResolvedModel {
  id: string
  label: string
  backendModel: string
  provider?: string
  endpoint?: string
  apiKey?: string
  apiKeySource?: 'env' | 'config' | 'unset'
  headers?: Record<string, string>
  contextWindow?: number
  supportsImages?: boolean
  supportsStructuredOutput?: boolean
  supportsStreaming?: boolean
  maxOutputTokens?: number
  timeoutMs?: number
  executor?: ModelExecutorConfig
}

export interface ModelRoute {
  backendModel: string
  endpointUrl: string
  headers: Record<string, string>
  translate: boolean
  timeoutMs?: number
  executorKind?: ModelExecutorKind
  executorConfig?: ModelExecutorConfig
  configuredModelId?: string
  requestedModelConfigured?: boolean
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
  const apiKeySource: 'env' | 'config' | 'unset' = typeof raw.apiKey === 'string'
    ? (raw.apiKey ? 'config' : 'unset')
    : envApiKey
      ? 'env'
      : 'unset'
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : undefined
  const rawBackendModel = typeof raw.backendModel === 'string' && raw.backendModel ? raw.backendModel : id
  const backendModel = normalizeBackendModelForEndpoint(rawBackendModel, endpoint)
  const rawProvider = typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : undefined
  const executor = normalizeModelExecutor(raw.executor, rawProvider)
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
    backendModel,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string') : [],
    tier: typeof raw.tier === 'string' && raw.tier ? raw.tier : 'general',
    provider: rawProvider ?? executor?.kind,
    default: raw.default === true ? true : undefined,
    channel: typeof raw.channel === 'string' ? raw.channel : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    endpoint,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : envApiKey,
    apiKeyEnv,
    apiKeySource,
    headers: customHeaders,
    supportsImages: typeof raw.supportsImages === 'boolean' ? raw.supportsImages : undefined,
    supportsStructuredOutput: typeof raw.supportsStructuredOutput === 'boolean'
      ? raw.supportsStructuredOutput
      : executor
        ? true
        : undefined,
    supportsStreaming: typeof raw.supportsStreaming === 'boolean'
      ? raw.supportsStreaming
      : executor
        ? false
        : undefined,
    maxOutputTokens: typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : undefined,
    contextWindow: resolveEffectiveContextWindow({
      id,
      label: typeof raw.label === 'string' && raw.label ? raw.label : id,
      backendModel,
      aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string') : [],
      provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : undefined,
      endpoint,
      contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined,
      supportsImages: typeof raw.supportsImages === 'boolean' ? raw.supportsImages : undefined,
      supportsStructuredOutput: typeof raw.supportsStructuredOutput === 'boolean'
        ? raw.supportsStructuredOutput
        : executor
          ? true
          : undefined,
      supportsStreaming: typeof raw.supportsStreaming === 'boolean'
        ? raw.supportsStreaming
        : executor
          ? false
          : undefined,
      maxOutputTokens: typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : undefined,
    }),
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    ...(executor ? { executor } : {}),
  }
}

function normalizeModelExecutor(raw: unknown, provider: string | undefined): ModelExecutorConfig | undefined {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined
  const explicit = typeof value?.kind === 'string' ? normalizeExecutorKind(value.kind) : undefined
  const fromProvider = provider ? normalizeExecutorKind(provider) : undefined
  const kind = explicit ?? fromProvider
  if (!kind) return undefined
  const numeric = (name: string): number | undefined => {
    const candidate = value?.[name]
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
  }
  return {
    kind,
    ...(typeof value?.executable === 'string' && value.executable.trim()
      ? { executable: value.executable.trim() }
      : {}),
    ...(numeric('timeoutMs') !== undefined ? { timeoutMs: numeric('timeoutMs') } : {}),
    ...(numeric('killGraceMs') !== undefined ? { killGraceMs: numeric('killGraceMs') } : {}),
    ...(numeric('maxStdoutBytes') !== undefined ? { maxStdoutBytes: numeric('maxStdoutBytes') } : {}),
    ...(numeric('maxStderrBytes') !== undefined ? { maxStderrBytes: numeric('maxStderrBytes') } : {}),
  }
}

function normalizeExecutorKind(value: string): ModelExecutorKind | undefined {
  switch (value.trim().toLowerCase()) {
    case 'kimi-cli':
    case 'kimi_cli':
      return 'kimi-cli'
    case 'cursor-agent':
    case 'cursor_agent':
    case 'cursor-cli':
      return 'cursor-agent'
    case 'codex-cli':
    case 'codex_cli':
      return 'codex-cli'
    default:
      return undefined
  }
}

function normalizeBackendModelForEndpoint(backendModel: string, endpoint: string | undefined): string {
  const trimmed = backendModel.trim()
  if (!endpoint?.toLowerCase().includes('xiaomimimo.com')) return trimmed
  if (/^mimo[-_]v/i.test(trimmed)) return trimmed.toLowerCase()
  return trimmed
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
    provider: m.provider,
    endpoint: m.endpoint,
    apiKey: m.apiKey,
    apiKeySource: m.apiKeySource,
    headers: m.headers,
    contextWindow: m.contextWindow,
    supportsImages: m.supportsImages,
    supportsStructuredOutput: m.supportsStructuredOutput,
    supportsStreaming: m.supportsStreaming,
    maxOutputTokens: m.maxOutputTokens,
    timeoutMs: m.timeoutMs,
    executor: m.executor,
  }
}

function isOpenAICompatibleEndpoint(endpoint: string): boolean {
  return /\/chat\/completions\/?$/.test(endpoint)
}

function normalizeOpenAICompatibleChatEndpoint(endpoint: string, provider: ReturnType<typeof normalizeProviderKind>): string | null {
  if (provider !== 'openai-compat' && provider !== 'moonshot') return null
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) {
    url.pathname = path
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/v1')) {
    url.pathname = `${path}/chat/completions`
    return url.toString().replace(/\/+$/, '')
  }
  return null
}

function normalizeKimiCodingChatEndpoint(endpoint: string): string | null {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/, '')
  if (!url.hostname.includes('api.kimi.com')) return null
  if (path.endsWith('/coding/v1/chat/completions') || path.endsWith('/chat/completions')) {
    url.pathname = path
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/coding/v1')) {
    url.pathname = `${path}/chat/completions`
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/coding')) {
    url.pathname = `${path}/v1/chat/completions`
    return url.toString().replace(/\/+$/, '')
  }
  return null
}

function normalizeAnthropicMessagesEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1/messages') || path.endsWith('/messages')) {
    url.pathname = path
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/v1/chat/completions')) {
    url.pathname = `${path.slice(0, -'/v1/chat/completions'.length)}/v1/messages`
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/chat/completions')) {
    url.pathname = `${path.slice(0, -'/chat/completions'.length)}/messages`
    return url.toString().replace(/\/+$/, '')
  }
  if (path === '' || path === '/') {
    url.pathname = '/v1/messages'
    return url.toString().replace(/\/+$/, '')
  }
  if (path.endsWith('/v1')) {
    url.pathname = `${path}/messages`
    return url.toString().replace(/\/+$/, '')
  }
  url.pathname = `${path}/v1/messages`
  return url.toString().replace(/\/+$/, '')
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

/**
 * Legacy placeholder written by older `owlcoda init` runs when no local
 * backend was reachable. It has no endpoint and a "your-…" id that no real
 * provider exposes. Treat it as never-default-eligible so a fresh cloud
 * provider added in Admin wins automatically and so launch can detect a
 * placeholder-only config and route to onboarding.
 */
export function isPlaceholderConfiguredModel(model: Pick<ConfiguredModel, 'id' | 'backendModel' | 'endpoint'>): boolean {
  if (model.endpoint) return false
  return model.id === 'your-default-model' && model.backendModel === 'your-default-model'
}

function findConfiguredModel(config: ModelRegistryConfig, requestModel: string): ConfiguredModel | null {
  for (const m of config.models) {
    if (m.id === requestModel) return m
  }
  for (const m of config.models) {
    if (m.aliases.includes(requestModel)) return m
  }
  for (const m of config.models) {
    if (m.backendModel === requestModel) return m
  }
  const withoutDate = requestModel.replace(/-\d{8}$/, '')
  if (withoutDate !== requestModel) {
    for (const m of config.models) {
      if (m.id === withoutDate || m.aliases.includes(withoutDate)) {
        return m
      }
    }
  }
  const lower = requestModel.toLowerCase()
  for (const m of config.models) {
    if (m.id.toLowerCase().includes(lower)) {
      return m
    }
  }
  return null
}

export function resolveConfiguredModel(config: ModelRegistryConfig, requestModel: string): ResolvedModel {
  const matched = findConfiguredModel(config, requestModel)
  if (matched) return toResolved(matched)
  const def = getDefaultConfiguredModel(config)
  if (def) return def
  return { id: requestModel, label: requestModel, backendModel: requestModel }
}

/**
 * Membership check: does `requestModel` resolve to an explicitly configured
 * model, or would {@link resolveConfiguredModel} silently fall back to the
 * default?
 *
 * Gateways and benchmark/lab runners should call this before routing a
 * user-requested model. Otherwise a typo like `gpt-4o` can be silently served by
 * the local default and poison A/B or provider verification. Returns true iff a
 * configured model matches by id / alias / backendModel / date-stripped id /
 * substring, excluding the default fallback used by the lower-level resolver.
 */
export function isModelExplicitlyConfigured(config: ModelRegistryConfig, requestModel: string): boolean {
  return findConfiguredModel(config, requestModel) !== null
}

export function getDefaultConfiguredModel(config: ModelRegistryConfig): ResolvedModel | null {
  const real = config.models.filter(m => !isPlaceholderConfiguredModel(m))
  const explicitDefault = real.find(m => m.default)
  if (explicitDefault) return toResolved(explicitDefault)

  const eligible = real.filter(isDefaultModelEligible)
  const def = eligible[0] ?? real[0]
  if (!def) return null
  return toResolved(def)
}

export function getPreferredInteractiveConfiguredModel(config: ModelRegistryConfig): ResolvedModel | null {
  const interactive = config.models.filter(m =>
    !isPlaceholderConfiguredModel(m) && isInteractiveChatModel(m)
  )
  const explicitDefault = interactive.find(m => m.default)
  if (explicitDefault) return toResolved(explicitDefault)

  const preferred = interactive.find(isDefaultModelEligible) ?? interactive[0]
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
  return !resolved.endpoint && !resolved.executor && !hasResolvedLocalRuntimeProtocol(config)
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
    if (m.executor) {
      m.availability = 'unknown'
      continue
    }
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
  return resolveModelContextCapability(config, requestModel).contextWindow
}

export function resolveModelContextCapability(config: ModelRegistryConfig, requestModel: string): ModelContextCapability {
  return resolveModelCapabilitiesForRequest(config, requestModel).context
}

export function resolveModelCapabilitiesForRequest(config: ModelRegistryConfig, requestModel: string): ModelCapabilities {
  const matched = findConfiguredModel(config, requestModel)
  if (matched) {
    return resolveModelCapabilities({
      id: matched.id,
      label: matched.label,
      backendModel: matched.backendModel,
      aliases: matched.aliases,
      provider: matched.provider,
      endpoint: matched.endpoint,
      contextWindow: matched.contextWindow,
      supportsImages: matched.supportsImages,
      supportsStructuredOutput: matched.supportsStructuredOutput,
      supportsStreaming: matched.supportsStreaming,
      maxOutputTokens: matched.maxOutputTokens,
    })
  }

  return resolveModelCapabilities({
    id: requestModel,
    label: requestModel,
    backendModel: requestModel,
  })
}

// ─── Model Routing ───

export function resolveModelRoute(config: ModelRegistryConfig, requestModel: string): ModelRoute {
  const resolved = resolveConfiguredModel(config, requestModel)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(resolved.headers ?? {}),
  }

  if (resolved.executor) {
    return {
      backendModel: resolved.backendModel,
      endpointUrl: '',
      headers,
      translate: false,
      timeoutMs: resolved.timeoutMs,
      executorKind: resolved.executor.kind,
      executorConfig: resolved.executor,
      configuredModelId: resolved.id,
      requestedModelConfigured: isModelExplicitlyConfigured(config, requestModel),
    }
  }

  if (resolved.endpoint) {
    const normalizedEndpoint = resolved.endpoint.replace(/\/+$/, '')
    const provider = normalizeProviderKind(resolved)
    const kimiChatEndpoint = provider === 'kimi' ? normalizeKimiCodingChatEndpoint(normalizedEndpoint) : null
    const openAIChatEndpoint = normalizeOpenAICompatibleChatEndpoint(normalizedEndpoint, provider)
    if (kimiChatEndpoint) {
      if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`
      }
      return {
        backendModel: resolved.backendModel,
        endpointUrl: kimiChatEndpoint,
        headers,
        translate: true,
        timeoutMs: resolved.timeoutMs,
      }
    }

    if (openAIChatEndpoint || isOpenAICompatibleEndpoint(normalizedEndpoint)) {
      if (resolved.apiKey) {
        headers['Authorization'] = `Bearer ${resolved.apiKey}`
      }
      return {
        backendModel: resolved.backendModel,
        endpointUrl: openAIChatEndpoint ?? normalizedEndpoint,
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
      endpointUrl: normalizeAnthropicMessagesEndpoint(normalizedEndpoint),
      headers,
      translate: false,
      timeoutMs: resolved.timeoutMs,
    }
  }

  if (config.localRuntimeProtocol === 'anthropic_messages') {
    return {
      backendModel: resolved.backendModel,
      endpointUrl: `${normalizeRouterBaseUrl(config.routerUrl)}/v1/messages`,
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
    endpointUrl: `${normalizeRouterBaseUrl(config.routerUrl)}/v1/chat/completions`,
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
