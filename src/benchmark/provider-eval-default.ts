import { resolveModelRoute, type ConfiguredModel } from '../model-registry.js'
import type { AnthropicMessagesResponse, OpenAIChatResponse } from '../types.js'
import type { BenchmarkDryRunResult } from './types.js'
import type {
  BenchmarkProviderEvalExecutor,
  BenchmarkProviderEvalExecutorInput,
} from './provider-eval.js'
import type { BenchmarkProviderEvalUsage } from './scorecard-adapter.js'

export interface BenchmarkProviderEvalActualBuilderInput {
  input: BenchmarkProviderEvalExecutorInput
  responseText: string
  usage: BenchmarkProviderEvalUsage
  durationMs: number
  rawResponse: unknown
}

export type BenchmarkProviderEvalActualBuilder = (
  input: BenchmarkProviderEvalActualBuilderInput
) => Promise<BenchmarkDryRunResult | undefined> | BenchmarkDryRunResult | undefined

export interface CreateBenchmarkProviderEvalExecutorOptions {
  model: ConfiguredModel
  fetch?: typeof globalThis.fetch
  maxTokens?: number
  temperature?: number
  actualResultBuilder?: BenchmarkProviderEvalActualBuilder
}

export function createBenchmarkProviderEvalExecutor(
  options: CreateBenchmarkProviderEvalExecutorOptions,
): BenchmarkProviderEvalExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch
  return async (input) => {
    if (!fetchImpl) {
      return { error: 'provider eval default executor requires fetch' }
    }

    const route = resolveModelRoute({
      models: [options.model],
      routerUrl: '',
      localRuntimeProtocol: 'openai_chat',
      responseModelStyle: 'platform',
      modelMap: {},
      defaultModel: options.model.id,
      reverseMapInResponse: true,
    }, options.model.id)

    const started = performance.now()
    try {
      const request = route.translate
        ? buildOpenAICompatibleRequest(route, input, options)
        : buildAnthropicCompatibleRequest(route, input, options)
      const response = await fetchImpl(request.url, request.init)
      const durationMs = Math.max(0, Math.round(performance.now() - started))
      const rawText = await response.text()
      if (!response.ok) {
        return {
          error: `provider eval request failed: HTTP ${response.status}: ${rawText.slice(0, 500)}`,
          usage: { durationMs },
        }
      }

      const raw = rawText ? JSON.parse(rawText) as unknown : {}
      const parsed = route.translate
        ? parseOpenAICompatibleResponse(raw as OpenAIChatResponse, durationMs)
        : parseAnthropicCompatibleResponse(raw as AnthropicMessagesResponse, durationMs)

      if (!options.actualResultBuilder) {
        return {
          error: 'provider eval received model output but no actualResultBuilder was configured to audit benchmark artifacts',
          usage: parsed.usage,
        }
      }

      const actual = await options.actualResultBuilder({
        input,
        responseText: parsed.text,
        usage: parsed.usage,
        durationMs,
        rawResponse: raw,
      })
      return { actual, usage: parsed.usage }
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        usage: { durationMs: Math.max(0, Math.round(performance.now() - started)) },
      }
    }
  }
}

function buildOpenAICompatibleRequest(
  route: { endpointUrl: string; backendModel: string; headers: Record<string, string>; timeoutMs?: number },
  input: BenchmarkProviderEvalExecutorInput,
  options: Pick<CreateBenchmarkProviderEvalExecutorOptions, 'maxTokens' | 'temperature'>,
): { url: string; init: RequestInit } {
  return {
    url: route.endpointUrl,
    init: {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify({
        model: route.backendModel,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal: input.signal,
    },
  }
}

function buildAnthropicCompatibleRequest(
  route: { endpointUrl: string; backendModel: string; headers: Record<string, string>; timeoutMs?: number },
  input: BenchmarkProviderEvalExecutorInput,
  options: Pick<CreateBenchmarkProviderEvalExecutorOptions, 'maxTokens' | 'temperature'>,
): { url: string; init: RequestInit } {
  return {
    url: route.endpointUrl,
    init: {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify({
        model: route.backendModel,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal: input.signal,
    },
  }
}

function parseOpenAICompatibleResponse(
  raw: OpenAIChatResponse,
  durationMs: number,
): { text: string; usage: BenchmarkProviderEvalUsage } {
  const text = raw.choices?.[0]?.message?.content ?? ''
  const usage = raw.usage
  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)),
      durationMs,
    },
  }
}

function parseAnthropicCompatibleResponse(
  raw: AnthropicMessagesResponse,
  durationMs: number,
): { text: string; usage: BenchmarkProviderEvalUsage } {
  const text = (raw.content ?? [])
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const usage = raw.usage
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs,
    },
  }
}
