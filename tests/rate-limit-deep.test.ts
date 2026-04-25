/**
 * Deep rate-limit tests — token bucket mechanics, refill, prune, stats.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkRateLimit,
  getRateLimitStats,
  resetRateLimits,
  pruneRateLimitBuckets,
} from '../src/middleware/rate-limit.js'

beforeEach(() => resetRateLimits())

describe('checkRateLimit — token bucket', () => {
  it('allows requests up to limit', () => {
    const config = { maxRequests: 5, windowMs: 60000 }
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit('model-x', config)
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(5 - i - 1)
    }
  })

  it('blocks after limit exhausted', () => {
    const config = { maxRequests: 3, windowMs: 60000 }
    checkRateLimit('model-y', config)
    checkRateLimit('model-y', config)
    checkRateLimit('model-y', config)
    const result = checkRateLimit('model-y', config)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('tracks models independently', () => {
    const config = { maxRequests: 2, windowMs: 60000 }
    checkRateLimit('model-a', config)
    checkRateLimit('model-a', config)
    const resultA = checkRateLimit('model-a', config)
    expect(resultA.allowed).toBe(false)

    const resultB = checkRateLimit('model-b', config)
    expect(resultB.allowed).toBe(true)
  })

  it('uses default config (60 req/min) when none provided', () => {
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit('default-model').allowed).toBe(true)
    }
    expect(checkRateLimit('default-model').allowed).toBe(false)
  })

  it('refills tokens after window elapses', async () => {
    const config = { maxRequests: 2, windowMs: 50 } // 50ms window for fast test
    checkRateLimit('fast-model', config)
    checkRateLimit('fast-model', config)
    expect(checkRateLimit('fast-model', config).allowed).toBe(false)

    await new Promise(r => setTimeout(r, 60))
    const result = checkRateLimit('fast-model', config)
    expect(result.allowed).toBe(true)
  })

  it('provides retryAfterMs when blocked', () => {
    const config = { maxRequests: 1, windowMs: 10000 }
    checkRateLimit('wait-model', config)
    const result = checkRateLimit('wait-model', config)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(result.retryAfterMs).toBeLessThanOrEqual(10000)
  })
})

describe('getRateLimitStats', () => {
  it('returns empty stats when no models tracked', () => {
    const stats = getRateLimitStats()
    expect(Object.keys(stats)).toHaveLength(0)
  })

  it('returns stats for tracked models', () => {
    const config = { maxRequests: 10, windowMs: 60000 }
    checkRateLimit('stat-model-1', config)
    checkRateLimit('stat-model-1', config)
    checkRateLimit('stat-model-2', config)

    const stats = getRateLimitStats()
    expect(stats['stat-model-1']).toBeDefined()
    expect(stats['stat-model-2']).toBeDefined()
    expect(stats['stat-model-1']!.total).toBe(10)
    expect(stats['stat-model-1']!.remaining).toBeLessThan(10)
    expect(stats['stat-model-2']!.remaining).toBeLessThan(10)
  })

  it('includes resetAtMs in the future', () => {
    const config = { maxRequests: 5, windowMs: 60000 }
    checkRateLimit('time-model', config)

    const stats = getRateLimitStats()
    expect(stats['time-model']!.resetAtMs).toBeGreaterThan(Date.now())
  })
})

describe('pruneRateLimitBuckets', () => {
  it('returns 0 when no buckets exist', () => {
    expect(pruneRateLimitBuckets()).toBe(0)
  })

  it('prunes fully-refilled idle buckets', async () => {
    const config = { maxRequests: 5, windowMs: 10 } // fast refill
    checkRateLimit('prunable', config)
    await new Promise(r => setTimeout(r, 30))
    const pruned = pruneRateLimitBuckets(0) // 0ms idle threshold
    expect(pruned).toBe(1)
    expect(Object.keys(getRateLimitStats())).toHaveLength(0)
  })

  it('keeps buckets with consumed tokens', () => {
    const config = { maxRequests: 100, windowMs: 60000 }
    for (let i = 0; i < 50; i++) checkRateLimit('busy', config)
    const pruned = pruneRateLimitBuckets(0)
    expect(pruned).toBe(0)
  })

  it('handles mixed prune/keep correctly', async () => {
    const fastConfig = { maxRequests: 5, windowMs: 10 }
    const slowConfig = { maxRequests: 100, windowMs: 60000 }
    checkRateLimit('idle-fast', fastConfig)
    for (let i = 0; i < 50; i++) checkRateLimit('busy-slow', slowConfig)

    await new Promise(r => setTimeout(r, 30))
    const pruned = pruneRateLimitBuckets(0)
    expect(pruned).toBe(1) // only idle-fast pruned
    expect(getRateLimitStats()['busy-slow']).toBeDefined()
    expect(getRateLimitStats()['idle-fast']).toBeUndefined()
  })
})

describe('resetRateLimits', () => {
  it('clears all tracked models', () => {
    checkRateLimit('a')
    checkRateLimit('b')
    checkRateLimit('c')
    expect(Object.keys(getRateLimitStats())).toHaveLength(3)

    resetRateLimits()
    expect(Object.keys(getRateLimitStats())).toHaveLength(0)
  })

  it('allows full quota after reset', () => {
    const config = { maxRequests: 2, windowMs: 60000 }
    checkRateLimit('reset-test', config)
    checkRateLimit('reset-test', config)
    expect(checkRateLimit('reset-test', config).allowed).toBe(false)

    resetRateLimits()
    expect(checkRateLimit('reset-test', config).allowed).toBe(true)
    expect(checkRateLimit('reset-test', config).allowed).toBe(true)
  })
})
