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

  it('probes openai-compatible dry-run payloads via chat completions by default', async () => {
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
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('authorization')).toBe('Bearer sk-openai')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      model: 'gpt-4.1',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.backendModel).toBe('gpt-4.1')
  })

  it('still fails explicit /models probes when the selected backend model is not visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'fallback-model' }] }), { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'openai-compat',
      id: 'selected-model',
      backendModel: 'selected-model',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      testPath: '/models',
      testMode: 'models',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
    expect(result.backendModel).toBe('selected-model')
    expect(result.detail).toContain('selected model "selected-model" is not visible')
    expect(result.detail).toContain('No fallback model was tested')
  })

  it('probes GPT brand presets through OpenAI chat completions', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'gpt',
      id: 'gpt',
      backendModel: 'gpt-5.1',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('authorization')).toBe('Bearer sk-openai')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      model: 'gpt-5.1',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('probes Kimi Code saved models via official chat completions route', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('authorization')).toBe('Bearer sk-kimi')
    expect(headers.get('anthropic-version')).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('upgrades legacy Kimi Code base endpoints to /coding/v1/chat/completions before probing', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding',
      apiKey: 'sk-kimi',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/chat/completions',
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

  it('also routes the international MiniMax endpoint as anthropic messages', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test(makeModel({
      id: 'minimax-m27',
      label: 'MiniMax M2.7-highspeed',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: 'https://api.minimax.io/anthropic',
      apiKey: 'sk-minimax-global',
    }))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/anthropic/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('x-api-key')).toBe('sk-minimax-global')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  it('publishes a single default MiniMax preset', () => {
    const minimax = getProviderTemplates().find(template => template.id === 'minimax')

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

  it('probes GLM brand presets via Anthropic-compatible messages', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test(makeModel({
      provider: 'glm',
      id: 'glm',
      label: 'GLM',
      backendModel: 'glm-5',
      endpoint: 'https://api.z.ai/api/anthropic',
      apiKey: 'sk-glm',
    }))

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.z.ai/api/anthropic/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = fetchMock.mock.calls[0]![1].headers as Headers
    expect(headers.get('x-api-key')).toBe('sk-glm')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      model: 'glm-5',
      max_tokens: 1,
    })
    expect(result.ok).toBe(true)
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
      provider: 'gpt',
      id: 'gpt',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
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

  it('returns truthful breadcrumb on success: provider, resolved endpoint, backend model', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const probe = createProbe()

    const result = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('kimi')
    expect(result.endpoint).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(result.backendModel).toBe('kimi-for-coding')
    expect(result.bodySnippet).toBeUndefined()
  })

  it('attaches raw response body snippet on HTTP failure so callers can see the upstream payload verbatim', async () => {
    const upstreamBody = JSON.stringify({ error: { code: 'model_not_found', message: 'requested model is not available' } })
    fetchMock.mockResolvedValue(new Response(upstreamBody, { status: 404, headers: { 'content-type': 'application/json' } }))
    const probe = createProbe()

    const failed = await probe.test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
    })

    expect(failed.ok).toBe(false)
    expect(failed.provider).toBe('kimi')
    expect(failed.endpoint).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(failed.backendModel).toBe('kimi-for-coding')
    expect(failed.bodySnippet).toContain('model_not_found')
    expect(failed.bodySnippet).toContain('requested model is not available')
  })

  it('omits body snippet on connection-level failures (no response body to read)', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
    Object.assign(err, { code: 'ECONNREFUSED', syscall: 'connect' })
    fetchMock.mockRejectedValue(err)
    const probe = createProbe()

    const failed = await probe.test({
      provider: 'gpt',
      id: 'gpt',
      backendModel: 'gpt-5.1',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
    })

    expect(failed.ok).toBe(false)
    expect(failed.provider).toBe('gpt')
    expect(failed.endpoint).toBe('https://api.openai.com/v1/chat/completions')
    expect(failed.backendModel).toBe('gpt-5.1')
    expect(failed.bodySnippet).toBeUndefined()
  })

  it('truncates body snippets over 500 chars and surfaces a truncation suffix', async () => {
    const longBody = `${'x'.repeat(800)}TAIL`
    fetchMock.mockResolvedValue(new Response(longBody, { status: 500 }))
    const probe = createProbe()

    const failed = await probe.test({
      provider: 'custom',
      id: 'huge',
      backendModel: 'huge',
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    })

    expect(failed.ok).toBe(false)
    expect(failed.bodySnippet).toBeDefined()
    expect(failed.bodySnippet!.length).toBeLessThanOrEqual(500 + 60)
    expect(failed.bodySnippet).toContain('truncated, ')
    expect(failed.bodySnippet).not.toContain('TAIL')
  })

  it('still surfaces provider and backend model when the probe short-circuits on missing endpoint', async () => {
    const probe = createProbe()
    const missing = await probe.test({ provider: 'kimi', id: 'kimi-code', backendModel: 'kimi-for-coding' })

    expect(missing.ok).toBe(false)
    expect(missing.status).toBe(400)
    expect(missing.provider).toBe('kimi')
    expect(missing.endpoint).toBe('')
    expect(missing.backendModel).toBe('kimi-for-coding')
  })
})

describe('getProviderTemplates', () => {
  it('lists provider families with admin-facing metadata', () => {
    const templates = getProviderTemplates()
    const ids = templates.map(provider => provider.id)
    expect(ids).toEqual([
      'kimi',
      'deepseek',
      'glm',
      'minimax',
      'gpt',
      'claude',
      'gemini',
      'grok',
      'openai-compat',
      'anthropic',
      'ollama',
      'lm-studio',
      'vllm',
      'owlmlx',
    ])

    expect(templates.find(provider => provider.id === 'kimi')).toMatchObject({
      provider: 'kimi',
      endpoint: 'https://api.kimi.com/coding/v1',
      defaultModelId: 'kimi-code',
      defaultBackendModel: 'kimi-for-coding',
      defaultAliases: ['kimi'],
      headers: { 'User-Agent': 'KimiCLI/1.33.0' },
      testPath: '/chat/completions',
      testMode: 'chat',
    })
    expect(templates.find(provider => provider.id === 'deepseek')).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.deepseek.com/anthropic',
      defaultBackendModel: 'deepseek-chat',
      testMode: 'messages',
    })
    expect(templates.find(provider => provider.id === 'openai-compat')).toMatchObject({
      provider: 'openai-compat',
      endpoint: '',
      testMode: 'chat',
      requiresBackendModel: true,
    })
    expect(templates.find(provider => provider.id === 'anthropic')).toMatchObject({
      provider: 'anthropic',
      endpoint: '',
      testMode: 'messages',
      requiresBackendModel: true,
    })
    expect(templates.find(provider => provider.id === 'ollama')).toMatchObject({
      provider: 'openai-compat',
      tier: 'local',
      endpoint: 'http://localhost:11434/v1',
      testMode: 'models',
      requiresBackendModel: true,
    })
    expect(templates.find(provider => provider.id === 'owlmlx')).toMatchObject({
      provider: 'openai-compat',
      tier: 'local',
      endpoint: 'http://localhost:8066/v1',
      testMode: 'models',
    })
    expect(templates.find(provider => provider.id === 'kimi')?.tier).toBe('cloud')
    expect(templates.find(provider => provider.id === 'openai-compat')?.tier).toBe('custom')
  })
})
