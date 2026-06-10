/**
 * Streaming headers-timeout budget (Issue #2 dogfood: 30s headers timeout vs
 * slow local CPU prefill).
 *
 * The upstream streaming fetch fails fast if no response *headers* arrive in
 * time. A hardcoded 30s budget is right for cloud (catch a stuck connect) but
 * wrong for a loopback runtime: a small model + a 47-tool agent payload can
 * take 30–60s of CPU prefill before Ollama emits the first byte, so the guard
 * fires spuriously and the fallback chain escalates to a heavier model. Give
 * loopback endpoints a longer budget, capped by the request's own timeout;
 * leave cloud untouched.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveHeadersTimeoutMs,
  isLoopbackEndpoint,
  readCloudHeadersTimeoutMsFromEnv,
  CLOUD_HEADERS_TIMEOUT_MS,
  LOCAL_HEADERS_TIMEOUT_MS,
} from '../src/endpoints/headers-timeout.js'

describe('isLoopbackEndpoint', () => {
  it('treats 127.0.0.1 as loopback', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:11434/v1/chat/completions')).toBe(true)
  })
  it('treats localhost as loopback', () => {
    expect(isLoopbackEndpoint('http://localhost:1234/v1/chat/completions')).toBe(true)
  })
  it('treats ::1 as loopback', () => {
    expect(isLoopbackEndpoint('http://[::1]:11434/v1/chat/completions')).toBe(true)
  })
  it('treats a public host as non-loopback', () => {
    expect(isLoopbackEndpoint('https://api.openai.com/v1/chat/completions')).toBe(false)
  })
  it('is false for a malformed URL', () => {
    expect(isLoopbackEndpoint('not a url')).toBe(false)
  })
})

describe('resolveHeadersTimeoutMs', () => {
  it('gives a loopback runtime the longer local budget (covers slow CPU prefill)', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      routeTimeoutMs: 600_000,
    })).toBe(LOCAL_HEADERS_TIMEOUT_MS)
  })

  it('keeps cloud endpoints at the 30s fail-fast budget', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'https://api.openai.com/v1/chat/completions',
      routeTimeoutMs: 600_000,
    })).toBe(CLOUD_HEADERS_TIMEOUT_MS)
  })

  it('never lets the local headers budget exceed the request timeout', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      routeTimeoutMs: 45_000,
    })).toBe(45_000)
  })

  it('honors a sub-30s local request timeout', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'http://localhost:11434/v1/chat/completions',
      routeTimeoutMs: 10_000,
    })).toBe(10_000)
  })

  it('local budget is strictly larger than the cloud default', () => {
    expect(LOCAL_HEADERS_TIMEOUT_MS).toBeGreaterThan(CLOUD_HEADERS_TIMEOUT_MS)
  })

  it('applies an explicit cloud headers override to cloud endpoints (slow reasoning models)', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'https://api.openai.com/v1/chat/completions',
      routeTimeoutMs: 600_000,
      cloudHeadersTimeoutMs: 180_000,
    })).toBe(180_000)
  })

  it('keeps the 30s default when no cloud override is supplied', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'https://api.openai.com/v1/chat/completions',
      routeTimeoutMs: 600_000,
      cloudHeadersTimeoutMs: undefined,
    })).toBe(CLOUD_HEADERS_TIMEOUT_MS)
  })

  it('does not let the cloud override touch loopback runtimes', () => {
    expect(resolveHeadersTimeoutMs({
      endpointUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      routeTimeoutMs: 600_000,
      cloudHeadersTimeoutMs: 5_000,
    })).toBe(LOCAL_HEADERS_TIMEOUT_MS)
  })
})

describe('readCloudHeadersTimeoutMsFromEnv', () => {
  it('defaults to the 30s fail-fast budget when the override is unset', () => {
    expect(readCloudHeadersTimeoutMsFromEnv({})).toBe(CLOUD_HEADERS_TIMEOUT_MS)
  })

  it('honors an explicit override (lets a slow cloud model emit headers without premature fallback)', () => {
    expect(readCloudHeadersTimeoutMsFromEnv({ OWLCODA_CLOUD_HEADERS_TIMEOUT_MS: '180000' })).toBe(180_000)
  })

  it('ignores a non-numeric or non-positive override and keeps the default', () => {
    expect(readCloudHeadersTimeoutMsFromEnv({ OWLCODA_CLOUD_HEADERS_TIMEOUT_MS: 'abc' })).toBe(CLOUD_HEADERS_TIMEOUT_MS)
    expect(readCloudHeadersTimeoutMsFromEnv({ OWLCODA_CLOUD_HEADERS_TIMEOUT_MS: '0' })).toBe(CLOUD_HEADERS_TIMEOUT_MS)
    expect(readCloudHeadersTimeoutMsFromEnv({ OWLCODA_CLOUD_HEADERS_TIMEOUT_MS: '-5' })).toBe(CLOUD_HEADERS_TIMEOUT_MS)
  })
})
