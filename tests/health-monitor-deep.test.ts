/**
 * Deep health-monitor tests — probing, caching, start/stop lifecycle.
 * Uses a local HTTP mock server to test actual health probing logic.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { OwlCodaConfig, ConfiguredModel } from '../src/config.js'
import {
  startHealthMonitor,
  stopHealthMonitor,
  getModelHealth,
  getAllModelHealth,
  isModelHealthy,
  resetHealthCache,
} from '../src/health-monitor.js'

let mockServer: Server
let serverPort: number

function makeModel(id: string, endpoint?: string): ConfiguredModel {
  return {
    id,
    label: id,
    backendModel: id,
    aliases: [],
    tier: 'production',
    ...(endpoint ? { endpoint } : {}),
  } as ConfiguredModel
}

function makeConfig(models: ConfiguredModel[], routerUrl?: string): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: routerUrl ?? `http://127.0.0.1:${serverPort}`,
    routerTimeoutMs: 5000,
    models,
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'info',
  } as OwlCodaConfig
}

function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  return new Promise(resolve => {
    mockServer = createServer(handler)
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address()
      serverPort = typeof addr === 'object' && addr ? addr.port : 0
      resolve()
    })
  })
}

function stopMockServer(): Promise<void> {
  return new Promise(resolve => {
    if (mockServer) mockServer.close(() => resolve())
    else resolve()
  })
}

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

beforeEach(() => {
  resetHealthCache()
})

afterEach(async () => {
  resetHealthCache()
  await stopMockServer()
})

describe('health-monitor — probing with mock server', () => {
  it('marks model as healthy when found in /v1/models', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    })

    const config = makeConfig([makeModel('model-a')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    const h = getModelHealth('model-a')
    expect(h.status).toBe('healthy')
    expect(h.latencyMs).toBeGreaterThanOrEqual(0)
    expect(h.lastCheck).toBeTruthy()
  })

  it('marks model as unhealthy when not in /v1/models', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'other-model' }] }))
    })

    const config = makeConfig([makeModel('missing-model')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    const h = getModelHealth('missing-model')
    expect(h.status).toBe('unhealthy')
  })

  it('marks model as unhealthy on server error', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })

    const config = makeConfig([makeModel('err-model')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    const h = getModelHealth('err-model')
    expect(h.status).toBe('unhealthy')
  })

  it('marks model as unhealthy on connection refused', async () => {
    // Don't start a mock server — connection will be refused
    const config = makeConfig([makeModel('nohost-model')], 'http://127.0.0.1:19999')
    startHealthMonitor(config, 500)
    await waitMs(300)

    const h = getModelHealth('nohost-model')
    expect(h.status).toBe('unhealthy')
  })

  it('tracks multiple models independently', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'healthy-one' }] }))
    })

    const config = makeConfig([makeModel('healthy-one'), makeModel('unhealthy-one')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    expect(getModelHealth('healthy-one').status).toBe('healthy')
    expect(getModelHealth('unhealthy-one').status).toBe('unhealthy')
  })

  it('getAllModelHealth returns map after probing', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }))
    })

    const config = makeConfig([makeModel('a'), makeModel('b')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    const all = getAllModelHealth()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a']!.status).toBe('healthy')
    expect(all['b']!.status).toBe('healthy')
  })
})

describe('health-monitor — isModelHealthy', () => {
  it('returns true for unknown (optimistic default)', () => {
    expect(isModelHealthy('never-seen')).toBe(true)
  })

  it('returns false for known-unhealthy model', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })

    const config = makeConfig([makeModel('absent-model')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    expect(isModelHealthy('absent-model')).toBe(false)
  })

  it('returns true for known-healthy model', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'ok-model' }] }))
    })

    const config = makeConfig([makeModel('ok-model')])
    startHealthMonitor(config, 500)
    await waitMs(200)

    expect(isModelHealthy('ok-model')).toBe(true)
  })
})

describe('health-monitor — lifecycle', () => {
  it('stopHealthMonitor prevents further probes', async () => {
    let probeCount = 0
    await startMockServer((_req, res) => {
      probeCount++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })

    const config = makeConfig([makeModel('test')])
    startHealthMonitor(config, 100) // fast interval
    await waitMs(150)
    const countBefore = probeCount
    stopHealthMonitor()
    await waitMs(300)
    // After stop, probe count should not increase significantly
    expect(probeCount - countBefore).toBeLessThanOrEqual(1)
  })

  it('resetHealthCache clears all data and stops monitor', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'x' }] }))
    })

    const config = makeConfig([makeModel('x')])
    startHealthMonitor(config, 500)
    await waitMs(200)
    expect(Object.keys(getAllModelHealth())).toHaveLength(1)

    resetHealthCache()
    expect(Object.keys(getAllModelHealth())).toHaveLength(0)
  })

  it('double start is idempotent', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })

    const config = makeConfig([makeModel('y')])
    startHealthMonitor(config, 500)
    startHealthMonitor(config, 500) // second call should be no-op
    await waitMs(100)
    resetHealthCache()
  })
})
