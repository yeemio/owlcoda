/**
 * Per-model token bucket rate limiter.
 * Default: 60 requests per minute per model.
 */

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

interface Bucket {
  tokens: number
  lastRefill: number
  lastAccessAt: number
  maxTokens: number
  refillRate: number // tokens per ms
}

const buckets = new Map<string, Bucket>()

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000,
}

function getBucket(modelId: string, config: RateLimitConfig = DEFAULT_CONFIG): Bucket {
  let bucket = buckets.get(modelId)
  if (!bucket) {
    bucket = {
      tokens: config.maxRequests,
      lastRefill: Date.now(),
      lastAccessAt: Date.now(),
      maxTokens: config.maxRequests,
      refillRate: config.maxRequests / config.windowMs,
    }
    buckets.set(modelId, bucket)
  }
  bucket.lastAccessAt = Date.now()
  return bucket
}

function refillBucket(bucket: Bucket): void {
  const now = Date.now()
  const elapsed = now - bucket.lastRefill
  const tokensToAdd = elapsed * bucket.refillRate
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd)
  bucket.lastRefill = now
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs?: number
}

/**
 * Check if a request to this model is allowed.
 */
export function checkRateLimit(modelId: string, config?: RateLimitConfig): RateLimitResult {
  const bucket = getBucket(modelId, config)
  refillBucket(bucket)

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { allowed: true, remaining: Math.floor(bucket.tokens) }
  }

  // Calculate wait time for 1 token
  const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate)
  return { allowed: false, remaining: 0, retryAfterMs: waitMs }
}

export interface RateLimitStats {
  remaining: number
  total: number
  resetAtMs: number
}

/**
 * Get rate limit stats for all tracked models.
 */
export function getRateLimitStats(): Record<string, RateLimitStats> {
  const stats: Record<string, RateLimitStats> = {}
  for (const [modelId, bucket] of buckets) {
    refillBucket(bucket)
    const msUntilFull = bucket.tokens >= bucket.maxTokens
      ? 0
      : Math.ceil((bucket.maxTokens - bucket.tokens) / bucket.refillRate)
    stats[modelId] = {
      remaining: Math.floor(bucket.tokens),
      total: bucket.maxTokens,
      resetAtMs: Date.now() + msUntilFull,
    }
  }
  return stats
}

/**
 * Prune stale rate limit buckets not accessed in the given window.
 * Call periodically (e.g., every 5 minutes) to prevent unbounded growth.
 */
export function pruneRateLimitBuckets(maxIdleMs = 300_000): number {
  const now = Date.now()
  let pruned = 0
  for (const [modelId, bucket] of buckets) {
    refillBucket(bucket)
    if (now - bucket.lastAccessAt >= maxIdleMs && bucket.tokens >= bucket.maxTokens) {
      buckets.delete(modelId)
      pruned++
    }
  }
  return pruned
}

/**
 * Reset all rate limit buckets (for testing).
 */
export function resetRateLimits(): void {
  buckets.clear()
}
