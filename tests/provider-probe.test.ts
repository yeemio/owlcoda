import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderProbe, getProviderTemplates } from '../src/provider-probe.js'
import type { ConfiguredModel } from '../src/model-registry.js'

function makeModel(overrides: Partial<ConfiguredModel>): ConfiguredModel {
  return {
    id: 'test-model',
    label: 'Test Model',
    backendModel: 'test-model',
    aliases: [],
    tier: 'cloud',
    endpoint: 'https://api.example.com/v1',
    contextWindow: 32768,
    ...overrides,
  }
}

describe('ProviderProbe', () => {
  const fetchMock = vi.fn()
  let now = 1_000

  beforeEach(() => {
    fetchMock.mockReset()
    now = 1_000
  })

  function createProbe() {
    return new ProviderProbe({
      deps: {
        fetch: fetchMock as unknown as typeof fetch,
        now: () => {
          now += 25
          return now
        },
      },
    })
  }

  it('probes anthropic saved models via POST /v1/messages', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test(makeModel({
      endpoint: 'https://api.anthropic.com',
      apiKey: 'sk-test',
    }))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('x-api-key')).toBe('sk-test')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('probes openai-compatible dry-run payloads via GET /models', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'openai-compat',
      id: 'dry-run',
      backendModel: 'gpt-4.1',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('authorization')).toBe('Bearer sk-openai')
    expect(result.status).toBe(200)
  })

  it('probes Bailian-compatible dry-run payloads via POST /chat/completions', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'bailian',
      id: 'qwen-plus',
      backendModel: 'qwen-plus',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-bailian',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('authorization')).toBe('Bearer sk-bailian')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      model: 'qwen-plus',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('probes kimi saved models via POST /v1/messages with anthropic-style headers', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding',
      apiKey: 'sk-kimi',
      headers: { 'X-Msh-Platform': 'kimi_cli' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('x-api-key')).toBe('sk-kimi')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-msh-platform')).toBe('kimi_cli')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('rewrites saved kimi chat-completions endpoints to /v1/messages before probing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'sk-kimi',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('treats /anthropic endpoints as anthropic-style probes', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test(makeModel({
      id: 'minimax-m27',
      label: 'MiniMax M2.7-highspeed',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-minimax',
    }))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimaxi.com/anthropic/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('x-api-key')).toBe('sk-minimax')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('publishes a MiniMax preset matching the working OwlCoda configuration', () => {
    const minimax = getProviderTemplates().find(template => template.id === 'minimax-anthropic')

    expect(minimax).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.minimaxi.com/anthropic',
      defaultModelId: 'minimax-m27',
      defaultModelLabel: 'MiniMax M2.7-highspeed',
      defaultBackendModel: 'MiniMax-M2.7-highspeed',
      defaultAliases: ['minimax', 'm27'],
      defaultContextWindow: 204800,
      testPath: '/v1/messages',
      testMode: 'messages',
      family: 'single-model',
    })
  })

  it('falls back to the default probe timeout when saved timeoutMs is invalid', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    await probe.test(makeModel({
      endpoint: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-minimax',
      timeoutMs: -2,
    }))

    const init = fetchMock.mock.calls[0]![1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('supports custom dry-run test paths', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    await probe.test({
      provider: 'custom',
      id: 'custom-model',
      endpoint: 'http://127.0.0.1:8080/v1',
      apiKey: 'sk-custom',
      testPath: '/healthz',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/healthz',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns a structured failure when endpoint is missing or fetch throws', async () => {
    const probe = createProbe()
    const missing = await probe.test({ provider: 'custom', id: 'bad' })
    expect(missing.ok).toBe(false)
    expect(missing.status).toBe(400)

    const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
    Object.assign(err, { code: 'ECONNREFUSED', syscall: 'connect' })
    fetchMock.mockRejectedValue(err)
    const failed = await probe.test({
      provider: 'moonshot',
      id: 'moonshot',
      endpoint: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-moonshot',
    })
    expect(failed.ok).toBe(false)
    expect(failed.status).toBe(502)
    expect(failed.detail).toContain('unable to connect')
  })

  it('formats upstream HTTP failures with provider diagnostics', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad gateway' } }), {
      status: 502,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'probe-upstream-502',
      },
    }))
    const probe = createProbe()

    const failed = await probe.test({
      provider: 'anthropic',
      id: 'messages-vendor-model',
      backendModel: 'messages-vendor-3-7',
      endpoint: 'https://api.anthropic.com',
      apiKey: 'sk-test',
    })

    expect(failed.ok).toBe(false)
    expect(failed.status).toBe(502)
    expect(failed.detail).toContain('upstream 502 from provider')
    expect(failed.detail).toContain('probe-upstream-502')
  })
})

describe('getProviderTemplates', () => {
  it('lists provider families with admin-facing metadata', () => {
    const templates = getProviderTemplates()
    const ids = templates.map(provider => provider.id)
    expect(ids).toEqual([
      'anthropic',
      'openai-compat',
      'openrouter',
      'bailian',
      'kimi',
      'moonshot',
      'minimax-anthropic',
      'custom',
    ])

    expect(templates.find(provider => provider.id === 'bailian')).toMatchObject({
      provider: 'openai-compat',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      testPath: '/chat/completions',
      testMode: 'chat',
      requiresBackendModel: true,
    })
  })
})
