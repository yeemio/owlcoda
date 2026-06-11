export const DEFAULT_CONTEXT_WINDOW = 32_768

/**
 * Conservative-but-modern default context window for a model OwlCoda does not
 * recognize. Raised from the old 32_768 because most current models are far
 * larger (e.g. mimo-v2.5-pro is 1M), and a too-small window silently forces
 * constant compaction / loop-budget trimming that degrades long tasks. A model
 * that is actually smaller than this can be capped down in config.
 *
 * DEFAULT_CONTEXT_WINDOW stays 32_768 as the "stale historical default"
 * sentinel that resolveContextCapability uses to migrate old config values up
 * (config carrying exactly 32_768 + no inferred window → this fallback).
 */
export const CONSERVATIVE_FALLBACK_CONTEXT_WINDOW = 200_000

export type ContextWindowSource = 'configured' | 'official_known' | 'runtime_discovered' | 'fallback'
export type ContextWindowConfidence = 'verified' | 'documented' | 'inferred' | 'unknown'

export type ModelIdentity = {
  id?: string
  label?: string
  backendModel?: string
  aliases?: string[]
  endpoint?: string
  contextWindow?: number
  contextWindowSource?: ContextWindowSource
}

type ContextCapability = {
  contextWindow: number
  source: ContextWindowSource
  confidence: ContextWindowConfidence
  labels?: string[]
  notes?: string[]
  patterns: RegExp[]
}

export interface ModelContextCapability {
  contextWindow: number
  source: ContextWindowSource
  confidence: ContextWindowConfidence
  labels: string[]
  notes: string[]
}

export type SustainedWorkStatus = 'signed_off' | 'short_task_only' | 'unknown'

export interface SustainedWorkCapability {
  status: SustainedWorkStatus
  longTaskMainEligible: boolean
  defaultEligible: boolean
  automaticFallbackEligible: boolean
  longTaskRecommendationEligible: boolean
  labels: string[]
  reason?: string
}

export interface ModelCapabilities {
  context: ModelContextCapability
  sustainedWork: SustainedWorkCapability
}

const KNOWN_CONTEXT_CAPABILITIES: ContextCapability[] = [
  {
    contextWindow: 2_097_152,
    source: 'official_known',
    confidence: 'documented',
    labels: ['2M ctx', 'ctx documented'],
    notes: ['Gemini 1.5 Pro API route was documented with a 2,097,152 input-token limit; availability may depend on deprecation status.'],
    patterns: [
      /\bgemini[-_\s]?1\.5[-_\s]?pro\b/i,
      /\bmodels\/gemini[-_\s]?1\.5[-_\s]?pro\b/i,
    ],
  },
  {
    contextWindow: 1_048_576,
    source: 'official_known',
    confidence: 'documented',
    labels: ['1M ctx', 'ctx documented'],
    patterns: [
      /\bgemini[-_\s]?3(?:\.1)?[-_\s]?(?:pro|flash)(?:[-_\s](?:lite|preview|customtools))*\b/i,
      /\bgemini[-_\s]?2\.5[-_\s]?(?:pro|flash)(?:[-_\s]lite)?\b/i,
      /\bgemini[-_\s]?2\.0[-_\s]?flash\b/i,
    ],
  },
  {
    contextWindow: 1_000_000,
    source: 'official_known',
    confidence: 'documented',
    labels: ['1M ctx', 'ctx documented'],
    patterns: [
      /\bgpt[-_\s]?4\.1(?:[-_\s](?:mini|nano))?\b/i,
    ],
  },
  {
    contextWindow: 1_000_000,
    source: 'official_known',
    confidence: 'documented',
    labels: ['1M ctx', 'ctx documented'],
    notes: ['Claude 1M context depends on exact API model/route and account availability.'],
    patterns: [
      /\bclaude[-_\s]?(?:mythos[-_\s]?preview|opus[-_\s]?4(?:\.|-)?7|opus[-_\s]?4(?:\.|-)?6|sonnet[-_\s]?4(?:\.|-)?6)\b/i,
    ],
  },
  {
    contextWindow: 200_000,
    source: 'official_known',
    confidence: 'documented',
    labels: ['200K ctx', 'ctx documented'],
    patterns: [
      /\bclaude[-_\s]?(?:sonnet[-_\s]?4(?:\.|-)?5|sonnet[-_\s]?4\b|3(?:\.|-)?7[-_\s]?sonnet|3[-_\s]?5[-_\s]?sonnet|3[-_\s]?opus|3[-_\s]?haiku)\b/i,
    ],
  },
  {
    contextWindow: 1_000_000,
    source: 'official_known',
    confidence: 'documented',
    labels: ['1M ctx', 'ctx documented'],
    patterns: [
      /\bmimo[-_\s]?v?2\.?5\b/i,
    ],
  },
  {
    contextWindow: 204_800,
    source: 'official_known',
    confidence: 'inferred',
    labels: ['200K ctx', 'ctx inferred'],
    patterns: [
      /\bminimax-m?27\b/i,
      /\bminimax[-_\s]?m?2\.?7\b/i,
      /\bm27\b/i,
    ],
  },
  {
    contextWindow: 256_000,
    source: 'official_known',
    confidence: 'documented',
    labels: ['256K ctx', 'ctx documented'],
    patterns: [
      /\bkimi-code\b/i,
      /\bkimi[-_\s]?for[-_\s]?coding\b/i,
      /\bkimi[-_\s]?k2(?:[._-]?(?:5|6))?\b/i,
      /\bkimi[-_\s]?k2[-_\s]?(?:0905[-_\s]?preview|turbo[-_\s]?preview|thinking(?:[-_\s]?turbo)?)\b/i,
    ],
  },
  {
    contextWindow: 131_072,
    source: 'official_known',
    confidence: 'inferred',
    labels: ['128K ctx', 'ctx inferred'],
    patterns: [
      /\bmoonshot.*128k\b/i,
      /\bgpt-oss-(?:20b|120b)\b/i,
      /\bmistral-(?:large|small)\b/i,
      /\bnemotron\b/i,
    ],
  },
  {
    contextWindow: 40_960,
    source: 'official_known',
    confidence: 'inferred',
    labels: ['40K ctx', 'ctx inferred'],
    patterns: [
      /\bqwen3\b/i,
    ],
  },
  {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    source: 'official_known',
    confidence: 'inferred',
    labels: ['32K ctx', 'ctx inferred'],
    patterns: [
      /\bmirothinker\b/i,
      /\bmoonshot.*32k\b/i,
    ],
  },
]

const KIMI_SUSTAINED_WORK_CAPABILITY: SustainedWorkCapability = {
  status: 'signed_off',
  longTaskMainEligible: true,
  defaultEligible: true,
  automaticFallbackEligible: true,
  longTaskRecommendationEligible: true,
  labels: ['dogfood-proven', 'sustained-work capable'],
  reason: 'Kimi Code is now used for OwlCoda sustained dogfood lanes; provider/runtime errors remain monitored separately.',
}

const UNKNOWN_SUSTAINED_WORK_CAPABILITY: SustainedWorkCapability = {
  status: 'unknown',
  longTaskMainEligible: true,
  defaultEligible: true,
  automaticFallbackEligible: true,
  longTaskRecommendationEligible: true,
  labels: [],
}

const KIMI_IDENTITY_PATTERNS = [
  /\bkimi-code\b/i,
  /\bkimi[-_\s]?for[-_\s]?coding\b/i,
]

function identityHaystack(identity: ModelIdentity): string {
  return [
    identity.id,
    identity.label,
    identity.backendModel,
    ...(identity.aliases ?? []),
    identity.endpoint,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
}

function inferContextCapability(identity: ModelIdentity): ModelContextCapability | undefined {
  const haystack = identityHaystack(identity)
  if (!haystack) return undefined

  for (const capability of KNOWN_CONTEXT_CAPABILITIES) {
    if (capability.patterns.some(pattern => pattern.test(haystack))) {
      return {
        contextWindow: capability.contextWindow,
        source: capability.source,
        confidence: capability.confidence,
        labels: capability.labels ?? formatContextCapabilityLabels({
          contextWindow: capability.contextWindow,
          source: capability.source,
          confidence: capability.confidence,
        }),
        notes: capability.notes ?? [],
      }
    }
  }

  return undefined
}

export function inferContextWindow(identity: ModelIdentity): number | undefined {
  return inferContextCapability(identity)?.contextWindow
}

/**
 * Canonical compact token-count formatter. Shared by the status-bar CTX
 * pressure display (`formatContextPressure`) and the model-window labels
 * (`formatContextWindowShort`) so the SAME number renders identically
 * everywhere — previously the status bar used a k-only formatter that
 * rendered a 2M window as the misread-prone "2097.2k", while the label
 * formatter used a divergent uppercase-K rule.
 *
 *   n < 1000           → raw                       512
 *   1000 ≤ n < 1_000_000 → k, ≤1 decimal           1.8k / 204.8k / 256k
 *   n ≥ 1_000_000       → M, ≤1 decimal            1.3M
 *     clean binary (n % 1048576 === 0) and decimal (n % 1000000 === 0)
 *     multiples collapse to whole M, so a "2M model" configured as
 *     2*1024*1024 shows "2M", not "2.1M".
 */
export function formatTokenCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1_000_000) return `${trimOneDecimal(n / 1000)}k`
  if (n % 1_048_576 === 0) return `${n / 1_048_576}M`
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`
  return `${trimOneDecimal(n / 1_000_000)}M`
}

function trimOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
}

export function formatContextWindowShort(contextWindow: number): string {
  return `${formatTokenCompact(contextWindow)} ctx`
}

export function formatContextCapabilityLabels(capability: Pick<ModelContextCapability, 'contextWindow' | 'source' | 'confidence'>): string[] {
  const labels = [formatContextWindowShort(capability.contextWindow)]
  if (capability.source === 'fallback') {
    labels.push(`ctx fallback ${formatContextWindowShort(capability.contextWindow).replace(' ctx', '')}`)
  } else if (capability.source === 'configured') {
    labels.push('ctx configured')
  } else if (capability.source === 'runtime_discovered') {
    labels.push('ctx runtime')
  } else if (capability.confidence === 'inferred') {
    labels.push('ctx inferred')
  } else {
    labels.push('ctx documented')
  }
  return labels
}

function configuredContextCapability(identity: ModelIdentity): ModelContextCapability | undefined {
  if (typeof identity.contextWindow !== 'number') return undefined
  const source = identity.contextWindowSource ?? 'configured'
  const confidence: ContextWindowConfidence = source === 'runtime_discovered' ? 'verified' : 'unknown'
  const base = {
    contextWindow: identity.contextWindow,
    source,
    confidence,
    labels: [],
    notes: [],
  }
  return {
    ...base,
    labels: formatContextCapabilityLabels(base),
  }
}

export function resolveContextCapability(identity: ModelIdentity): ModelContextCapability {
  const inferred = inferContextCapability(identity)
  const configured = configuredContextCapability(identity)

  if (configured === undefined) {
    return inferred ?? fallbackContextCapability()
  }

  // Treat the historical 32k default on known long-context cloud aliases as
  // stale capability metadata. Preserve all other explicit values.
  if (configured.source === 'configured' && inferred !== undefined && configured.contextWindow === inferred.contextWindow) {
    return inferred
  }

  if (configured.contextWindow === DEFAULT_CONTEXT_WINDOW && inferred !== undefined && inferred.contextWindow > configured.contextWindow) {
    return inferred
  }

  if (configured.source === 'configured' && inferred === undefined && configured.contextWindow === DEFAULT_CONTEXT_WINDOW) {
    return fallbackContextCapability()
  }

  return configured
}

function fallbackContextCapability(): ModelContextCapability {
  const contextWindow = CONSERVATIVE_FALLBACK_CONTEXT_WINDOW
  const short = formatTokenCompact(contextWindow)
  return {
    contextWindow,
    source: 'fallback',
    confidence: 'unknown',
    labels: [`${short} ctx`, `ctx fallback ${short}`],
    notes: ['Unknown model; OwlCoda uses a conservative context budget until config, provider docs, or runtime discovery proves more. If this model is actually smaller, set contextWindow in config to cap it down.'],
  }
}

export function resolveEffectiveContextWindow(identity: ModelIdentity): number {
  return resolveContextCapability(identity).contextWindow
}

export function resolveModelCapabilities(identity: ModelIdentity): ModelCapabilities {
  return {
    context: resolveContextCapability(identity),
    sustainedWork: resolveSustainedWorkCapability(identity),
  }
}

export function resolveSustainedWorkCapability(identity: ModelIdentity): SustainedWorkCapability {
  const haystack = identityHaystack(identity)
  if (!haystack) return UNKNOWN_SUSTAINED_WORK_CAPABILITY

  if (KIMI_IDENTITY_PATTERNS.some(pattern => pattern.test(haystack))) {
    return KIMI_SUSTAINED_WORK_CAPABILITY
  }

  return UNKNOWN_SUSTAINED_WORK_CAPABILITY
}

export function isDefaultModelEligible(identity: ModelIdentity): boolean {
  return resolveSustainedWorkCapability(identity).defaultEligible
}

export function isAutomaticFallbackEligible(identity: ModelIdentity): boolean {
  return resolveSustainedWorkCapability(identity).automaticFallbackEligible
}
