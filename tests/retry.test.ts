import { describe, it, expect } from 'vitest'
import { withRetry } from '../src/middleware/retry.js'

function mockResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response
}

describe('retry middleware', () => {
  it('returns immediately on success', async () => {
    let calls = 0
    const result = await withRetry(() => {
      calls++
      return Promise.resolve(mockResponse(200))
    })
    expect(calls).toBe(1)
    expect(result.status).toBe(200)
  })

  it('returns immediately on 4xx without retry', async () => {
    let calls = 0
    const result = await withRetry(() => {
      calls++
      return Promise.resolve(mockResponse(400))
    })
    expect(calls).toBe(1)
    expect(result.status).toBe(400)
  })

  it('retries on 500 up to maxRetries', async () => {
    let calls = 0
    await withRetry(() => {
      calls++
      return Promise.resolve(mockResponse(500))
    }, { maxRetries: 2, baseDelayMs: 1 }).catch(() => {})
    expect(calls).toBe(3) // initial + 2 retries
  })

  it('retries on 502 then succeeds', async () => {
    let calls = 0
    const result = await withRetry(() => {
      calls++
      if (calls < 3) return Promise.resolve(mockResponse(502))
      return Promise.resolve(mockResponse(200))
    }, { maxRetries: 3, baseDelayMs: 1 })
    expect(calls).toBe(3)
    expect(result.status).toBe(200)
  })

  it('retries on connection errors', async () => {
    let calls = 0
    const result = await withRetry(() => {
      calls++
      if (calls < 2) throw new Error('fetch failed')
      return Promise.resolve(mockResponse(200))
    }, { maxRetries: 3, baseDelayMs: 1 })
    expect(calls).toBe(2)
    expect(result.status).toBe(200)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await expect(withRetry(() => {
      calls++
      throw new Error('invalid JSON in request body')
    }, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('invalid JSON')
    expect(calls).toBe(1)
  })

  it('times out slow requests', async () => {
    await expect(withRetry(async (signal) => {
      await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('too slow')), 10000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
      return mockResponse(200)
    }, { maxRetries: 0, timeoutMs: 50 })).rejects.toThrow('timed out')
  })

  it('exports RETRY_DEFAULTS', async () => {
    const { RETRY_DEFAULTS } = await import('../src/middleware/retry.js')
    expect(RETRY_DEFAULTS.maxRetries).toBe(3)
    expect(RETRY_DEFAULTS.timeoutMs).toBe(60000)
    expect(RETRY_DEFAULTS.retryableStatuses).toContain(502)
  })
})
