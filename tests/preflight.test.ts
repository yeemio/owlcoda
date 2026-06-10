/**
 * Tests for src/preflight.ts — local platform preflight checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

// Import the functions under test
import { checkRouterHealth, checkBackendModel, runPreflight } from '../dist/preflight.js'
import type { OwlCodaConfig } from '../dist/config.js'

// ─── Test helpers ───

function startMockRouter(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` })
      }
    })
  })
}

function makeConfig(routerUrl: string, port?: number): OwlCodaConfig {
  return {
    port: port ?? 8019,
    host: '127.0.0.1',
    routerUrl,
    localRuntimeProtocol: 'auto',
    routerTimeoutMs: 600_000,
    logLevel: 'info',
    responseModelStyle: 'platform',
    catalogLoaded: false,
    models: [
      {
        id: 'qwen2.5-coder:32b',
        label: 'Qwen2.5 Coder 32B',
        backendModel: 'qwen2.5-coder:32b',
        aliases: ['default', 'distilled'],
        tier: 'production',
        default: true,
      },
    ],
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
  } as OwlCodaConfig
}

// ─── Tests ───

describe('preflight: checkRouterHealth', () => {
  it('returns healthy_reused when router /healthz is reachable', async () => {
    const { server, url } = await startMockRouter((req, res) => {
      if (req.url === '/v1/runtime/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          inventory: { model_count: 1, entries: [{ model_id: 'Qwen3.5-27B' }] },
          health: { readiness: 'ready' },
          backend: { healthy: true, loaded_models: [{ model_id: 'Qwen3.5-27B' }] },
        }))
      } else if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', pid: 123 }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    try {
      const result = await checkRouterHealth(url)
      expect(result.status).toBe('healthy_reused')
      expect(result.name).toBe('Local runtime')
      expect(result.detail).toContain('runtime_status')
    } finally {
      server.close()
    }
  })

  it('returns missing when router is unreachable', async () => {
    const result = await checkRouterHealth('http://127.0.0.1:65530')
    expect(result.status).toBe('missing')
    expect(result.detail).toContain('Not reachable')
  })

  it('returns missing when router returns non-200', async () => {
    const { server, url } = await startMockRouter((_req, res) => {
      res.writeHead(503)
      res.end('Service Unavailable')
    })

    try {
      const result = await checkRouterHealth(url)
      // Non-200 is treated as unreachable (ok is false when status >= 400)
      expect(result.status).toBe('missing')
    } finally {
      server.close()
    }
  })
})

describe('preflight: checkBackendModel', () => {
  it('returns healthy_reused when model appears in /v1/models', async () => {
    const { server, url } = await startMockRouter((req, res) => {
      if (req.url === '/v1/runtime/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          inventory: { model_count: 2, entries: [{ model_id: 'Qwen3.5-27B' }, { model_id: 'gpt-oss-120b' }] },
          health: { readiness: 'ready' },
          backend: { healthy: true },
        }))
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ id: 'Qwen3.5-27B' }, { id: 'gpt-oss-120b' }],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    try {
      const result = await checkBackendModel(url, 'Qwen3.5-27B', true)
      expect(result.status).toBe('healthy_reused')
      expect(result.name).toContain('Qwen3.5-27B')
      expect(result.detail).toContain('models')
    } finally {
      server.close()
    }
  })

  it('returns degraded when model is not in /v1/models list', async () => {
    const { server, url } = await startMockRouter((req, res) => {
      if (req.url === '/v1/runtime/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-120b' }] },
          health: { readiness: 'ready' },
          backend: { healthy: true },
        }))
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ id: 'gpt-oss-120b' }],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    try {
      const result = await checkBackendModel(url, 'Qwen3.5-27B', true)
      expect(result.status).toBe('degraded')
      expect(result.detail).toContain('not listed in the runtime visibility surface')
    } finally {
      server.close()
    }
  })

  it('returns degraded when router is not healthy', async () => {
    const result = await checkBackendModel('http://127.0.0.1:65530', 'Qwen3.5-27B', false)
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('local runtime is down')
  })
})

describe('preflight: runPreflight', () => {
  let mockServer: Server
  let mockUrl: string

  beforeAll(async () => {
    const { server, url } = await startMockRouter((req, res) => {
      if (req.url === '/v1/runtime/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          inventory: {
            model_count: 1,
            entries: [{ model_id: 'qwen2.5-coder:32b' }],
          },
          health: { readiness: 'ready' },
          backend: { healthy: true },
        }))
      } else if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', pid: 999 }))
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ id: 'qwen2.5-coder:32b' }],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    mockServer = server
    mockUrl = url
  })

  afterAll(() => {
    mockServer.close()
  })

  it('returns canProceed=true when router and models are healthy', async () => {
    const config = makeConfig(mockUrl)
    const result = await runPreflight(config)

    expect(result.canProceed).toBe(true)
    expect(result.overall).toBe('healthy_reused')
    expect(result.router.status).toBe('healthy_reused')
    expect(result.backends.length).toBeGreaterThan(0)
    expect(result.summary).toContain('healthy')
  })

  it('returns canProceed=false when router is unreachable', async () => {
    const config = makeConfig('http://127.0.0.1:65530')
    const result = await runPreflight(config)

    expect(result.canProceed).toBe(false)
    expect(result.overall).toBe('blocked')
    expect(result.router.status).toBe('missing')
  })

  it('blocks when only /healthz is reachable and local runtime protocol is unresolved', async () => {
    const { server, url } = await startMockRouter((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', pid: 999 }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    try {
      const config = makeConfig(url)
      const result = await runPreflight(config)
      expect(result.canProceed).toBe(false)
      expect(result.overall).toBe('blocked')
      expect(result.router.status).toBe('blocked')
      expect(result.router.detail).toContain('protocol unresolved')
    } finally {
      server.close()
    }
  })

  it('passes skipCache through to the truth aggregator on startup paths', async () => {
    const config = makeConfig('http://127.0.0.1:65530')
    const calls: Array<{ skipCache?: boolean }> = []
    const fakeTruth = {
      async getSnapshot(options?: { skipCache?: boolean }) {
        calls.push(options ?? {})
        return {
          statuses: [],
          byModelId: {},
          runtimeOk: false,
          runtimeSource: null,
          runtimeLocalProtocol: null,
          runtimeProbeDetail: '',
          runtimeModelCount: 0,
          refreshedAt: Date.now(),
          ttlMs: 5000,
          cacheHit: false,
        }
      },
    }

    const result = await runPreflight(config, { skipCache: true, modelTruth: fakeTruth as any })
    expect(result.canProceed).toBe(false)
    expect(calls).toEqual([{ skipCache: true }])
  })
})

describe('preflight: formatPreflightForCli collapse', () => {
  it('collapses 3+ unavailable models into a summary', async () => {
    const { formatPreflightForCli } = await import('../dist/preflight.js')
    const result = formatPreflightForCli({
      router: { name: 'Local runtime', url: 'http://test', status: 'healthy_reused', detail: 'Healthy (5ms)' },
      backends: [
        { name: 'Backend (ModelA)', url: 'http://test', status: 'healthy_reused', detail: 'Available' },
        { name: 'Backend (ModelB)', url: 'http://test', status: 'degraded', detail: 'Not found' },
        { name: 'Backend (ModelC)', url: 'http://test', status: 'degraded', detail: 'Not found' },
        { name: 'Backend (ModelD)', url: 'http://test', status: 'degraded', detail: 'Not found' },
      ],
      overall: 'degraded',
      canProceed: true,
      summary: 'Some models not available',
    })
    // Should show the healthy model individually
    expect(result).toContain('ModelA')
    // Should collapse degraded into summary (3+ models)
    expect(result).toContain('3 models not visible')
    // Should NOT list each degraded model separately with full detail
    expect(result).not.toContain('Not found')
  })

  it('shows 1-2 unavailable models individually', async () => {
    const { formatPreflightForCli } = await import('../dist/preflight.js')
    const result = formatPreflightForCli({
      router: { name: 'Local runtime', url: 'http://test', status: 'healthy_reused', detail: 'Healthy (5ms)' },
      backends: [
        { name: 'Backend (ModelA)', url: 'http://test', status: 'healthy_reused', detail: 'Available' },
        { name: 'Backend (ModelB)', url: 'http://test', status: 'degraded', detail: 'Not found' },
      ],
      overall: 'degraded',
      canProceed: true,
      summary: 'Some models not available',
    })
    // With only 1 degraded, should show it individually
    expect(result).toContain('ModelB')
    expect(result).toContain('Not found')
  })
})
