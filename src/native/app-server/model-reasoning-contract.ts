import { resolveModelRoute, type ConfiguredModel, type OwlCodaConfig } from '../../config.js'
import { normalizeProviderKind } from '../../provider-kind.js'
import type { ReasoningEffort } from '../protocol/types.js'

export const REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high'] as const satisfies readonly ReasoningEffort[]

export interface AppServerReasoningEffortContract {
  default: ReasoningEffort
  options: ReasoningEffort[]
}

export type AppServerModelSelectionValidation =
  | { ok: true; model?: ConfiguredModel }
  | { ok: false; reason: 'unknown_model' | 'model_unavailable' }

const CLAUDE_EXTENDED_THINKING_MODELS = [
  /\bclaude[-_.\s]?(?:3[-_.\s]?7[-_.\s]?sonnet|(?:sonnet|opus|haiku)[-_.\s]?4(?:[-_.\s]\d+)?|4(?:[-_.\s]\d+)?[-_.\s]?(?:sonnet|opus|haiku))\b/i,
]

export function findConfiguredAppServerModel(
  config: OwlCodaConfig | undefined,
  modelId: string | undefined,
): ConfiguredModel | undefined {
  if (!modelId) return undefined
  return config?.models.find(candidate =>
    candidate.id === modelId
    || candidate.backendModel === modelId
    || candidate.aliases.includes(modelId),
  )
}

export function validateConfiguredAppServerModelSelection(
  config: OwlCodaConfig | undefined,
  modelId: string | undefined,
): AppServerModelSelectionValidation {
  if (!config || config.models.length === 0 || !modelId) return { ok: true }
  const model = findConfiguredAppServerModel(config, modelId)
  if (!model) return { ok: false, reason: 'unknown_model' }
  if (model.availability === 'unavailable') return { ok: false, reason: 'model_unavailable' }
  return { ok: true, model }
}

export function resolveReasoningEffortContract(
  config: OwlCodaConfig | undefined,
  model: ConfiguredModel | undefined,
): AppServerReasoningEffortContract | undefined {
  if (!config || !model || model.availability === 'unavailable') return undefined
  if (normalizeProviderKind(model) !== 'anthropic') return undefined
  if (!CLAUDE_EXTENDED_THINKING_MODELS.some(pattern => pattern.test(modelIdentity(model)))) return undefined

  try {
    if (resolveModelRoute(config, model.id).translate) return undefined
  } catch {
    return undefined
  }

  return {
    default: 'medium',
    options: [...REASONING_EFFORT_OPTIONS],
  }
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined
}

function modelIdentity(model: ConfiguredModel): string {
  return [model.id, model.backendModel, model.label, ...model.aliases].join(' ')
}
