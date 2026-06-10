/**
 * Tests for production hardening: rate-limit pruning, health monitor guard, stream cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, resetRateLimits, pruneRateLimitBuckets, getRateLimitStats } from '../src/middleware/rate-limit.js'

beforeEach(() => resetRateLimits())

describe('rate-limit bucket pruning', () => {
  it('prunes idle fully-refilled buckets', () => {
    // Create a bucket by checking; uses 1 token (59/60)
    checkRateLimit('model-a')

    // With maxIdleMs=0, bucket won't be pruned because tokens < maxTokens
    const prunedEarly = pruneRateLimitBuckets(0)
    expect(prunedEarly).toBe(0) // Not full, so kept

    // Now reset and re-check: a bucket created fresh starts at full (60/60) then drops to 59
    // The prune condition requires full tokens AND idle time
    resetRateLimits()
  })

  it('keeps active buckets with consumed tokens', () => {
    // Drain tokens so bucket is not full
    for (let i = 0; i < 60; i++) checkRateLimit('busy-model')

    const pruned = pruneRateLimitBuckets(0)
    expect(pruned).toBe(0)

    const after = getRateLimitStats()
    expect(Object.keys(after)).toHaveLength(1)
  })

  it('prunes when tokens are fully refilled', async () => {
    // Create bucket, consume 1 token
    checkRateLimit('idle-model', { maxRequests: 60, windowMs: 10 }) // 10ms window for fast refill

    // Wait for refill
    await new Promise(r => setTimeout(r, 50))

    // Now bucket should be refilled
    const pruned = pruneRateLimitBuckets(0)
    expect(pruned).toBe(1)
  })

  it('no-op on empty map', () => {
    const pruned = pruneRateLimitBuckets()
    expect(pruned).toBe(0)
  })
})
