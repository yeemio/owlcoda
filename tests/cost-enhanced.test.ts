/**
 * Tests for enhanced cost estimation with real perf data.
 */

import { describe, it, expect } from 'vitest'
import {
  getCostProfileWithPerf,
  getSessionCostSummary,
} from '../src/cost-estimator.js'

describe('getCostProfileWithPerf', () => {
  it('uses real TPS when provided', () => {
    const profile = getCostProfileWithPerf('model-27B', 45.5)
    expect(profile.estimatedTps).toBe(45.5)
  })

  it('falls back to size-based TPS when no real data', () => {
    const profile = getCostProfileWithPerf('model-27B')
    expect(profile.estimatedTps).toBe(25) // medium default
  })

  it('ignores zero TPS', () => {
    const profile = getCostProfileWithPerf('model-27B', 0)
    expect(profile.estimatedTps).toBe(25) // medium default
  })

  it('preserves configured source', () => {
    const profile = getCostProfileWithPerf('custom', 50, {
      custom: { inputCostPer1M: 5, outputCostPer1M: 10 },
    })
    expect(profile.source).toBe('configured')
    expect(profile.estimatedTps).toBe(50)
  })

  it('preserves user profile costs', () => {
    const profile = getCostProfileWithPerf('custom', 30, {
      custom: { inputCostPer1M: 2.5, outputCostPer1M: 5.0, unit: '$' },
    })
    expect(profile.inputCostPer1M).toBe(2.5)
    expect(profile.unit).toBe('$')
    expect(profile.estimatedTps).toBe(30)
  })
})

describe('getSessionCostSummary', () => {
  it('computes per-model costs', () => {
    const summary = getSessionCostSummary([
      { modelId: 'model-7B', inputTokens: 1000, outputTokens: 500 },
      { modelId: 'model-70B', inputTokens: 2000, outputTokens: 1000 },
    ])

    expect(summary.perModel).toHaveLength(2)
    expect(summary.perModel[0]!.modelId).toBe('model-7B')
    expect(summary.perModel[1]!.modelId).toBe('model-70B')
    // 70B costs more than 7B
    expect(summary.perModel[1]!.cost.totalCost).toBeGreaterThan(summary.perModel[0]!.cost.totalCost)
  })

  it('computes total across models', () => {
    const summary = getSessionCostSummary([
      { modelId: 'model-27B', inputTokens: 1_000_000, outputTokens: 500_000 },
    ])

    const expected = summary.perModel[0]!.cost.totalCost
    expect(summary.totalCost).toBeCloseTo(expected)
  })

  it('uses real TPS when provided', () => {
    const withReal = getSessionCostSummary([
      { modelId: 'model-27B', inputTokens: 1000, outputTokens: 500, realTps: 45 },
    ])
    const withoutReal = getSessionCostSummary([
      { modelId: 'model-27B', inputTokens: 1000, outputTokens: 500 },
    ])

    // Costs should be the same (TPS doesn't affect cost, only time)
    expect(withReal.perModel[0]!.cost.totalCost).toBeCloseTo(withoutReal.perModel[0]!.cost.totalCost)
    // But estimated time differs
    expect(withReal.perModel[0]!.cost.estimatedSeconds).toBeLessThan(withoutReal.perModel[0]!.cost.estimatedSeconds)
  })

  it('handles empty usage', () => {
    const summary = getSessionCostSummary([])
    expect(summary.perModel).toHaveLength(0)
    expect(summary.totalCost).toBe(0)
  })

  it('returns correct unit', () => {
    const summary = getSessionCostSummary([
      { modelId: 'model-27B', inputTokens: 100, outputTokens: 50 },
    ])
    expect(summary.unit).toBe('¥')
  })

  it('handles mixed configured and estimated models', () => {
    const summary = getSessionCostSummary(
      [
        { modelId: 'custom', inputTokens: 1000, outputTokens: 500 },
        { modelId: 'model-70B', inputTokens: 1000, outputTokens: 500 },
      ],
      { custom: { inputCostPer1M: 10, outputCostPer1M: 20, unit: '$' } },
    )

    expect(summary.perModel[0]!.cost.source).toBe('configured')
    expect(summary.perModel[1]!.cost.source).toBe('estimated')
    expect(summary.totalCost).toBeGreaterThan(0)
  })
})
