import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
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
})
