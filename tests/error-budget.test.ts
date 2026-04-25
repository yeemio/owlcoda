import { describe, it, expect, beforeEach } from 'vitest'
import { recordOutcome, getErrorBudget, getAllBudgets, resetBudgets, setSloTarget, getSloTarget } from '../src/error-budget.js'

describe('error budget tracking', () => {
  beforeEach(() => {
    resetBudgets()
    setSloTarget(0.95) // reset to default
  })

  it('records successful outcome', () => {
    recordOutcome('model-a', true)
    const budget = getErrorBudget('model-a')
    expect(budget.total).toBe(1)
    expect(budget.successes).toBe(1)
    expect(budget.failures).toBe(0)
    expect(budget.successRate).toBe(1)
  })

  it('records failed outcome', () => {
    recordOutcome('model-a', false)
    const budget = getErrorBudget('model-a')
    expect(budget.total).toBe(1)
    expect(budget.successes).toBe(0)
    expect(budget.failures).toBe(1)
    expect(budget.successRate).toBe(0)
  })

  it('calculates rolling success rate', () => {
    for (let i = 0; i < 8; i++) recordOutcome('model-a', true)
    for (let i = 0; i < 2; i++) recordOutcome('model-a', false)
    const budget = getErrorBudget('model-a')
    expect(budget.total).toBe(10)
    expect(budget.successRate).toBe(0.8)
  })

  it('calculates SLO budget remaining', () => {
    // 80% success with 95% SLO = -15% budget
    for (let i = 0; i < 8; i++) recordOutcome('model-a', true)
    for (let i = 0; i < 2; i++) recordOutcome('model-a', false)
    const budget = getErrorBudget('model-a')
    expect(budget.budgetRemaining).toBeCloseTo(-0.15, 5)
  })

  it('respects rolling window of 100', () => {
    // Fill 100 failures then 10 successes (should drop oldest 10)
    for (let i = 0; i < 100; i++) recordOutcome('model-a', false)
    for (let i = 0; i < 10; i++) recordOutcome('model-a', true)
    const budget = getErrorBudget('model-a')
    // Window has 90 failures + 10 successes = 100 total
    expect(budget.total).toBe(100)
    expect(budget.successes).toBe(10)
    expect(budget.successRate).toBeCloseTo(0.1, 5)
  })

  it('returns default for unknown model', () => {
    const budget = getErrorBudget('nonexistent')
    expect(budget.total).toBe(0)
    expect(budget.successRate).toBe(1)
    expect(budget.budgetRemaining).toBeCloseTo(0.05, 5) // 100% - 95% SLO
  })

  it('resets all budgets', () => {
    recordOutcome('a', true)
    recordOutcome('b', false)
    resetBudgets()
    expect(getAllBudgets().size).toBe(0)
  })

  it('getAllBudgets returns all tracked models', () => {
    recordOutcome('a', true)
    recordOutcome('b', false)
    recordOutcome('c', true)
    const all = getAllBudgets()
    expect(all.size).toBe(3)
    expect(all.has('a')).toBe(true)
    expect(all.has('b')).toBe(true)
    expect(all.has('c')).toBe(true)
  })

  it('setSloTarget changes SLO', () => {
    setSloTarget(0.99)
    expect(getSloTarget()).toBe(0.99)
    for (let i = 0; i < 10; i++) recordOutcome('model-a', true)
    const budget = getErrorBudget('model-a')
    expect(budget.budgetRemaining).toBeCloseTo(0.01, 5) // 100% - 99%
  })

  it('isolates models from each other', () => {
    recordOutcome('a', true)
    recordOutcome('b', false)
    expect(getErrorBudget('a').successRate).toBe(1)
    expect(getErrorBudget('b').successRate).toBe(0)
  })
})
