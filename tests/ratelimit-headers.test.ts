import { describe, it, expect } from 'vitest'
import { setRateLimitHeaders } from '../src/utils/ratelimit.js'

describe('rate-limit headers', () => {
  it('setRateLimitHeaders sets all required headers', () => {
    const headers: Record<string, string> = {}
    const fakeRes = {
      setHeader(key: string, value: string) {
        headers[key] = value
      },
    }

    setRateLimitHeaders(fakeRes as any)

    expect(headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0')
    expect(headers['anthropic-ratelimit-unified-7d-utilization']).toBe('0')
    expect(headers['anthropic-ratelimit-unified-status']).toBe('allowed')

    const now = Math.floor(Date.now() / 1000)
    const reset5h = parseInt(headers['anthropic-ratelimit-unified-5h-reset']!)
    const reset7d = parseInt(headers['anthropic-ratelimit-unified-7d-reset']!)
    expect(reset5h).toBeGreaterThan(now)
    expect(reset7d).toBeGreaterThan(now)
    expect(reset7d).toBeGreaterThan(reset5h)
  })
})
