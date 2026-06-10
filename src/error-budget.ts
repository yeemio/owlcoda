/**
 * Error budget tracking — per-model rolling-window success rate.
 * Advisory only: logs warnings when SLO violated but never blocks requests.
 */

import { logWarn } from './logger.js'

export interface ErrorBudget {
  total: number
  successes: number
  failures: number
  successRate: number
  budgetRemaining: number  // successRate - sloTarget (negative = SLO violated)
}

const WINDOW_SIZE = 100
let sloTarget = 0.95

// Per-model circular buffer of outcomes (true = success)
const windows = new Map<string, boolean[]>()

export function recordOutcome(model: string, success: boolean): void {
  let window = windows.get(model)
  if (!window) {
    window = []
    windows.set(model, window)
  }
  window.push(success)
  if (window.length > WINDOW_SIZE) {
    window.shift()
  }

  // Advisory warning when SLO violated
  if (window.length >= 10) {
    const rate = window.filter(Boolean).length / window.length
    if (rate < sloTarget) {
      logWarn('error-budget', `${model} below SLO`, { successRate: (rate * 100).toFixed(1), sloTarget: (sloTarget * 100).toFixed(0) })
    }
  }
}

export function getErrorBudget(model: string): ErrorBudget {
  const window = windows.get(model)
  if (!window || window.length === 0) {
    return { total: 0, successes: 0, failures: 0, successRate: 1, budgetRemaining: 1 - sloTarget }
  }

  const successes = window.filter(Boolean).length
  const failures = window.length - successes
  const successRate = successes / window.length
  return {
    total: window.length,
    successes,
    failures,
    successRate,
    budgetRemaining: successRate - sloTarget,
  }
}

export function getAllBudgets(): Map<string, ErrorBudget> {
  const result = new Map<string, ErrorBudget>()
  for (const model of windows.keys()) {
    result.set(model, getErrorBudget(model))
  }
  return result
}

export function setSloTarget(target: number): void {
  sloTarget = Math.max(0, Math.min(1, target))
}

export function getSloTarget(): number {
  return sloTarget
}

export function resetBudgets(): void {
  windows.clear()
}
