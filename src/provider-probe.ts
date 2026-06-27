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

export interface ModelDescriptor {
  id: string
  displayName?: string
}

export interface ProviderProbeResult {
  ok: boolean
  status: number
  latencyMs: number
  detail: string
  /** Provider template id the probe ran against (e.g. 'kimi', 'openai-compat'). Truthful breadcrumb so callers can verify which provider was actually hit. */
  provider: string
  /** Fully-resolved URL the probe sent its request to. Empty string when the probe short-circuited before URL resolution (missing endpoint, fetch unavailable). */
  endpoint: string
  /** Backend model id that the probe sent in the request body (or asserted should be visible for /models listings). */
  backendModel: string
  /** Where the API key for this probe came from: 'config' if explicit in OwlCoda config, 'env' if resolved through apiKeyEnv, 'unset' if no key was available. */
  credentialSource?: 'env' | 'config' | 'unset'
  /** Raw response body snippet (truncated) when the probe failed at the HTTP layer. Omitted on success and on connection-level failures (no body to read). */
  bodySnippet?: string
  /** The endpoint's real model, discovered best-effort via GET /models (its display_name when available). Distinct from backendModel, which is what the probe sent. Omitted when the endpoint exposes no usable /models list. */
  resolvedModel?: ModelDescriptor
}

export interface ProviderVisionProbeResult {
  supported: boolean
  status: number
  latencyMs: number
  detail: string
  provider: string
  endpoint: string
  backendModel: string
  credentialSource?: 'env' | 'config' | 'unset'
  bodySnippet?: string
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
  tier?: 'cloud' | 'local' | 'custom'
  endpoint: string
  defaultModelId?: string
  defaultModelLabel?: string
  defaultBackendModel?: string
  defaultAliases?: string[]
  defaultContextWindow?: number
  headers?: Record<string, string>
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
    id: 'kimi',
    provider: 'kimi',
    label: 'Kimi',
    tier: 'cloud',
    endpoint: 'https://api.kimi.com/coding/v1',
    defaultModelId: 'kimi-code',
    defaultModelLabel: 'Kimi Code',
    defaultBackendModel: 'kimi-for-coding',
    defaultAliases: ['kimi'],
    defaultContextWindow: 256000,
    headers: { 'User-Agent': 'KimiCLI/1.33.0' },
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'single-model',
    description: 'Domestic brand adapter. Paste a Kimi key; OwlCoda uses the Kimi Code route that is already proven in dogfood.',
    backendModelHint: 'Default is kimi-for-coding. Change only if your Kimi model picker shows a newer exact id.',
    featured: true,
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers-and-models.html',
  },
  {
    id: 'kimi-k2.7-code',
    provider: 'moonshot',
    label: 'Kimi K2.7 Code',
    tier: 'cloud',
    endpoint: 'https://api.moonshot.ai/v1',
    defaultModelId: 'kimi-k2.7-code',
    defaultModelLabel: 'Kimi K2.7 Code',
    defaultBackendModel: 'kimi-k2.7-code',
    defaultAliases: ['kimi27', 'kimi-2.7', 'kimi-vision'],
    defaultContextWindow: 256000,
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'single-model',
    description: 'Kimi API Platform route for K2.7 Code. Supports text and base64 image inputs through OpenAI-compatible chat completions.',
    backendModelHint: 'Default is kimi-k2.7-code. Use kimi-k2.7-code-highspeed only if your account has access.',
    featured: true,
    docs: 'https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart',
  },
  {
    id: 'deepseek',
    provider: 'anthropic',
    label: 'DeepSeek',
    tier: 'cloud',
    endpoint: 'https://api.deepseek.com/anthropic',
    defaultModelId: 'deepseek',
    defaultModelLabel: 'DeepSeek',
    defaultBackendModel: 'deepseek-chat',
    defaultAliases: ['deepseek', 'ds'],
    defaultContextWindow: 128000,
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Domestic brand adapter. Uses the Anthropic-compatible DeepSeek route favored by external coding-assistant switchers.',
    backendModelHint: 'Default is deepseek-chat.',
    featured: true,
  },
  {
    id: 'glm',
    provider: 'anthropic',
    label: 'GLM',
    tier: 'cloud',
    endpoint: 'https://api.z.ai/api/anthropic',
    defaultModelId: 'glm',
    defaultModelLabel: 'GLM',
    defaultBackendModel: 'glm-5',
    defaultAliases: ['glm', 'zai'],
    defaultContextWindow: 128000,
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Domestic brand adapter for Zhipu / z.ai GLM. Paste a GLM key and keep the default model unless your console says otherwise.',
    backendModelHint: 'Default is glm-5.',
    featured: true,
    docs: 'https://z.ai',
  },
  {
    id: 'minimax',
    provider: 'anthropic',
    label: 'MiniMax',
    tier: 'cloud',
    endpoint: 'https://api.minimaxi.com/anthropic',
    defaultModelId: 'minimax-m27',
    defaultModelLabel: 'MiniMax M2.7-highspeed',
    defaultBackendModel: 'MiniMax-M2.7-highspeed',
    defaultAliases: ['minimax', 'm27'],
    defaultContextWindow: 204800,
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Domestic brand adapter. Uses the MiniMax Anthropic-compatible route; paste a key and test.',
    endpointHint: 'Default is the China host api.minimaxi.com. Use the generic Anthropic-compatible channel if your account is global-only.',
    backendModelHint: 'Default is MiniMax-M2.7-highspeed.',
    featured: true,
    docs: 'https://platform.minimax.io/docs/guides/text-ai-coding-tools',
  },
  {
    id: 'gpt',
    provider: 'openai-compat',
    label: 'GPT',
    tier: 'cloud',
    endpoint: 'https://api.openai.com/v1',
    defaultModelId: 'gpt',
    defaultModelLabel: 'GPT',
    defaultBackendModel: 'gpt-5.1',
    defaultAliases: ['gpt', 'openai'],
    defaultContextWindow: 256000,
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'single-model',
    description: 'Global brand adapter for OpenAI GPT. Paste an OpenAI API key.',
    backendModelHint: 'Default is gpt-5.1; change it if your OpenAI account should use a different GPT model.',
    featured: true,
    docs: 'https://platform.openai.com/docs/models',
  },
  {
    id: 'claude',
    provider: 'anthropic',
    label: 'Claude',
    tier: 'cloud',
    endpoint: 'https://api.anthropic.com',
    defaultModelId: 'claude',
    defaultModelLabel: 'Claude',
    defaultBackendModel: 'claude-sonnet-4-5-20250929',
    defaultAliases: ['claude', 'sonnet'],
    defaultContextWindow: 200000,
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'single-model',
    description: 'Global brand adapter for Anthropic Claude. Paste an Anthropic key.',
    backendModelHint: 'Default is Claude Sonnet 4.5.',
    featured: true,
    docs: 'https://docs.anthropic.com',
  },
  {
    id: 'gemini',
    provider: 'openai-compat',
    label: 'Gemini',
    tier: 'cloud',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModelId: 'gemini',
    defaultModelLabel: 'Gemini',
    defaultBackendModel: 'gemini-2.5-pro',
    defaultAliases: ['gemini'],
    defaultContextWindow: 1048576,
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'single-model',
    description: 'Global brand adapter for Google Gemini through the OpenAI-compatible API.',
    backendModelHint: 'Default is gemini-2.5-pro.',
    featured: true,
    docs: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'grok',
    provider: 'openai-compat',
    label: 'Grok',
    tier: 'cloud',
    endpoint: 'https://api.x.ai/v1',
    defaultModelId: 'grok',
    defaultModelLabel: 'Grok',
    defaultBackendModel: 'grok-4',
    defaultAliases: ['grok', 'xai'],
    defaultContextWindow: 256000,
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'single-model',
    description: 'Global brand adapter for xAI Grok through its OpenAI-compatible API.',
    backendModelHint: 'Default is grok-4.',
    featured: true,
    docs: 'https://docs.x.ai/docs/api-reference',
  },
  {
    id: 'openai-compat',
    provider: 'openai-compat',
    label: 'OpenAI-compatible',
    tier: 'custom',
    endpoint: '',
    testPath: '/chat/completions',
    testMode: 'chat',
    family: 'multi-model',
    description: 'Other providers: choose this for any OpenAI-compatible chat/completions endpoint.',
    endpointHint: 'Paste the base URL, for example api.your-gateway.com/v1. The https:// prefix is added automatically if missing.',
    backendModelHint: 'Enter the exact backend model id exposed by your provider.',
    requiresBackendModel: true,
  },
  {
    id: 'anthropic',
    provider: 'anthropic',
    label: 'Anthropic-compatible',
    tier: 'custom',
    endpoint: '',
    testPath: '/v1/messages',
    testMode: 'messages',
    family: 'multi-model',
    description: 'Other providers: choose this for any Anthropic-compatible /v1/messages endpoint.',
    endpointHint: 'Paste the base URL, for example api.your-relay.com/anthropic. The https:// prefix is added automatically if missing.',
    backendModelHint: 'Enter the exact backend model id exposed by your provider.',
    requiresBackendModel: true,
  },
  {
    id: 'ollama',
    provider: 'openai-compat',
    label: 'Ollama',
    tier: 'local',
    endpoint: 'http://localhost:11434/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Local Ollama runtime. Exposes OpenAI-compatible /v1 endpoints on the default port 11434.',
    endpointHint: 'Default is http://localhost:11434/v1. Change the host or port if your Ollama listens elsewhere.',
    backendModelHint: 'Enter the exact local model id from `ollama list`, for example llama3.1:8b.',
    requiresBackendModel: true,
  },
  {
    id: 'lm-studio',
    provider: 'openai-compat',
    label: 'LM Studio',
    tier: 'local',
    endpoint: 'http://localhost:1234/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Local LM Studio server. Start the LM Studio Local Server tab first; default port 1234.',
    endpointHint: 'Default is http://localhost:1234/v1. Adjust if you changed the LM Studio server port.',
    backendModelHint: 'Enter the backend model id LM Studio shows for the currently loaded model.',
    requiresBackendModel: true,
  },
  {
    id: 'vllm',
    provider: 'openai-compat',
    label: 'vLLM',
    tier: 'local',
    endpoint: 'http://localhost:8000/v1',
    testPath: '/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Local vLLM OpenAI-compatible server. Default port 8000 unless vLLM was started with --port.',
    endpointHint: 'Default is http://localhost:8000/v1. Change if vLLM was started with --port or --host.',
    backendModelHint: 'Enter the exact model id passed to vLLM --served-model-name, or the HuggingFace repo id.',
    requiresBackendModel: true,
  },
  {
    id: 'owlmlx',
    provider: 'openai-compat',
    label: 'owlmlx (Apple MLX)',
    tier: 'local',
    endpoint: 'http://localhost:8066/v1',
    testPath: '/openai/models',
    testMode: 'models',
    family: 'multi-model',
    description: 'Local owlmlx runtime for Apple Silicon. Default port 8066, OpenAI-compatible surface.',
    endpointHint: 'Default is http://localhost:8066/v1. owlmlx exposes /v1/openai/models for visibility and /v1/chat/completions for generation.',
    backendModelHint: 'Enter the exact model id visible via owlmlx /v1/openai/models.',
    requiresBackendModel: true,
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
    const credentialSource: 'env' | 'config' | 'unset' = request.model.apiKeySource ?? 'unset'
    const breadcrumb = {
      provider: request.providerId,
      backendModel: request.model.backendModel ?? request.model.id ?? '',
      credentialSource,
    }

    if (!request.model.endpoint) {
      return {
        ok: false,
        status: 400,
        latencyMs: 0,
        detail: 'Missing endpoint',
        ...breadcrumb,
        endpoint: '',
      }
    }

    if (!this.deps.fetch) {
      return {
        ok: false,
        status: 500,
        latencyMs: 0,
        detail: 'Fetch API is unavailable',
        ...breadcrumb,
        endpoint: request.model.endpoint,
      }
    }

    const { url, init } = buildRequest(request)
    const start = this.deps.now()
    try {
      const response = await this.deps.fetch(url, init)
      const latencyMs = Math.max(0, this.deps.now() - start)
      const rawBody = await response.text()
      if (!response.ok) {
        const diagnostic = createProviderHttpDiagnostic(response.status, rawBody, {
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
          ...breadcrumb,
          endpoint: url,
          ...(rawBody ? { bodySnippet: truncateBody(rawBody) } : {}),
        }
      }
      let resolvedModel: ModelDescriptor | undefined
      if (usesModelListProbe(request)) {
        const descriptors = extractModelDescriptors(rawBody)
        const listedModels = descriptors.map(descriptor => descriptor.id)
        const backendModel = request.model.backendModel ?? request.model.id
        if (backendModel && listedModels.length > 0 && !listedModels.includes(backendModel)) {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            detail: `Provider responded, but selected model "${backendModel}" is not visible from /models. No fallback model was tested.`,
            ...breadcrumb,
            endpoint: url,
            ...(rawBody ? { bodySnippet: truncateBody(rawBody) } : {}),
          }
        }
        if (backendModel && listedModels.length === 0) {
          return {
            ok: false,
            status: response.status,
            latencyMs,
            detail: `Provider /models response did not include model ids, so OwlCoda could not verify selected model "${backendModel}". No fallback model was tested.`,
            ...breadcrumb,
            endpoint: url,
            ...(rawBody ? { bodySnippet: truncateBody(rawBody) } : {}),
          }
        }
        resolvedModel = resolveModelDescriptor(descriptors, backendModel)
      } else if (usesOpenAIChatProbe(request)) {
        // A chat probe only proves the endpoint answers; it doesn't reveal which
        // model actually served it. Single-model coding routes (e.g. Kimi) ignore
        // the model field and only expose their true version via /models, so make
        // a best-effort GET /models to surface the real model. Never fail on it.
        resolvedModel = await this.tryResolveModelFromList(request)
      }
      return {
        ok: true,
        status: response.status,
        latencyMs,
        detail: `${request.providerId} probe succeeded for ${breadcrumb.backendModel || request.model.id}`,
        ...breadcrumb,
        endpoint: url,
        ...(resolvedModel ? { resolvedModel } : {}),
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
        ...breadcrumb,
        endpoint: url,
      }
    }
  }

  async testVision(input: ConfiguredModel | DryRunProviderPayload): Promise<ProviderVisionProbeResult> {
    const request = normalizeProbeInput(input)
    const credentialSource: 'env' | 'config' | 'unset' = request.model.apiKeySource ?? 'unset'
    const breadcrumb = {
      provider: request.providerId,
      backendModel: request.model.backendModel ?? request.model.id ?? '',
      credentialSource,
    }

    if (!request.model.endpoint) {
      return {
        supported: false,
        status: 400,
        latencyMs: 0,
        detail: 'Missing endpoint',
        ...breadcrumb,
        endpoint: '',
      }
    }

    if (!this.deps.fetch) {
      return {
        supported: false,
        status: 500,
        latencyMs: 0,
        detail: 'Fetch API is unavailable',
        ...breadcrumb,
        endpoint: request.model.endpoint,
      }
    }

    const { url, init } = buildVisionProbeRequest(request)
    const start = this.deps.now()
    try {
      const response = await this.deps.fetch(url, init)
      const latencyMs = Math.max(0, this.deps.now() - start)
      const rawBody = await response.text()
      if (!response.ok) {
        const diagnostic = createProviderHttpDiagnostic(response.status, rawBody, {
          provider: request.providerId,
          model: request.model.id,
          endpointUrl: request.model.endpoint,
          headers: request.model.headers,
          upstreamRequestId: upstreamRequestIdFromHeaders(response.headers),
        })
        return {
          supported: false,
          status: diagnostic.status ?? response.status,
          latencyMs,
          detail: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
          ...breadcrumb,
          endpoint: url,
          ...(rawBody ? { bodySnippet: truncateBody(rawBody) } : {}),
        }
      }

      return {
        supported: true,
        status: response.status,
        latencyMs,
        detail: `${request.providerId} vision probe succeeded for ${breadcrumb.backendModel || request.model.id}`,
        ...breadcrumb,
        endpoint: url,
      }
    } catch (error) {
      const diagnostic = classifyProviderRequestError(error, {
        provider: request.providerId,
        model: request.model.id,
        endpointUrl: request.model.endpoint,
        headers: request.model.headers,
      })
      return {
        supported: false,
        status: diagnostic.status ?? 0,
        latencyMs: Math.max(0, this.deps.now() - start),
        detail: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
        ...breadcrumb,
        endpoint: url,
      }
    }
  }

  /**
   * Best-effort GET /models to discover the endpoint's real model. Returns
   * undefined on any failure (no list, non-2xx, parse error, network/timeout) —
   * this never affects the probe verdict, it only enriches a successful one.
   */
  private async tryResolveModelFromList(request: ProbeRequest): Promise<ModelDescriptor | undefined> {
    if (!this.deps.fetch || !request.model.endpoint) return undefined
    try {
      const url = resolveModelsListUrl(request.model.endpoint)
      const headers = new Headers(request.model.headers ?? {})
      if (request.model.apiKey) headers.set('authorization', `Bearer ${request.model.apiKey}`)
      const response = await this.deps.fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(MODELS_LIST_PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const descriptors = extractModelDescriptors(await response.text())
      return resolveModelDescriptor(descriptors, request.model.backendModel ?? request.model.id)
    } catch {
      return undefined
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
    const testPath = request.testMode === 'messages' ? (request.testPath ?? '/v1/messages') : '/v1/messages'
    if (apiKey) headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', '2023-06-01')
    headers.set('content-type', 'application/json')
    return {
      url: resolveTargetUrl(request.model.endpoint!, testPath, 'anthropic'),
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

function buildVisionProbeRequest(request: ProbeRequest): { url: string, init: RequestInit } {
  const headers = new Headers(request.model.headers ?? {})
  const timeoutMs = resolveProbeTimeoutMs(request.model.timeoutMs)
  const apiKey = request.model.apiKey

  if (usesAnthropicMessagesProbe(request)) {
    const testPath = request.testMode === 'messages' ? (request.testPath ?? '/v1/messages') : '/v1/messages'
    if (apiKey) headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', '2023-06-01')
    headers.set('content-type', 'application/json')
    return {
      url: resolveTargetUrl(request.model.endpoint!, testPath, 'anthropic'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model.backendModel,
          max_tokens: 1,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: VISION_PROBE_PNG_BASE64,
                },
              },
              { type: 'text', text: VISION_PROBE_TEXT },
            ],
          }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    }
  }

  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  headers.set('content-type', 'application/json')
  const testPath = request.testMode === 'chat' ? (request.testPath ?? '/chat/completions') : '/chat/completions'
  return {
    url: resolveTargetUrl(request.model.endpoint!, testPath, request.provider),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model.backendModel,
        max_tokens: 1,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROBE_TEXT },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG_BASE64}` },
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  }
}

function resolveProbeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 15_000
}

const PROBE_BODY_SNIPPET_MAX = 500

// Best-effort /models discovery should not stall the Test-connection UI.
const MODELS_LIST_PROBE_TIMEOUT_MS = 5_000

const VISION_PROBE_TEXT = 'Reply with one short word describing the image.'
const VISION_PROBE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwP2WQAAAABJRU5ErkJggg=='

/**
 * Build the `/models` URL for an endpoint base, independent of resolveTargetUrl
 * (which has provider-specific rewrites — notably the kimi branch always rewrites
 * to /chat/completions). Strips a trailing chat/messages path so a configured
 * generation endpoint still resolves to its sibling /models.
 */
function resolveModelsListUrl(endpoint: string): string {
  const url = new URL(endpoint)
  const base = url.pathname.replace(/\/+$/, '')
  const stripped = base
    .replace(/\/chat\/completions$/, '')
    .replace(/\/v1\/messages$/, '')
    .replace(/\/messages$/, '')
  url.pathname = `${stripped}/models`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function truncateBody(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length <= PROBE_BODY_SNIPPET_MAX) return trimmed
  const head = trimmed.slice(0, PROBE_BODY_SNIPPET_MAX)
  return `${head}…[truncated, ${trimmed.length - PROBE_BODY_SNIPPET_MAX} more chars]`
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
      return '/chat/completions'
    case 'anthropic':
      return '/v1/messages'
  }
}

function usesAnthropicMessagesProbe(request: ProbeRequest): boolean {
  if (request.testMode === 'messages' || request.provider === 'anthropic') {
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

function usesModelListProbe(request: ProbeRequest): boolean {
  if (usesAnthropicMessagesProbe(request) || usesOpenAIChatProbe(request)) return false
  const path = (request.testPath ?? defaultTestPathForRequest(request)).trim().toLowerCase()
  return path === 'models' || path.endsWith('/models')
}

export function extractModelDescriptors(rawBody: string): ModelDescriptor[] {
  if (!rawBody.trim()) return []
  try {
    const parsed = JSON.parse(rawBody) as unknown
    const out = new Map<string, ModelDescriptor>()
    collectModelDescriptors(parsed, out)
    return [...out.values()]
  } catch {
    return []
  }
}

function collectModelDescriptors(value: unknown, out: Map<string, ModelDescriptor>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectModelDescriptors(item, out)
    return
  }

  const record = value as Record<string, unknown>
  if (typeof record.id === 'string' && record.id.trim() && !out.has(record.id)) {
    const displayName = pickModelDisplayName(record)
    out.set(record.id, displayName ? { id: record.id, displayName } : { id: record.id })
  }
  const nested = record.data ?? record.models
  if (Array.isArray(nested)) {
    for (const item of nested) collectModelDescriptors(item, out)
  }
}

function pickModelDisplayName(record: Record<string, unknown>): string | undefined {
  for (const key of ['display_name', 'displayName', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Pick the real model from a /models descriptor list. A single-model endpoint
 * (a coding route that ignores the model field) exposes exactly one model — that
 * IS the answer, whatever the user typed. With several models, match the sent
 * backendModel by id; if nothing matches confidently, return undefined rather
 * than fabricate one.
 */
export function resolveModelDescriptor(
  descriptors: ModelDescriptor[],
  backendModel: string | undefined,
): ModelDescriptor | undefined {
  if (descriptors.length === 0) return undefined
  if (descriptors.length === 1) return descriptors[0]
  if (backendModel) {
    const match = descriptors.find(descriptor => descriptor.id === backendModel)
    if (match) return match
  }
  return undefined
}

function inferProviderTemplate(input: Pick<ConfiguredModel, 'endpoint' | 'headers'> & { provider?: string }): ProviderTemplate | undefined {
  const explicit = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : ''
  if (explicit) {
    const fromId = PROVIDER_TEMPLATES.find(template => template.id === explicit)
    if (fromId) return fromId
  }

  const endpoint = input.endpoint?.toLowerCase() ?? ''
  if (endpoint.includes('api.kimi.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'kimi')
  if (endpoint.includes('api.deepseek.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'deepseek')
  if (endpoint.includes('api.z.ai') || endpoint.includes('open.bigmodel.cn')) return PROVIDER_TEMPLATES.find(template => template.id === 'glm')
  if (endpoint.includes('api.minimax.io') || endpoint.includes('api.minimaxi.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'minimax')
  if (endpoint.includes('api.openai.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'gpt')
  if (endpoint.includes('api.anthropic.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'claude')
  if (endpoint.includes('generativelanguage.googleapis.com')) return PROVIDER_TEMPLATES.find(template => template.id === 'gemini')
  if (endpoint.includes('api.x.ai')) return PROVIDER_TEMPLATES.find(template => template.id === 'grok')

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

  if (provider === 'kimi') {
    const normalized = url.pathname.replace(/\/+$/, '')
    if (normalized.endsWith('/coding/v1/chat/completions') || normalized.endsWith('/chat/completions')) {
      return url.toString()
    }
    if (normalized.endsWith('/coding/v1')) {
      url.pathname = `${normalized}/chat/completions`
      return url.toString()
    }
    if (normalized.endsWith('/coding')) {
      url.pathname = `${normalized}/v1/chat/completions`
      return url.toString()
    }
    if (normalized.endsWith('/v1')) {
      url.pathname = `${normalized}/chat/completions`
      return url.toString()
    }
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
