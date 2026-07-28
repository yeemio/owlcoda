import * as http from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AdminAuthManager } from '../src/admin-api.js'
import { getAdminBearerToken } from '../src/admin-delivery.js'
import type { OwlCodaConfig } from '../src/config.js'
import { forceStopOrphanDaemon } from '../src/daemon.js'
import { setLogLevel } from '../src/logger.js'
import { startServer } from '../src/server.js'

const RUNTIME_SECRET = 'fixture-runtime-identity-secret'
const ADMIN_SECRET = 'fixture-admin-bearer-secret'
const MODEL_SECRET = 'fixture-model-api-key'
const BACKEND_SECRET = 'fixture-backend-api-key'
const HEADER_SECRET = 'fixture-authorization-header-secret'
const CUSTOM_HEADER_SECRET = 'fixture-opaque-custom-header-secret'

const TEST_CONFIG = {
  port: 0,
  host: '127.0.0.1',
  routerUrl: 'http://127.0.0.1:9',
  localRuntimeProtocol: 'auto',
  routerTimeoutMs: 250,
  models: [{
    id: 'security-fixture',
    label: 'Security fixture',
    backendModel: 'security-fixture',
    aliases: ['default'],
    tier: 'cloud',
    default: true,
    contextWindow: 8192,
    apiKey: MODEL_SECRET,
    headers: {
      Authorization: `Bearer ${HEADER_SECRET}`,
      'X-Auth': CUSTOM_HEADER_SECRET,
      'User-Agent': 'owlcoda-security-fixture',
    },
  }],
  responseModelStyle: 'platform',
  catalogLoaded: false,
  modelMap: {},
  defaultModel: 'security-fixture',
  reverseMapInResponse: true,
  logLevel: 'error',
  middleware: {},
  adminToken: ADMIN_SECRET,
  backends: [{
    type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: BACKEND_SECRET,
  }],
} as OwlCodaConfig

let server: http.Server
let baseUrl: string
let previousRuntimeSecret: string | undefined

beforeAll(async () => {
  previousRuntimeSecret = process.env['OWLCODA_RUNTIME_TOKEN']
  process.env['OWLCODA_RUNTIME_TOKEN'] = RUNTIME_SECRET
  server = startServer(TEST_CONFIG)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback test server address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousRuntimeSecret === undefined) {
    delete process.env['OWLCODA_RUNTIME_TOKEN']
  } else {
    process.env['OWLCODA_RUNTIME_TOKEN'] = previousRuntimeSecret
  }
})

describe('SEC-03 health trust boundary', () => {
  it('keeps unauthenticated health public and omits wildcard CORS and daemon identity metadata', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: 'https://attacker.invalid' },
    })
    const body = await response.json() as Record<string, unknown>

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('version')
    for (const internalField of [
      'pid',
      'host',
      'port',
      'routerUrl',
      'configFingerprint',
      'runtimeToken',
      'runtimeTokenFingerprint',
      'router',
      'circuitBreakers',
      'errorBudgets',
    ]) {
      expect(body).not.toHaveProperty(internalField)
    }
  })

  it('does not grant wildcard CORS preflight access to healthz', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.invalid',
        'access-control-request-method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('returns authenticated daemon identity metadata without echoing the identity secret', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { authorization: `Bearer ${RUNTIME_SECRET}` },
    })
    const body = await response.json() as Record<string, unknown>
    const serialized = JSON.stringify(body)

    expect(body.pid).toBe(process.pid)
    expect(body.runtimeTokenFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(body).not.toHaveProperty('runtimeToken')
    expect(serialized).not.toContain(RUNTIME_SECRET)
  })

  it('does not authorize process signaling from a public health response', async () => {
    const signal = vi.fn(() => true)
    const stopped = await forceStopOrphanDaemon(baseUrl, {
      fetchHealthz: async () => ({
        status: 'healthy',
        version: 'fixture',
      }),
      readRuntimeMeta: () => ({
        pid: process.pid,
        runtimeToken: RUNTIME_SECRET,
        host: '127.0.0.1',
        port: Number(new URL(baseUrl).port),
        routerUrl: TEST_CONFIG.routerUrl,
        version: 'fixture',
        startedAt: new Date(0).toISOString(),
      }),
      signal,
      waitGone: async () => true,
      isAlive: () => true,
    })

    expect(stopped).toBeNull()
    expect(signal).not.toHaveBeenCalled()
  })
})

describe('SEC-04 admin trust boundary', () => {
  it('does not derive the default admin bearer from a public port number', () => {
    expect(getAdminBearerToken({ port: 8123 }, RUNTIME_SECRET)).toBe(RUNTIME_SECRET)
    expect(getAdminBearerToken({ port: 8123 }, '')).toBeNull()
  })

  it('rejects replay of an already-consumed one-shot token', () => {
    const auth = new AdminAuthManager(ADMIN_SECRET)
    const token = auth.issueOneShotToken()

    expect(auth.exchangeOneShotToken(token)).not.toBeNull()
    expect(auth.exchangeOneShotToken(token)).toBeNull()
  })

  it('mints one-shot tokens through the authenticated loopback daemon and consumes them once', async () => {
    const issueResponse = await fetch(`${baseUrl}/admin/api/auth/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    })
    const issueBody = await issueResponse.json() as { token?: string }

    expect(issueResponse.status).toBe(200)
    expect(issueBody.token).toMatch(/^ots1\./)

    const exchangeUrl = `${baseUrl}/admin/api/auth/exchange?token=${encodeURIComponent(issueBody.token!)}`
    const firstExchange = await fetch(exchangeUrl)
    const replay = await fetch(exchangeUrl)
    expect(firstExchange.status).toBe(200)
    expect(replay.status).toBe(401)
  })

  it('redacts one-shot credentials from HTTP request logs', async () => {
    const issueResponse = await fetch(`${baseUrl}/admin/api/auth/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    })
    const issueBody = await issueResponse.json() as { token?: string }
    const token = issueBody.token!
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setLogLevel('info')
    try {
      const response = await fetch(
        `${baseUrl}/admin/api/auth/exchange?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent('/admin?tab=security')}`,
      )
      expect(response.status).toBe(200)
      await new Promise<void>(resolve => setImmediate(resolve))

      const logs = writeSpy.mock.calls.map(call => String(call[0])).join('')
      expect(logs).not.toContain(token)
      expect(logs).not.toContain(encodeURIComponent(token))
      expect(logs).toContain('token=%5BREDACTED%5D')
      expect(logs).toContain('returnTo=%2Fadmin%3Ftab%3Dsecurity')
    } finally {
      setLogLevel('error')
      writeSpy.mockRestore()
    }
  })

  it('uses CSPRNG-backed independent session and CSRF tokens', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const auth = new AdminAuthManager(ADMIN_SECRET)
      const first = auth.exchangeOneShotToken(auth.issueOneShotToken())
      const second = auth.exchangeOneShotToken(auth.issueOneShotToken())

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first?.sessionId).not.toBe(second?.sessionId)
      expect(first?.csrfToken).not.toBe(second?.csrfToken)
      expect(first?.sessionId).toMatch(/^sess_[A-Za-z0-9_-]{40,}$/)
      expect(first?.csrfToken).toMatch(/^csrf_[A-Za-z0-9_-]{40,}$/)
    } finally {
      randomSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  it('redacts secret-like values from current config and model-truth projections', async () => {
    const headers = { authorization: `Bearer ${ADMIN_SECRET}` }
    const responses = await Promise.all([
      fetch(`${baseUrl}/admin/api/config`, { headers }),
      fetch(`${baseUrl}/admin/api/snapshot`, { headers }),
      fetch(`${baseUrl}/admin/config`, { headers }),
      fetch(`${baseUrl}/admin/model-truth?skipCache=true`, { headers }),
    ])

    for (const response of responses) {
      expect(response.status).toBe(200)
      const serialized = await response.text()
      for (const secret of [ADMIN_SECRET, MODEL_SECRET, BACKEND_SECRET, HEADER_SECRET, CUSTOM_HEADER_SECRET]) {
        expect(serialized).not.toContain(secret)
      }
    }
  })
})
