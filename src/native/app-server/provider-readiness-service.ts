import { resolveModelRoute, type ConfiguredModel, type OwlCodaConfig } from '../../config.js'
import { isLoopbackEndpoint } from '../../endpoints/headers-timeout.js'

export type AppServerProviderAvailability = 'available' | 'unavailable' | 'unknown'

export interface AppServerProviderReadiness {
  id: string
  availability: AppServerProviderAvailability
  unavailableReason?: string
}

export interface AppServerProviderReadinessResult {
  defaultModelId: string | null
  models: AppServerProviderReadiness[]
}

export type AppServerModelOrigin = 'cloud' | 'local' | 'unknown'

export function classifyAppServerModelOrigin(endpoint: string | undefined): AppServerModelOrigin {
  if (!endpoint) return 'unknown'
  try {
    return isLoopbackEndpoint(endpoint) ? 'local' : 'cloud'
  } catch {
    return 'unknown'
  }
}

export function resolveAppServerModelOrigin(
  config: OwlCodaConfig | undefined,
  model: ConfiguredModel,
): AppServerModelOrigin {
  if (!config) return classifyAppServerModelOrigin(model.endpoint)
  try {
    return classifyAppServerModelOrigin(resolveModelRoute(config, model.id).endpointUrl)
  } catch {
    return classifyAppServerModelOrigin(model.endpoint)
  }
}

export function resolveAppServerProviderReadiness(
  config: OwlCodaConfig | undefined,
): AppServerProviderReadinessResult {
  if (!config) return { defaultModelId: null, models: [] }
  const models = config.models.map(model => readinessForModel(config, model))
  const explicitDefault = config.models.find(model =>
    model.default && models.find(candidate => candidate.id === model.id)?.availability === 'available'
  )
  const defaultModelId = explicitDefault?.id
    ?? models.find(model => model.availability === 'available')?.id
    ?? null
  return { defaultModelId, models }
}

function readinessForModel(
  config: OwlCodaConfig,
  model: ConfiguredModel,
): AppServerProviderReadiness {
  if (model.availability === 'unavailable') {
    return {
      id: model.id,
      availability: 'unavailable',
      unavailableReason: 'Unavailable by configuration.',
    }
  }
  if (model.availability === 'available') {
    return { id: model.id, availability: 'available' }
  }
  try {
    resolveModelRoute(config, model.id)
    return { id: model.id, availability: 'available' }
  } catch {
    return {
      id: model.id,
      availability: 'unknown',
      unavailableReason: 'Runtime route is not configured.',
    }
  }
}
