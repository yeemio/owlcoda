/**
 * Middleware integration tests — rate limit, circuit breaker, fallback, and validation interactions.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { buildFallbackChain, withFallback } from '../src/middleware/fallback.js'
import { checkRateLimit } from '../src/middleware/rate-limit.js'
import { configureCircuitBreaker, recordFailure, recordSuccess, isCircuitOpen, resetCircuitBreaker } from '../src/middleware/circuit-breaker.js'
import { validateMessagesBody } from '../src/middleware/validate.js'
import { withRetry } from '../src/middleware/retry.js'
import type { OwlCodaConfig } from '../src/config.js'

beforeEach(() => {
  resetCircuitBreaker()
})

function makeConfig(models: Array<{ id: string; tier?: string }>): OwlCodaConfig {
  return {
    models: models.map(m => ({
      id: m.id,
      label: m.id,
      backendModel: m.id,
      aliases: [],
      tier: m.tier ?? 'general',
      contextWindow: 32768,
    })),
    routerUrl: 'http://localhost:11435/v1',
  } as unknown as OwlCodaConfig
}

describe('fallback chain building', () => {
  it('puts requested model first, others sorted by tier', () => {
    const config = makeConfig([
      { id: 'heavy', tier: 'heavy' },
      { id: 'fast', tier: 'fast' },
      { id: 'balanced', tier: 'balanced' },
    ])
    const chain = buildFallbackChain(config, 'heavy')
    expect(chain[0]).toBe('heavy')
    expect(chain.indexOf('balanced')).toBeLessThan(chain.indexOf('fast'))
  })

  it('excludes embedding models from fallback', () => {
    const config = makeConfig([
      { id: 'main', tier: 'general' },
      { id: 'embedder', tier: 'embedding' },
    ])
    const chain = buildFallbackChain(config, 'main')
    expect(chain).not.toContain('embedder')
  })
})

describe('fallback execution', () => {
  it('returns first successful response', async () => {
    const result = await withFallback(
      ['model-a', 'model-b'],
      async (id) => new Response('ok', { status: 200 }),
    )
    expect(result.servedBy).toBe('model-a')
    expect(result.fallbackUsed).toBe(false)
  })

  it('falls back on 5xx error', async () => {
    let callCount = 0
    const result = await withFallback(
      ['model-a', 'model-b'],
      async (id) => {
        callCount++
        if (id === 'model-a') return new Response('error', { status: 500 })
        return new Response('ok', { status: 200 })
      },
    )
    expect(result.servedBy).toBe('model-b')
    expect(result.fallbackUsed).toBe(true)
    expect(callCount).toBe(2)
  })

  it('does NOT fall back on 4xx error', async () => {
    const result = await withFallback(
      ['model-a', 'model-b'],
      async (id) => {
        if (id === 'model-a') return new Response('bad request', { status: 400 })
        return new Response('ok', { status: 200 })
      },
    )
    expect(result.servedBy).toBe('model-a')
    expect(result.fallbackUsed).toBe(false)
  })

  it('returns the last failing response when all models exhausted', async () => {
    // Post-kimi provider-error: withFallback preserves the final upstream
    // response so callers can map it into a structured diagnostic.
    const result = await withFallback(
      ['a', 'b'],
      async () => new Response('error', { status: 500 }),
    )
    expect(result.response.ok).toBe(false)
    expect(result.response.status).toBe(500)
    expect(result.attemptedModels).toEqual(['a', 'b'])
    expect(result.fallbackUsed).toBe(true)
  })

  it('skips unhealthy models via health filter', async () => {
    const attempted: string[] = []
    await withFallback(
      ['a', 'b', 'c'],
      async (id) => { attempted.push(id); return new Response('ok', { status: 200 }) },
      (id) => id !== 'b',
    )
    // 'a' is always tried (primary), 'b' skipped, 'c' not needed since 'a' succeeded
    expect(attempted).toEqual(['a'])
  })
})

describe('circuit breaker + fallback interaction', () => {
  it('circuit breaker opens independently of fallback', () => {
    configureCircuitBreaker({ threshold: 2 })
    recordFailure('model-a')
    recordFailure('model-a')
    expect(isCircuitOpen('model-a')).toBe(true)
    // model-b unaffected
    expect(isCircuitOpen('model-b')).toBe(false)
  })

  it('success after fallback closes breaker for successful model', () => {
    configureCircuitBreaker({ threshold: 2 })
    recordFailure('model-b')
    recordFailure('model-b')
    expect(isCircuitOpen('model-b')).toBe(true)
    recordSuccess('model-b')
    expect(isCircuitOpen('model-b')).toBe(false)
  })
})

describe('validation before middleware', () => {
  it('invalid request rejected before any middleware', () => {
    const result = validateMessagesBody({ messages: [] })
    expect(result.valid).toBe(false)
    // No rate limit or circuit breaker should be consumed
  })

  it('valid request passes validation', () => {
    const result = validateMessagesBody({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    })
    expect(result.valid).toBe(true)
  })
})

describe('retry middleware', () => {
  it('retries on retryable error and succeeds', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 3) throw new Error('fetch failed: ECONNRESET')
        return new Response('ok', { status: 200 })
      },
      { maxRetries: 3, baseDelayMs: 1 },
    )
    expect(result.status).toBe(200)
    expect(attempts).toBe(3)
  })

  it('retries on retryable HTTP status and succeeds', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 2) return new Response('error', { status: 503 })
        return new Response('ok', { status: 200 })
      },
      { maxRetries: 3, baseDelayMs: 1 },
    )
    expect(result.status).toBe(200)
    expect(attempts).toBe(2)
  })

  it('gives up after max retries on retryable error', async () => {
    await expect(
      withRetry(
        async () => { throw new Error('fetch failed: timeout') },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('fetch failed: timeout')
  })

  it('does NOT retry non-retryable errors', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => { attempts++; throw new Error('ENOMEM out of memory') },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('ENOMEM')
    expect(attempts).toBe(1)
  })

  it('does NOT retry 4xx responses', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => { attempts++; return new Response('bad', { status: 400 }) },
      { maxRetries: 3, baseDelayMs: 1 },
    )
    expect(result.status).toBe(400)
    expect(attempts).toBe(1)
  })
})
