/**
 * Difficulty-based model routing (shadow-first).
 *
 * Sibling to intent-router.ts. Intent answers "what KIND of work" (code / chat /
 * analysis); difficulty answers "how HARD is this turn" — a `code` turn can be a
 * one-line edit or a deep refactor. Routing simple turns (confirmations, short
 * summaries) to a cheap/local model and reserving the strong model for hard
 * reasoning is the largest single-box cost+latency lever (output tokens are
 * 2-6x input; a local fleet has ~zero marginal token cost).
 *
 * This module is SHADOW-ONLY: it classifies and records "what difficulty routing
 * WOULD pick" without changing the model actually used. Enforcement is a later
 * decision, informed by the accumulated shadow distribution + the S8 dogfood
 * trajectory set. Recording is opt-in (OWLCODA_ROUTING_SHADOW) and default-off,
 * so this file is a zero-cost no-op until explicitly enabled.
 */

import type { OwlCodaConfig } from './config.js'
import {
  buildTelemetryEventEnvelope,
  recordTelemetryEnvelope,
  type TelemetryEventEnvelope,
} from './native/telemetry-envelope.js'

export type TurnDifficulty = 'simple' | 'moderate' | 'hard'

export interface DifficultySignal {
  difficulty: TurnDifficulty
  /** Confidence 0-1. `moderate` is the catch-all and carries confidence 1.0. */
  confidence: number
  source: 'complex_verb' | 'long_request' | 'confirmation' | 'summarize' | 'default'
  reasonCodes: string[]
}

interface RoutableBody {
  model?: string
  messages?: Array<{ role: string; content: unknown }>
  tools?: unknown[]
  system?: unknown
}

// Hard-reasoning verbs: turns that almost always need the strong model.
const COMPLEX_VERB =
  /\b(implement|implementing|refactor|debug|fix the bug|fix the failing|design|architect|migrat|optimi[sz]e|investigat|root[- ]cause|rewrite|diagnos|reason about|trace through)\b/i
// Short, bounded confirmations — the highest-precision "simple" signal.
// A PURE confirmation: one or more confirmation words ("yes", "lgtm, proceed"),
// and nothing else. A turn that merely STARTS with a confirmation word but then
// carries a correction or new instruction ("no, fix it properly") must fall
// through to moderate rather than route down to a weak model.
const CONFIRM_WORD =
  'y(?:es)?|no?|ok(?:ay)?|sure|continue|proceed|go ahead|approved?|lgtm|looks good|sounds good|do it|confirm(?:ed)?|thanks?|ship it'
const CONFIRMATION = new RegExp(`^(?:${CONFIRM_WORD})(?:[\\s,.!]+(?:${CONFIRM_WORD}))*[\\s.!,]*$`, 'i')
// Explicit restatement of already-present content.
const SUMMARIZE = /\b(summar(y|ize|ise)|tl;?dr|recap|rephrase|restate|brief overview)\b/i

const LONG_REQUEST_CHARS = 1500
const CONFIRMATION_MAX_CHARS = 80
const SUMMARIZE_MAX_CHARS = 280

function extractLastUserText(body: RoutableBody): string {
  const lastUser = body.messages?.filter(m => m.role === 'user').pop()
  if (!lastUser) return ''
  const c = lastUser.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b: unknown) => {
      const t = (b as { text?: unknown })?.text
      return typeof t === 'string' ? t : ''
    }).join(' ')
  }
  return ''
}

/**
 * Classify a turn's difficulty from its request body. Deliberately conservative:
 * it only calls a turn `simple` on a high-precision signal (a short confirmation
 * or an explicit short summarize request) so a hard turn is never routed down by
 * mistake. Everything ambiguous is `moderate`. Recall is intentionally low; the
 * shadow distribution is what tells us whether to loosen it. Pure.
 */
export function classifyTurnDifficulty(body: RoutableBody): DifficultySignal {
  const text = extractLastUserText(body).trim()
  const len = text.length

  const complex = text.match(COMPLEX_VERB)
  if (complex) {
    return { difficulty: 'hard', confidence: 0.7, source: 'complex_verb', reasonCodes: ['complex_verb', complex[0].toLowerCase()] }
  }
  if (len > LONG_REQUEST_CHARS) {
    return { difficulty: 'hard', confidence: 0.55, source: 'long_request', reasonCodes: ['long_request', `len_${len}`] }
  }
  if (len > 0 && len <= CONFIRMATION_MAX_CHARS && CONFIRMATION.test(text)) {
    return { difficulty: 'simple', confidence: 0.8, source: 'confirmation', reasonCodes: ['confirmation'] }
  }
  if (len <= SUMMARIZE_MAX_CHARS && SUMMARIZE.test(text)) {
    return { difficulty: 'simple', confidence: 0.7, source: 'summarize', reasonCodes: ['summarize'] }
  }
  return { difficulty: 'moderate', confidence: 1.0, source: 'default', reasonCodes: ['default'] }
}

/** Preferred tiers per difficulty, mirroring intent-router's INTENT_TIER_MAP. */
const DIFFICULTY_TIER_MAP: Record<TurnDifficulty, string[]> = {
  simple: ['fast', 'balanced', 'general'],
  moderate: ['balanced', 'general', 'production'],
  hard: ['heavy', 'production', 'balanced'],
}

/**
 * Resolve the model a difficulty class would route to, via the tier map with a
 * default-model fallback. Self-contained (no catalog dependency) so the decision
 * is unit-testable with a minimal config. Returns null when nothing resolves.
 */
export function resolveDifficultyModel(
  config: Pick<OwlCodaConfig, 'models'>,
  difficulty: TurnDifficulty,
): string | null {
  const tiers = DIFFICULTY_TIER_MAP[difficulty] ?? DIFFICULTY_TIER_MAP.moderate
  for (const tier of tiers) {
    const match = config.models.find(m => m.tier === tier)
    if (match) return match.id
  }
  const def = config.models.find(m => m.default) ?? config.models[0]
  return def?.id ?? null
}

/** Opt-in (default OFF). Brand-new router → zero behavior change unless asked. */
export function isRoutingShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_ROUTING_SHADOW']
  if (raw === undefined) return false
  return new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']).has(raw.trim().toLowerCase())
}

/**
 * Build the behavior-neutral shadow envelope: difficulty classification plus the
 * model difficulty routing WOULD pick vs. the model actually used. Pure — no IO.
 */
export function buildRoutingShadowEvent(
  config: Pick<OwlCodaConfig, 'models'>,
  body: RoutableBody,
  effectiveModel: string | undefined,
): TelemetryEventEnvelope {
  const signal = classifyTurnDifficulty(body)
  const actual = effectiveModel || body.model || 'unknown'
  const would = resolveDifficultyModel(config, signal.difficulty)
  return buildTelemetryEventEnvelope({
    eventType: 'model_routing_shadow',
    surface: 'http',
    subject: actual,
    origin: 'runtime',
    severity: 'info',
    decision: 'observe',
    reasonCode: `difficulty_${signal.difficulty}`,
    attributes: {
      difficulty: signal.difficulty,
      confidence: signal.confidence,
      source: signal.source,
      reasonCodes: signal.reasonCodes,
      actualModel: actual,
      wouldRouteModel: would,
      wouldDiffer: would !== null && would !== actual,
    },
  })
}

/**
 * Record one shadow sample of the difficulty-routing decision. No-op unless
 * OWLCODA_ROUTING_SHADOW is enabled. Fire-and-forget (recordTelemetryEnvelope
 * swallows IO errors). NEVER changes the model in use — caller's effectiveModel
 * is unchanged; this only observes.
 */
export function recordRoutingShadow(
  config: Pick<OwlCodaConfig, 'models'>,
  body: RoutableBody,
  effectiveModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isRoutingShadowEnabled(env)) return
  recordTelemetryEnvelope(buildRoutingShadowEvent(config, body, effectiveModel), env)
}
