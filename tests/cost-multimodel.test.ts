/**
 * Tests for the enhanced /cost command with multi-model session cost.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionCostSummary } from '../src/cost-estimator.js'
import { recordRequestMetrics, resetModelMetrics, getAllModelMetrics, getModelPerfSummary } from '../src/perf-tracker.js'

beforeEach(() => resetModelMetrics())

describe('/cost multi-model session cost', () => {
  it('aggregates cost across multiple models', () => {
    recordRequestMetrics({ modelId: 'qwen2.5-7B', inputTokens: 5000, outputTokens: 2000, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'llama3.3-70B', inputTokens: 3000, outputTokens: 1500, durationMs: 1200, success: true })

    const allMetrics = getAllModelMetrics()
    expect(allMetrics.length).toBe(2)

    const modelUsage = allMetrics.map(m => {
      const perf = getModelPerfSummary(m.modelId)
      return {
        modelId: m.modelId,
        inputTokens: m.totalInputTokens,
        outputTokens: m.totalOutputTokens,
        realTps: perf?.avgOutputTps,
      }
    })
    const summary = getSessionCostSummary(modelUsage)

    expect(summary.perModel).toHaveLength(2)
    expect(summary.totalCost).toBeGreaterThan(0)
    expect(summary.unit).toBe('¥')
  })

  it('uses real TPS from perf tracker', () => {
    // 1000 output tokens in 2000ms = 500 tok/s
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 500, outputTokens: 1000, durationMs: 2000, success: true })

    const perf = getModelPerfSummary('model-7B')
    expect(perf).not.toBeNull()
    expect(perf!.avgOutputTps).toBe(500)

    const modelUsage = [{
      modelId: 'model-7B',
      inputTokens: 500,
      outputTokens: 1000,
      realTps: perf!.avgOutputTps,
    }]
    const summary = getSessionCostSummary(modelUsage)
    expect(summary.perModel[0]!.cost.estimatedSeconds).toBeGreaterThan(0)
  })

  it('handles single model correctly', () => {
    recordRequestMetrics({ modelId: 'qwen2.5-27B', inputTokens: 10000, outputTokens: 5000, durationMs: 800, success: true })

    const allMetrics = getAllModelMetrics()
    const modelUsage = allMetrics.map(m => ({
      modelId: m.modelId,
      inputTokens: m.totalInputTokens,
      outputTokens: m.totalOutputTokens,
    }))
    const summary = getSessionCostSummary(modelUsage)

    expect(summary.perModel).toHaveLength(1)
    expect(summary.perModel[0]!.modelId).toBe('qwen2.5-27B')
    expect(summary.totalCost).toBe(summary.perModel[0]!.cost.totalCost)
  })

  it('accumulates metrics across multiple requests per model', () => {
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 1000, outputTokens: 500, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 2000, outputTokens: 1000, durationMs: 400, success: true })
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 3000, outputTokens: 1500, durationMs: 600, success: true })

    const allMetrics = getAllModelMetrics()
    expect(allMetrics).toHaveLength(1)
    expect(allMetrics[0]!.totalInputTokens).toBe(6000)
    expect(allMetrics[0]!.totalOutputTokens).toBe(3000)
  })

  it('per-model cost includes source annotation', () => {
    recordRequestMetrics({ modelId: 'llama3.3-70B-instruct', inputTokens: 5000, outputTokens: 2500, durationMs: 1000, success: true })

    const allMetrics = getAllModelMetrics()
    const modelUsage = allMetrics.map(m => ({
      modelId: m.modelId,
      inputTokens: m.totalInputTokens,
      outputTokens: m.totalOutputTokens,
    }))
    const summary = getSessionCostSummary(modelUsage)
    expect(summary.perModel[0]!.cost.source).toBe('estimated')
  })
})
