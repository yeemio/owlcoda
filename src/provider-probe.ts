import type { ConfiguredModel } from './model-registry.js'
import { normalizeModel } from './config.js'
import { normalizeProviderKind, type ProviderKind } from './provider-kind.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  formatProviderDiagnostic,
  upstreamRequestIdFromHeaders,
} from './provider-error.js'
export type { ProviderKind } from './provider-kind.js'

export interface ProviderProbeResult {
  ok: boolean
  status: number
  latencyMs: number
  detail: string
}

export type ProviderProbeMode = 'models' | 'chat' | 'messages'

export interface DryRunProviderPayload {
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

export interface ProviderProbeDeps {
  fetch: typeof globalThis.fetch
  now: () => number
}

export interface ProviderProbeOptions {
  deps?: Partial<ProviderProbeDeps>
}

interface ProbeRequest {
  providerId: string
  provider: ProviderKind
  model: ConfiguredModel
  testPath?: string
  testMode: ProviderProbeMode
}

export interface ProviderTemplate {
  id: string
  provider: ProviderKind
  label: string
  endpoint: string
  defaultModelId?: string
  defaultModelLabel?: string
  defaultBackendModel?: string
  defaultAliases?: string[]
  defaultContextWindow?: number
  testPath?: string
  testMode: ProviderProbeMode
  family: 'single-model' | 'multi-model'
  description?: string
  endpointHint?: string
  backendModelHint?: string
  requiresBackendModel?: boolean
  featured?: boolean
  docs?: string
}

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'anthropic',
    provider: 'anthropic',
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com',
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Direct Anthropic-compatible endpoint for native /v1/messages providers.',
  },
  {
    id: 'openai-compat',
    provider: 'openai-compat',
    label: 'OpenAI Compatible',
    endpoint: 'https://api.openai.com/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Generic OpenAI-compatible family. Use this when the provider exposes /v1/models and OpenAI-style chat/completions.',
    backendModelHint: 'Save one OwlCoda model entry per backend model id you actually plan to route.',
  },
  {
    id: 'openrouter',
    provider: 'openai-compat',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'One API key, many upstream models. Start with the family endpoint, then save concrete backend model ids like provider/model.',
    backendModelHint: 'Use the exact OpenRouter model id you want OwlCoda to route, for example provider/model.',
    featured: true,
    docs: 'https://openrouter.ai/docs/api-reference/overview',
  },
  {
    id: 'bailian',
    provider: 'openai-compat',
    label: 'Bailian / DashScope',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'multi-model',
    description: 'Alibaba Cloud Model Studio exposes many backend models behind one OpenAI-compatible compatible-mode endpoint.',
    endpointHint: 'The default here is China (Beijing). Switch to the region-specific compatible-mode base URL if your workspace is elsewhere.',
    backendModelHint: 'Enter the exact Alibaba backend model id from Model Studio docs for the family you want to use.',
    requiresBackendModel: true,
    featured: true,
    docs: 'https://www.alibabacloud.com/help/en/model-studio/what-is-model-studio',
  },
  {
    id: 'kimi',
    provider: 'kimi',
    label: 'Kimi',
    endpoint: 'https://api.kimi.com/coding',
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Moonshot Kimi coding endpoint using Anthropic-style messages probing.',
    featured: true,
  },
  {
    id: 'moonshot',
    provider: 'moonshot',
    label: 'Moonshot',
    endpoint: 'https://api.moonshot.ai/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Moonshot OpenAI-compatible family endpoint.',
  },
  {
    id: 'minimax-anthropic',
    provider: 'anthropic',
    label: 'MiniMax (Anthropic-compatible)',
    endpoint: 'https://api.minimaxi.com/anthropic',
    defaultModelId: 'minimax-m27',
    defaultModelLabel: 'MiniMax M2.7-highspeed',
    defaultBackendModel: 'MiniMax-M2.7-highspeed',
    defaultAliases: ['minimax', 'm27'],
    defaultContextWindow: 204800,
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'MiniMax M2.7 highspeed via the Anthropic-compatible messages endpoint.',
    backendModelHint: 'Use MiniMax-M2.7-highspeed unless your MiniMax console shows a different exact model id.',
    featured: true,
    docs: 'https://platform.minimax.io/docs/api-reference/text-anthropic-api',
  },
  {
    id: 'custom',
    provider: 'custom',
    label: 'Custom',
    endpoint: 'http://127.0.0.1:8080',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Bring your own endpoint. Override the test path if the provider needs a different probe surface.',
  },
]

function defaultDeps(): ProviderProbeDeps {
  return {
    fetch: globalThis.fetch,
    now: () => Date.now(),
  }
}

export class ProviderProbe {
  private readonly deps: ProviderProbeDeps

  constructor(options: ProviderProbeOptions = {}) {
    this.deps = {
      ...defaultDeps(),
      ...options.deps,
    }
  }

  async test(input: ConfiguredModel | DryRunProviderPayload): Promise<ProviderProbeResult> {
    const request = normalizeProbeInput(input)
    if (!request.model.endpoint) {
      return {
        ok: false,
        status: 400,
        latencyMs: 0,
        detail: 'Missing endpoint',
      }
    }

    if (!this.deps.fetch) {
      return {
        ok: false,
        status: 500,
        latencyMs: 0,
        detail: 'Fetch API is unavailable',
      }
    }

    const { url, init } = buildRequest(request)
    const start = this.deps.now()
    try {
      const response = await this.deps.fetch(url, init)
      const latencyMs = Math.max(0, this.deps.now() - start)
      if (!response.ok) {
        const diagnostic = createProviderHttpDiagnostic(response.status, await response.text(), {
          provider: request.providerId,
          model: request.model.id,
          endpointUrl: request.model.endpoint,
          headers: request.model.headers,
          upstreamRequestId: upstreamRequestIdFromHeaders(response.headers),
        })
        return {
          ok: false,
          status: diagnostic.status ?? response.status,
          latencyMs,
          detail: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
        }
      }
      return {
        ok: true,
        status: response.status,
        latencyMs,
        detail: `${request.providerId} probe succeeded`,
      }
    } catch (error) {
      const diagnostic = classifyProviderRequestError(error, {
        provider: request.providerId,
        model: request.model.id,
        endpointUrl: request.model.endpoint,
        headers: request.model.headers,
      })
      return {
        ok: false,
        status: diagnostic.status ?? 0,
        latencyMs: Math.max(0, this.deps.now() - start),
        detail: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
      }
    }
  }
}

export function getProviderTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES.map(template => ({ ...template }))
}

function normalizeProbeInput(input: ConfiguredModel | DryRunProviderPayload): ProbeRequest {
  if (isConfiguredModel(input)) {
    const template = inferProviderTemplate(input)
    return {
      providerId: template?.id ?? normalizeProviderKind(input),
      provider: template?.provider ?? normalizeProviderKind(input),
      model: input,
      testPath: template?.testPath,
      testMode: template?.testMode ?? inferProbeMode(input.endpoint),
    }
  }

  const template = inferProviderTemplate(input)
  const normalized = normalizeModel({
    id: input.id ?? 'dry-run-model',
    label: input.label ?? input.id ?? 'Dry Run Model',
    backendModel: input.backendModel ?? input.id ?? 'dry-run-model',
    aliases: input.aliases ?? [],
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    apiKeyEnv: input.apiKeyEnv,
    headers: input.headers,
    timeoutMs: input.timeoutMs,
    role: input.role,
    contextWindow: input.contextWindow,
    tier: 'cloud',
  })
  return {
    providerId: template?.id ?? input.provider ?? normalizeProviderKind({ ...normalized, provider: input.provider } as ConfiguredModel & { provider?: string }),
    provider: template?.provider ?? normalizeProviderKind({ ...normalized, provider: input.provider } as ConfiguredModel & { provider?: string }),
    model: normalized,
    testPath: input.testPath ?? template?.testPath,
    testMode: input.testMode ?? template?.testMode ?? inferProbeMode(input.endpoint),
  }
}

function isConfiguredModel(input: ConfiguredModel | DryRunProviderPayload): input is ConfiguredModel {
  return 'tier' in input
}

function buildRequest(request: ProbeRequest): { url: string, init: RequestInit } {
  const headers = new Headers(request.model.headers ?? {})
  // Probes should be fast, but 5s is too aggressive for some cloud providers
  // (for example MiniMax anthropic-compatible endpoints often land just under 10s).
  const timeoutMs = resolveProbeTimeoutMs(request.model.timeoutMs)
  const apiKey = request.model.apiKey

  if (usesAnthropicMessagesProbe(request)) {
    if (apiKey) headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', '2023-06-01')
    headers.set('content-type', 'application/json')
    return {
      url: resolveTargetUrl(request.model.endpoint!, request.testPath ?? '/v1/messages', 'anthropic'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model.backendModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    }
  }

  if (usesOpenAIChatProbe(request)) {
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    headers.set('content-type', 'application/json')
    return {
      url: resolveTargetUrl(request.model.endpoint!, request.testPath ?? defaultTestPathForRequest(request), request.provider),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model.backendModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    }
  }

  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  return {
    url: resolveTargetUrl(request.model.endpoint!, request.testPath ?? defaultTestPathForRequest(request), request.provider),
    init: {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    },
  }
}

function resolveProbeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 15_000
}

function defaultTestPathForRequest(request: ProbeRequest): string {
  if (request.testMode === 'messages') return '/v1/messages'
  if (request.testMode === 'chat') return '/chat/completions'
  switch (request.provider) {
    case 'openai-compat':
    case 'moonshot':
    case 'custom':
      return '/models'
    case 'kimi':
    case 'anthropic':
      return '/v1/messages'
  }
}

function usesAnthropicMessagesProbe(request: ProbeRequest): boolean {
  if (request.testMode === 'messages' || request.provider === 'anthropic' || request.provider === 'kimi') {
    return true
  }
  const endpoint = request.model.endpoint?.toLowerCase() ?? ''
  return endpoint.includes('/anthropic') || endpoint.includes('/v1/messages')
}

function usesOpenAIChatProbe(request: ProbeRequest): boolean {
  if (request.testMode === 'chat') return true
  if (request.testMode === 'messages') return false
  return inferProbeMode(request.model.endpoint) === 'chat'
}

function inferProviderTemplate(input: Pick<ConfiguredModel, 'endpoint' | 'headers'> & { provider?: string }): ProviderTemplate | undefined {
  const explicit = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : ''
  if (explicit) {
    const fromId = PROVIDER_TEMPLATES.find(template => template.id === explicit)
    if (fromId) return fromId
  }

  const endpoint = input.endpoint?.toLowerCase() ?? ''
  if (endpoint.includes('dashscope') && endpoint.includes('compatible-mode')) {
    return PROVIDER_TEMPLATES.find(template => template.id === 'bailian')
  }
  if (endpoint.includes('openrouter.ai')) {
    return PROVIDER_TEMPLATES.find(template => template.id === 'openrouter')
  }
  if (endpoint.includes('api.minimax.io/anthropic') || endpoint.includes('api.minimaxi.com/anthropic')) {
    return PROVIDER_TEMPLATES.find(template => template.id === 'minimax-anthropic')
  }

  const normalized = normalizeProviderKind(input)
  return PROVIDER_TEMPLATES.find(template => template.id === normalized)
    ?? PROVIDER_TEMPLATES.find(template => template.provider === normalized)
}

function inferProbeMode(endpoint: string | undefined): ProviderProbeMode {
  const normalized = endpoint?.toLowerCase() ?? ''
  if (normalized.includes('/anthropic') || normalized.includes('/v1/messages')) return 'messages'
  if (normalized.includes('dashscope') && normalized.includes('compatible-mode')) return 'chat'
  return 'models'
}

function resolveTargetUrl(endpoint: string, testPath: string, provider: ProviderKind): string {
  const url = new URL(endpoint)
  const rawPath = testPath.trim()
  if (!rawPath) {
    return url.toString()
  }

  if (provider === 'anthropic') {
    const anthropicMessagePath = rewriteCompletionEndpointToMessages(url.pathname)
    if (anthropicMessagePath) {
      url.pathname = anthropicMessagePath
      return url.toString()
    }
    if (url.pathname.endsWith('/messages')) return url.toString()
    if (url.pathname.endsWith('/v1/messages')) return url.toString()
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = rawPath
      return url.toString()
    }
    if (url.pathname.endsWith('/v1')) {
      url.pathname = `${url.pathname}${rawPath.replace(/^\/v1/, '')}`
      return url.toString()
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`
    return url.toString()
  }

  if (url.pathname.endsWith('/models') || url.pathname.endsWith('/v1/models')) {
    return url.toString()
  }
  if (url.pathname.endsWith('/v1')) {
    url.pathname = `${url.pathname}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`
    return url.toString()
  }
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    return url.toString()
  }
  if (provider === 'kimi') {
    return url.toString()
  }
  url.pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  return url.toString()
}

function rewriteCompletionEndpointToMessages(pathname: string): string | null {
  if (pathname.endsWith('/v1/chat/completions')) {
    return `${pathname.slice(0, -'/v1/chat/completions'.length)}/v1/messages`
  }
  if (pathname.endsWith('/chat/completions')) {
    return `${pathname.slice(0, -'/chat/completions'.length)}/messages`
  }
  return null
}
