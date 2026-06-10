/**
 * Tests for model warmup and enhanced health monitoring.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { warmupModels, formatWarmupResults } from '../src/warmup.js'
import type { OwlCodaConfig, ConfiguredModel } from '../src/config.js'

// Mock backend server
function createMockBackend(handler: (req: any, res: any) => void) {
  const server = createServer(handler)
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      })
    })
  })
}

function makeConfig(models: Partial<ConfiguredModel>[]): OwlCodaConfig {
  return {
    port: 8009,
    host: '127.0.0.1',
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 30000,
    models: models.map((m, i) => ({
      id: m.id ?? `model-${i}`,
      label: m.label ?? m.id ?? `Model ${i}`,
      backendModel: m.backendModel ?? `backend-${i}`,
      aliases: [],
      tier: m.tier ?? 'production',
      endpoint: m.endpoint,
    })) as ConfiguredModel[],
    responseModelStyle: 'preserve',
    logLevel: 'warn',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: 'model-0',
    reverseMapInResponse: false,
  } as OwlCodaConfig
}

// ─── warmupModels ───

describe('warmupModels', () => {
  const servers: Array<{ close: () => void }> = []

  afterAll(() => {
    for (const s of servers) s.close()
  })

  it('warms models with direct endpoints', async () => {
    const backend = await createMockBackend((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
    })
    servers.push(backend)

    const config = makeConfig([
      { id: 'warm-model', backendModel: 'test', endpoint: `${backend.url}/v1/chat/completions` },
    ])

    const results = await warmupModels(config, { timeoutMs: 5000 })
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('warm')
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('skips models without endpoint', async () => {
    const config = makeConfig([
      { id: 'router-model', backendModel: 'test' }, // no endpoint
    ])

    const results = await warmupModels(config)
    expect(results).toHaveLength(0) // filtered out before warmup
  })

  it('marks failed models on connection error', async () => {
    const config = makeConfig([
      { id: 'dead-model', backendModel: 'test', endpoint: 'http://127.0.0.1:1/v1/chat/completions' },
    ])

    const results = await warmupModels(config, { timeoutMs: 2000 })
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('failed')
    expect(results[0]!.error).toBeTruthy()
    expect(results[0]!.error).toContain('transport failed before more detail was available')
    expect(results[0]!.error).not.toContain('fetch failed')
  })

  it('marks failed on 500 response', async () => {
    const backend = await createMockBackend((_req, res) => {
      res.writeHead(500)
      res.end('Internal error')
    })
    servers.push(backend)

    const config = makeConfig([
      { id: 'error-model', backendModel: 'test', endpoint: `${backend.url}/v1/chat/completions` },
    ])

    const results = await warmupModels(config, { timeoutMs: 5000 })
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('failed')
    expect(results[0]!.error).toContain('upstream 500 from provider')
  })

  it('warms multiple models in parallel', async () => {
    const backend = await createMockBackend((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
    })
    servers.push(backend)

    const config = makeConfig([
      { id: 'm1', backendModel: 'a', endpoint: `${backend.url}/v1/chat/completions` },
      { id: 'm2', backendModel: 'b', endpoint: `${backend.url}/v1/chat/completions` },
      { id: 'm3', backendModel: 'c', endpoint: `${backend.url}/v1/chat/completions` },
    ])

    const results = await warmupModels(config, { concurrency: 2 })
    expect(results).toHaveLength(3)
    expect(results.every(r => r.status === 'warm')).toBe(true)
  })

  it('returns empty for config with no endpoints', async () => {
    const config = makeConfig([
      { id: 'a', backendModel: 'a' },
      { id: 'b', backendModel: 'b' },
    ])

    const results = await warmupModels(config)
    expect(results).toHaveLength(0)
  })
})

// ─── formatWarmupResults ───

describe('formatWarmupResults', () => {
  it('formats empty results', () => {
    expect(formatWarmupResults([])).toBe('No models to warm up')
  })

  it('formats all-warm results', () => {
    const text = formatWarmupResults([
      { modelId: 'm1', backendModel: 'a', status: 'warm', latencyMs: 150 },
      { modelId: 'm2', backendModel: 'b', status: 'warm', latencyMs: 200 },
    ])
    expect(text).toContain('2/2 ready')
    expect(text).toContain('✓ m1')
    expect(text).toContain('✓ m2')
  })

  it('formats mixed results', () => {
    const text = formatWarmupResults([
      { modelId: 'm1', backendModel: 'a', status: 'warm', latencyMs: 100 },
      { modelId: 'm2', backendModel: 'b', status: 'failed', latencyMs: 2000, error: 'timeout' },
    ])
    expect(text).toContain('1/2 ready')
    expect(text).toContain('✓ m1')
    expect(text).toContain('✗ m2')
    expect(text).toContain('timeout')
  })

  it('includes latency in warm output', () => {
    const text = formatWarmupResults([
      { modelId: 'm1', backendModel: 'a', status: 'warm', latencyMs: 350 },
    ])
    expect(text).toContain('350ms')
  })
})
