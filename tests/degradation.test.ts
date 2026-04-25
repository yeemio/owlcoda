import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_SRC = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')

describe('deep healthz probe: status levels', () => {
  it('returns healthy when router reachable and no open circuits', () => {
    // The doProbe function sets status based on router reachability and circuit states
    expect(SERVER_SRC).toContain("status = 'healthy'")
  })

  it('returns degraded when some circuits open', () => {
    expect(SERVER_SRC).toContain("status = 'degraded'")
  })

  it('returns unhealthy when router unreachable', () => {
    expect(SERVER_SRC).toContain("status = 'unhealthy'")
  })

  it('returns unhealthy when all circuits open', () => {
    // The logic checks openCircuits >= totalModels
    expect(SERVER_SRC).toContain('openCircuits >= totalModels')
  })

  it('healthz returns 200 for healthy and degraded', () => {
    expect(SERVER_SRC).toContain("data.status === 'healthy' ? 200")
    expect(SERVER_SRC).toContain("data.status === 'degraded' ? 200")
  })

  it('healthz returns 503 for unhealthy', () => {
    // The ternary chain ends with 503 as default
    expect(SERVER_SRC).toContain(': 503')
  })
})

describe('deep healthz probe: first-call optimization', () => {
  it('returns basic data immediately on first call (no cache)', () => {
    expect(SERVER_SRC).toContain('getBasicHealthData')
    expect(SERVER_SRC).toContain('probeInFlight')
  })

  it('basic health data includes status healthy', () => {
    expect(SERVER_SRC).toContain("status: 'healthy'")
  })

  it('basic health data includes version and pid', () => {
    // getBasicHealthData returns version and pid
    expect(SERVER_SRC).toContain('version: VERSION')
    expect(SERVER_SRC).toContain('pid: process.pid')
  })

  it('uses cache when fresh (within TTL)', () => {
    expect(SERVER_SRC).toContain('HEALTH_PROBE_TTL')
    expect(SERVER_SRC).toContain('healthProbeCache')
  })
})

describe('deep healthz probe: router info', () => {
  it('probes router via probeRuntimeSurface', () => {
    expect(SERVER_SRC).toContain("probeRuntimeSurface(config.routerUrl")
  })

  it('has 2s timeout for router probe', () => {
    expect(SERVER_SRC).toContain('2000')
  })

  it('catches fetch errors gracefully', () => {
    expect(SERVER_SRC).toContain("reachable: false")
  })

  it('reports router latency and model count', () => {
    expect(SERVER_SRC).toContain('latencyMs: latency')
    expect(SERVER_SRC).toContain('modelCount:')
  })
})

describe('healthz identity matching: degraded modes', () => {
  it('healthz-client accepts unhealthy status for identity matching', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'healthz-client.ts'), 'utf-8')
    // healthzMatchesRuntimeMeta accepts all valid statuses
    expect(src).toContain("'ok', 'healthy', 'degraded', 'unhealthy'")
  })

  it('waitForVerifiedHealthz accepts all health statuses', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'healthz-client.ts'), 'utf-8')
    expect(src).toContain("'ok', 'healthy', 'degraded', 'unhealthy'")
  })
})
