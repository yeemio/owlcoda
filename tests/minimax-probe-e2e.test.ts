/**
 * End-to-end MiniMax provider-probe tests against an in-process fake server.
 *
 * The Windows feedback was that even when MiniMax appeared "configured" in
 * Admin, real calls failed in opaque ways. Static unit-mocks pass without
 * proving the probe actually round-trips through HTTP correctly. This file
 * stands up a real http.Server, asserts the exact route, headers, and body
 * the probe sends, then exercises the diagnostic surface for representative
 * upstream failure modes (401 / 404 / 429 / 5xx).
 *
 * No real MiniMax credentials are required and no live network calls are
 * made — the probe is pointed at 127.0.0.1 with a fresh ephemeral port per
 * test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ProviderProbe } from '../src/provider-probe.js'

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | undefined>
  body: string
}

interface FakeServer {
  baseUrl: string
  close: () => Promise<void>
  setResponse: (response: { status: number, body: string, headers?: Record<string, string> }) => void
  requests: CapturedRequest[]
}

async function startFakeMiniMax(): Promise<FakeServer> {
  let closed = false
  const requests: CapturedRequest[] = []
  let nextResponse: { status: number, body: string, headers?: Record<string, string> } = {
    status: 200,
    body: JSON.stringify({
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'MiniMax-M2.7-highspeed',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    headers: { 'content-type': 'application/json' },
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'UNKNOWN',
        url: req.url ?? '',
        headers: { ...req.headers } as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf-8'),
      })
      res.writeHead(nextResponse.status, nextResponse.headers ?? { 'content-type': 'application/json' })
      res.end(nextResponse.body)
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind fake MiniMax server')
  }
  // The provider preset's path is `/anthropic`. Reproduce that on the fake
  // server by exposing the base URL with `/anthropic` included so the probe
  // resolves `${endpoint}/v1/messages` → `127.0.0.1:port/anthropic/v1/messages`.
  const baseUrl = `http://127.0.0.1:${address.port}/anthropic`

  return {
    baseUrl,
    requests,
    setResponse: (response) => { nextResponse = response },
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) { resolve(); return }
      closed = true
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

describe('MiniMax provider probe (fake server e2e)', () => {
  let server: FakeServer

  beforeEach(async () => {
    server = await startFakeMiniMax()
  })

  afterEach(async () => {
    await server.close()
  })

  it('POSTs /anthropic/v1/messages with x-api-key, anthropic-version, and the configured backend model', async () => {
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-m27',
      label: 'MiniMax M2.7-highspeed',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: server.baseUrl,
      apiKey: 'sk-minimax-fake',
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.endpoint.endsWith('/anthropic/v1/messages')).toBe(true)
    expect(result.backendModel).toBe('MiniMax-M2.7-highspeed')

    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('/anthropic/v1/messages')
    expect(captured.headers['x-api-key']).toBe('sk-minimax-fake')
    expect(captured.headers['anthropic-version']).toBe('2023-06-01')
    expect(captured.headers['content-type']).toBe('application/json')

    const body = JSON.parse(captured.body) as Record<string, unknown>
    expect(body['model']).toBe('MiniMax-M2.7-highspeed')
    expect(body['max_tokens']).toBe(1)
    expect(body['messages']).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('surfaces MiniMax-style 401 invalid_api_key with body context for diagnostics', async () => {
    server.setResponse({
      status: 401,
      body: JSON.stringify({
        error: { type: 'authentication_error', code: 'invalid_api_key', message: 'API key is invalid' },
      }),
    })
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-m27',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: server.baseUrl,
      apiKey: 'sk-bad',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.bodySnippet).toContain('invalid_api_key')
    expect(result.bodySnippet).toContain('API key is invalid')
  })

  it('surfaces MiniMax-style 404 model_not_found with the bad model id in the body snippet', async () => {
    server.setResponse({
      status: 404,
      body: JSON.stringify({
        error: { type: 'not_found_error', code: 'model_not_found', message: 'Model MiniMax-Mystery does not exist' },
      }),
    })
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-mystery',
      backendModel: 'MiniMax-Mystery',
      endpoint: server.baseUrl,
      apiKey: 'sk-good',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
    expect(result.bodySnippet).toContain('model_not_found')
    expect(result.bodySnippet).toContain('MiniMax-Mystery')
  })

  it('surfaces MiniMax-style 429 rate-limit responses verbatim', async () => {
    server.setResponse({
      status: 429,
      body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }),
    })
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-m27',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: server.baseUrl,
      apiKey: 'sk-good',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.bodySnippet).toContain('rate_limit_error')
  })

  it('surfaces MiniMax-style 5xx upstream failures with the upstream request id', async () => {
    server.setResponse({
      status: 502,
      body: JSON.stringify({ error: { type: 'api_error', message: 'upstream gateway is unavailable' } }),
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-mm-fake-502' },
    })
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-m27',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: server.baseUrl,
      apiKey: 'sk-good',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(502)
    expect(result.detail).toContain('req-mm-fake-502')
    expect(result.bodySnippet).toContain('upstream gateway is unavailable')
  })

  it('flags an unreachable endpoint as a connect failure rather than a fake-success', async () => {
    // Close the fake server to simulate the network failure mode Windows
    // users hit when they paste the wrong regional endpoint or when a
    // corporate proxy blocks egress.
    await server.close()
    const probe = new ProviderProbe()
    const result = await probe.test({
      provider: 'anthropic',
      id: 'minimax-m27',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: server.baseUrl,
      apiKey: 'sk-good',
    })

    expect(result.ok).toBe(false)
    expect(result.bodySnippet).toBeUndefined()
    expect(result.detail.length).toBeGreaterThan(0)
  })
})
