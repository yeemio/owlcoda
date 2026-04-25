/**
 * Tests for per-model performance tracker.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordRequestMetrics,
  getModelMetrics,
  getAllModelMetrics,
  getModelPerfSummary,
  formatPerfSummary,
  formatAllPerfSummaries,
  resetModelMetrics,
} from '../src/perf-tracker.js'

beforeEach(() => {
  resetModelMetrics()
})

// ─── recordRequestMetrics ───

describe('recordRequestMetrics', () => {
  it('creates new entry on first record', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 500, success: true })
    const m = getModelMetrics('model-a')
    expect(m).toBeDefined()
    expect(m!.requestCount).toBe(1)
    expect(m!.totalInputTokens).toBe(100)
    expect(m!.totalOutputTokens).toBe(50)
    expect(m!.totalDurationMs).toBe(500)
    expect(m!.failureCount).toBe(0)
  })

  it('accumulates across multiple records', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 200, outputTokens: 100, durationMs: 300, success: true })
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 150, outputTokens: 75, durationMs: 700, success: false })

    const m = getModelMetrics('model-a')!
    expect(m.requestCount).toBe(3)
    expect(m.totalInputTokens).toBe(450)
    expect(m.totalOutputTokens).toBe(225)
    expect(m.totalDurationMs).toBe(1500)
    expect(m.minDurationMs).toBe(300)
    expect(m.maxDurationMs).toBe(700)
    expect(m.failureCount).toBe(1)
  })

  it('tracks per-model separately', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'b', inputTokens: 300, outputTokens: 150, durationMs: 600, success: true })

    expect(getModelMetrics('a')!.requestCount).toBe(1)
    expect(getModelMetrics('b')!.requestCount).toBe(1)
    expect(getAllModelMetrics()).toHaveLength(2)
  })

  it('tracks timestamps', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    const m = getModelMetrics('a')!
    expect(m.firstRequestAt).toBeTruthy()
    expect(m.lastRequestAt).toBeTruthy()
  })
})

// ─── getModelPerfSummary ───

describe('getModelPerfSummary', () => {
  it('returns null for unknown model', () => {
    expect(getModelPerfSummary('nonexistent')).toBeNull()
  })

  it('computes average duration', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 400, success: true })

    const s = getModelPerfSummary('a')!
    expect(s.avgDurationMs).toBe(300)
  })

  it('computes output TPS', () => {
    // 100 output tokens in 1000ms = 100 tok/s
    recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 100, durationMs: 1000, success: true })

    const s = getModelPerfSummary('a')!
    expect(s.avgOutputTps).toBe(100)
  })

  it('computes success rate', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 25, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 25, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 25, durationMs: 100, success: false })

    const s = getModelPerfSummary('a')!
    expect(s.successRate).toBeCloseTo(0.667, 2)
  })

  it('computes p50 from single record', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 25, durationMs: 350, success: true })

    const s = getModelPerfSummary('a')!
    expect(s.p50DurationMs).toBe(350)
  })

  it('computes p50 from multiple records', () => {
    for (const d of [100, 200, 300, 400, 500]) {
      recordRequestMetrics({ modelId: 'a', inputTokens: 50, outputTokens: 25, durationMs: d, success: true })
    }

    const s = getModelPerfSummary('a')!
    expect(s.p50DurationMs).toBe(300) // middle of [100, 200, 300, 400, 500]
  })
})

// ─── formatPerfSummary ───

describe('formatPerfSummary', () => {
  it('includes all fields', () => {
    recordRequestMetrics({ modelId: 'test-model', inputTokens: 5000, outputTokens: 2000, durationMs: 1500, success: true })
    const s = getModelPerfSummary('test-model')!
    const text = formatPerfSummary(s)

    expect(text).toContain('test-model')
    expect(text).toContain('Requests:')
    expect(text).toContain('Avg latency:')
    expect(text).toContain('Output TPS:')
    expect(text).toContain('Success:')
    expect(text).toContain('Tokens:')
  })

  it('formats large token counts with commas', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100_000, outputTokens: 50_000, durationMs: 5000, success: true })
    const s = getModelPerfSummary('a')!
    const text = formatPerfSummary(s)
    expect(text).toContain('100,000')
    expect(text).toContain('50,000')
  })
})

// ─── formatAllPerfSummaries ───

describe('formatAllPerfSummaries', () => {
  it('returns placeholder when empty', () => {
    expect(formatAllPerfSummaries()).toBe('No performance data recorded yet.')
  })

  it('formats multiple models', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'b', inputTokens: 200, outputTokens: 100, durationMs: 400, success: true })

    const text = formatAllPerfSummaries()
    expect(text).toContain('Model: a')
    expect(text).toContain('Model: b')
  })

  it('sorts by request count descending', () => {
    recordRequestMetrics({ modelId: 'less-used', inputTokens: 50, outputTokens: 25, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'more-used', inputTokens: 50, outputTokens: 25, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'more-used', inputTokens: 50, outputTokens: 25, durationMs: 100, success: true })

    const text = formatAllPerfSummaries()
    const aIdx = text.indexOf('more-used')
    const bIdx = text.indexOf('less-used')
    expect(aIdx).toBeLessThan(bIdx) // more-used first
  })
})

// ─── resetModelMetrics ───

describe('resetModelMetrics', () => {
  it('clears all data', () => {
    recordRequestMetrics({ modelId: 'a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    expect(getAllModelMetrics()).toHaveLength(1)
    resetModelMetrics()
    expect(getAllModelMetrics()).toHaveLength(0)
  })
})
