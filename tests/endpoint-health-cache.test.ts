import { describe, it, expect } from 'vitest'
import {
  EndpointHealthCache,
  sampleFromProbeResult,
} from '../src/endpoint-health-cache.js'

const baseSample = {
  endpoint: 'http://localhost:11434/v1',
  ok: true,
  latencyMs: 12,
  status: 200,
  detail: 'reachable',
  observedAt: 1_000,
}

describe('EndpointHealthCache', () => {
  it('returns undefined for an unrecorded endpoint', () => {
    const cache = new EndpointHealthCache()
    expect(cache.get('http://nope')).toBeUndefined()
  })

  it('returns the recorded sample within TTL', () => {
    const cache = new EndpointHealthCache({ ttlMs: 1_000 })
    cache.record(baseSample)
    const sample = cache.get(baseSample.endpoint, 1_500)
    expect(sample).toBeDefined()
    expect(sample?.ok).toBe(true)
    expect(sample?.latencyMs).toBe(12)
  })

  it('evicts samples past TTL and removes them from size()', () => {
    const cache = new EndpointHealthCache({ ttlMs: 1_000 })
    cache.record(baseSample)
    expect(cache.get(baseSample.endpoint, 2_500)).toBeUndefined()
    expect(cache.size(2_500)).toBe(0)
  })

  it('overwrites earlier sample with the latest record() for same endpoint', () => {
    const cache = new EndpointHealthCache({ ttlMs: 10_000 })
    cache.record({ ...baseSample, ok: false, detail: 'fail', observedAt: 1_000 })
    cache.record({ ...baseSample, ok: true, detail: 'ok', observedAt: 1_500 })
    const sample = cache.get(baseSample.endpoint, 1_600)
    expect(sample?.ok).toBe(true)
    expect(sample?.detail).toBe('ok')
  })

  it('list() omits expired entries without throwing', () => {
    const cache = new EndpointHealthCache({ ttlMs: 1_000 })
    cache.record({ ...baseSample, endpoint: 'http://a', observedAt: 1_000 })
    cache.record({ ...baseSample, endpoint: 'http://b', observedAt: 1_500 })
    const fresh = cache.list(2_200).map(s => s.endpoint).sort()
    expect(fresh).toEqual(['http://b'])
  })

  it('clear() drops every sample', () => {
    const cache = new EndpointHealthCache()
    cache.record(baseSample)
    cache.clear()
    expect(cache.size()).toBe(0)
  })

  it('record() ignores samples with empty endpoint to avoid polluting the map', () => {
    const cache = new EndpointHealthCache()
    cache.record({ ...baseSample, endpoint: '' })
    expect(cache.size()).toBe(0)
  })
})

describe('sampleFromProbeResult', () => {
  it('maps probe-result-shaped input to a cache sample with observedAt', () => {
    const sample = sampleFromProbeResult(
      'http://localhost:8066/v1',
      {
        ok: true,
        latencyMs: 87,
        status: 200,
        detail: 'pong',
        credentialSource: 'env',
      },
      1_234,
    )
    expect(sample).toEqual({
      endpoint: 'http://localhost:8066/v1',
      ok: true,
      latencyMs: 87,
      status: 200,
      detail: 'pong',
      credentialSource: 'env',
      observedAt: 1_234,
    })
  })

  it('passes through undefined credentialSource and status without inventing defaults', () => {
    const sample = sampleFromProbeResult(
      'http://x',
      { ok: false, latencyMs: 0, detail: 'unreachable' },
      500,
    )
    expect(sample.credentialSource).toBeUndefined()
    expect(sample.status).toBeUndefined()
    expect(sample.observedAt).toBe(500)
  })
})
