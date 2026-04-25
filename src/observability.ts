/**
 * Observability metrics for OwlCoda proxy.
 * Tracks request counts, errors, model usage, and active connections.
 */

import { VERSION } from './version.js'
import { getTokenUsage } from './trace.js'
import { getRateLimitStats } from './middleware/rate-limit.js'
import { getRecentErrors, getUptime } from './diagnostics.js'

// ─── Counters ───

let totalRequests = 0
let activeRequests = 0
const requestsByModel = new Map<string, number>()
const requestsByStatus = new Map<number, number>()
const durationSum = new Map<string, number>()

// ─── Recording ───

export function recordRequestStart(): void {
  activeRequests++
}

export function recordRequestEnd(model: string, statusCode: number, durationMs: number): void {
  activeRequests = Math.max(0, activeRequests - 1)
  totalRequests++
  requestsByModel.set(model, (requestsByModel.get(model) ?? 0) + 1)
  requestsByStatus.set(statusCode, (requestsByStatus.get(statusCode) ?? 0) + 1)
  durationSum.set(model, (durationSum.get(model) ?? 0) + durationMs)
}

export function getActiveRequests(): number {
  return activeRequests
}

// ─── Dashboard ───

export interface ObservabilityMetrics {
  version: string
  uptime: number
  totalRequests: number
  activeRequests: number
  requestsByModel: Record<string, number>
  requestsByStatus: Record<string, number>
  avgDurationByModel: Record<string, number>
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    requestCount: number
  }
  rateLimits: Record<string, { remaining: number; total: number }>
  recentErrors: number
}

export function getMetrics(): ObservabilityMetrics {
  const usage = getTokenUsage()
  const rateLimits = getRateLimitStats()
  const errors = getRecentErrors()

  const avgDuration: Record<string, number> = {}
  for (const [model, sum] of durationSum) {
    const count = requestsByModel.get(model) ?? 1
    avgDuration[model] = Math.round(sum / count)
  }

  const statusEntries: Record<string, number> = {}
  for (const [code, count] of requestsByStatus) {
    statusEntries[String(code)] = count
  }

  const rlSimple: Record<string, { remaining: number; total: number }> = {}
  for (const [model, stats] of Object.entries(rateLimits)) {
    rlSimple[model] = { remaining: stats.remaining, total: stats.total }
  }

  return {
    version: VERSION,
    uptime: getUptime(),
    totalRequests,
    activeRequests,
    requestsByModel: Object.fromEntries(requestsByModel),
    requestsByStatus: statusEntries,
    avgDurationByModel: avgDuration,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      requestCount: usage.requestCount,
    },
    rateLimits: rlSimple,
    recentErrors: errors.length,
  }
}

/**
 * Reset all counters (for testing).
 */
export function resetMetrics(): void {
  totalRequests = 0
  activeRequests = 0
  requestsByModel.clear()
  requestsByStatus.clear()
  durationSum.clear()
}
