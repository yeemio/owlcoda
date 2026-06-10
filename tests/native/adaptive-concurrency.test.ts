import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AdaptiveConcurrencyController,
  __resetAdaptiveConcurrencyForTesting,
  adaptiveConcurrencyKeyFromApiBaseUrl,
  computeRequestRetryDelayMs,
  parseRetryAfterMs,
  requestAutoRetryLimit,
} from '../../src/native/adaptive-concurrency.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY']
  delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']
  delete process.env['OWLCODA_AGENT_RETRY_BUDGET_PER_WINDOW']
  delete process.env['OWLCODA_AGENT_RETRY_BUDGET_WINDOW_MS']
  __resetAdaptiveConcurrencyForTesting()
})

describe('AdaptiveConcurrencyController', () => {
  it('keeps cap=1 at effective limit 1', () => {
    const controller = new AdaptiveConcurrencyController()
    for (let i = 0; i < 10; i++) controller.recordSuccess('https://api.example.com', 1)
    expect(controller.currentLimit('https://api.example.com', 1)).toBe(1)
  })

  it('slow-starts from 1 and additively increases after 3 successes', () => {
    const controller = new AdaptiveConcurrencyController({ now: () => 1_000 })
    const key = 'https://api.example.com'
    expect(controller.currentLimit(key, 4)).toBe(1)
    controller.recordSuccess(key, 4)
    controller.recordSuccess(key, 4)
    expect(controller.currentLimit(key, 4)).toBe(1)
    controller.recordSuccess(key, 4)
    expect(controller.currentLimit(key, 4)).toBe(2)
    for (let i = 0; i < 20; i++) controller.recordSuccess(key, 4)
    expect(controller.currentLimit(key, 4)).toBe(4)
  })

  it('halves on rate-limit and suppresses increases during cooldown', () => {
    let now = 1_000
    const controller = new AdaptiveConcurrencyController({ now: () => now, cooldownMs: 5_000 })
    const key = 'https://api.example.com'
    for (let i = 0; i < 9; i++) controller.recordSuccess(key, 8)
    expect(controller.currentLimit(key, 8)).toBe(4)

    controller.recordRateLimit(key, 8)
    expect(controller.currentLimit(key, 8)).toBe(2)

    controller.recordSuccess(key, 8)
    controller.recordSuccess(key, 8)
    controller.recordSuccess(key, 8)
    expect(controller.currentLimit(key, 8)).toBe(2)

    now += 5_001
    controller.recordSuccess(key, 8)
    controller.recordSuccess(key, 8)
    controller.recordSuccess(key, 8)
    expect(controller.currentLimit(key, 8)).toBe(3)
  })
})

describe('adaptive concurrency helpers', () => {
  it('normalizes /v1/messages and trailing slash from API base keys', () => {
    expect(adaptiveConcurrencyKeyFromApiBaseUrl('https://api.example.com/v1/messages/')).toBe('https://api.example.com')
    expect(adaptiveConcurrencyKeyFromApiBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000')
  })

  it('honors Retry-After as a lower bound', () => {
    const retryAt = computeRequestRetryDelayMs({
      attempt: 0,
      status: 503,
      retryAfterHeader: '7',
      random: () => 0,
    })
    expect(retryAt).toBe(7_000)
  })

  it('parses HTTP-date Retry-After values', () => {
    const now = Date.parse('2026-05-29T00:00:00Z')
    expect(parseRetryAfterMs('Fri, 29 May 2026 00:00:03 GMT', now)).toBe(3_000)
  })

  it('uses wider ±50% rate-limit jitter only when adaptive mode is on', () => {
    expect(computeRequestRetryDelayMs({
      attempt: 0,
      status: 429,
      adaptive: false,
      random: () => 0,
    })).toBe(3_750)
    expect(computeRequestRetryDelayMs({
      attempt: 0,
      status: 429,
      adaptive: true,
      random: () => 0,
    })).toBe(2_500)
    expect(computeRequestRetryDelayMs({
      attempt: 0,
      status: 429,
      adaptive: true,
      random: () => 1,
    })).toBe(7_500)
  })

  it('raises auto-retry budget to 3 only when adaptive env flag is enabled', () => {
    expect(requestAutoRetryLimit(true, 'http_5xx')).toBe(1)
    process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'] = '1'
    expect(requestAutoRetryLimit(true, 'http_5xx')).toBe(3)
    expect(requestAutoRetryLimit(true, 'timeout')).toBe(0)
  })
})
