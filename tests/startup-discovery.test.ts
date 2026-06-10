/**
 * Tests for auto-discovery at startup — verifies that discovered backend
 * models are merged into config when the server starts.
 *
 * We test discoverAndMergeBackends indirectly via the exported
 * mergeDiscoveredModels + discoverBackends, since the startup flow
 * is an async side-effect. The integration test verifies the actual
 * server startup wiring.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { discoverBackends } from '../src/backends/discovery.js'
import { mergeDiscoveredModels, type OwlCodaConfig } from '../src/config.js'

function startMockOllama(): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '0.6.2' }))
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          models: [
            {
              name: 'llama3.3:latest',
              model: 'llama3.3:latest',
              modified_at: '2025-01-01T00:00:00Z',
              size: 4_000_000_000,
              digest: 'abc123',
              details: { parameter_size: '70B', quantization_level: 'Q4_K_M' },
            },
          ],
        }))
      } else { res.writeHead(404); res.end() }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
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

describe('startup auto-discovery flow', () => {
  let mock: { server: Server; url: string }

  beforeAll(async () => {
    mock = await startMockOllama()
  })

  afterAll(() => mock.server.close())

  it('discovers and merges Ollama models into empty config', async () => {
    const config = makeConfig({
      backends: [{ type: 'ollama', baseUrl: mock.url, enabled: true }],
    })

    // Simulate the startup flow
    const result = await discoverBackends(config.backends!, 3000)
    expect(result.models.length).toBeGreaterThan(0)

    const merged = mergeDiscoveredModels(config, result.models)
    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]!.id).toBe('llama3.3:latest')
    expect(merged.models[0]!.endpoint).toContain(mock.url)
  })

  it('preserves existing models when merging discovered ones', async () => {
    const config = makeConfig({
      models: [{
        id: 'existing',
        label: 'Existing Model',
        backendModel: 'existing',
        aliases: [],
        tier: 'production',
        contextWindow: 32768,
      }],
      backends: [{ type: 'ollama', baseUrl: mock.url, enabled: true }],
    })

    const result = await discoverBackends(config.backends!, 3000)
    const merged = mergeDiscoveredModels(config, result.models)
    expect(merged.models).toHaveLength(2)
    expect(merged.models[0]!.id).toBe('existing')
    expect(merged.models[1]!.id).toBe('llama3.3:latest')
  })

  it('in-place mutation updates config models array', async () => {
    const config = makeConfig({
      backends: [{ type: 'ollama', baseUrl: mock.url, enabled: true }],
    })

    const result = await discoverBackends(config.backends!, 3000)
    const merged = mergeDiscoveredModels(config, result.models)

    // Simulate the server.ts in-place mutation
    if (merged !== config) {
      config.models = merged.models
      Object.assign(config.modelMap, merged.modelMap)
    }

    expect(config.models).toHaveLength(1)
    expect(config.modelMap['llama3.3:latest']).toBe('llama3.3:latest')
  })

  it('handles all-unreachable backends gracefully', async () => {
    const config = makeConfig({
      backends: [{ type: 'vllm', baseUrl: 'http://127.0.0.1:1', enabled: true }],
    })

    const result = await discoverBackends(config.backends!, 500)
    expect(result.models).toHaveLength(0)

    const merged = mergeDiscoveredModels(config, result.models)
    expect(merged).toBe(config) // no changes
  })
})
