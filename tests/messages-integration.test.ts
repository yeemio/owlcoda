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
import {
  configureCircuitBreaker,
  getCircuitState,
  recordFailure,
  resetCircuitBreaker,
} from '../src/middleware/circuit-breaker.js'
import { getErrorBudget, resetBudgets } from '../src/error-budget.js'
import { getModelMetrics, resetModelMetrics } from '../src/perf-tracker.js'

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

  it('records the requested model in request audit entries instead of the path', async () => {
    mockRouterHandler = undefined as any

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'audit model field' }],
      max_tokens: 100,
    })
    expect(res.status).toBe(200)

    const auditRes = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/audit?path=/v1/messages&limit=1`)
    const audit = await auditRes.json() as { entries: Array<{ path: string; model: string; statusCode: number }> }

    expect(audit.entries[0]).toMatchObject({
      path: '/v1/messages',
      model: 'default',
      statusCode: 200,
    })
  })

  it('rejects unknown requested models instead of silently serving the default', async () => {
    mockRouterHandler = undefined as any
    lastRouterRequest = null

    const res = await post('/v1/messages', {
      model: 'completely-unknown-model',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100,
    })

    expect(res.status).toBe(404)
    expect(res.body.error.type).toBe('not_found_error')
    expect(res.body.error.message).toContain('completely-unknown-model')
    expect(lastRouterRequest).toBeNull()
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

  it('accounts for a translated JSON response exactly once on the streaming path', async () => {
    resetCircuitBreaker()
    resetBudgets()
    resetModelMetrics()
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-json-stream',
        object: 'chat.completion',
        model: 'test-backend',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Translated JSON stream.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'translate JSON as SSE' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      const requestId = response.headers.get('x-request-id')
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('Translated JSON stream.')
      expect(text).toContain('event: message_stop')
      expect(getCircuitState('test-backend')).toMatchObject({ state: 'closed', failures: 0 })
      expect(getErrorBudget('test-backend')).toMatchObject({ total: 1, successes: 1, failures: 0 })
      expect(getModelMetrics('test-backend')).toMatchObject({
        requestCount: 1,
        failureCount: 0,
        totalInputTokens: 7,
        totalOutputTokens: 5,
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      const matchingAudit = (await readAuditLog(20)).filter(entry => entry.requestId === requestId)
      expect(matchingAudit).toHaveLength(1)
      expect(matchingAudit[0]).toMatchObject({
        servedBy: 'test-backend',
        inputTokens: 7,
        outputTokens: 5,
        status: 200,
        streaming: true,
      })
      expect(matchingAudit[0]?.failure).toBeUndefined()
    } finally {
      resetCircuitBreaker()
      resetBudgets()
      resetModelMetrics()
    }
  })

  it('reports malformed translated JSON as a streaming failure instead of synthesizing normal completion', async () => {
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.fallbackEnabled = false
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = false
    resetCircuitBreaker()
    resetBudgets()
    resetModelMetrics()
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"choices":[')
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'malformed JSON must fail' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      const requestId = response.headers.get('x-request-id')
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('event: error')
      expect(text).not.toContain('event: message_stop')
      expect(getCircuitState('test-backend')).toMatchObject({ failures: 1 })
      expect(getErrorBudget('test-backend')).toMatchObject({ total: 1, successes: 0, failures: 1 })
      expect(getModelMetrics('test-backend')).toMatchObject({ requestCount: 1, failureCount: 1 })

      await new Promise(resolve => setTimeout(resolve, 50))
      const matchingAudit = (await readAuditLog(20)).filter(entry => entry.requestId === requestId)
      expect(matchingAudit).toHaveLength(1)
      expect(matchingAudit[0]?.failure).toBeDefined()
    } finally {
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      resetCircuitBreaker()
      resetBudgets()
      resetModelMetrics()
    }
  })

  it('enforces the first-token watchdog while reading a translated JSON body', async () => {
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    const previousFirstTokenTimeout = owlcodaConfig.middleware?.streamFirstTokenTimeoutMs
    const previousTotalTimeout = owlcodaConfig.middleware?.streamTotalTimeoutMs
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.fallbackEnabled = false
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = false
    owlcodaConfig.middleware.streamFirstTokenTimeoutMs = 50
    owlcodaConfig.middleware.streamTotalTimeoutMs = 120
    resetCircuitBreaker()
    resetBudgets()
    let lateBodySent = false
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      const timer = setTimeout(() => {
        lateBodySent = true
        res.end(JSON.stringify({
          id: 'chatcmpl-late-json',
          object: 'chat.completion',
          model: 'test-backend',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'LATE_JSON_SUCCESS' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }))
      }, 350)
      res.on('close', () => clearTimeout(timer))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'late JSON body must time out' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('event: error')
      expect(text).toContain('stream_first_token_timeout')
      expect(text).not.toContain('LATE_JSON_SUCCESS')
      expect(text).not.toContain('event: message_stop')
      expect(lateBodySent).toBe(false)
      expect(getCircuitState('test-backend').failures).toBe(1)
      expect(getErrorBudget('test-backend')).toMatchObject({ total: 1, successes: 0, failures: 1 })
    } finally {
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      if (previousFirstTokenTimeout === undefined) delete owlcodaConfig.middleware.streamFirstTokenTimeoutMs
      else owlcodaConfig.middleware.streamFirstTokenTimeoutMs = previousFirstTokenTimeout
      if (previousTotalTimeout === undefined) delete owlcodaConfig.middleware.streamTotalTimeoutMs
      else owlcodaConfig.middleware.streamTotalTimeoutMs = previousTotalTimeout
      resetCircuitBreaker()
      resetBudgets()
    }
  }, 20_000)

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
  it('preserves bare fields, multi-line data, and event-field SSE semantics without recovery', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      {
        id: 'multiline-primary',
        label: 'Multiline primary',
        backendModel: 'multiline-primary-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'general',
        default: true,
        contextWindow: 32768,
      },
      {
        id: 'multiline-fallback',
        label: 'Multiline fallback',
        backendModel: 'multiline-fallback-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]
    let nonStreamingCalls = 0
    mockRouterHandler = (_req, res) => {
      if (lastRouterRequest?.body?.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('id\n\n')
        res.write('event: content_block_delta\ndata: {"index":0,\ndata: "delta":{"type":"text_delta","text":"VISIBLE_MULTILINE"}}\n\n')
        res.write('event: message_stop\ndata: {}\n\n')
        res.end()
        return
      }
      nonStreamingCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'REPLACEMENT' }],
        model: lastRouterRequest?.body?.model ?? 'multiline-fallback-backend',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'multiline-primary',
          messages: [{ role: 'user', content: 'legal multiline SSE' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('VISIBLE_MULTILINE')
      expect(text).not.toContain('REPLACEMENT')
      expect(text).not.toContain('event: error')
      expect(response.headers.get('x-owlcoda-served-by')).toBe('multiline-primary-backend')
      expect(response.headers.get('x-owlcoda-fallback')).toBeNull()
      expect(nonStreamingCalls).toBe(0)
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it('records fetch failures only for fallback models that were actually attempted', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    const previousRetryMaxAttempts = owlcodaConfig.middleware?.retryMaxAttempts
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'openai_chat'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = false
    owlcodaConfig.middleware.retryMaxAttempts = 0
    owlcodaConfig.models = [
      {
        id: 'attempt-primary',
        label: 'Attempt primary',
        backendModel: 'attempt-primary-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'general',
        default: true,
        contextWindow: 32768,
      },
      {
        id: 'attempt-fallback',
        label: 'Skipped fallback',
        backendModel: 'attempt-fallback-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]
    resetCircuitBreaker()
    resetBudgets()
    configureCircuitBreaker({ threshold: 1, cooldownMs: 60_000 })
    recordFailure('attempt-fallback')
    let fallbackCalls = 0
    mockRouterHandler = (_req, res) => {
      if (lastRouterRequest?.body?.model === 'attempt-fallback-backend') {
        fallbackCalls += 1
      }
      res.destroy(new Error('fetch failed before response headers'))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'attempt-primary',
          messages: [{ role: 'user', content: 'only attempted models may fail' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      await response.text()

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(fallbackCalls).toBe(0)
      expect(getCircuitState('attempt-primary-backend').failures).toBe(1)
      expect(getErrorBudget('attempt-primary-backend')).toMatchObject({ total: 1, failures: 1 })
      expect(getCircuitState('attempt-fallback')).toMatchObject({ state: 'open', failures: 1 })
      expect(getErrorBudget('attempt-fallback')).toMatchObject({ total: 0, failures: 0 })
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      if (previousRetryMaxAttempts === undefined) delete owlcodaConfig.middleware.retryMaxAttempts
      else owlcodaConfig.middleware.retryMaxAttempts = previousRetryMaxAttempts
      resetCircuitBreaker()
      resetBudgets()
    }
  }, 20_000)

  it('records earlier fetch failures when the last attempted model recovers with JSON', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    const previousRetryMaxAttempts = owlcodaConfig.middleware?.retryMaxAttempts
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'openai_chat'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.middleware.retryMaxAttempts = 0
    owlcodaConfig.models = [
      {
        id: 'account-primary',
        label: 'Accounting primary',
        backendModel: 'account-primary-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/chat/completions`,
        tier: 'general',
        default: true,
        contextWindow: 32768,
      },
      {
        id: 'account-fallback',
        label: 'Accounting fallback',
        backendModel: 'account-fallback-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/chat/completions`,
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]
    resetCircuitBreaker()
    resetBudgets()
    let primaryStreamCalls = 0
    let fallbackStreamCalls = 0
    let fallbackJsonCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'account-primary-backend' && streaming) {
        primaryStreamCalls += 1
        res.destroy(new Error('fetch failed before headers'))
        return
      }
      if (requestModel === 'account-fallback-backend' && streaming) {
        fallbackStreamCalls += 1
        res.destroy(new Error('fetch failed before headers'))
        return
      }
      if (requestModel === 'account-fallback-backend') {
        fallbackJsonCalls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-accounting-recovery',
          object: 'chat.completion',
          model: 'account-fallback-backend',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'RECOVERED_ON_LAST_ATTEMPT' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }))
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected accounting request' } }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'account-primary',
          messages: [{ role: 'user', content: 'recover after two fetch failures' }],
          max_tokens: 100,
          stream: true,
        }),
      })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('RECOVERED_ON_LAST_ATTEMPT')
      expect(text).toContain('event: message_stop')
      expect(primaryStreamCalls).toBe(1)
      expect(fallbackStreamCalls).toBe(1)
      expect(fallbackJsonCalls).toBe(1)
      expect(getCircuitState('account-primary-backend').failures).toBe(1)
      expect(getErrorBudget('account-primary-backend')).toMatchObject({ total: 1, successes: 0, failures: 1 })
      expect(getCircuitState('account-fallback')).toMatchObject({ state: 'closed', failures: 0 })
      expect(getErrorBudget('account-fallback')).toMatchObject({ total: 1, successes: 1, failures: 0 })
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      if (previousRetryMaxAttempts === undefined) delete owlcodaConfig.middleware.retryMaxAttempts
      else owlcodaConfig.middleware.retryMaxAttempts = previousRetryMaxAttempts
      resetCircuitBreaker()
      resetBudgets()
    }
  }, 20_000)

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

  it('continues on a fallback model when the selected model fails before first token in both stream modes', async () => {
    const previousModels = owlcodaConfig.models
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels,
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    let primaryStreamCalls = 0
    let primaryNonStreamCalls = 0
    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        primaryStreamCalls += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"id":"chatcmpl-primary","object":"chat.completion.chunk","model":"test-backend","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n')
        setImmediate(() => res.destroy(new Error('primary stream closed after role-only chunk')))
        return
      }
      if (requestModel === 'test-backend') {
        primaryNonStreamCalls += 1
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'primary non-streaming recovery failed' } }))
        return
      }

      fallbackModelCalls += 1
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end([
          'data: {"id":"chatcmpl-cross-model","object":"chat.completion.chunk","model":"fallback-backend","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-cross-model","object":"chat.completion.chunk","model":"fallback-backend","choices":[{"index":0,"delta":{"content":"Recovered on fallback model."},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-cross-model","object":"chat.completion.chunk","model":"fallback-backend","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-cross-model',
        object: 'chat.completion',
        model: 'fallback-backend',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Recovered on fallback model.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'recover across models' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('Recovered on fallback model.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
      expect(text.match(/event: message_start/g)).toHaveLength(1)
      expect(primaryStreamCalls).toBeGreaterThanOrEqual(1)
      expect(primaryNonStreamCalls).toBeGreaterThanOrEqual(1)
      expect(fallbackModelCalls).toBeGreaterThanOrEqual(1)
      expect(response.headers.get('x-owlcoda-served-by')).toBe('fallback-model')
      expect(response.headers.get('x-owlcoda-fallback')).toBe('true')
    } finally {
      owlcodaConfig.models = previousModels
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it.each([
    {
      wireFormat: 'Anthropic SSE',
      controlFrames: [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_primary","type":"message","role":"assistant","content":[],"model":"test-backend","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
        '',
        'event: ping',
        'data: {"type":"ping"}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        '',
      ].join('\n'),
    },
    {
      wireFormat: 'raw JSON lines',
      controlFrames: [
        '{"type":"message_start","message":{"id":"msg_primary","type":"message","role":"assistant","content":[],"model":"test-backend","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
        '{"type":"ping"}',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
      ].join('\n'),
    },
  ])('discards uncommitted $wireFormat control frames before cross-model recovery', async ({ controlFrames }) => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels.map(model => ({
        ...model,
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
      })),
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    let primaryNonStreamCalls = 0
    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(controlFrames)
        setImmediate(() => res.destroy(new Error('primary stream closed after control frames')))
        return
      }
      if (requestModel === 'test-backend') {
        primaryNonStreamCalls += 1
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'primary non-streaming recovery failed' } }))
        return
      }

      fallbackModelCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_cross_model_control_frame_recovery',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered after buffered control frames.' }],
        model: 'fallback-backend',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 5 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'recover after upstream control frames' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('Recovered after buffered control frames.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
      expect(text.match(/event: message_start/g)).toHaveLength(1)
      expect(primaryNonStreamCalls).toBeGreaterThanOrEqual(1)
      expect(fallbackModelCalls).toBeGreaterThanOrEqual(1)
      expect(response.headers.get('x-owlcoda-served-by')).toBe('fallback-model')
      expect(response.headers.get('x-owlcoda-fallback')).toBe('true')
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it.each([
    {
      wireFormat: 'Anthropic SSE',
      messageStart: [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_buffer_limit","type":"message","role":"assistant","content":[],"model":"test-backend","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
        '',
        '',
      ].join('\n'),
      makePing: (index: number, padding: string) =>
        `event: ping\ndata: ${JSON.stringify({ type: 'ping', index, padding })}\n\n`,
    },
    {
      wireFormat: 'raw JSON lines',
      messageStart: '{"type":"message_start","message":{"id":"msg_buffer_limit","type":"message","role":"assistant","content":[],"model":"test-backend","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}\n',
      makePing: (index: number, padding: string) =>
        `${JSON.stringify({ type: 'ping', index, padding })}\n`,
    },
  ])('commits the primary $wireFormat lifecycle when non-visible control frames exceed the precommit byte budget', async ({ messageStart, makePing }) => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels.map(model => ({
        ...model,
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
      })),
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    const controlFrames = [messageStart]
    let controlFrameBytes = Buffer.byteLength(messageStart)
    let controlFrameIndex = 0
    while (controlFrameBytes <= 80 * 1024) {
      const padding = controlFrameIndex === 32 ? `precommit-limit-crossed-${'x'.repeat(2048)}` : 'x'.repeat(2048)
      const frame = makePing(controlFrameIndex, padding)
      controlFrames.push(frame)
      controlFrameBytes += Buffer.byteLength(frame)
      controlFrameIndex += 1
    }

    let primaryNonStreamCalls = 0
    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const frame of controlFrames) res.write(frame)
        res.end()
        return
      }
      if (requestModel === 'test-backend') {
        primaryNonStreamCalls += 1
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'must not retry after protocol commit' } }))
        return
      }

      if (requestModel === 'fallback-backend') {
        fallbackModelCalls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_unsafe_replay',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Must not replay after buffer commit.' }],
          model: 'fallback-backend',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 5 },
        }))
        return
      }

      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected mock request' } }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'bound non-visible control buffering' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(controlFrameBytes).toBeGreaterThan(80 * 1024)
      expect(text).toContain('precommit-limit-crossed')
      expect(text).toContain('event: error')
      expect(text).not.toContain('Must not replay after buffer commit.')
      expect(text.match(/event: message_start/g)).toHaveLength(1)
      expect(primaryNonStreamCalls).toBe(0)
      expect(fallbackModelCalls).toBe(0)
      expect(response.headers.get('x-owlcoda-served-by')).toBe('test-backend')
      expect(response.headers.get('x-owlcoda-fallback')).toBeNull()
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it.each([
    {
      wireFormat: 'Anthropic SSE',
      incompleteFramePrefix: 'event: ping\ndata: {"type":"ping","padding":"',
      continuationChunk: 'x'.repeat(2048),
    },
    {
      wireFormat: 'raw JSON line',
      incompleteFramePrefix: '{"type":"ping","padding":"',
      continuationChunk: 'x'.repeat(2048),
    },
    {
      wireFormat: 'undetermined wire-format prefix',
      incompleteFramePrefix: ' '.repeat(2048),
      continuationChunk: ' '.repeat(2048),
    },
  ])('fails closed when one incomplete $wireFormat parser frame exceeds the byte budget', async ({
    incompleteFramePrefix,
    continuationChunk,
  }) => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels.map(model => ({
        ...model,
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
      })),
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    let primaryNonStreamCalls = 0
    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(incompleteFramePrefix)
        for (let i = 0; i < 48; i += 1) res.write(continuationChunk)
        res.end()
        return
      }
      if (requestModel === 'test-backend') {
        primaryNonStreamCalls += 1
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'must not recover after parser limit' } }))
        return
      }
      if (requestModel === 'fallback-backend') {
        fallbackModelCalls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_unsafe_parser_replay',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Must not replay after parser limit.' }],
          model: 'fallback-backend',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 5 },
        }))
        return
      }

      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected mock request' } }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'bound incomplete parser frames' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('parser buffer limit')
      expect(text).toContain('65536')
      expect(text).toContain('event: error')
      expect(text).not.toContain('Must not replay after parser limit.')
      expect(primaryNonStreamCalls).toBe(0)
      expect(fallbackModelCalls).toBe(0)
      expect(response.headers.get('x-owlcoda-served-by')).toBe('test-backend')
      expect(response.headers.get('x-owlcoda-fallback')).toBeNull()
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it('detects Anthropic SSE when event and data prefixes are split across TCP chunks', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels.map(model => ({
        ...model,
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
      })),
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        const messageStart = {
          type: 'message_start',
          message: {
            id: 'msg_split_prefix',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'test-backend',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('ev')
        setTimeout(() => res.write('ent: message_start\nda'), 10)
        setTimeout(() => {
          res.write(`ta: ${JSON.stringify(messageStart)}\n\n`)
          res.end([
            'event: content_block_start',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Split SSE prefix parsed."}}',
            '',
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":0}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
            '',
          ].join('\n'))
        }, 20)
        return
      }
      if (requestModel === 'fallback-backend') {
        fallbackModelCalls += 1
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected recovery request' } }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'parse split SSE prefixes' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('Split SSE prefix parsed.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
      expect(text.match(/event: message_start/g)).toHaveLength(1)
      expect(fallbackModelCalls).toBe(0)
      expect(response.headers.get('x-owlcoda-served-by')).toBe('test-backend')
      expect(response.headers.get('x-owlcoda-fallback')).toBeNull()
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
    }
  }, 20_000)

  it('processes CRLF SSE frames when the delimiter is split across upstream chunks', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    const previousFirstTokenTimeout = owlcodaConfig.middleware?.streamFirstTokenTimeoutMs
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.models = previousModels.map(model => ({
      ...model,
      endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
    }))
    owlcodaConfig.middleware.fallbackEnabled = false
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = false
    owlcodaConfig.middleware.streamFirstTokenTimeoutMs = 1_000

    let tailSentAt = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      if (requestModel !== 'test-backend' || lastRouterRequest?.body?.stream !== true) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        return
      }

      const messageStart = JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_crlf_split',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-backend',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      })
      const visibleDelta = JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'CRLF visible before delayed tail.' },
      })
      const tailFrames = [
        `event: content_block_stop\r\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\r\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } })}`,
        `event: message_stop\r\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
      ].join('\r\n\r\n')

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: message_start\r\ndata: ${messageStart}\r\n\r\n`)
      // Leave the final CR of the visible frame's CRLFCRLF delimiter in the
      // first TCP write; the rest arrives in a separate write below.
      res.write(`event: content_block_delta\r\ndata: ${visibleDelta}\r`)
      setTimeout(() => {
        res.write('\n\r\n')
        setTimeout(() => {
          tailSentAt = Date.now()
          res.write(`${tailFrames}\r\n\r\n`)
          res.end()
        }, 220)
      }, 20)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'parse CRLF split SSE' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeTruthy()
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      let visibleAt = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (!visibleAt && text.includes('CRLF visible before delayed tail.')) visibleAt = Date.now()
      }
      text += decoder.decode()

      expect(visibleAt).toBeGreaterThan(0)
      expect(tailSentAt).toBeGreaterThan(0)
      expect(visibleAt).toBeLessThan(tailSentAt)
      expect(text).toContain('CRLF visible before delayed tail.')
      expect(text).toContain('event: message_stop')
      expect(text).not.toContain('event: error')
    } finally {
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      if (previousFirstTokenTimeout === undefined) delete owlcodaConfig.middleware.streamFirstTokenTimeoutMs
      else owlcodaConfig.middleware.streamFirstTokenTimeoutMs = previousFirstTokenTimeout
    }
  }, 20_000)

  it('counts a body-stage primary failure once and opens its circuit after cross-model recovery', async () => {
    const previousModels = owlcodaConfig.models
    const previousProtocol = owlcodaConfig.localRuntimeProtocol
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    const previousFirstTokenTimeout = owlcodaConfig.middleware?.streamFirstTokenTimeoutMs
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.localRuntimeProtocol = 'anthropic_messages'
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.middleware.streamFirstTokenTimeoutMs = 1_000
    owlcodaConfig.models = [
      {
        id: 'c-primary',
        label: 'C primary',
        backendModel: 'c-primary-backend',
        aliases: ['c-primary'],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'general',
        default: true,
        contextWindow: 32768,
      },
      {
        id: 'c-fallback',
        label: 'C fallback',
        backendModel: 'c-fallback-backend',
        aliases: [],
        endpoint: `http://127.0.0.1:${mockRouterPort}/v1/messages`,
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    resetCircuitBreaker()
    resetBudgets()
    configureCircuitBreaker({ threshold: 3, cooldownMs: 60_000 })
    let primaryStreamCalls = 0
    let primaryNonStreamCalls = 0
    let fallbackNonStreamCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'c-primary-backend' && streaming) {
        primaryStreamCalls += 1
        const messageStart = JSON.stringify({
          type: 'message_start',
          message: {
            id: `c-primary-${primaryStreamCalls}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'c-primary-backend',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`event: message_start\ndata: ${messageStart}\n\n`)
        setTimeout(() => res.destroy(new Error('primary body closed before visible output')), 10)
        return
      }
      if (requestModel === 'c-primary-backend') {
        primaryNonStreamCalls += 1
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'primary non-stream recovery failed' } }))
        return
      }
      if (requestModel === 'c-fallback-backend' && !streaming) {
        fallbackNonStreamCalls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered after body-stage failure.' }],
          model: 'c-fallback-backend',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 5 },
        }))
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected circuit test request' } }))
    }

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'c-primary',
            messages: [{ role: 'user', content: `body-stage recovery ${attempt}` }],
            max_tokens: 100,
            stream: true,
          }),
        })
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toContain('Recovered after body-stage failure.')
        expect(text).toContain('event: message_stop')
        expect(text).not.toContain('event: error')
        expect(response.headers.get('x-owlcoda-served-by')).toBe('c-fallback')
        expect(response.headers.get('x-owlcoda-fallback')).toBe('true')
      }

      const primaryCircuit = getCircuitState('c-primary-backend')
      expect(primaryCircuit.state).toBe('open')
      expect(primaryCircuit.failures).toBe(3)
      expect(getErrorBudget('c-primary-backend')).toMatchObject({ total: 3, successes: 0, failures: 3 })
      expect(getErrorBudget('c-fallback')).toMatchObject({ total: 3, successes: 3, failures: 0 })
      expect(primaryStreamCalls).toBe(3)
      expect(primaryNonStreamCalls).toBe(3)
      expect(fallbackNonStreamCalls).toBe(3)
    } finally {
      resetCircuitBreaker()
      resetBudgets()
      owlcodaConfig.models = previousModels
      owlcodaConfig.localRuntimeProtocol = previousProtocol
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
      if (previousFirstTokenTimeout === undefined) delete owlcodaConfig.middleware.streamFirstTokenTimeoutMs
      else owlcodaConfig.middleware.streamFirstTokenTimeoutMs = previousFirstTokenTimeout
    }
  }, 20_000)

  it('does not cross models when the selected model rejects non-streaming recovery with a client error', async () => {
    const previousModels = owlcodaConfig.models
    const previousFallbackEnabled = owlcodaConfig.middleware?.fallbackEnabled
    const previousStreamFallbackEnabled = owlcodaConfig.middleware?.streamFallbackToNonStreamingEnabled
    if (!owlcodaConfig.middleware) owlcodaConfig.middleware = {}
    owlcodaConfig.middleware.fallbackEnabled = true
    owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = true
    owlcodaConfig.models = [
      ...previousModels,
      {
        id: 'fallback-model',
        label: 'Fallback',
        backendModel: 'fallback-backend',
        aliases: [],
        tier: 'balanced',
        contextWindow: 32768,
      },
    ]

    let fallbackModelCalls = 0
    mockRouterHandler = (_req, res) => {
      const requestModel = lastRouterRequest?.body?.model
      const streaming = lastRouterRequest?.body?.stream === true
      if (requestModel === 'test-backend' && streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.flushHeaders()
        setImmediate(() => res.destroy(new Error('primary stream closed before first token')))
        return
      }
      if (requestModel === 'test-backend') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'request is invalid for every model' } }))
        return
      }

      fallbackModelCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-unsafe-fallback',
        object: 'chat.completion',
        model: 'fallback-backend',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Must not be used.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }))
    }

    try {
      const response = await fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'invalid across all models' }],
          max_tokens: 100,
          stream: true,
        }),
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('event: error')
      expect(text).not.toContain('Must not be used.')
      expect(fallbackModelCalls).toBe(0)
    } finally {
      owlcodaConfig.models = previousModels
      if (previousFallbackEnabled === undefined) delete owlcodaConfig.middleware.fallbackEnabled
      else owlcodaConfig.middleware.fallbackEnabled = previousFallbackEnabled
      if (previousStreamFallbackEnabled === undefined) delete owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled
      else owlcodaConfig.middleware.streamFallbackToNonStreamingEnabled = previousStreamFallbackEnabled
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
