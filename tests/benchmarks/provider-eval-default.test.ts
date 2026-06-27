import { describe, expect, it } from 'vitest'
import {
  createBenchmarkProviderEvalExecutor,
  runBenchmarkProviderEvalCase,
  type ConfiguredModel,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval default executor', () => {
  it('calls an OpenAI-compatible provider and lets an audit builder produce the benchmark actual', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const executor = createBenchmarkProviderEvalExecutor({
      model: configuredModel({
        id: 'gpt-test',
        provider: 'openai',
        backendModel: 'gpt-4.1-test',
        endpoint: 'https://api.openai.test/v1',
        apiKey: 'sk-test',
      }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return jsonResponse({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'benchmark output' },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        })
      },
      actualResultBuilder: async ({ input }) => ({
        ...input.expected,
        binaryBuild: 'provider-openai-actual',
      }),
    })

    const result = await runBenchmarkProviderEvalCase({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: 'gpt-test',
      evalRunId: 'openai-default',
      executor,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.openai.test/v1/chat/completions')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer sk-test')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toMatchObject({
      model: 'gpt-4.1-test',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: expect.stringContaining('/'),
      }],
    })
    expect(result.observation.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    })
    expect(result.observation.usage?.durationMs).toEqual(expect.any(Number))
    expect(result.observation.actual?.binaryBuild).toBe('provider-openai-actual')
    expect(result.scorecardPacket.providerEval.usage).toEqual(result.observation.usage)
  })

  it('calls an Anthropic-compatible provider with messages transport', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const executor = createBenchmarkProviderEvalExecutor({
      model: configuredModel({
        id: 'claude-test',
        provider: 'anthropic',
        backendModel: 'claude-sonnet-test',
        endpoint: 'https://api.anthropic.test/v1/messages',
        apiKey: 'sk-ant-test',
      }),
      maxTokens: 512,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return jsonResponse({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-test',
          content: [{ type: 'text', text: 'benchmark output' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        })
      },
      actualResultBuilder: async ({ input }) => ({
        ...input.expected,
        binaryBuild: 'provider-anthropic-actual',
      }),
    })

    const result = await runBenchmarkProviderEvalCase({
      caseId: 'readonly-review',
      providerId: 'anthropic',
      modelId: 'claude-test',
      evalRunId: 'anthropic-default',
      executor,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.test/v1/messages')
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toMatchObject({
      model: 'claude-sonnet-test',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: expect.stringContaining('Review'),
      }],
    })
    expect(result.observation.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    })
    expect(result.observation.actual?.binaryBuild).toBe('provider-anthropic-actual')
  })

  it('does not pretend a raw provider text response is a benchmark actual without an audit builder', async () => {
    const executor = createBenchmarkProviderEvalExecutor({
      model: configuredModel({
        id: 'gpt-test',
        provider: 'openai',
        backendModel: 'gpt-4.1-test',
        endpoint: 'https://api.openai.test/v1',
        apiKey: 'sk-test',
      }),
      fetch: async () => jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'looks done' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
    })

    const result = await runBenchmarkProviderEvalCase({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: 'gpt-test',
      evalRunId: 'missing-audit-builder',
      executor,
    })

    expect(result.observation.actual).toBeUndefined()
    expect(result.observation.error).toContain('actualResultBuilder')
    expect(result.observation.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    })
    expect(result.scorecardPacket.scorecard.verdict).toBe('fail')
  })
})

function configuredModel(input: {
  id: string
  provider: string
  backendModel: string
  endpoint: string
  apiKey: string
}): ConfiguredModel {
  return {
    id: input.id,
    label: input.id,
    backendModel: input.backendModel,
    aliases: [],
    tier: 'cloud',
    provider: input.provider,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
