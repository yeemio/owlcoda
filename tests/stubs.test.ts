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
    { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['default'], tier: 'production', default: true },
    { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy' },
  ],
  responseModelStyle: 'platform',
  catalogLoaded: false,
  modelMap: {},
  defaultModel: '',
  reverseMapInResponse: true,
  logLevel: 'error',
}

let server: http.Server
let port: number

function startTestServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const s = startServer({ ...TEST_CONFIG, port: 0 })
    s.on('listening', () => {
      const addr = s.address() as { port: number }
      resolve({ server: s, port: addr.port })
    })
  })
}

async function fetchJson(path: string, method = 'GET'): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method })
  const body = await res.json()
  return { status: res.status, body, headers: res.headers }
}

describe('stub endpoints', () => {
  it('setup', async () => {
    const s = await startTestServer()
    server = s.server
    port = s.port
  })

  it('GET /api/oauth/usage returns zero utilization', async () => {
    const { status, body } = await fetchJson('/api/oauth/usage')
    expect(status).toBe(200)
    expect(body.five_hour).toBeDefined()
    expect(body.five_hour.utilization).toBe(0)
    expect(body.seven_day).toBeDefined()
    expect(body.seven_day.utilization).toBe(0)
  })

  it('GET /api/oauth/profile returns local user', async () => {
    const { status, body } = await fetchJson('/api/oauth/profile')
    expect(status).toBe(200)
    expect(body.id).toBe('local-user')
    expect(body.email).toBe('local@owlcoda')
  })

  it('GET /api/oauth/account/settings returns grove disabled', async () => {
    const { status, body } = await fetchJson('/api/oauth/account/settings')
    expect(status).toBe(200)
    expect(body.grove_enabled).toBe(false)
  })

  it('POST /v1/oauth/token returns fake token', async () => {
    const { status, body } = await fetchJson('/v1/oauth/token', 'POST')
    expect(status).toBe(200)
    expect(body.access_token).toBe('owlcoda-local-token')
    expect(body.token_type).toBe('bearer')
  })

  it('GET /v1/files returns empty list', async () => {
    const { status, body } = await fetchJson('/v1/files')
    expect(status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('GET /v1/session_ingress/xyz returns ok', async () => {
    const { status, body } = await fetchJson('/v1/session_ingress/some-session-id')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it('unknown endpoint returns 200 empty instead of 404', async () => {
    const { status, body } = await fetchJson('/some/unknown/path')
    expect(status).toBe(200)
    expect(body).toEqual({})
  })

  it('GET /healthz returns version and status (may be unhealthy without router)', async () => {
    const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')))
    const { status, body } = await fetchJson('/healthz')
    // Deep probe returns 503 when router unreachable, 200 when healthy
    expect([200, 503]).toContain(status)
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(body.version).toBe(pkg.version)
  })

  it('GET /v1/models returns models with availability field', async () => {
    const { status, body } = await fetchJson('/v1/models')
    expect(status).toBe(200)
    expect(body.data).toBeDefined()
    expect(body.data.length).toBeGreaterThan(0)
    // Each model should have an availability field
    for (const m of body.data) {
      expect(m.id).toBeDefined()
      expect(m.display_name).toBeDefined()
      expect(m.availability).toBeDefined()
      expect(['available', 'unavailable', 'unknown']).toContain(m.availability)
    }
    // Primary display is platform model ID, not short label
    const ids = body.data.map((m: any) => m.id)
    expect(ids).toContain('qwen2.5-coder:32b')
  })

  it('GET /v1/models availability field is one of the legal values', async () => {
    // Router at port 9999 is configured-but-unreachable in this fixture.
    // Earlier we asserted the stricter "not 'available'" contract here,
    // but the model-truth aggregator now consults runtime + discovery +
    // catalog signals in addition to the router probe — and on a dev
    // machine where the same model ID happens to be loaded in a real
    // local runtime the snapshot can legitimately resolve to 'available'.
    // For the public contract we only require: the field exists and is
    // one of the documented legal values. End-to-end degradation is
    // covered by the router-specific tests in availability.test.ts.
    await new Promise(r => setTimeout(r, 500))
    const { body } = await fetchJson('/v1/models')
    for (const m of body.data) {
      expect(['available', 'unknown', 'unavailable']).toContain(m.availability)
    }
  })

  it('URL with query string routes correctly', async () => {
    const { status, body } = await fetchJson('/api/oauth/usage?foo=bar')
    expect(status).toBe(200)
    expect(body.five_hour).toBeDefined()
  })

  afterAll(() => {
    server?.close()
  })
})
