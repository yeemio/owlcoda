/**
 * Per-model performance tracker.
 *
 * Records real request metrics (tokens/s, latency, success rate) per model.
 * Used to feed accurate data into cost estimation, intent routing weights,
 * and the /perf REPL command.
 *
 * Thread-safe via single-threaded Node.js event loop guarantee.
 */

export interface ModelMetrics {
  /** Model identifier */
  modelId: string
  /** Total requests completed */
  requestCount: number
  /** Total input tokens processed */
  totalInputTokens: number
  /** Total output tokens generated */
  totalOutputTokens: number
  /** Total wall-clock time across all requests (ms) */
  totalDurationMs: number
  /** Fastest request (ms) */
  minDurationMs: number
  /** Slowest request (ms) */
  maxDurationMs: number
  /** Number of failed requests (5xx or connection errors) */
  failureCount: number
  /** Last request timestamp */
  lastRequestAt: string
  /** First request timestamp */
  firstRequestAt: string
}

export interface ModelPerfSummary {
  modelId: string
  requestCount: number
  avgDurationMs: number
  avgOutputTps: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  p50DurationMs: number
}

// ─── Storage ───

const metricsStore = new Map<string, ModelMetrics>()
const durationHistory = new Map<string, number[]>() // for percentile calculations

const MAX_HISTORY_PER_MODEL = 100 // Keep last 100 durations for percentiles

// ─── Recording ───

export interface RequestRecord {
  modelId: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  success: boolean
}

/**
 * Record a completed request's metrics.
 */
export function recordRequestMetrics(record: RequestRecord): void {
  const existing = metricsStore.get(record.modelId)
  const now = new Date().toISOString()

  if (!existing) {
    metricsStore.set(record.modelId, {
      modelId: record.modelId,
      requestCount: 1,
      totalInputTokens: record.inputTokens,
      totalOutputTokens: record.outputTokens,
      totalDurationMs: record.durationMs,
      minDurationMs: record.durationMs,
      maxDurationMs: record.durationMs,
      failureCount: record.success ? 0 : 1,
      lastRequestAt: now,
      firstRequestAt: now,
    })
  } else {
    existing.requestCount += 1
    existing.totalInputTokens += record.inputTokens
    existing.totalOutputTokens += record.outputTokens
    existing.totalDurationMs += record.durationMs
    existing.minDurationMs = Math.min(existing.minDurationMs, record.durationMs)
    existing.maxDurationMs = Math.max(existing.maxDurationMs, record.durationMs)
    if (!record.success) existing.failureCount += 1
    existing.lastRequestAt = now
  }

  // Track duration history for percentiles
  let history = durationHistory.get(record.modelId)
  if (!history) {
    history = []
    durationHistory.set(record.modelId, history)
  }
  history.push(record.durationMs)
  if (history.length > MAX_HISTORY_PER_MODEL) {
    history.shift()
  }
}

// ─── Queries ───

/**
 * Get raw metrics for a model.
 */
export function getModelMetrics(modelId: string): ModelMetrics | undefined {
  return metricsStore.get(modelId)
}

/**
 * Get all model metrics.
 */
export function getAllModelMetrics(): ModelMetrics[] {
  return Array.from(metricsStore.values())
}

/**
 * Get performance summary for a model.
 */
export function getModelPerfSummary(modelId: string): ModelPerfSummary | null {
  const m = metricsStore.get(modelId)
  if (!m || m.requestCount === 0) return null

  const avgDurationMs = m.totalDurationMs / m.requestCount
  const avgOutputTps = avgDurationMs > 0
    ? (m.totalOutputTokens / m.requestCount) / (avgDurationMs / 1000)
    : 0
  const successRate = m.requestCount > 0
    ? (m.requestCount - m.failureCount) / m.requestCount
    : 1

  // P50 from history
  const history = durationHistory.get(modelId) ?? []
  const sorted = [...history].sort((a, b) => a - b)
  const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : avgDurationMs

  return {
    modelId,
    requestCount: m.requestCount,
    avgDurationMs: Math.round(avgDurationMs),
    avgOutputTps: Math.round(avgOutputTps * 10) / 10,
    successRate: Math.round(successRate * 1000) / 1000,
    totalInputTokens: m.totalInputTokens,
    totalOutputTokens: m.totalOutputTokens,
    p50DurationMs: Math.round(p50),
  }
}

/**
 * Format performance summary for display.
 */
export function formatPerfSummary(summary: ModelPerfSummary): string {
  const lines: string[] = [
    `Model: ${summary.modelId}`,
    `  Requests:    ${summary.requestCount}`,
    `  Avg latency: ${summary.avgDurationMs}ms (p50: ${summary.p50DurationMs}ms)`,
    `  Output TPS:  ${summary.avgOutputTps} tok/s`,
    `  Success:     ${(summary.successRate * 100).toFixed(1)}%`,
    `  Tokens:      ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`,
  ]
  return lines.join('\n')
}

/**
 * Format all model performance summaries.
 */
export function formatAllPerfSummaries(): string {
  const metrics = getAllModelMetrics()
  if (metrics.length === 0) return 'No performance data recorded yet.'

  const summaries = metrics
    .map(m => getModelPerfSummary(m.modelId))
    .filter((s): s is ModelPerfSummary => s !== null)
    .sort((a, b) => b.requestCount - a.requestCount)

  return summaries.map(formatPerfSummary).join('\n\n')
}

/**
 * Reset all metrics (for testing).
 */
export function resetModelMetrics(): void {
  metricsStore.clear()
  durationHistory.clear()
}
