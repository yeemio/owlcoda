import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, getRateLimitStats, resetRateLimits } from '../src/middleware/rate-limit.js'

describe('rate-limit middleware', () => {
  beforeEach(() => {
    resetRateLimits()
  })

  it('allows requests within limit', () => {
    const result = checkRateLimit('test-model')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBeGreaterThan(0)
  })

  it('exhausts bucket after maxRequests', () => {
    // Default is 60 RPM — exhaust it
    for (let i = 0; i < 60; i++) {
      const r = checkRateLimit('exhaust-model')
      expect(r.allowed).toBe(true)
    }
    const blocked = checkRateLimit('exhaust-model')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('isolates rate limits per model', () => {
    // Exhaust model-a
    for (let i = 0; i < 60; i++) {
      checkRateLimit('model-a')
    }
    // model-b should still be allowed
    const result = checkRateLimit('model-b')
    expect(result.allowed).toBe(true)
  })

  it('reports stats correctly', () => {
    checkRateLimit('stats-model')
    checkRateLimit('stats-model')
    const stats = getRateLimitStats()
    expect(stats['stats-model']).toBeDefined()
    expect(stats['stats-model']!.remaining).toBe(58) // 60 - 2
    expect(stats['stats-model']!.total).toBe(60)
  })

  it('reset clears all buckets', () => {
    checkRateLimit('reset-model')
    resetRateLimits()
    const stats = getRateLimitStats()
    expect(stats['reset-model']).toBeUndefined()
  })
})
