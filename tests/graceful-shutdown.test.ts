/**
 * Tests for graceful shutdown signal.
 */

import { describe, it, expect } from 'vitest'

describe('graceful shutdown signal', () => {
  it('AbortSignal.any combines timeout and abort', () => {
    const controller = new AbortController()
    const combined = AbortSignal.any([
      AbortSignal.timeout(60_000), // Long timeout
      controller.signal,
    ])

    expect(combined.aborted).toBe(false)

    controller.abort()
    expect(combined.aborted).toBe(true)
  })

  it('AbortSignal.any works with only timeout when no shutdown signal', () => {
    const signals = [AbortSignal.timeout(60_000)]
    const combined = AbortSignal.any(signals)
    expect(combined.aborted).toBe(false)
  })

  it('abort reason is propagated', () => {
    const controller = new AbortController()
    const combined = AbortSignal.any([
      AbortSignal.timeout(60_000),
      controller.signal,
    ])

    controller.abort('server shutdown')
    expect(combined.reason).toBe('server shutdown')
  })

  it('already-aborted signal works with AbortSignal.any', () => {
    const controller = new AbortController()
    controller.abort()

    const combined = AbortSignal.any([
      AbortSignal.timeout(60_000),
      controller.signal,
    ])

    expect(combined.aborted).toBe(true)
  })
})
