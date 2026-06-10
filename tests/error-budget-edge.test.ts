/**
 * Edge case tests for error budget — exhaustion, recovery, concurrent models.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { recordOutcome, getErrorBudget, getAllBudgets, setSloTarget, getSloTarget, resetBudgets } from '../src/error-budget.js'

beforeEach(() => {
  resetBudgets()
  setSloTarget(0.95)
})

describe('error budget edge cases', () => {
  it('empty model budget has 100% success rate', () => {
    const b = getErrorBudget('nonexistent')
    expect(b.total).toBe(0)
    expect(b.successRate).toBe(1)
    expect(b.budgetRemaining).toBeCloseTo(0.05)
  })

  it('budget exhaustion: all failures', () => {
    for (let i = 0; i < 20; i++) recordOutcome('fail-model', false)
    const b = getErrorBudget('fail-model')
    expect(b.failures).toBe(20)
    expect(b.successRate).toBe(0)
    expect(b.budgetRemaining).toBeLessThan(0) // SLO violated
  })

  it('budget recovery after reset', () => {
    for (let i = 0; i < 10; i++) recordOutcome('recover', false)
    expect(getErrorBudget('recover').budgetRemaining).toBeLessThan(0)
    resetBudgets()
    expect(getErrorBudget('recover').total).toBe(0)
    expect(getErrorBudget('recover').successRate).toBe(1)
  })

  it('concurrent model budgets are independent', () => {
    for (let i = 0; i < 10; i++) recordOutcome('model-a', true)
    for (let i = 0; i < 10; i++) recordOutcome('model-b', false)
    expect(getErrorBudget('model-a').successRate).toBe(1)
    expect(getErrorBudget('model-b').successRate).toBe(0)
  })

  it('rolling window caps at 100', () => {
    for (let i = 0; i < 150; i++) recordOutcome('window', true)
    const b = getErrorBudget('window')
    expect(b.total).toBe(100) // WINDOW_SIZE
  })

  it('getAllBudgets returns all tracked models', () => {
    recordOutcome('x', true)
    recordOutcome('y', false)
    const all = getAllBudgets()
    expect(all.size).toBe(2)
    expect(all.has('x')).toBe(true)
    expect(all.has('y')).toBe(true)
  })

  it('setSloTarget clamps to [0, 1]', () => {
    setSloTarget(2.0)
    expect(getSloTarget()).toBe(1)
    setSloTarget(-1.0)
    expect(getSloTarget()).toBe(0)
    setSloTarget(0.99)
    expect(getSloTarget()).toBe(0.99)
  })

  it('mixed success/failure rate is correct', () => {
    for (let i = 0; i < 8; i++) recordOutcome('mixed', true)
    for (let i = 0; i < 2; i++) recordOutcome('mixed', false)
    const b = getErrorBudget('mixed')
    expect(b.successRate).toBeCloseTo(0.8)
    expect(b.budgetRemaining).toBeCloseTo(-0.15) // 0.8 - 0.95
  })
})
