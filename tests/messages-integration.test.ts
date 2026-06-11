/**
 * Messages endpoint integration tests — real HTTP server + mock router.
 * Tests the full /v1/messages pipeline: translation, error handling, headers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'
import { resetCache } from '../src/response-cache.js'
import { readAuditLog } from '../src/audit.js'
import { __resetAdmissionForTesting } from '../src/endpoints/admission.js'

// ─── Mock Router ───
// Simulates an OpenAI-compatible backend

let mockRouter: http.Server
let mockRouterPort: number
let lastRouterRequest: { method: string; url: string; body: any; headers: Record<string, string> } | null = null
let mockRouterHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void

function startMockRouter(): Promise<void> {
  return new Promise(resolve => {
    mockRouter = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        let body: any = null
        try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
        lastRouterRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body,
          headers: req.headers as Record<string, string>,
        }

        // Probe endpoints: return proper responses so protocol detection works
        const url = req.url ?? '/'
        if (url === '/v1/runtime/status') {
          // Return 404 — this mock is an OpenAI-compatible router rather than an owlmlx runtime
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"error":"not found"}')
          return
        }
        if (url === '/v1/models') {
          // Return OpenAI /v1/models response → probeRuntimeSurface detects openai_chat
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'test-backend' }] }))
          return
        }

        if (mockRouterHandler) {
          mockRouterHandler(req, res)
        } else {
          // Default: return valid OpenAI chat completion
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body?.model ?? 'test-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Hello from mock router!' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }))
        }
      })
    })
    mockRouter.listen(0, '127.0.0.1', () => {
      mockRouterPort = (mockRouter.address() as { port: number }).port
      resolve()
    })
  })
}

// ─── OwlCoda Server ───

let owlcodaServer: http.Server
let owlcodaPort: number
let auditHomeDir: string
let owlcodaConfig: OwlCodaConfig

function makeConfig(): OwlCodaConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    routerUrl: `http://127.0.0.1:${mockRouterPort}`,
    routerTimeoutMs: 1000,
    models: [
      { id: 'test-model', label: 'Test', backendModel: 'test-backend', aliases: ['default'], tier: 'general', default: true, contextWindow: 32768 },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
    contextWindow: 32768,
    localRuntimeProtocol: 'openai_chat',
    // 0.14.2: the streaming-timeout test below classifies the first-token
    // path directly; without disabling fallback, the synthesizer would
    // re-fetch the same `: ping`-only mock and stall.
    middleware: {
      streamFallbackToNonStreamingEnabled: false,
      // 0.14.5: hangs-forever upstream would also stall the
      // non-streaming → streaming fallback. Tests in this file
      // exercise the wording-emission path directly.
      nonStreamFallbackToStreamingEnabled: false,
    },
  } as unknown as OwlCodaConfig
}

function post(path: string, body: any): Promise<{ status: number; body: any; headers: Headers }> {
  return fetch(`http://127.0.0.1:${owlcodaPort}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async res => ({
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
  }))
}

beforeAll(async () => {
  auditHomeDir = mkdtempSync('/tmp/owlcoda-messages-audit-')
  process.env['OWLCODA_HOME'] = auditHomeDir
  await startMockRouter()
  owlcodaConfig = makeConfig()
  owlcodaServer = startServer(owlcodaConfig)
  await new Promise<void>(resolve => {
    owlcodaServer.on('listening', () => {
      owlcodaPort = (owlcodaServer.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(() => {
  owlcodaServer?.close()
  mockRouter?.close()
  rmSync(auditHomeDir, { recursive: true, force: true })
  delete process.env['OWLCODA_HOME']
})

describe('messages endpoint — non-streaming', () => {
  beforeAll(() => {
    // Reset handler to default
    mockRouterHandler = undefined as any
  })

  beforeEach(() => {
    resetCache()
  })

  it('translates request and returns Anthropic-format response', async () => {
    mockRouterHandler = undefined as any
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
    })
    expect(res.status).toBe(200)
    expect(res.body.type).toBe('message')
    expect(res.body.role).toBe('assistant')
    expect(res.body.content).toBeDefined()
    expect(Array.isArray(res.body.content)).toBe(true)
    expect(res.body.content[0].type).toBe('text')
    expect(res.body.content[0].text).toBe('Hello from mock router!')
  })

  it('forwards to correct backend model', async () => {
    mockRouterHandler = undefined as any
    await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100,
    })
    expect(lastRouterRequest).not.toBeNull()
    expect(lastRouterRequest!.body.model).toBe('test-backend')
    expect(lastRouterRequest!.url).toBe('/v1/chat/completions')
  })

  it('returns usage stats in response', async () => {
    mockRouterHandler = undefined as any
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(res.body.usage).toBeDefined()
    expect(res.body.usage.input_tokens).toBeGreaterThanOrEqual(0)
    expect(res.body.usage.output_tokens).toBeGreaterThanOrEqual(0)
  })

  it('sets x-owlcoda-served-by header', async () => {
    mockRouterHandler = undefined as any
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(res.headers.get('x-owlcoda-served-by')).toBeTruthy()
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await post('/v1/messages', 'not json{{{')
    expect(res.status).toBe(400)
    expect(res.body.type).toBe('error')
    expect(res.body.error.type).toBe('invalid_request_error')
  })

  it('returns 400 for missing model field', async () => {
    const res = await post('/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(res.status).toBe(400)
    expect(res.body.type).toBe('error')
  })

  it('returns 400 for missing messages field', async () => {
    const res = await post('/v1/messages', {
      model: 'default',
      max_tokens: 100,
    })
    expect(res.status).toBe(400)
    expect(res.body.type).toBe('error')
  })

  it('maps upstream 500 to Anthropic error', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal Server Error' }))
    }
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body.type).toBe('error')
  })

  it('returns structured diagnostics for upstream provider failures', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'x-request-id': 'provider-502',
      })
      res.end(JSON.stringify({ error: { message: 'bad gateway' } }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })

    expect(res.status).toBe(502)
    expect(res.body.error.message).toContain('upstream 502 from provider')
    expect(res.body.error.diagnostic).toMatchObject({
      model: 'default',
      kind: 'http_5xx',
      requestId: expect.any(String),
      retryable: true,
      upstreamRequestId: 'provider-502',
    })
  })

  it('CORS headers are set', async () => {
    mockRouterHandler = undefined as any
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('messages endpoint — streaming', () => {
  it('returns SSE stream with event-stream content type', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n')
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234,"model":"test","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n')
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const text = await response.text()
    expect(text).toContain('event:')
    expect(text.length).toBeGreaterThan(0)
  })

  it('returns error for stream with upstream failure', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Service Unavailable' }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      stream: true,
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body.type).toBe('error')
  })
})

describe('messages endpoint — request timeout', () => {
  it('returns error when upstream hangs beyond per-model timeout', async () => {
    // Handler never responds — simulates a hanging backend
    mockRouterHandler = () => {}

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hello timeout' }],
      max_tokens: 100,
    })

    // Should get an error after retries exhaust (529 overloaded or timeout-related)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body.type).toBe('error')
    expect(res.body.error?.diagnostic?.kind).toBe('timeout')

    await new Promise(resolve => setTimeout(resolve, 50))
    const entries = await readAuditLog(10)
    const failure = entries.find(entry => entry.requestId === res.headers.get('x-request-id'))
    expect(failure).toBeTruthy()
    expect(failure?.failure).toBeDefined()
    expect(failure?.failure?.kind).toBe('timeout')
    expect(failure?.model).toBe('default')
    expect(failure?.durationMs).toBeGreaterThanOrEqual(0)
  }, 20_000)
})

describe('messages endpoint — streaming body timeout', () => {
  it('falls back to non-streaming when upstream stream socket closes before headers', async () => {
    const previous = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    let callCount = 0
    let streamCallCount = 0
    let nonStreamCallCount = 0
    mockRouterHandler = (_req, res) => {
      callCount += 1
      if (lastRouterRequest?.body?.stream === true) {
        streamCallCount += 1
        res.destroy(new Error('socket closed before response headers'))
        return
      }
      nonStreamCallCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-fetch-fallback',
        object: 'chat.completion',
        model: 'test-backend',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Recovered after fetch-level stream close.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'hi fetch-level stream close' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('Recovered after fetch-level stream close.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
      expect(callCount).toBeGreaterThanOrEqual(2)
      expect(streamCallCount).toBeGreaterThanOrEqual(1)
      expect(nonStreamCallCount).toBeGreaterThanOrEqual(1)
      expect(lastRouterRequest?.body?.stream).toBeUndefined()
    } finally {
      if (previous === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previous
    }
  }, 20_000)

  it('falls back to non-streaming when upstream stream closes before first token', async () => {
    const previous = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    let callCount = 0
    let streamCallCount = 0
    let nonStreamCallCount = 0
    mockRouterHandler = (_req, res) => {
      callCount += 1
      if (lastRouterRequest?.body?.stream === true) {
        streamCallCount += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.flushHeaders()
        setImmediate(() => res.destroy(new Error('socket closed before first token')))
        return
      }
      nonStreamCallCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        model: 'test-backend',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Recovered via non-streaming fallback.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'hi pre first token close' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('Recovered via non-streaming fallback.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
      expect(callCount).toBeGreaterThanOrEqual(2)
      expect(streamCallCount).toBeGreaterThanOrEqual(1)
      expect(nonStreamCallCount).toBeGreaterThanOrEqual(1)
      expect(lastRouterRequest?.body?.stream).toBeUndefined()
    } finally {
      if (previous === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previous
    }
  }, 20_000)

  it('classifies streaming body abort as stream_first_token_timeout (not "timeout", not user cancellation)', async () => {
    // 0.13.97: per-chunk idle deadline (routerTimeoutMs=1000ms in this test
    // config) fires when no chunk arrives within 1s. Pre-0.13.97 catch-all
    // labelled it kind='timeout'; 0.13.97 distinguishes:
    //   - no chunk seen ever → stream_first_token_timeout (partialOutputSeen=false)
    //   - chunk seen, then idle gap → stream_idle_timeout (partialOutputSeen=true)
    // Here the mock writes headers but never any body chunk, so the
    // per-chunk timer fires before any partial output → first-token kind.
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Send a `: ping` SSE comment so Node fetch returns Response (it
      // otherwise blocks until at least one body byte arrives). Comments
      // are filtered by parseSSEStream — markFirstChunkArrived is NOT
      // called for comment-only output, so the first-token state stays
      // false and the timeout still classifies as first-token.
      res.write(': ping\n\n')
    }

    const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: 'hi streaming timeout' }],
        max_tokens: 100,
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('event: error')
    expect(text).toContain('"kind":"stream_first_token_timeout"')
    expect(text).toContain('"partialOutputSeen":false')
    // Wording contract: no longer "before a usable response" anywhere.
    expect(text).not.toContain('before a usable response')
    expect(text).not.toContain('Request cancelled by user')

    await new Promise(resolve => setTimeout(resolve, 50))
    const entries = await readAuditLog(10)
    const failure = entries.find(entry => entry.requestId === response.headers.get('x-request-id'))
    expect(failure?.failure?.kind).toBe('stream_first_token_timeout')
    expect(failure?.failure?.partialOutputSeen).toBe(false)
    expect(failure?.failure?.message).not.toContain('cancelled by user')
  }, 20_000)
})

describe('messages endpoint — cross-process admission gate', () => {
  // Mock upstream that counts how many requests are in flight at once, so we
  // can prove the daemon admission gate serializes across concurrent requests.
  function countingDelayedHandler(state: { inFlight: number; max: number }, delayMs: number) {
    return (_req: http.IncomingMessage, res: http.ServerResponse) => {
      state.inFlight += 1
      state.max = Math.max(state.max, state.inFlight)
      setTimeout(() => {
        state.inFlight -= 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion', model: 'test-backend',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }))
      }, delayMs)
    }
  }

  beforeEach(() => {
    resetCache()
    __resetAdmissionForTesting()
  })

  afterAll(() => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    delete process.env.OWLCODA_AGENT_MAX_CONCURRENCY
    delete process.env.OWLCODA_DAEMON_ADMIT_WAIT_MS
    __resetAdmissionForTesting()
    mockRouterHandler = undefined as any
  })

  it('serializes concurrent requests to the upstream when cap=1 (no burst)', async () => {
    process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY = '1'
    process.env.OWLCODA_AGENT_MAX_CONCURRENCY = '1'
    process.env.OWLCODA_DAEMON_ADMIT_WAIT_MS = '5000'
    __resetAdmissionForTesting()
    const state = { inFlight: 0, max: 0 }
    mockRouterHandler = countingDelayedHandler(state, 80)

    const results = await Promise.all([0, 1, 2].map(i =>
      post('/v1/messages', { model: 'default', messages: [{ role: 'user', content: `Hi ${i}` }], max_tokens: 50 }),
    ))
    expect(results.every(r => r.status === 200)).toBe(true)
    // Gate bound = cap = 1 ⇒ upstream never sees more than one at a time.
    expect(state.max).toBe(1)
  })

  it('does not gate when the adaptive flag is off (default — burst reaches upstream)', async () => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    __resetAdmissionForTesting()
    const state = { inFlight: 0, max: 0 }
    mockRouterHandler = countingDelayedHandler(state, 80)

    const results = await Promise.all([0, 1, 2].map(i =>
      post('/v1/messages', { model: 'default', messages: [{ role: 'user', content: `Yo ${i}` }], max_tokens: 50 }),
    ))
    expect(results.every(r => r.status === 200)).toBe(true)
    // No gate ⇒ concurrent requests reach the upstream together.
    expect(state.max).toBeGreaterThan(1)
  })
})
