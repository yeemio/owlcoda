/**
 * Server request dispatch tests — route matching, CORS, 404 handling, API info.
 * Uses real HTTP server on random port.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as http from 'node:http'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'

const TEST_CONFIG: OwlCodaConfig = {
  port: 0,
  host: '127.0.0.1',
  routerUrl: 'http://127.0.0.1:9999',
  routerTimeoutMs: 5000,
  models: [
    { id: 'test-model', label: 'Test', backendModel: 'test-model', aliases: ['default'], tier: 'general', default: true, contextWindow: 32768 },
  ],
  responseModelStyle: 'platform',
  catalogLoaded: false,
  modelMap: {},
  defaultModel: '',
  reverseMapInResponse: true,
  logLevel: 'error',
  contextWindow: 32768,
} as unknown as OwlCodaConfig

let server: http.Server
let baseUrl: string

const startOnce = (async () => {
  server = startServer(TEST_CONFIG)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})()

afterAll(async () => {
  await startOnce
  server?.close()
})

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  await startOnce
  return fetch(`${baseUrl}${path}`, init)
}

describe('server dispatch', () => {
  it('returns 204 for CORS OPTIONS on any path', async () => {
    const res = await fetchApi('/v1/messages', { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('returns 200 empty for unknown routes (CC-safe catch-all)', async () => {
    const res = await fetchApi('/unknown/path')
    expect(res.status).toBe(200)
  })

  it('returns api-info with endpoint list', async () => {
    const res = await fetchApi('/v1/api-info')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('OwlCoda')
    expect(body.endpoints).toBeInstanceOf(Array)
    expect(body.endpoints.length).toBeGreaterThan(0)
    // Should include core endpoints
    const paths = body.endpoints.map((e: any) => e.path)
    expect(paths).toContain('/v1/messages')
    expect(paths).toContain('/v1/models')
    expect(paths).toContain('/healthz')
  })

  it('returns valid OpenAPI spec', async () => {
    const res = await fetchApi('/openapi.json')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.openapi).toMatch(/^3\.0\.\d+$/)
    expect(body.info.title).toContain('OwlCoda')
    expect(body.paths).toBeDefined()
    expect(Object.keys(body.paths).length).toBeGreaterThan(5)
  })

  it('returns /healthz with status field', async () => {
    const res = await fetchApi('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(body).toHaveProperty('version')
  })

  it('returns /health basic info', async () => {
    const res = await fetchApi('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('uptime')
  })

  it('returns /v1/models list', async () => {
    const res = await fetchApi('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.data.length).toBeGreaterThan(0)
  })

  it('returns /v1/usage stats', async () => {
    const res = await fetchApi('/v1/usage')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('totalTokens')
    expect(body).toHaveProperty('pricingNote')
  })

  it('returns /dashboard JSON metrics', async () => {
    const res = await fetchApi('/dashboard')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body).toHaveProperty('totalRequests')
    expect(body).toHaveProperty('errorBudgets')
  })

  it('returns /metrics prometheus text', async () => {
    const res = await fetchApi('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('owlcoda_')
  })
})
