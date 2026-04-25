import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordExchange,
  getCaptures,
  clearCaptures,
  getCaptureStats,
  formatCaptures,
  type CapturedExchange,
} from '../src/capture.js'

function makeExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2025-01-01T12:00:00.000Z',
    model: 'qwen2.5-32b',
    durationMs: 1200,
    request: {
      messageCount: 3,
      systemPromptLength: 500,
      toolCount: 2,
      streaming: true,
    },
    response: {
      statusCode: 200,
      stopReason: 'end_turn',
      textLength: 150,
      toolCallCount: 0,
      inputTokens: 400,
      outputTokens: 80,
    },
    ...overrides,
  }
}

describe('capture', () => {
  beforeEach(() => {
    clearCaptures()
  })

  it('records and retrieves exchanges', () => {
    recordExchange(makeExchange({ model: 'model-a' }))
    recordExchange(makeExchange({ model: 'model-b' }))

    const captures = getCaptures()
    expect(captures).toHaveLength(2)
    expect(captures[0].model).toBe('model-a')
    expect(captures[1].model).toBe('model-b')
  })

  it('limits to MAX_CAPTURES', () => {
    for (let i = 0; i < 60; i++) {
      recordExchange(makeExchange({ id: `req-${i}` }))
    }
    const captures = getCaptures(100)
    expect(captures.length).toBeLessThanOrEqual(50)
  })

  it('getCaptures respects limit', () => {
    for (let i = 0; i < 10; i++) {
      recordExchange(makeExchange({ id: `req-${i}` }))
    }
    expect(getCaptures(3)).toHaveLength(3)
    expect(getCaptures()).toHaveLength(10)
  })

  it('computes stats correctly', () => {
    recordExchange(makeExchange({ model: 'a', durationMs: 100, response: { statusCode: 200, stopReason: 'end_turn', textLength: 10, toolCallCount: 0 } }))
    recordExchange(makeExchange({ model: 'a', durationMs: 200, response: { statusCode: 200, stopReason: 'end_turn', textLength: 10, toolCallCount: 0 } }))
    recordExchange(makeExchange({ model: 'b', durationMs: 300, response: { statusCode: 500, stopReason: null, textLength: 0, toolCallCount: 0 }, error: 'timeout' }))

    const stats = getCaptureStats()
    expect(stats.totalExchanges).toBe(3)
    expect(stats.avgDurationMs).toBe(200)
    expect(stats.errorRate).toBeCloseTo(0.33, 1)
    expect(stats.modelBreakdown).toEqual({ a: 2, b: 1 })
  })

  it('returns empty stats when no captures', () => {
    const stats = getCaptureStats()
    expect(stats.totalExchanges).toBe(0)
    expect(stats.avgDurationMs).toBe(0)
    expect(stats.errorRate).toBe(0)
  })

  it('formats captures as text', () => {
    recordExchange(makeExchange({ model: 'qwen2.5-32b' }))
    recordExchange(makeExchange({ model: 'bad-model', response: { statusCode: 500, stopReason: null, textLength: 0, toolCallCount: 0 }, error: 'timeout' }))

    const out = formatCaptures(getCaptures())
    expect(out).toContain('Recent Exchanges')
    expect(out).toContain('qwen2.5-32b')
    expect(out).toContain('✅')
    expect(out).toContain('❌')
    expect(out).toContain('timeout')
  })

  it('handles empty captures', () => {
    const out = formatCaptures([])
    expect(out).toContain('No captured exchanges')
  })

  it('clearCaptures resets', () => {
    recordExchange(makeExchange())
    expect(getCaptures()).toHaveLength(1)
    clearCaptures()
    expect(getCaptures()).toHaveLength(0)
  })
})
