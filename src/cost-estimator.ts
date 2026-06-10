/**
 * Cost estimation for local LLM models.
 *
 * Unlike cloud models with per-token pricing, local models have:
 *   1. Hardware amortization cost (GPU, RAM, storage)
 *   2. Power consumption cost
 *   3. Opportunity cost (what else could run on this hardware)
 *
 * This module provides a simple estimation framework that's
 * more honest than showing $0.00 or cloud Anthropic prices.
 *
 * Users can configure per-model costs in config.json, or use
 * defaults based on model size and quantization.
 */

export interface CostProfile {
  /** Cost per million input tokens (in local currency units, e.g. kWh or ¥) */
  inputCostPer1M: number
  /** Cost per million output tokens */
  outputCostPer1M: number
  /** Currency/unit label (e.g. "kWh", "¥", "$", "compute-units") */
  unit: string
  /** Estimated tokens per second for this model */
  estimatedTps: number
  /** Source of the estimate */
  source: 'configured' | 'estimated' | 'default'
}

export interface CostEstimate {
  /** Input token cost */
  inputCost: number
  /** Output token cost */
  outputCost: number
  /** Total cost */
  totalCost: number
  /** Currency/unit label */
  unit: string
  /** Estimated wall-clock time in seconds */
  estimatedSeconds: number
  /** Source of the cost profile */
  source: CostProfile['source']
}

// ─── Default cost profiles by model size ───

// Based on rough estimates:
// - 7B model on Apple Silicon: ~0.3 kWh per million tokens
// - 30B model: ~1.2 kWh per million tokens
// - 70B model: ~3.0 kWh per million tokens
// - 120B+ model: ~5.0 kWh per million tokens
// Electricity cost: ~0.6 ¥/kWh in China (residential)

interface SizeProfile {
  inputCostPer1M: number
  outputCostPer1M: number
  estimatedTps: number
}

const SIZE_PROFILES: Record<string, SizeProfile> = {
  small:  { inputCostPer1M: 0.18, outputCostPer1M: 0.36, estimatedTps: 60 },   // <10B
  medium: { inputCostPer1M: 0.72, outputCostPer1M: 1.44, estimatedTps: 25 },   // 10-40B
  large:  { inputCostPer1M: 1.80, outputCostPer1M: 3.60, estimatedTps: 12 },   // 40-80B
  xlarge: { inputCostPer1M: 3.00, outputCostPer1M: 6.00, estimatedTps: 6 },    // 80B+
}

const DEFAULT_UNIT = '¥'

// ─── Cost Profile Resolution ───

/**
 * Extract parameter count from model ID (e.g. "70B", "27B", "120b").
 */
export function extractParamCount(modelId: string): number | null {
  const match = modelId.match(/(\d+\.?\d*)\s*[Bb]/)
  if (!match) return null
  return parseFloat(match[1]!)
}

/**
 * Determine size category from parameter count.
 */
export function sizeCategory(params: number): keyof typeof SIZE_PROFILES {
  if (params < 10) return 'small'
  if (params < 40) return 'medium'
  if (params < 80) return 'large'
  return 'xlarge'
}

/**
 * Get cost profile for a model.
 * Priority: user-configured > size-estimated > default.
 */
export function getCostProfile(
  modelId: string,
  userProfiles?: Record<string, Partial<CostProfile>>,
): CostProfile {
  // 1. User-configured profile
  if (userProfiles?.[modelId]) {
    const up = userProfiles[modelId]!
    const params = extractParamCount(modelId)
    const category = params ? sizeCategory(params) : 'medium'
    const defaults = SIZE_PROFILES[category]!
    return {
      inputCostPer1M: up.inputCostPer1M ?? defaults.inputCostPer1M,
      outputCostPer1M: up.outputCostPer1M ?? defaults.outputCostPer1M,
      unit: up.unit ?? DEFAULT_UNIT,
      estimatedTps: up.estimatedTps ?? defaults.estimatedTps,
      source: 'configured',
    }
  }

  // 2. Size-based estimation
  const params = extractParamCount(modelId)
  if (params) {
    const category = sizeCategory(params)
    const profile = SIZE_PROFILES[category]!
    return {
      ...profile,
      unit: DEFAULT_UNIT,
      source: 'estimated',
    }
  }

  // 3. Default (medium)
  return {
    ...SIZE_PROFILES['medium']!,
    unit: DEFAULT_UNIT,
    source: 'default',
  }
}

// ─── Cost Calculation ───

/**
 * Calculate cost for a given token usage.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string,
  userProfiles?: Record<string, Partial<CostProfile>>,
): CostEstimate {
  const profile = getCostProfile(modelId, userProfiles)

  const inputCost = (inputTokens / 1_000_000) * profile.inputCostPer1M
  const outputCost = (outputTokens / 1_000_000) * profile.outputCostPer1M
  const totalTokens = inputTokens + outputTokens
  const estimatedSeconds = profile.estimatedTps > 0
    ? totalTokens / profile.estimatedTps
    : 0

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    unit: profile.unit,
    estimatedSeconds,
    source: profile.source,
  }
}

/**
 * Format cost estimate for display.
 */
export function formatCostEstimate(estimate: CostEstimate): string {
  const total = estimate.totalCost < 0.01
    ? `<${estimate.unit}0.01`
    : `${estimate.unit}${estimate.totalCost.toFixed(4)}`

  const parts = [total]
  if (estimate.source === 'estimated') {
    parts.push('(estimated from model size)')
  } else if (estimate.source === 'default') {
    parts.push('(default estimate)')
  }
  return parts.join(' ')
}

/**
 * Format a detailed cost breakdown.
 */
export function formatCostBreakdown(
  inputTokens: number,
  outputTokens: number,
  estimate: CostEstimate,
): string {
  const lines: string[] = []
  lines.push(`Input:  ${inputTokens.toLocaleString()} tokens → ${estimate.unit}${estimate.inputCost.toFixed(6)}`)
  lines.push(`Output: ${outputTokens.toLocaleString()} tokens → ${estimate.unit}${estimate.outputCost.toFixed(6)}`)
  lines.push(`Total:  ${estimate.unit}${estimate.totalCost.toFixed(6)} (${estimate.source})`)
  if (estimate.estimatedSeconds > 0) {
    const s = estimate.estimatedSeconds
    lines.push(`Est. time: ${s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`}`)
  }
  return lines.join('\n')
}

// ─── Enhanced estimation with real perf data ───

/**
 * Get cost profile enhanced with actual TPS from perf tracker.
 * Falls back to size-based estimation if no real data available.
 */
export function getCostProfileWithPerf(
  modelId: string,
  realTps?: number,
  userProfiles?: Record<string, Partial<CostProfile>>,
): CostProfile {
  const base = getCostProfile(modelId, userProfiles)
  if (realTps && realTps > 0) {
    return { ...base, estimatedTps: realTps, source: base.source === 'configured' ? 'configured' : 'estimated' }
  }
  return base
}

/**
 * Get session cost summary across all models.
 */
export function getSessionCostSummary(
  modelUsage: Array<{ modelId: string; inputTokens: number; outputTokens: number; realTps?: number }>,
  userProfiles?: Record<string, Partial<CostProfile>>,
): { perModel: Array<{ modelId: string; cost: CostEstimate }>; totalCost: number; unit: string } {
  const perModel: Array<{ modelId: string; cost: CostEstimate }> = []
  let totalCost = 0
  let unit = DEFAULT_UNIT

  for (const u of modelUsage) {
    const profile = getCostProfileWithPerf(u.modelId, u.realTps, userProfiles)
    const inputCost = (u.inputTokens / 1_000_000) * profile.inputCostPer1M
    const outputCost = (u.outputTokens / 1_000_000) * profile.outputCostPer1M
    const totalTokens = u.inputTokens + u.outputTokens
    const estimatedSeconds = profile.estimatedTps > 0 ? totalTokens / profile.estimatedTps : 0

    const cost: CostEstimate = {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      unit: profile.unit,
      estimatedSeconds,
      source: profile.source,
    }
    perModel.push({ modelId: u.modelId, cost })
    totalCost += cost.totalCost
    unit = profile.unit
  }

  return { perModel, totalCost, unit }
}
