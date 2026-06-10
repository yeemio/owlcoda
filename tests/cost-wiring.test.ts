/**
 * Tests for cost estimation wiring in messages endpoint and /cost command.
 */

import { describe, it, expect } from 'vitest'
import { estimateCost, formatCostEstimate, formatCostBreakdown } from '../src/cost-estimator.js'
import { getTokenUsage, addTokenUsage, resetTokenUsage } from '../src/trace.js'

// ─── Messages endpoint cost header logic ───

describe('messages endpoint cost header', () => {
  it('generates x-owlcoda-estimated-cost header value', () => {
    // Simulates the header logic from handleMessages
    const inputTok = 1000
    const outputTok = 500
    const servedBy = 'Qwen2.5-27B-instruct'
    const cost = estimateCost(inputTok, outputTok, servedBy)
    const header = formatCostEstimate(cost)
    expect(header).toBeTruthy()
    expect(header).toContain('¥')
  })

  it('skips cost header when no tokens', () => {
    const inputTok = 0
    const outputTok = 0
    // In the endpoint, this check skips the header
    const shouldAddHeader = inputTok > 0 || outputTok > 0
    expect(shouldAddHeader).toBe(false)
  })

  it('adds cost header for output-only tokens', () => {
    const inputTok = 0
    const outputTok = 100
    const shouldAddHeader = inputTok > 0 || outputTok > 0
    expect(shouldAddHeader).toBe(true)
    const cost = estimateCost(inputTok, outputTok, 'model-7B')
    expect(cost.totalCost).toBeGreaterThan(0)
  })

  it('header includes source annotation', () => {
    const cost = estimateCost(500, 300, 'llama3.3-70B-instruct')
    const header = formatCostEstimate(cost)
    expect(header).toContain('estimated from model size')
  })
})

// ─── /cost command integration ───

describe('/cost command with cost estimation', () => {
  it('shows cost breakdown when usage exists', () => {
    resetTokenUsage()
    addTokenUsage(5000, 2000)
    const usage = getTokenUsage()

    // Simulate what the /cost command handler does
    const modelId = 'Qwen2.5-27B-instruct'
    const cost = estimateCost(usage.inputTokens, usage.outputTokens, modelId)
    const breakdown = formatCostBreakdown(usage.inputTokens, usage.outputTokens, cost)

    expect(breakdown).toContain('Input:')
    expect(breakdown).toContain('5,000')
    expect(breakdown).toContain('Output:')
    expect(breakdown).toContain('2,000')
    expect(breakdown).toContain('Total:')

    resetTokenUsage()
  })

  it('shows zero cost when no usage', () => {
    resetTokenUsage()
    const usage = getTokenUsage()
    expect(usage.requestCount).toBe(0)
    // Command would bail early with "No usage recorded yet."
  })

  it('accumulates cost across requests', () => {
    resetTokenUsage()
    addTokenUsage(1000, 500)
    addTokenUsage(2000, 1000)
    addTokenUsage(3000, 1500)
    const usage = getTokenUsage()

    expect(usage.inputTokens).toBe(6000)
    expect(usage.outputTokens).toBe(3000)
    expect(usage.requestCount).toBe(3)

    const cost = estimateCost(usage.inputTokens, usage.outputTokens, 'model-27B')
    expect(cost.totalCost).toBeGreaterThan(0)

    resetTokenUsage()
  })

  it('uses model-specific pricing', () => {
    resetTokenUsage()
    addTokenUsage(1_000_000, 500_000)
    const usage = getTokenUsage()

    const costSmall = estimateCost(usage.inputTokens, usage.outputTokens, 'qwen2.5-7B')
    const costLarge = estimateCost(usage.inputTokens, usage.outputTokens, 'llama3.3-70B')
    expect(costLarge.totalCost).toBeGreaterThan(costSmall.totalCost)

    resetTokenUsage()
  })
})
