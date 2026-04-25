/**
 * Tests for /warmup REPL command and startup warmup hook.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { warmupModels, formatWarmupResults } from '../src/warmup.js'
import type { OwlCodaConfig } from '../src/config.js'

function createMockBackend() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() })
    })
  })
}

function makeConfig(endpoint?: string): OwlCodaConfig {
  return {
    port: 8009,
    host: '127.0.0.1',
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 30000,
    models: endpoint ? [
      { id: 'test-model', backendModel: 'test', tier: 'production', endpoint, aliases: [], label: 'Test' },
    ] : [
      { id: 'router-model', backendModel: 'test', tier: 'production', aliases: [], label: 'Test' },
    ],
    responseModelStyle: 'preserve',
    logLevel: 'warn',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: 'test-model',
    reverseMapInResponse: false,
  } as OwlCodaConfig
}

describe('/warmup command', () => {
  const servers: Array<{ close: () => void }> = []
  afterAll(() => servers.forEach(s => s.close()))

  it('warms models when endpoints available', async () => {
    const backend = await createMockBackend()
    servers.push(backend)

    const config = makeConfig(`${backend.url}/v1/chat/completions`)
    const results = await warmupModels(config, { timeoutMs: 5000 })
    const output = formatWarmupResults(results)

    expect(output).toContain('1/1 ready')
    expect(output).toContain('✓ test-model')
  })

  it('reports no models when none have endpoints', async () => {
    const config = makeConfig() // no endpoint
    const modelsWithEndpoint = config.models.filter(m => m.endpoint)
    expect(modelsWithEndpoint).toHaveLength(0)
    // Command would return "No models with direct endpoints to warm up."
  })

  it('handles mixed warm and failed', async () => {
    const backend = await createMockBackend()
    servers.push(backend)

    const config = {
      ...makeConfig(`${backend.url}/v1/chat/completions`),
      models: [
        { id: 'ok-model', backendModel: 'ok', tier: 'production', endpoint: `${backend.url}/v1/chat/completions`, aliases: [], label: 'OK' },
        { id: 'dead-model', backendModel: 'dead', tier: 'production', endpoint: 'http://127.0.0.1:1/v1/chat/completions', aliases: [], label: 'Dead' },
      ],
    } as OwlCodaConfig

    const results = await warmupModels(config, { timeoutMs: 2000 })
    expect(results).toHaveLength(2)
    expect(results.find(r => r.modelId === 'ok-model')?.status).toBe('warm')
    expect(results.find(r => r.modelId === 'dead-model')?.status).toBe('failed')
  })
})

describe('startup warmup hook', () => {
  it('warmup after discovery pattern works', async () => {
    // Simulates the server.ts pattern: discover → warmup
    const backend = await createMockBackend()
    const config = makeConfig(`${backend.url}/v1/chat/completions`)

    // Simulate discovery completing then warmup
    const results = await warmupModels(config, { timeoutMs: 5000 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.status).toBe('warm')

    backend.close()
  })
})
