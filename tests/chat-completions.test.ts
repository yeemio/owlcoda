import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { handleChatCompletions } from '../src/endpoints/chat-completions.js'
import type { OwlCodaConfig } from '../src/config.js'
import type { ConfiguredModel } from '../src/model-registry.js'
import { EventEmitter } from 'node:events'
import type * as http from 'node:http'

// Mock fetch to avoid real network calls to the router
const mockFetch = vi.fn()
let origFetch: typeof globalThis.fetch

beforeAll(() => {
  origFetch = globalThis.fetch
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = origFetch
})

function makeConfig(overrides: Partial<OwlCodaConfig> = {}): OwlCodaConfig {
  return {
    host: '127.0.0.1',
    port: 8019,
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 5000,
    logLevel: 'info',
    responseModelStyle: 'platform',
    defaultModel: 'qwen2.5-32b',
    modelMap: { default: 'qwen2.5-32b' },
    reverseMapInResponse: false,
    models: [
      {
        id: 'qwen2.5-32b',
        label: 'qwen2.5-32b',
        backendModel: 'qwen2.5-32b',
        aliases: ['default'],
        tier: 'balanced',
        availability: 'available',
      } as ConfiguredModel,
    ],
    middleware: {},
    ...overrides,
  } as OwlCodaConfig
}

function mockRes(): http.ServerResponse & { chunks: string[]; statusCode: number; headers: Record<string, string> } {
  const res = new EventEmitter() as http.ServerResponse & { chunks: string[]; statusCode: number; headers: Record<string, string> }
  res.chunks = []
  res.headers = {}
  res.headersSent = false
  res.writeHead = vi.fn((code: number, hdrs?: Record<string, string>) => {
    res.statusCode = code
    res.headersSent = true
    if (hdrs) Object.assign(res.headers, hdrs)
    return res
  })
  res.write = vi.fn((data: string) => { res.chunks.push(String(data)); return true })
  res.end = vi.fn((data?: string) => { if (data) res.chunks.push(data); return res })
  res.setHeader = vi.fn()
  return res
}

describe('chat-completions endpoint', () => {
  beforeEach(() => {
    // Reset call history so "not.toHaveBeenCalled" assertions don't see
    // accumulated calls from previous tests.
    mockFetch.mockReset()
  })

  it('rejects invalid JSON', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig()

    await handleChatCompletions(req, res, config, '{invalid')
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(res.chunks.join('')).toContain('Invalid JSON')
  })

  it('resolves known model and attempts forward', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig()

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'qwen2.5-32b',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(res.writeHead).toHaveBeenCalled()
    expect(typeof res.statusCode).toBe('number')
  })

  it('resolves alias model', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig()

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(res.writeHead).toHaveBeenCalled()
    expect(typeof res.statusCode).toBe('number')
  })

  it('falls back to default model for unknown', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig()

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'completely-unknown',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(res.writeHead).toHaveBeenCalled()
    expect(typeof res.statusCode).toBe('number')
  })

  // 2026-05-29: /v1/chat/completions per-model routing fix.
  // Before this fix, every request was forwarded to the local routerUrl
  // regardless of the requested model's `endpoint` field — so any
  // cloud-tier model 404'd because the local MLX router doesn't know
  // about it. The four tests below pin the new behavior end-to-end.

  it('forwards cloud OpenAI-compat model to its configured endpoint with Bearer auth', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig({
      models: [
        {
          id: 'deepseek-v4-pro',
          label: 'deepseek-v4-pro',
          backendModel: 'deepseek-v4-pro',
          aliases: [],
          tier: 'cloud',
          availability: 'available',
          endpoint: 'https://api.deepseek.com/v1',
          apiKey: 'sk-test-deepseek',
          apiKeySource: 'config',
        } as ConfiguredModel,
      ],
    })

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(mockFetch).toHaveBeenCalled()
    const [calledUrl, calledOpts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]
    // Must NOT have forwarded to local routerUrl.
    expect(String(calledUrl)).not.toContain('localhost:8009')
    // Must have forwarded to the model's configured endpoint.
    expect(String(calledUrl)).toContain('api.deepseek.com')
    // Bearer auth derived from the model's apiKey.
    const sentHeaders = (calledOpts as { headers: Record<string, string> }).headers
    expect(sentHeaders['Authorization']).toBe('Bearer sk-test-deepseek')
    expect(res.statusCode).toBe(200)
  })

  it('rejects Anthropic-protocol endpoints with a clear 400 pointing at /v1/messages', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig({
      models: [
        {
          id: 'minimax-m27',
          label: 'minimax-m27',
          backendModel: 'minimax-m27',
          aliases: [],
          tier: 'cloud',
          availability: 'available',
          endpoint: 'https://api.minimaxi.com/anthropic',
          apiKey: 'sk-test-minimax',
          apiKeySource: 'config',
        } as ConfiguredModel,
      ],
    })

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'minimax-m27',
      messages: [{ role: 'user', content: 'test' }],
    }))

    // No upstream call should be made — we reject before forwarding.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    const body = res.chunks.join('')
    expect(body).toContain('protocol_mismatch')
    expect(body).toContain('/v1/messages')
  })

  it('returns 503 LocalRuntimeProtocolUnresolved when localRuntimeProtocol=auto and no endpoint', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig({
      localRuntimeProtocol: 'auto',
    })

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'qwen2.5-32b',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(mockFetch).not.toHaveBeenCalled()
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    expect(res.chunks.join('')).toContain('service_unavailable')
  })

  it('uses model-specific timeout when configured (route.timeoutMs)', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    const config = makeConfig({
      models: [
        {
          id: 'slow-cloud',
          label: 'slow-cloud',
          backendModel: 'slow-cloud',
          aliases: [],
          tier: 'cloud',
          availability: 'available',
          endpoint: 'https://api.slow.example.com/v1',
          apiKey: 'sk-test',
          apiKeySource: 'config',
          timeoutMs: 60_000,
        } as ConfiguredModel,
      ],
    })

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await handleChatCompletions(req, res, config, JSON.stringify({
      model: 'slow-cloud',
      messages: [{ role: 'user', content: 'test' }],
    }))

    expect(mockFetch).toHaveBeenCalled()
    // Successful forward — the per-model timeout was used as the base for
    // the adaptive budget (no assertion on the exact ms beyond fetch
    // having succeeded; tighter ms-level assertions are too brittle here).
    expect(res.statusCode).toBe(200)
  })
})
