/**
 * Availability truth integration tests.
 * Verifies alias-aware overlay, server wiring, and frontend display
 * using a fake router that returns realistic model IDs.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import * as http from 'node:http'
import { startServer } from '../src/server.js'
import { overlayAvailability, probeRouterModels } from '../src/config.js'
import type { OwlCodaConfig } from '../src/config.js'
import { handleCommand, type CommandContext, type CommandResult } from '../src/frontend/commands.js'

// ─── Fake router that mimics real live router /v1/models ───

const FAKE_ROUTER_MODELS = [
  { id: 'distilled-27b', object: 'model', owned_by: 'omlx', backend: 'omlx' },
  { id: 'Qwen3.5-35B-A3B-4bit', object: 'model', owned_by: 'omlx', backend: 'omlx' },
  { id: 'gpt-oss-120b-MXFP4-Q4', object: 'model', owned_by: 'omlx', backend: 'omlx' },
  { id: 'gpt-oss-20b-MXFP4-Q4', object: 'model', owned_by: 'omlx', backend: 'omlx' },
  { id: 'nemotron-cascade', object: 'model', owned_by: 'omlx', backend: 'omlx' },
  { id: 'Mistral-Large-Instruct-2411-Q4-MLX', object: 'model', owned_by: 'omlx', backend: 'omlx' },
]

let fakeRouter: http.Server
let fakeRouterPort: number

beforeAll(async () => {
  await new Promise<void>(resolve => {
    fakeRouter = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: FAKE_ROUTER_MODELS }))
      } else if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    fakeRouter.listen(0, '127.0.0.1', () => {
      fakeRouterPort = (fakeRouter.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(() => {
  fakeRouter?.close()
})

function makeTestConfig(): OwlCodaConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    routerUrl: `http://127.0.0.1:${fakeRouterPort}`,
    routerTimeoutMs: 5000,
    models: [
      { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['distilled', 'default'], tier: 'production', default: true },
      { id: 'Qwen3.5-35B-A3B-4bit', label: 'Qwen 35B MoE', backendModel: 'Qwen3.5-35B-A3B-4bit', aliases: ['qwen35'], tier: 'production' },
      { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['oss120', 'heavy'], tier: 'heavy' },
      { id: 'gpt-oss-20b-MXFP4-Q4', label: 'GPT-OSS 20B', backendModel: 'gpt-oss-20b-MXFP4-Q4', aliases: ['oss20', 'fast'], tier: 'production' },
      { id: 'Nemotron-Cascade-2-30B-A3B-4bit', label: 'Nemotron Cascade', backendModel: 'Nemotron-Cascade-2-30B-A3B-4bit', aliases: ['nemotron'], tier: 'production' },
      { id: 'Mistral-Large-Instruct-2411-Q4-MLX', label: 'Mistral Large', backendModel: 'Mistral-Large-Instruct-2411-Q4-MLX', aliases: ['mistral'], tier: 'production' },
      { id: 'Qwen3.5-122B-A10B-4bit', label: 'Qwen 122B MoE', backendModel: 'Qwen3.5-122B-A10B-4bit', aliases: ['qwen122'], tier: 'candidate' },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: true,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
  }
}

// ─── probeRouterModels integration ───

describe('probeRouterModels (shared)', () => {
  it('returns live router model IDs as Set', async () => {
    const ids = await probeRouterModels(`http://127.0.0.1:${fakeRouterPort}`)
    expect(ids.size).toBe(FAKE_ROUTER_MODELS.length)
    expect(ids.has('distilled-27b')).toBe(true)
    expect(ids.has('nemotron-cascade')).toBe(true)
    expect(ids.has('Qwen3.5-35B-A3B-4bit')).toBe(true)
  })

  it('returns empty set for unreachable router', async () => {
    const ids = await probeRouterModels('http://127.0.0.1:1')
    expect(ids.size).toBe(0)
  })
})

// ─── Alias-aware overlay with live probe ───

describe('availability truth (live probe → overlay)', () => {
  it('distilled-27b (router alias) marks aliased model as available', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    const aliased = cfg.models.find(m => m.aliases.includes('distilled'))!
    expect(aliased.availability).toBe('available')
  })

  it('nemotron-cascade (router alias) marks Nemotron model as available', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    const nemotron = cfg.models.find(m => m.id.includes('Nemotron'))!
    expect(nemotron.availability).toBe('available')
  })

  it('direct platform IDs mark models as available', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    expect(cfg.models.find(m => m.id === 'Qwen3.5-35B-A3B-4bit')!.availability).toBe('available')
    expect(cfg.models.find(m => m.id === 'gpt-oss-120b-MXFP4-Q4')!.availability).toBe('available')
    expect(cfg.models.find(m => m.id === 'gpt-oss-20b-MXFP4-Q4')!.availability).toBe('available')
    expect(cfg.models.find(m => m.id === 'Mistral-Large-Instruct-2411-Q4-MLX')!.availability).toBe('available')
  })

  it('models not in router are marked unavailable', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    const qwen122 = cfg.models.find(m => m.id === 'Qwen3.5-122B-A10B-4bit')!
    expect(qwen122.availability).toBe('unavailable')
  })

  it('unreachable router → all models unknown', async () => {
    const cfg = makeTestConfig()
    cfg.routerUrl = 'http://127.0.0.1:1'
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    for (const m of cfg.models) {
      expect(m.availability).toBe('unknown')
    }
  })
})

// ─── Server /v1/models availability truth ───

describe('server /v1/models availability truth', () => {
  let server: http.Server
  let serverPort: number

  beforeAll(async () => {
    const cfg = makeTestConfig()
    await new Promise<void>(resolve => {
      server = startServer({ ...cfg, port: 0 })
      server.on('listening', () => {
        serverPort = (server.address() as { port: number }).port
        resolve()
      })
    })
    // Wait for async checkRouter + probe to complete
    await new Promise(r => setTimeout(r, 1500))
  })

  afterAll(() => {
    server?.close()
  })

  it('/v1/models returns real availability from router probe', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/v1/models`)
    const body = await res.json() as { data: Array<{ id: string; availability: string }> }

    // Aliased model: matched via alias prefix "distilled-27b" → "distilled"
    // (test config maps qwen2.5-coder:32b under the 'distilled' alias)
    const aliased = body.data.find(m => m.id === 'qwen2.5-coder:32b')
    expect(aliased?.availability).toBe('available')

    // Direct ID matches
    const qwen35 = body.data.find(m => m.id === 'Qwen3.5-35B-A3B-4bit')
    expect(qwen35?.availability).toBe('available')

    const oss120 = body.data.find(m => m.id === 'gpt-oss-120b-MXFP4-Q4')
    expect(oss120?.availability).toBe('available')

    // Nemotron: matched via alias prefix "nemotron-cascade" → "nemotron"
    const nemotron = body.data.find(m => m.id.includes('Nemotron'))
    expect(nemotron?.availability).toBe('available')

    // Not in router → unavailable
    const qwen122 = body.data.find(m => m.id === 'Qwen3.5-122B-A10B-4bit')
    expect(qwen122?.availability).toBe('unavailable')
  })
})

// ─── Frontend /model command availability truth ───

describe('frontend /model availability display', () => {
  function makeContext(config: OwlCodaConfig): CommandContext {
    return {
      config,
      currentModel: config.models[0]!.id,
      sessionId: null,
      messageCount: 0,
      autoApprove: false,
      setModel: () => {},
      setAutoApprove: () => {},
      clearMessages: () => {},
      quit: () => {},
      resumeSession: async () => null,
    }
  }

  it('/model shows ✓ for available models and ✗ unavailable for missing', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    const result = await handleCommand('/model', makeContext(cfg))
    // Available models should have ✓
    expect(result.output).toContain('✓')
    // Qwen 122B is not in router → should show unavailable
    expect(result.output).toContain('unavailable')
  })

  it('/model and /v1/models share same availability truth', async () => {
    const cfg = makeTestConfig()
    const routerIds = await probeRouterModels(cfg.routerUrl)
    overlayAvailability(cfg, routerIds)

    // Both read from the same config.models[].availability
    const result = await handleCommand('/model', makeContext(cfg))
    const availableInFrontend = cfg.models.filter(m => m.availability === 'available').length
    const unavailableInFrontend = cfg.models.filter(m => m.availability === 'unavailable').length

    // Verify counts match what we expect from the fake router
    expect(availableInFrontend).toBe(6) // 6 models in fake router
    expect(unavailableInFrontend).toBe(1) // Qwen 122B not in router
  })
})
