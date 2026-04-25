/**
 * Latency histogram — tracks per-model request durations with percentile support.
 * Uses a fixed-size ring buffer per model to bound memory.
 */

const MAX_SAMPLES = 200

const samples = new Map<string, number[]>()

/**
 * Record a request duration for a model.
 */
export function recordLatency(model: string, durationMs: number): void {
  let buf = samples.get(model)
  if (!buf) {
    buf = []
    samples.set(model, buf)
  }
  if (buf.length >= MAX_SAMPLES) {
    buf.shift() // ring buffer behavior
  }
  buf.push(durationMs)
}

export interface LatencyStats {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p90: number
  p95: number
  p99: number
}

/**
 * Compute latency percentiles for a model.
 */
export function getLatencyStats(model: string): LatencyStats | null {
  const buf = samples.get(model)
  if (!buf || buf.length === 0) return null

  const sorted = [...buf].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)

  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    mean: Math.round(sum / count),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  }
}

/**
 * Get stats for all models.
 */
export function getAllLatencyStats(): Record<string, LatencyStats> {
  const result: Record<string, LatencyStats> = {}
  for (const [model] of samples) {
    const stats = getLatencyStats(model)
    if (stats) result[model] = stats
  }
  return result
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const idx = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return sorted[lower]
  const frac = idx - lower
  return Math.round(sorted[lower] * (1 - frac) + sorted[upper] * frac)
}

/**
 * Format latency stats for display.
 */
export function formatLatencyStats(stats: Record<string, LatencyStats>): string {
  const models = Object.keys(stats)
  if (models.length === 0) return 'No latency data recorded yet.'

  const lines: string[] = ['Model Latency (ms):']
  for (const model of models) {
    const s = stats[model]
    lines.push(`  ${model} (${s.count} requests):`)
    lines.push(`    min=${s.min}  p50=${s.p50}  p90=${s.p90}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`)
  }
  return lines.join('\n')
}

/**
 * Reset all samples (for testing).
 */
export function resetLatency(): void {
  samples.clear()
}
