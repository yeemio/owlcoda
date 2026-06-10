/**
 * Unit tests for src/routes/admin.ts — admin handlers in isolation.
 */
import { describe, it, expect, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import {
  handleResetCircuitBreakers,
  handleResetBudgets,
  handleGetConfig,
  handleGetModelTruth,
  handleGetRequests,
  handleGetAudit,
  type AdminDeps,
} from '../../src/routes/admin.js'
import type { OwlCodaConfig } from '../../src/config.js'

function mockRes(): ServerResponse & { _body: string; _status: number } {
  const res = {
    _body: '',
    _status: 0,
    writeHead(status: number, _headers?: Record<string, string>) { res._status = status; return res },
    end(body?: string) { res._body = body ?? ''; return res },
    setHeader() { return res },
  } as unknown as ServerResponse & { _body: string; _status: number }
  return res
}

const mockDeps: AdminDeps = {
  resetCircuitBreaker: vi.fn(),
  resetBudgets: vi.fn(),
  getAllCircuitStates: () => ({}),
  getRecentTraces: (count: number) => Array.from({ length: Math.min(count, 3) }, (_, i) => ({
    requestId: `trace-${i}`,
    model: 'test-model',
  })),
  readAuditLog: async (count: number) => Array.from({ length: Math.min(count, 2) }, (_, i) => ({
    action: `action-${i}`,
  })),
  getModelTruthSnapshot: async () => ({
    statuses: [{
      id: 'cloud-model',
      label: 'Cloud Model',
      providerKind: 'cloud',
      isDefault: false,
      presentIn: { config: true, router: false, discovered: false, catalog: false },
      availability: { kind: 'missing_key', envName: 'OPENAI_API_KEY' },
      raw: {
        config: {
          id: 'cloud-model',
          label: 'Cloud Model',
          backendModel: 'cloud-model',
          aliases: [],
          tier: 'cloud',
          endpoint: 'https://api.example.com',
          apiKey: 'secret-key',
          apiKeyEnv: 'OPENAI_API_KEY',
          default: false,
        },
      },
    }],
    byModelId: {
      'cloud-model': {
        id: 'cloud-model',
        label: 'Cloud Model',
        providerKind: 'cloud',
        isDefault: false,
        presentIn: { config: true, router: false, discovered: false, catalog: false },
        availability: { kind: 'missing_key', envName: 'OPENAI_API_KEY' },
        raw: {
          config: {
            id: 'cloud-model',
            label: 'Cloud Model',
            backendModel: 'cloud-model',
            aliases: [],
            tier: 'cloud',
            endpoint: 'https://api.example.com',
            apiKey: 'secret-key',
            apiKeyEnv: 'OPENAI_API_KEY',
            default: false,
          },
        },
      },
    },
    runtimeOk: true,
    runtimeSource: 'runtime_status',
    runtimeLocalProtocol: 'openai_chat',
    runtimeProbeDetail: 'ready',
    runtimeModelCount: 0,
    refreshedAt: Date.now(),
    ttlMs: 5000,
    cacheHit: false,
  }),
}

const mockConfig = {
  host: '0.0.0.0',
  port: 8019,
  routerUrl: 'http://localhost:11435/v1',
  models: [
    { id: 'model-1', backendModel: 'model-1', aliases: [], tier: 'general', contextWindow: 32768, apiKey: 'secret-key' },
    { id: 'model-2', backendModel: 'model-2', aliases: [], tier: 'general', contextWindow: 32768 },
  ],
} as unknown as OwlCodaConfig

describe('handleResetCircuitBreakers', () => {
  it('calls resetCircuitBreaker and returns ok', () => {
    const res = mockRes()
    handleResetCircuitBreakers({} as IncomingMessage, res, mockConfig, mockDeps)
    expect(mockDeps.resetCircuitBreaker).toHaveBeenCalled()
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ ok: true, message: 'All circuit breakers reset' })
  })
})

describe('handleResetBudgets', () => {
  it('calls resetBudgets and returns ok', () => {
    const res = mockRes()
    handleResetBudgets({} as IncomingMessage, res, mockConfig, mockDeps)
    expect(mockDeps.resetBudgets).toHaveBeenCalled()
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ ok: true, message: 'All error budgets reset' })
  })
})

describe('handleGetConfig', () => {
  it('redacts apiKey fields', () => {
    const res = mockRes()
    handleGetConfig({} as IncomingMessage, res, mockConfig)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.models[0].apiKey).toBe('***')
    expect(body.models[1].apiKey).toBeUndefined()
  })
})

describe('handleGetRequests', () => {
  it('returns traces with default count', () => {
    const res = mockRes()
    handleGetRequests({} as IncomingMessage, res, mockConfig, mockDeps, '/admin/requests')
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.traces).toHaveLength(3)
  })

  it('filters by model parameter', () => {
    const res = mockRes()
    handleGetRequests({} as IncomingMessage, res, mockConfig, mockDeps, '/admin/requests?model=trace-1')
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.traces.length).toBeGreaterThanOrEqual(1)
  })
})

describe('handleGetModelTruth', () => {
  it('returns truth snapshot and honors skipCache param', async () => {
    const res = mockRes()
    handleGetModelTruth({} as IncomingMessage, res, mockConfig, mockDeps, '/admin/model-truth?skipCache=true')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.runtimeOk).toBe(true)
    expect(Array.isArray(body.statuses)).toBe(true)
    expect(body.statuses[0].raw.config.apiKey).toBe('***')
    expect(body.byModelId['cloud-model'].raw.config.apiKey).toBe('***')
  })
})

describe('handleGetAudit', () => {
  it('returns audit entries', async () => {
    const res = mockRes()
    handleGetAudit({} as IncomingMessage, res, mockConfig, mockDeps, '/admin/audit')
    // handleGetAudit is async internally — wait for promise
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.entries).toHaveLength(2)
  })
})
