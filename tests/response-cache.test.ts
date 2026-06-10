import { describe, it, expect, beforeEach } from 'vitest'
import { cacheKey, getCached, putCache, getCacheStats, resetCache, configureCache, clearCache } from '../src/response-cache.js'

describe('response-cache', () => {
  beforeEach(() => {
    resetCache()
  })

  it('cacheKey produces consistent hashes', () => {
    const k1 = cacheKey('model', [{ role: 'user', content: 'hi' }])
    const k2 = cacheKey('model', [{ role: 'user', content: 'hi' }])
    expect(k1).toBe(k2)
    expect(k1.length).toBe(16)
  })

  it('cacheKey varies with different input', () => {
    const k1 = cacheKey('model', [{ role: 'user', content: 'hello' }])
    const k2 = cacheKey('model', [{ role: 'user', content: 'world' }])
    expect(k1).not.toBe(k2)
  })

  it('getCached returns null for missing key', () => {
    expect(getCached('nonexistent')).toBeNull()
  })

  it('put + get round-trip', () => {
    putCache('k1', '{"ok":true}', 200)
    const entry = getCached('k1')
    expect(entry).not.toBeNull()
    expect(entry!.body).toBe('{"ok":true}')
    expect(entry!.statusCode).toBe(200)
  })

  it('respects TTL', async () => {
    configureCache({ ttlMs: 50 })
    putCache('k2', 'data', 200)
    expect(getCached('k2')).not.toBeNull()
    await new Promise(r => setTimeout(r, 60))
    expect(getCached('k2')).toBeNull()
  })

  it('evicts oldest when at capacity', () => {
    configureCache({ maxEntries: 3 })
    putCache('a', '1', 200)
    putCache('b', '2', 200)
    putCache('c', '3', 200)
    putCache('d', '4', 200) // should evict 'a'
    expect(getCached('a')).toBeNull()
    expect(getCached('d')).not.toBeNull()
  })

  it('tracks hit/miss stats', () => {
    putCache('x', 'data', 200)
    getCached('x') // hit
    getCached('y') // miss
    const stats = getCacheStats()
    expect(stats.totalHits).toBe(1)
    expect(stats.totalMisses).toBe(1)
    expect(stats.hitRate).toBe(0.5)
  })

  it('clearCache removes all entries', () => {
    putCache('a', '1', 200)
    putCache('b', '2', 200)
    clearCache()
    expect(getCacheStats().size).toBe(0)
  })

  it('disabled cache returns null', () => {
    configureCache({ enabled: false })
    putCache('k', 'data', 200)
    expect(getCached('k')).toBeNull()
  })

  it('increments hit count on repeated access', () => {
    putCache('k', 'data', 200)
    getCached('k')
    getCached('k')
    const entry = getCached('k')
    expect(entry!.hits).toBe(3)
  })

  it('evicts when byte limit exceeded', () => {
    // Set a small byte limit: 100 bytes. Each char ≈ 2 bytes in the estimator.
    configureCache({ maxEntries: 100, maxBytes: 100 })
    // 30 chars × 2 = 60 bytes — fits
    putCache('a', 'x'.repeat(30), 200)
    expect(getCached('a')).not.toBeNull()
    // Another 30 chars × 2 = 60 bytes — total would be 120, over 100 → evict 'a'
    putCache('b', 'y'.repeat(30), 200)
    expect(getCached('a')).toBeNull()
    expect(getCached('b')).not.toBeNull()
  })

  it('reports currentBytes and maxBytes in stats', () => {
    configureCache({ maxBytes: 5000 })
    putCache('a', 'hello', 200) // 5 × 2 = 10 bytes
    const stats = getCacheStats()
    expect(stats.maxBytes).toBe(5000)
    expect(stats.currentBytes).toBe(10)
  })
})
