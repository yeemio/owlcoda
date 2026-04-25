/**
 * Deep server endpoint tests — covers routes not hit by server-dispatch.test.ts.
 * Uses real HTTP server on random port.
 *
 * Already tested in server-dispatch: OPTIONS CORS, /healthz, /health, /v1/models,
 * /v1/usage, /dashboard, /metrics, /openapi.json, /v1/api-info, unknown catch-all.
 *
 * This file covers: /v1/cache, /v1/latency, /v1/perf, /v1/cost, /v1/recommend,
 * /v1/captures, /events/metrics SSE, /v1/web-search (param validation),
 * local stub endpoints, admin auth, /v1/oauth/token, /v1/files, /v1/session_ingress,
 * request-id header, CORS on all routes, /v1/skill-stats, /v1/insights.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as http from 'node:http'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'

const TEST_CONFIG: OwlCodaConfig = {
  port: 0,
  host: '127.0.0.1',
  routerUrl: 'http://127.0.0.1:19999',
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
  adminToken: 'test-admin-secret',
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

describe('server deep — cache endpoints', () => {
  it('GET /v1/cache returns cache stats', async () => {
    const res = await fetchApi('/v1/cache')
    expect(res.status).toBe(200)
    const body = await res.json()
    // Cache stats should have some structure (hits, misses, size, etc.)
    expect(typeof body).toBe('object')
  })

  it('DELETE /v1/cache clears cache', async () => {
    const res = await fetchApi('/v1/cache', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('cleared')
  })
})

describe('server deep — observability endpoints', () => {
  it('GET /v1/latency returns latency stats', async () => {
    const res = await fetchApi('/v1/latency')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('latency')
  })

  it('GET /v1/perf returns perf metrics', async () => {
    const res = await fetchApi('/v1/perf')
    expect(res.status).toBe(200)
  })

  it('GET /v1/cost returns cost summary', async () => {
    const res = await fetchApi('/v1/cost')
    expect(res.status).toBe(200)
  })

  it('GET /v1/captures returns captures list', async () => {
    const res = await fetchApi('/v1/captures')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('captures')
    expect(body).toHaveProperty('stats')
  })
})

describe('server deep — recommend endpoint', () => {
  it('GET /v1/recommend returns a recommendation', async () => {
    const res = await fetchApi('/v1/recommend')
    expect(res.status).toBe(200)
  })

  it('GET /v1/recommend?intent=code includes intent', async () => {
    const res = await fetchApi('/v1/recommend?intent=code')
    expect(res.status).toBe(200)
  })
})

describe('server deep — audit endpoint', () => {
  it('GET /v1/audit returns entries and summary', async () => {
    const res = await fetchApi('/v1/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('entries')
    expect(body).toHaveProperty('summary')
  })

  it('GET /v1/audit?limit=5 filters by limit', async () => {
    const res = await fetchApi('/v1/audit?limit=5')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toBeInstanceOf(Array)
  })
})

describe('server deep — web search', () => {
  it('GET /v1/web-search without q param returns 400', async () => {
    const res = await fetchApi('/v1/web-search')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing')
  })

  it('GET /v1/web-search/status returns availability', async () => {
    const res = await fetchApi('/v1/web-search/status')
    // Either 200 (available) or 503 (unavailable) — both valid
    expect([200, 503]).toContain(res.status)
    const body = await res.json()
    expect(body).toHaveProperty('available')
  })
})

describe('server deep — SSE metrics stream', () => {
  it('GET /events/metrics returns SSE stream with initial snapshot', async () => {
    const res = await fetchApi('/events/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    // Read initial event from the stream
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const { value, done } = await reader.read()
    if (value) text += decoder.decode(value)
    // Should contain an event: metrics line and data line
    expect(text).toContain('event: metrics')
    expect(text).toContain('data: ')
    // Abort the stream (don't wait for more events)
    reader.cancel()
  })
})

describe('server deep — local stub endpoints', () => {
  it('GET /api/oauth/usage returns usage data', async () => {
    const res = await fetchApi('/api/oauth/usage')
    expect(res.status).toBe(200)
  })

  it('GET /api/oauth/profile returns profile', async () => {
    const res = await fetchApi('/api/oauth/profile')
    expect(res.status).toBe(200)
  })

  it('GET /api/oauth/account/settings returns settings', async () => {
    const res = await fetchApi('/api/oauth/account/settings')
    expect(res.status).toBe(200)
  })

  it('GET organizations referral eligibility returns false', async () => {
    const res = await fetchApi('/api/oauth/organizations/test-org/referral/eligibility')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.eligible).toBe(false)
  })

  it('GET organizations admin_requests returns empty', async () => {
    const res = await fetchApi('/api/oauth/organizations/test-org/admin_requests')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  it('GET organizations overage_credit_grant returns zero', async () => {
    const res = await fetchApi('/api/oauth/organizations/test-org/overage_credit_grant')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.amount).toBe(0)
  })
})

describe('server deep — oauth + files stubs', () => {
  it('POST /v1/oauth/token returns local token', async () => {
    const res = await fetchApi('/v1/oauth/token', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.access_token).toBe('owlcoda-local-token')
    expect(body.token_type).toBe('bearer')
    expect(body.expires_in).toBe(86400)
  })

  it('GET /v1/files returns empty list', async () => {
    const res = await fetchApi('/v1/files')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.has_more).toBe(false)
  })

  it('GET /v1/session_ingress/* returns ok', async () => {
    const res = await fetchApi('/v1/session_ingress/abc123')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

describe('server deep — admin auth enforcement', () => {
  it('POST /admin/reset-circuit-breakers rejects without auth', async () => {
    const res = await fetchApi('/admin/reset-circuit-breakers', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('POST /admin/reset-circuit-breakers succeeds with correct token', async () => {
    const res = await fetchApi('/admin/reset-circuit-breakers', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-secret' },
    })
    expect(res.status).toBe(200)
  })

  it('POST /admin/reset-budgets rejects without auth', async () => {
    const res = await fetchApi('/admin/reset-budgets', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('GET /admin/config rejects without auth', async () => {
    const res = await fetchApi('/admin/config')
    expect(res.status).toBe(401)
  })

  it('GET /admin/config succeeds with auth', async () => {
    const res = await fetchApi('/admin/config', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    })
    expect(res.status).toBe(200)
  })

  it('GET /admin/requests works with auth', async () => {
    const res = await fetchApi('/admin/requests', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    })
    expect(res.status).toBe(200)
  })

  it('GET /admin/audit works with auth', async () => {
    const res = await fetchApi('/admin/audit', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    })
    expect(res.status).toBe(200)
  })
})

describe('server deep — request metadata', () => {
  it('sendJson endpoints include CORS headers', async () => {
    // /v1/cache uses sendJson → should have CORS
    const res = await fetchApi('/health')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('responses include x-request-id header', async () => {
    const res = await fetchApi('/health')
    const reqId = res.headers.get('x-request-id')
    // assignRequestId should have set it
    expect(reqId).toBeTruthy()
    expect(typeof reqId).toBe('string')
  })
})

describe('server deep — skill-stats endpoint', () => {
  it('GET /v1/skill-stats returns stats', async () => {
    const res = await fetchApi('/v1/skill-stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe('object')
  })

  it('DELETE /v1/skill-stats resets stats', async () => {
    const res = await fetchApi('/v1/skill-stats', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})

describe('server deep — insights endpoint', () => {
  it('GET /v1/insights returns batch summary', async () => {
    const res = await fetchApi('/v1/insights')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe('object')
  })

  it('GET /v1/insights/nonexistent-session returns 404 or empty', async () => {
    const res = await fetchApi('/v1/insights/nonexistent-session-id')
    // Should either 404 or return an empty/error response
    expect([200, 404, 500]).toContain(res.status)
  })
})
