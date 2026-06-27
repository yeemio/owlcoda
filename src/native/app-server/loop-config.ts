import type { ConversationLoopOptions } from '../conversation.js'
import {
  getPreferredInteractiveConfiguredModel,
  resolveModelContextWindow,
  type OwlCodaConfig,
} from '../../config.js'
import { getBaseUrl } from '../../daemon.js'

export type AppServerLoopConfigResult =
  | {
      ok: true
      model: string
      loopOptions: Pick<ConversationLoopOptions, 'apiBaseUrl' | 'apiKey'> & Partial<ConversationLoopOptions>
    }
  | {
      ok: false
      reason: 'no_interactive_model'
      message: string
    }

export function resolveAppServerLoopConfig(config: OwlCodaConfig, modelId?: string): AppServerLoopConfigResult {
  const model = modelId
    ? config.models.find(candidate => candidate.id === modelId || candidate.aliases.includes(modelId))
    : getPreferredInteractiveConfiguredModel(config)

  if (!model) {
    return {
      ok: false,
      reason: 'no_interactive_model',
      message: 'No usable OwlCoda model is configured for App Server loop execution.',
    }
  }

  return {
    ok: true,
    model: model.id,
    loopOptions: {
      apiBaseUrl: getBaseUrl(config),
      apiKey: `owlcoda-local-key-${config.port}`,
      contextWindow: resolveModelContextWindow(config, model.id),
      compactionModel: config.middleware?.compactionModel,
      compactionInputMaxTokens: config.middleware?.compactionInputMaxTokens,
      requestTimeoutMs: config.middleware?.requestTimeoutMs,
    },
  }
}
