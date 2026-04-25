/**
 * Tests for src/healthz-client.ts — healthz types, host resolution, and matching.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveClientHost,
  healthzMatchesConfig,
  healthzMatchesRuntimeMeta,
  type HealthzResponse,
  type RuntimeMetaLike,
} from '../src/healthz-client.js'

// ─── resolveClientHost ───

describe('resolveClientHost', () => {
  it('maps 0.0.0.0 to 127.0.0.1', () => {
    expect(resolveClientHost('0.0.0.0')).toBe('127.0.0.1')
  })

  it('maps :: to 127.0.0.1', () => {
    expect(resolveClientHost('::')).toBe('127.0.0.1')
  })

  it('maps ::: to 127.0.0.1', () => {
    expect(resolveClientHost(':::')).toBe('127.0.0.1')
  })

  it('maps empty string to 127.0.0.1', () => {
    expect(resolveClientHost('')).toBe('127.0.0.1')
  })

  it('passes through specific addresses', () => {
    expect(resolveClientHost('127.0.0.1')).toBe('127.0.0.1')
    expect(resolveClientHost('192.168.1.100')).toBe('192.168.1.100')
    expect(resolveClientHost('localhost')).toBe('localhost')
  })
})

// ─── healthzMatchesConfig ───

const baseHealthz: HealthzResponse = {
  status: 'healthy',
  version: '0.9.9',
  pid: 1234,
  runtimeToken: 'tok-abc',
  host: '0.0.0.0',
  port: 8019,
  routerUrl: 'http://localhost:11435/v1',
}

describe('healthzMatchesConfig', () => {
  it('matches when port, routerUrl, and host align', () => {
    const config = { port: 8019, routerUrl: 'http://localhost:11435/v1', host: '0.0.0.0' }
    expect(healthzMatchesConfig(baseHealthz, config)).toBe(true)
  })

  it('matches wildcard host on healthz vs specific 127.0.0.1 in config', () => {
    const config = { port: 8019, routerUrl: 'http://localhost:11435/v1', host: '127.0.0.1' }
    expect(healthzMatchesConfig(baseHealthz, config)).toBe(true)
  })

  it('rejects port mismatch', () => {
    const config = { port: 9999, routerUrl: 'http://localhost:11435/v1', host: '0.0.0.0' }
    expect(healthzMatchesConfig(baseHealthz, config)).toBe(false)
  })

  it('rejects routerUrl mismatch', () => {
    const config = { port: 8019, routerUrl: 'http://other:11434/v1', host: '0.0.0.0' }
    expect(healthzMatchesConfig(baseHealthz, config)).toBe(false)
  })

  it('rejects host mismatch when neither is wildcard', () => {
    const healthz = { ...baseHealthz, host: '10.0.0.1' }
    const config = { port: 8019, routerUrl: 'http://localhost:11435/v1', host: '192.168.1.1' }
    expect(healthzMatchesConfig(healthz, config)).toBe(false)
  })
})

// ─── healthzMatchesRuntimeMeta ───

describe('healthzMatchesRuntimeMeta', () => {
  const meta: RuntimeMetaLike = {
    pid: 1234,
    runtimeToken: 'tok-abc',
    host: '0.0.0.0',
    port: 8019,
    routerUrl: 'http://localhost:11435/v1',
  }

  it('matches valid healthy status', () => {
    expect(healthzMatchesRuntimeMeta(baseHealthz, meta)).toBe(true)
  })

  it('accepts all valid statuses: ok, healthy, degraded, unhealthy', () => {
    for (const status of ['ok', 'healthy', 'degraded', 'unhealthy']) {
      expect(healthzMatchesRuntimeMeta({ ...baseHealthz, status }, meta)).toBe(true)
    }
  })

  it('rejects unknown status', () => {
    expect(healthzMatchesRuntimeMeta({ ...baseHealthz, status: 'bad' }, meta)).toBe(false)
  })

  it('rejects PID mismatch', () => {
    expect(healthzMatchesRuntimeMeta({ ...baseHealthz, pid: 9999 }, meta)).toBe(false)
  })

  it('rejects runtimeToken mismatch', () => {
    expect(healthzMatchesRuntimeMeta({ ...baseHealthz, runtimeToken: 'other' }, meta)).toBe(false)
  })

  it('rejects port mismatch', () => {
    expect(healthzMatchesRuntimeMeta({ ...baseHealthz, port: 9999 }, meta)).toBe(false)
  })

  it('matches wildcard hosts on both sides', () => {
    const metaWildcard = { ...meta, host: '::' }
    const healthzWildcard = { ...baseHealthz, host: '0.0.0.0' }
    expect(healthzMatchesRuntimeMeta(healthzWildcard, metaWildcard)).toBe(true)
  })
})
