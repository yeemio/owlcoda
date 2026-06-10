/**
 * Response cache — cache non-streaming responses by content hash.
 * LRU eviction with TTL. Useful for repeated identical queries.
 */

import { createHash } from 'node:crypto'

export interface CacheEntry {
  key: string
  body: string
  statusCode: number
  headers: Record<string, string>
  cachedAt: number
  hits: number
}

export interface CacheConfig {
  maxEntries: number
  maxBytes: number
  ttlMs: number
  enabled: boolean
}

const DEFAULT_CONFIG: CacheConfig = {
  maxEntries: 100,
  maxBytes: 10 * 1024 * 1024, // 10 MB
  ttlMs: 300_000, // 5 minutes
  enabled: true,
}

const cache = new Map<string, CacheEntry>()
let config = { ...DEFAULT_CONFIG }
let totalHits = 0
let totalMisses = 0
let totalBytes = 0

/**
 * Configure the cache.
 */
export function configureCache(opts: Partial<CacheConfig>): void {
  config = { ...config, ...opts }
}

/**
 * Generate cache key from model + messages.
 */
export function cacheKey(model: string, messages: unknown[], extra?: Record<string, unknown>): string {
  const data = JSON.stringify({ model, messages, ...(extra || {}) })
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

/**
 * Get a cached response if available and not expired.
 */
export function getCached(key: string): CacheEntry | null {
  if (!config.enabled) return null

  const entry = cache.get(key)
  if (!entry) {
    totalMisses++
    return null
  }

  // Check TTL
  if (Date.now() - entry.cachedAt > config.ttlMs) {
    totalBytes -= entry.body.length * 2
    cache.delete(key)
    totalMisses++
    return null
  }

  // LRU: move to end
  cache.delete(key)
  entry.hits++
  cache.set(key, entry)
  totalHits++

  return entry
}

/**
 * Store a response in the cache.
 */
export function putCache(key: string, body: string, statusCode: number, headers: Record<string, string> = {}): void {
  if (!config.enabled) return

  const entryBytes = body.length * 2 // rough UTF-16 estimate

  // Evict oldest while over entry count or byte limit
  while (cache.size >= config.maxEntries || (totalBytes + entryBytes > config.maxBytes && cache.size > 0)) {
    const firstKey = cache.keys().next().value
    if (firstKey === undefined) break
    const evicted = cache.get(firstKey)
    if (evicted) totalBytes -= evicted.body.length * 2
    cache.delete(firstKey)
  }

  totalBytes += entryBytes
  cache.set(key, {
    key,
    body,
    statusCode,
    headers,
    cachedAt: Date.now(),
    hits: 0,
  })
}

export interface CacheStats {
  size: number
  maxEntries: number
  maxBytes: number
  currentBytes: number
  ttlMs: number
  enabled: boolean
  totalHits: number
  totalMisses: number
  hitRate: number
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): CacheStats {
  const total = totalHits + totalMisses
  return {
    size: cache.size,
    maxEntries: config.maxEntries,
    maxBytes: config.maxBytes,
    currentBytes: totalBytes,
    ttlMs: config.ttlMs,
    enabled: config.enabled,
    totalHits,
    totalMisses,
    hitRate: total > 0 ? Math.round((totalHits / total) * 100) / 100 : 0,
  }
}

/**
 * Clear all cached entries.
 */
export function clearCache(): void {
  cache.clear()
  totalBytes = 0
}

/**
 * Reset cache and stats (for testing).
 */
export function resetCache(): void {
  cache.clear()
  totalHits = 0
  totalMisses = 0
  totalBytes = 0
  config = { ...DEFAULT_CONFIG }
}
