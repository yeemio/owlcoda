export const DEFAULT_CONTEXT_WINDOW = 32_768

type ModelIdentity = {
  id?: string
  label?: string
  backendModel?: string
  aliases?: string[]
  endpoint?: string
}

type ContextCapability = {
  contextWindow: number
  patterns: RegExp[]
}

const KNOWN_CONTEXT_CAPABILITIES: ContextCapability[] = [
  {
    contextWindow: 204_800,
    patterns: [
      /\bminimax-m?27\b/i,
      /\bminimax[-_\s]?m?2\.?7\b/i,
      /\bm27\b/i,
    ],
  },
  {
    contextWindow: 256_000,
    patterns: [
      /\bkimi-code\b/i,
      /\bkimi[-_\s]?for[-_\s]?coding\b/i,
      /\bkimi[-_\s]?k2(?:\.5)?\b/i,
    ],
  },
  {
    contextWindow: 131_072,
    patterns: [
      /\bmoonshot.*128k\b/i,
      /\bgpt-oss-(?:20b|120b)\b/i,
      /\bmistral-(?:large|small)\b/i,
      /\bnemotron\b/i,
    ],
  },
  {
    contextWindow: 40_960,
    patterns: [
      /\bqwen3\b/i,
    ],
  },
  {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    patterns: [
      /\bmirothinker\b/i,
      /\bmoonshot.*32k\b/i,
    ],
  },
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

export function inferContextWindow(identity: ModelIdentity): number | undefined {
  const haystack = identityHaystack(identity)
  if (!haystack) return undefined

  for (const capability of KNOWN_CONTEXT_CAPABILITIES) {
    if (capability.patterns.some(pattern => pattern.test(haystack))) {
      return capability.contextWindow
    }
  }

  return undefined
}

export function resolveEffectiveContextWindow(identity: ModelIdentity & { contextWindow?: number }): number {
  const inferred = inferContextWindow(identity)
  const configured = typeof identity.contextWindow === 'number' ? identity.contextWindow : undefined

  if (configured === undefined) {
    return inferred ?? DEFAULT_CONTEXT_WINDOW
  }

  // Treat the historical 32k default on known long-context cloud aliases as
  // stale capability metadata. Preserve all other explicit values.
  if (configured === DEFAULT_CONTEXT_WINDOW && inferred !== undefined && inferred > configured) {
    return inferred
  }

  return configured
}
