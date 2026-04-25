/**
 * Tests for cost estimation module.
 */

import { describe, it, expect } from 'vitest'
import {
  extractParamCount,
  sizeCategory,
  getCostProfile,
  estimateCost,
  formatCostEstimate,
  formatCostBreakdown,
} from '../src/cost-estimator.js'

// ─── extractParamCount ───

describe('extractParamCount', () => {
  it('extracts integer param count', () => {
    expect(extractParamCount('llama3.3-70B-instruct')).toBe(70)
  })

  it('extracts decimal param count', () => {
    expect(extractParamCount('Qwen2.5-32.5B')).toBe(32.5)
  })

  it('handles lowercase b', () => {
    expect(extractParamCount('model-7b-q4')).toBe(7)
  })

  it('returns null for no match', () => {
    expect(extractParamCount('gpt-4')).toBeNull()
  })

  it('extracts from complex model IDs', () => {
    expect(extractParamCount('qwen2.5-coder:32b')).toBe(32)
  })

  it('returns null for version-number-style names', () => {
    expect(extractParamCount('llama3:latest')).toBeNull()
  })

  it('extracts 120B', () => {
    expect(extractParamCount('gpt-oss-120b-MXFP4-Q4')).toBe(120)
  })
})

// ─── sizeCategory ───

describe('sizeCategory', () => {
  it('small for <10B', () => {
    expect(sizeCategory(7)).toBe('small')
    expect(sizeCategory(3)).toBe('small')
  })

  it('medium for 10-40B', () => {
    expect(sizeCategory(27)).toBe('medium')
    expect(sizeCategory(32)).toBe('medium')
  })

  it('large for 40-80B', () => {
    expect(sizeCategory(70)).toBe('large')
    expect(sizeCategory(65)).toBe('large')
  })

  it('xlarge for 80B+', () => {
    expect(sizeCategory(120)).toBe('xlarge')
    expect(sizeCategory(405)).toBe('xlarge')
  })

  it('boundary: 10B is medium', () => {
    expect(sizeCategory(10)).toBe('medium')
  })

  it('boundary: 40B is large', () => {
    expect(sizeCategory(40)).toBe('large')
  })

  it('boundary: 80B is xlarge', () => {
    expect(sizeCategory(80)).toBe('xlarge')
  })
})

// ─── getCostProfile ───

describe('getCostProfile', () => {
  it('returns estimated profile for known size model', () => {
    const profile = getCostProfile('llama3-70B')
    expect(profile.source).toBe('estimated')
    expect(profile.inputCostPer1M).toBe(1.80) // large
    expect(profile.unit).toBe('¥')
  })

  it('returns default profile for unknown model', () => {
    const profile = getCostProfile('mysterious-model')
    expect(profile.source).toBe('default')
    expect(profile.inputCostPer1M).toBe(0.72) // medium default
  })

  it('uses user-configured profile', () => {
    const profile = getCostProfile('my-model', {
      'my-model': { inputCostPer1M: 5.0, outputCostPer1M: 10.0, unit: '$' },
    })
    expect(profile.source).toBe('configured')
    expect(profile.inputCostPer1M).toBe(5.0)
    expect(profile.outputCostPer1M).toBe(10.0)
    expect(profile.unit).toBe('$')
  })

  it('fills missing fields from size defaults', () => {
    const profile = getCostProfile('test-27B-model', {
      'test-27B-model': { unit: '$' },
    })
    expect(profile.source).toBe('configured')
    expect(profile.unit).toBe('$')
    expect(profile.inputCostPer1M).toBe(0.72) // medium defaults
  })

  it('returns small profile for 7B model', () => {
    const profile = getCostProfile('qwen2.5-7b')
    expect(profile.estimatedTps).toBe(60)
    expect(profile.inputCostPer1M).toBe(0.18)
  })

  it('returns xlarge profile for 120B model', () => {
    const profile = getCostProfile('gpt-oss-120b-MXFP4')
    expect(profile.estimatedTps).toBe(6)
    expect(profile.inputCostPer1M).toBe(3.00)
  })
})

// ─── estimateCost ───

describe('estimateCost', () => {
  it('calculates cost for typical usage', () => {
    const est = estimateCost(1000, 500, 'model-27B')
    expect(est.inputCost).toBeCloseTo(0.72 * 1000 / 1_000_000)
    expect(est.outputCost).toBeCloseTo(1.44 * 500 / 1_000_000)
    expect(est.totalCost).toBeCloseTo(est.inputCost + est.outputCost)
  })

  it('returns zero for zero tokens', () => {
    const est = estimateCost(0, 0, 'any-model')
    expect(est.totalCost).toBe(0)
    expect(est.estimatedSeconds).toBe(0)
  })

  it('estimates time based on TPS', () => {
    const est = estimateCost(600, 600, 'model-7b') // small: 60 tps
    expect(est.estimatedSeconds).toBeCloseTo(1200 / 60)
  })

  it('uses user profiles when provided', () => {
    const est = estimateCost(1_000_000, 0, 'custom', {
      custom: { inputCostPer1M: 10, outputCostPer1M: 20, unit: '$' },
    })
    expect(est.inputCost).toBeCloseTo(10)
    expect(est.unit).toBe('$')
  })

  it('handles large token counts', () => {
    const est = estimateCost(10_000_000, 5_000_000, 'model-70B')
    expect(est.totalCost).toBeGreaterThan(0)
    expect(est.estimatedSeconds).toBeGreaterThan(0)
  })
})

// ─── formatCostEstimate ───

describe('formatCostEstimate', () => {
  it('formats small cost as <¥0.01', () => {
    const est = estimateCost(100, 50, 'model-7b')
    const formatted = formatCostEstimate(est)
    expect(formatted).toContain('<¥0.01')
  })

  it('formats larger cost with 4 decimals', () => {
    const est = estimateCost(1_000_000, 500_000, 'model-70B')
    const formatted = formatCostEstimate(est)
    expect(formatted).toMatch(/¥\d+\.\d{4}/)
  })

  it('includes source annotation for estimated', () => {
    const est = estimateCost(1000, 500, 'model-27B')
    const formatted = formatCostEstimate(est)
    expect(formatted).toContain('estimated from model size')
  })

  it('includes source annotation for default', () => {
    const est = estimateCost(1000, 500, 'unknown-model')
    const formatted = formatCostEstimate(est)
    expect(formatted).toContain('default estimate')
  })

  it('no annotation for configured profiles', () => {
    const est = estimateCost(1_000_000, 500_000, 'custom', {
      custom: { inputCostPer1M: 10, outputCostPer1M: 20 },
    })
    const formatted = formatCostEstimate(est)
    expect(formatted).not.toContain('estimated')
    expect(formatted).not.toContain('default')
  })
})

// ─── formatCostBreakdown ───

describe('formatCostBreakdown', () => {
  it('includes input, output, total lines', () => {
    const est = estimateCost(5000, 2000, 'model-27B')
    const breakdown = formatCostBreakdown(5000, 2000, est)
    expect(breakdown).toContain('Input:')
    expect(breakdown).toContain('Output:')
    expect(breakdown).toContain('Total:')
  })

  it('includes estimated time', () => {
    const est = estimateCost(1000, 1000, 'model-7b')
    const breakdown = formatCostBreakdown(1000, 1000, est)
    expect(breakdown).toContain('Est. time:')
  })

  it('formats time in minutes for long estimates', () => {
    const est = estimateCost(100_000, 100_000, 'model-120B') // ~33000s at 6 tps
    const breakdown = formatCostBreakdown(100_000, 100_000, est)
    expect(breakdown).toMatch(/\d+m/)
  })

  it('includes source in total line', () => {
    const est = estimateCost(1000, 500, 'model-27B')
    const breakdown = formatCostBreakdown(1000, 500, est)
    expect(breakdown).toContain('(estimated)')
  })
})
