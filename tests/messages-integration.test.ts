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
          // Return 404 — this mock is an OpenAI-compatible router, not an owlmlx runtime
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
  const config = makeConfig()
  owlcodaServer = startServer(config)
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
  it('classifies streaming body aborts as timeout, not user cancellation', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
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
    expect(text).toContain('"kind":"timeout"')
    expect(text).not.toContain('Request cancelled by user')

    await new Promise(resolve => setTimeout(resolve, 50))
    const entries = await readAuditLog(10)
    const failure = entries.find(entry => entry.requestId === response.headers.get('x-request-id'))
    expect(failure?.failure?.kind).toBe('timeout')
    expect(failure?.failure?.message).not.toContain('cancelled by user')
  }, 20_000)
})
