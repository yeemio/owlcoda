/**
 * 0.13.97 stream-lifecycle timeout regression tests.
 *
 * Three timeout layers exist after 0.13.97:
 *   1. middleware.requestTimeoutMs (default 120s) — wall-clock, NON-streaming only
 *   2. middleware.streamFirstTokenTimeoutMs (default 90s) — streaming first-chunk watchdog
 *   3. middleware.streamIdleTimeoutMs / route.timeoutMs / config.routerTimeoutMs
 *      — streaming per-chunk idle deadline (fresh timer per reader.read())
 *
 * These tests verify each layer fires only when it should, and that proxy
 * diagnostics carry the new ProviderFailureKind values + partialOutputSeen
 * flag through to the SSE error event.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'

let mockRouter: http.Server
let mockRouterPort: number
let mockRouterHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null

function startMockRouter(): Promise<void> {
  return new Promise(resolve => {
    mockRouter = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const url = req.url ?? '/'
        // Probe responses — match messages-integration.test.ts surface.
        if (url === '/v1/runtime/status') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"error":"not found"}')
          return
        }
        if (url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'test-backend' }] }))
          return
        }
        if (mockRouterHandler) {
          mockRouterHandler(req, res)
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end('{"error":"no handler set"}')
        }
      })
    })
    mockRouter.listen(0, '127.0.0.1', () => {
      mockRouterPort = (mockRouter.address() as { port: number }).port
      resolve()
    })
  })
}

let owlcodaServer: http.Server
let owlcodaPort: number
let homeDir: string

function makeConfig(overrides: Partial<NonNullable<OwlCodaConfig['middleware']>> = {}): OwlCodaConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    routerUrl: `http://127.0.0.1:${mockRouterPort}`,
    // Per-route HTTP timeout — far above any test deadline so route timeouts
    // don't accidentally fire during the test.
    routerTimeoutMs: 60_000,
    models: [
      { id: 'test-model', label: 'Test', backendModel: 'test-backend', aliases: ['default'], tier: 'general', default: true, contextWindow: 32768 },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
    localRuntimeProtocol: 'openai_chat',
    middleware: {
      // 0.14.2: tests in this file exercise the timeout-layer
      // classification path. The streaming → non-streaming fallback
      // would re-fetch from the same mock (which keeps writing keep-
      // alive pings indefinitely) and consume the test's wall-clock
      // before the diagnostic surfaces. Default-disable here; tests
      // wanting to exercise fallback can override.
      streamFallbackToNonStreamingEnabled: false,
      ...overrides,
    },
  } as unknown as OwlCodaConfig
}

async function startOwlcodaWith(overrides: Partial<NonNullable<OwlCodaConfig['middleware']>>): Promise<void> {
  const config = makeConfig(overrides)
  owlcodaServer = startServer(config)
  await new Promise<void>(resolve => {
    owlcodaServer.on('listening', () => {
      owlcodaPort = (owlcodaServer.address() as { port: number }).port
      resolve()
    })
  })
}

function postStream(body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${owlcodaPort}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  })
}

/** Read SSE response body, returning a record of seen events (parsed) and
 *  the raw text. Stops on `[DONE]`, `message_stop`, or stream end. */
async function readSseEvents(res: Response): Promise<{ events: any[]; raw: string }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  let buffer = ''
  const events: any[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
    buffer += decoder.decode(value, { stream: true })
    let delim = buffer.indexOf('\n\n')
    while (delim !== -1) {
      const block = buffer.slice(0, delim)
      buffer = buffer.slice(delim + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trimStart()
        if (payload === '[DONE]') continue
        try { events.push(JSON.parse(payload)) } catch { /* non-JSON */ }
      }
      delim = buffer.indexOf('\n\n')
    }
  }
  return { events, raw }
}

beforeAll(async () => {
  homeDir = mkdtempSync('/tmp/owlcoda-stream-timeout-')
  process.env['OWLCODA_HOME'] = homeDir
  await startMockRouter()
})

afterAll(() => {
  mockRouter?.close()
  rmSync(homeDir, { recursive: true, force: true })
  delete process.env['OWLCODA_HOME']
})

// Helper: write OpenAI SSE chunk to res. The translator parses these and
// emits Anthropic content_block_delta events from them.
function writeOpenAiContentChunk(res: http.ServerResponse, text: string): void {
  const obj = {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'test-backend',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function writeOpenAiDone(res: http.ServerResponse): void {
  const obj = {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'test-backend',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

describe('0.13.97 streaming timeout layers', () => {
  describe('non-streaming wall-clock does NOT kill active streams', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('streams to completion even when total wall-clock exceeds requestTimeoutMs', async () => {
      // requestTimeoutMs is 200ms (would have killed pre-0.13.97). The stream
      // emits 4 chunks at 100ms apart = 400ms total. First chunk arrives at
      // 100ms; per-chunk idle is 5s so no idle fire; first-token is 5s so no
      // first-token fire. Pre-fix: outer 200ms wall-clock would abort
      // at 200ms even mid-stream. Post-fix: streaming ignores wall-clock.
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        let n = 0
        const tick = (): void => {
          if (n >= 4) { writeOpenAiDone(res); return }
          writeOpenAiContentChunk(res, `chunk${n} `)
          n++
          setTimeout(tick, 100)
        }
        setTimeout(tick, 100)
      }
      await startOwlcodaWith({
        requestTimeoutMs: 200,             // very tight wall-clock
        streamFirstTokenTimeoutMs: 5_000,  // not under test
        streamIdleTimeoutMs: 5_000,        // not under test
      })
      server = owlcodaServer
      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      expect(res.status).toBe(200)
      const { events } = await readSseEvents(res)
      // Should see at least 4 content_block_delta events (one per chunk) +
      // a message_stop, NOT an error event.
      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents.length).toBe(0)
      const deltaEvents = events.filter(e => e.type === 'content_block_delta')
      expect(deltaEvents.length).toBeGreaterThanOrEqual(4)
    }, 10_000)
  })

  describe('first-token watchdog', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('fires stream_first_token_timeout when no chunk arrives in time', async () => {
      // Mock opens SSE response with a `: ping` comment (so Node fetch
      // returns the Response with a body that has at least one byte) but
      // emits no actual chunk. parseSSEStream filters lines starting with
      // ':' (per SSE spec) so markFirstChunkArrived is NOT called. Watchdog
      // should fire at 300ms.
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': watchdog-keepalive\n\n')
      }
      await startOwlcodaWith({
        requestTimeoutMs: 30_000,        // not under test
        streamFirstTokenTimeoutMs: 300,  // tight first-token deadline
        streamIdleTimeoutMs: 30_000,     // would not fire even if propagated
      })
      server = owlcodaServer
      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      expect(res.status).toBe(200) // stream headers were written before watchdog fired
      const { events } = await readSseEvents(res)
      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.error.diagnostic.kind).toBe('stream_first_token_timeout')
      expect(errorEvent.error.diagnostic.partialOutputSeen).toBe(false)
      // Wording contract: never "before a usable response" for streaming.
      expect(JSON.stringify(errorEvent.error)).not.toContain('before a usable response')
    }, 10_000)
  })

  describe('per-chunk idle watchdog after first-token', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('fires stream_idle_timeout with partialOutputSeen=true after chunks then silence', async () => {
      // Mock emits 2 chunks fast, then goes silent. With first-token=2s and
      // idle=300ms: first-token cleared on first chunk; idle fires 300ms
      // after the last chunk emitted.
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        setTimeout(() => writeOpenAiContentChunk(res, 'first '), 50)
        setTimeout(() => writeOpenAiContentChunk(res, 'second '), 100)
        // never DONE / never close
      }
      await startOwlcodaWith({
        requestTimeoutMs: 30_000,
        streamFirstTokenTimeoutMs: 2_000,
        streamIdleTimeoutMs: 300,
      })
      server = owlcodaServer
      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      expect(res.status).toBe(200)
      const { events } = await readSseEvents(res)
      // Must have seen content_block_delta(s) before the error.
      const deltas = events.filter(e => e.type === 'content_block_delta')
      expect(deltas.length).toBeGreaterThanOrEqual(2)
      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.error.diagnostic.kind).toBe('stream_idle_timeout')
      expect(errorEvent.error.diagnostic.partialOutputSeen).toBe(true)
      expect(JSON.stringify(errorEvent.error)).not.toContain('before a usable response')
    }, 10_000)
  })

  describe('stream total-runtime watchdog', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('terminates a continuously active stream at the configured hard ceiling', async () => {
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const timer = setInterval(() => writeOpenAiContentChunk(res, 'still-running '), 40)
        res.on('close', () => clearInterval(timer))
      }
      await startOwlcodaWith({
        requestTimeoutMs: 30_000,
        streamFirstTokenTimeoutMs: 2_000,
        streamIdleTimeoutMs: 2_000,
        streamTotalTimeoutMs: 300,
      })
      server = owlcodaServer
      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      const { events } = await readSseEvents(res)
      expect(events.filter(e => e.type === 'content_block_delta').length).toBeGreaterThan(1)
      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent?.error.diagnostic).toMatchObject({
        kind: 'timeout',
        partialOutputSeen: true,
      })
      expect(errorEvent?.error.diagnostic.detail).toContain('total-runtime watchdog')
    }, 10_000)
  })

  describe('provider socket close after partial output', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('maps mid-stream socket termination to retryable stream_interrupted with partialOutputSeen=true', async () => {
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        writeOpenAiContentChunk(res, 'partial answer ')
        setTimeout(() => res.destroy(new Error('terminated')), 50)
      }
      await startOwlcodaWith({
        requestTimeoutMs: 30_000,
        streamFirstTokenTimeoutMs: 2_000,
        streamIdleTimeoutMs: 30_000,
      })
      server = owlcodaServer

      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      expect(res.status).toBe(200)
      const { events } = await readSseEvents(res)
      const deltas = events.filter(e => e.type === 'content_block_delta')
      expect(deltas.length).toBeGreaterThanOrEqual(1)
      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.error.diagnostic.kind).toBe('stream_interrupted')
      expect(errorEvent.error.diagnostic.retryable).toBe(true)
      expect(errorEvent.error.diagnostic.partialOutputSeen).toBe(true)
      expect(JSON.stringify(errorEvent.error)).not.toContain('unknown_fetch_error')
    }, 10_000)
  })

  describe('clean stream completion', () => {
    let server: http.Server
    afterAll(() => { server?.close() })

    it('emits no error when stream finishes normally', async () => {
      mockRouterHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        writeOpenAiContentChunk(res, 'hello world')
        writeOpenAiDone(res)
      }
      await startOwlcodaWith({
        requestTimeoutMs: 30_000,
        streamFirstTokenTimeoutMs: 5_000,
        streamIdleTimeoutMs: 5_000,
      })
      server = owlcodaServer
      const res = await postStream({ model: 'default', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
      expect(res.status).toBe(200)
      const { events } = await readSseEvents(res)
      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents.length).toBe(0)
      const deltas = events.filter(e => e.type === 'content_block_delta')
      expect(deltas.length).toBeGreaterThanOrEqual(1)
    }, 10_000)
  })
})
