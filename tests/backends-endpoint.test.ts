/**
 * Tests for GET /v1/backends endpoint.
 * Uses mock backend servers to simulate Ollama, LM Studio responses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http'
import { handleBackends } from '../src/endpoints/backends.js'
import type { OwlCodaConfig } from '../src/config.js'
import { Socket } from 'node:net'

// ─── Mock HTTP infrastructure ───

function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

function makeReq(): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'GET'
  req.url = '/v1/backends'
  return req
}

function makeRes(): ServerResponse & { _body: string; _status: number; _headers: Record<string, string> } {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  const res = new ServerResponse(req) as any
  res._body = ''
  res._status = 200
  res._headers = {}
  const originalWriteHead = res.writeHead.bind(res)
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res._status = status
    if (headers) Object.assign(res._headers, headers)
    return originalWriteHead(status, headers)
  }
  const originalEnd = res.end.bind(res)
  res.end = (data?: string) => {
    if (data) res._body = data
    return originalEnd(data)
  }
  return res
}

function makeConfig(overrides?: Partial<OwlCodaConfig>): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600_000,
    models: [],
    responseModelStyle: 'platform',
    logLevel: 'info',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}

describe('GET /v1/backends', () => {
  let ollamaMock: { server: Server; url: string }
  let lmstudioMock: { server: Server; url: string }

  beforeAll(async () => {
    ollamaMock = await startMockServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '0.6.2' }))
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          models: [
            { name: 'llama3:latest', model: 'llama3:latest', modified_at: '', size: 0, digest: '', details: { parameter_size: '8B' } },
            { name: 'qwen2:7b', model: 'qwen2:7b', modified_at: '', size: 0, digest: '' },
          ],
        }))
      } else { res.writeHead(404); res.end() }
    })

    lmstudioMock = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ id: 'model-a', object: 'model' }],
        }))
      } else { res.writeHead(404); res.end() }
    })
  })

  afterAll(() => {
    ollamaMock.server.close()
    lmstudioMock.server.close()
  })

  it('returns 200 with backend discovery results', async () => {
    const config = makeConfig({
      backends: [
        { type: 'ollama', baseUrl: ollamaMock.url, enabled: true },
        { type: 'lmstudio', baseUrl: lmstudioMock.url, enabled: true },
      ],
    })
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    const body = JSON.parse(res._body)
    expect(res._status).toBe(200)
    expect(body.totalModels).toBe(3)
    expect(body.reachableBackends).toContain('ollama')
    expect(body.reachableBackends).toContain('lmstudio')
  })

  it('includes model details per backend', async () => {
    const config = makeConfig({
      backends: [
        { type: 'ollama', baseUrl: ollamaMock.url, enabled: true },
      ],
    })
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    const body = JSON.parse(res._body)
    const ollamaBackend = body.backends.find((b: any) => b.name === 'ollama')
    expect(ollamaBackend).toBeDefined()
    expect(ollamaBackend.reachable).toBe(true)
    expect(ollamaBackend.models).toHaveLength(2)
    expect(ollamaBackend.models[0].id).toBe('llama3:latest')
  })

  it('reports unreachable backends', async () => {
    const config = makeConfig({
      backends: [
        { type: 'vllm', baseUrl: 'http://127.0.0.1:1', enabled: true },
      ],
    })
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    const body = JSON.parse(res._body)
    expect(body.totalModels).toBe(0)
    expect(body.unreachableBackends).toContain('vllm')
  })

  it('sets CORS headers', async () => {
    const config = makeConfig({ backends: [] })
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    expect(res.getHeader('Access-Control-Allow-Origin')).toBe('*')
  })

  it('returns durationMs in response', async () => {
    const config = makeConfig({ backends: [] })
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    const body = JSON.parse(res._body)
    expect(typeof body.durationMs).toBe('number')
    expect(body.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('uses default backends when config has no backends field', async () => {
    const config = makeConfig() // no backends field
    const req = makeReq()
    const res = makeRes()
    await handleBackends(req, res, config)

    const body = JSON.parse(res._body)
    // Defaults probe ollama, lmstudio, vllm — all should be unreachable
    expect(body.backends).toBeDefined()
    expect(typeof body.durationMs).toBe('number')
  })
})
