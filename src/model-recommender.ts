/**
 * Model recommendation engine.
 *
 * Suggests the best model for a given intent based on:
 * - Intent match (code→coding models, analysis→reasoning models)
 * - Real performance data (TPS, success rate, latency)
 * - Cost efficiency
 * - Model size/capability tier
 */

import type { OwlCodaConfig, ConfiguredModel } from './config.js'
import { listConfiguredModels } from './config.js'
import { getModelPerfSummary, type ModelPerfSummary } from './perf-tracker.js'
import { getCostProfile, extractParamCount, type CostProfile } from './cost-estimator.js'

export type Intent = 'code' | 'analysis' | 'search' | 'chat' | 'general'

export interface ModelScore {
  modelId: string
  score: number
  reasons: string[]
  perf?: ModelPerfSummary
  cost?: CostProfile
}

export interface Recommendation {
  intent: Intent
  recommended: ModelScore
  alternatives: ModelScore[]
}

// Intent → preferred model keywords (higher specificity = higher score)
const INTENT_KEYWORDS: Record<Intent, string[]> = {
  code: ['coder', 'code', 'instruct', 'dev'],
  analysis: ['reasoning', 'think', 'analyst', 'math'],
  search: ['search', 'retrieval', 'rag'],
  chat: ['chat', 'assistant', 'dialog'],
  general: [],
}

// Minimum success rate to consider a model healthy
const MIN_SUCCESS_RATE = 0.5

/**
 * Score a model for a given intent.
 */
function scoreModel(
  model: ConfiguredModel,
  intent: Intent,
  perf: ModelPerfSummary | null,
  costProfile: CostProfile,
): ModelScore {
  let score = 50 // Base score
  const reasons: string[] = []
  const backendModel = model.backendModel.toLowerCase()

  // Intent keyword match (+20 per keyword)
  const keywords = INTENT_KEYWORDS[intent]
  for (const kw of keywords) {
    if (backendModel.includes(kw)) {
      score += 20
      reasons.push(`name matches "${kw}"`)
    }
  }

  // Performance bonus (if we have real data)
  if (perf && perf.requestCount >= 2) {
    // TPS bonus: higher = better (max +15)
    if (perf.avgOutputTps > 50) {
      const tpsBonus = Math.min(15, Math.round(perf.avgOutputTps / 10))
      score += tpsBonus
      reasons.push(`${perf.avgOutputTps} tok/s (+${tpsBonus})`)
    }

    // Success rate penalty
    if (perf.successRate < MIN_SUCCESS_RATE) {
      score -= 30
      reasons.push(`low success ${(perf.successRate * 100).toFixed(0)}%`)
    } else if (perf.successRate >= 0.95) {
      score += 10
      reasons.push('reliable (≥95%)')
    }

    // Latency: fast response bonus (max +10)
    if (perf.avgDurationMs < 1000) {
      score += 10
      reasons.push('fast (<1s avg)')
    } else if (perf.avgDurationMs < 3000) {
      score += 5
      reasons.push('moderate latency')
    }
  } else {
    reasons.push('no perf data')
  }

  // Cost efficiency: cheaper = small bonus for general/chat, penalty for code/analysis
  const paramCount = extractParamCount(model.backendModel)
  const isLargeModel = paramCount !== null && paramCount >= 40
  const isSmallModel = paramCount !== null && paramCount < 15

  if (intent === 'code' || intent === 'analysis') {
    if (isLargeModel) {
      score += 10
      reasons.push('large model (preferred for complexity)')
    }
  } else {
    if (isSmallModel) {
      score += 10
      reasons.push('cost-efficient')
    }
  }

  return { modelId: model.id, score, reasons, perf: perf ?? undefined, cost: costProfile }
}

/**
 * Get model recommendation for an intent.
 */
export function recommendModel(config: OwlCodaConfig, intent: Intent): Recommendation {
  const models = listConfiguredModels(config)
  if (models.length === 0) {
    return {
      intent,
      recommended: { modelId: 'none', score: 0, reasons: ['no models configured'] },
      alternatives: [],
    }
  }

  const scored: ModelScore[] = models.map(model => {
    const perf = getModelPerfSummary(model.id) ?? getModelPerfSummary(model.backendModel)
    const costProfile = getCostProfile(model.backendModel)
    return scoreModel(model, intent, perf, costProfile)
  })

  scored.sort((a, b) => b.score - a.score)

  return {
    intent,
    recommended: scored[0]!,
    alternatives: scored.slice(1, 4), // Top 3 alternatives
  }
}

/**
 * Format recommendation for display.
 */
export function formatRecommendation(rec: Recommendation): string {
  const lines: string[] = [
    `Intent: ${rec.intent}`,
    `Recommended: ${rec.recommended.modelId} (score: ${rec.recommended.score})`,
    `  Reasons: ${rec.recommended.reasons.join(', ')}`,
  ]

  if (rec.alternatives.length > 0) {
    lines.push('Alternatives:')
    for (const alt of rec.alternatives) {
      lines.push(`  ${alt.modelId} (score: ${alt.score}) — ${alt.reasons.join(', ')}`)
    }
  }

  return lines.join('\n')
}
