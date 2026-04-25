/**
 * Intent-based model routing.
 *
 * Maps user intents (code, chat, analysis, etc.) to optimal models.
 * Works with both catalog-defined intents and runtime heuristics.
 *
 * Intent priority:
 *   1. Explicit user model choice (--model flag or /model command)
 *   2. Message-level intent detection (tool_use → code intent)
 *   3. Catalog intent_defaults mapping
 *   4. Default model
 */

import type { OwlCodaConfig } from './config.js'
import { resolveConfiguredModel, getDefaultConfiguredModel } from './config.js'

// ─── Intent Types ───

export type Intent =
  | 'code'          // Code generation, debugging, refactoring
  | 'chat'          // General conversation
  | 'analysis'      // Data analysis, reasoning, complex tasks
  | 'search'        // Web search, information retrieval
  | 'embedding'     // Text embedding (not chat)
  | 'fast'          // Low-latency, lightweight tasks
  | 'heavy'         // Complex, requires strongest model
  | 'default'       // No specific intent

export interface IntentSignal {
  /** Detected intent */
  intent: Intent
  /** Confidence 0-1 */
  confidence: number
  /** What triggered the detection */
  source: 'explicit' | 'tools' | 'system_prompt' | 'message_content' | 'default'
}

export interface IntentRouteResult {
  /** Resolved model ID */
  modelId: string
  /** The intent that was used for routing */
  intent: Intent
  /** How the intent was detected */
  signal: IntentSignal
  /** Whether this overrode the user's explicit model choice */
  overrodeExplicit: boolean
}

// ─── Intent Detection ───

/**
 * Detect intent from an Anthropic messages request.
 */
export function detectIntent(body: {
  model?: string
  messages?: Array<{ role: string; content: unknown }>
  tools?: unknown[]
  system?: unknown
}): IntentSignal {
  // Tool presence strongly signals code intent
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    return { intent: 'code', confidence: 0.8, source: 'tools' }
  }

  // System prompt analysis
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b: any) => b.text ?? '').join(' ')
        : ''
    const lower = sysText.toLowerCase()

    if (lower.includes('code') || lower.includes('programming') || lower.includes('developer')) {
      return { intent: 'code', confidence: 0.7, source: 'system_prompt' }
    }
    if (lower.includes('analys') || lower.includes('research') || lower.includes('reason')) {
      return { intent: 'analysis', confidence: 0.7, source: 'system_prompt' }
    }
    if (lower.includes('search') || lower.includes('find') || lower.includes('lookup')) {
      return { intent: 'search', confidence: 0.6, source: 'system_prompt' }
    }
  }

  // Last user message content analysis
  const lastUser = body.messages?.filter(m => m.role === 'user').pop()
  if (lastUser) {
    const text = typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? lastUser.content.map((b: any) => b.text ?? '').join(' ')
        : ''
    const lower = text.toLowerCase()

    if (lower.includes('write code') || lower.includes('implement') || lower.includes('fix the bug')
        || lower.includes('refactor') || lower.includes('debug')) {
      return { intent: 'code', confidence: 0.6, source: 'message_content' }
    }
    if (lower.includes('analyze') || lower.includes('explain') || lower.includes('compare')) {
      return { intent: 'analysis', confidence: 0.5, source: 'message_content' }
    }
  }

  return { intent: 'default', confidence: 1.0, source: 'default' }
}

// ─── Intent → Model Resolution ───

/** Built-in intent → tier mapping when catalog doesn't have intent_defaults */
const INTENT_TIER_MAP: Record<Intent, string[]> = {
  code:      ['production', 'heavy', 'balanced'],
  chat:      ['production', 'balanced', 'general'],
  analysis:  ['heavy', 'production'],
  search:    ['fast', 'production'],
  embedding: ['embedding'],
  fast:      ['fast', 'discovered'],
  heavy:     ['heavy', 'production'],
  default:   ['production', 'balanced', 'general', 'discovered'],
}

/**
 * Resolve model for a given intent using catalog or tier-based fallback.
 */
export function resolveIntentModel(
  config: OwlCodaConfig,
  intent: Intent,
): string | null {
  // 1. Check catalog intent_defaults (if catalog was loaded)
  if (config.catalogLoaded) {
    // The catalog stores intent_defaults as intent → model_id
    const catalogIntentDefaults = (config as any)._intentDefaults as Record<string, string> | undefined
    if (catalogIntentDefaults?.[intent]) {
      const modelId = catalogIntentDefaults[intent]!
      // Verify it exists in config
      try {
        resolveConfiguredModel(config, modelId)
        return modelId
      } catch {
        // Model not found, fall through
      }
    }
  }

  // 2. Tier-based resolution
  const preferredTiers = INTENT_TIER_MAP[intent] ?? INTENT_TIER_MAP['default']!
  for (const tier of preferredTiers) {
    const match = config.models.find(m => m.tier === tier)
    if (match) return match.id
  }

  // 3. Fall back to default model
  const def = getDefaultConfiguredModel(config)
  return def?.id ?? config.models[0]?.id ?? null
}

/**
 * Full intent-based routing: detect intent from request, resolve model.
 * Only activates when the user hasn't explicitly chosen a model.
 */
export function routeByIntent(
  config: OwlCodaConfig,
  body: {
    model?: string
    messages?: Array<{ role: string; content: unknown }>
    tools?: unknown[]
    system?: unknown
  },
  explicitModelChoice?: string,
): IntentRouteResult {
  const signal = detectIntent(body)

  // If user explicitly chose a model, respect it
  if (explicitModelChoice) {
    return {
      modelId: explicitModelChoice,
      intent: signal.intent,
      signal,
      overrodeExplicit: false,
    }
  }

  // If intent is default (no strong signal), use default model
  if (signal.intent === 'default') {
    const defaultModel = getDefaultConfiguredModel(config)
    return {
      modelId: defaultModel?.id ?? config.models[0]?.id ?? body.model ?? '',
      intent: 'default',
      signal,
      overrodeExplicit: false,
    }
  }

  // Resolve model for detected intent
  const resolved = resolveIntentModel(config, signal.intent)
  const fallback = getDefaultConfiguredModel(config)
  return {
    modelId: resolved ?? fallback?.id ?? config.models[0]?.id ?? '',
    intent: signal.intent,
    signal,
    overrodeExplicit: false,
  }
}
