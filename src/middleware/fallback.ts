/**
 * Model fallback chain — when primary model fails, try alternatives.
 * Only falls back on 5xx/connection errors, never on 4xx.
 */

import type { OwlCodaConfig, ConfiguredModel } from '../config.js'

export interface FallbackResult {
  response: Response
  servedBy: string
  fallbackUsed: boolean
  attemptedModels: string[]
}

/**
 * Build an ordered fallback chain starting with the requested model,
 * followed by other configured models sorted by:
 *   1. Models on different backends first (cross-provider resilience)
 *   2. Tier priority within same-backend group
 */
export function buildFallbackChain(config: OwlCodaConfig, requestedModel: string): string[] {
  const chain: string[] = [requestedModel]
  const tierPriority: Record<string, number> = {
    production: 0,
    balanced: 1,
    fast: 2,
    heavy: 3,
    general: 4,
    discovered: 5,
    embedding: 99,
  }

  // Find the primary model's endpoint to detect same-backend models
  const primary = config.models.find(m => m.id === requestedModel || m.backendModel === requestedModel)
  const primaryEndpoint = primary?.endpoint ?? ''

  const others = config.models
    .filter(m => m.id !== requestedModel && m.backendModel !== requestedModel)
    .filter(m => !m.tier?.toLowerCase().includes('embedding'))

  // Separate into different-backend and same-backend groups
  const diffBackend = others.filter(m => (m.endpoint ?? '') !== primaryEndpoint)
  const sameBackend = others.filter(m => (m.endpoint ?? '') === primaryEndpoint)

  const byTier = (a: ConfiguredModel, b: ConfiguredModel) => {
    const pa = tierPriority[a.tier?.toLowerCase() ?? 'balanced'] ?? 50
    const pb = tierPriority[b.tier?.toLowerCase() ?? 'balanced'] ?? 50
    return pa - pb
  }

  // Different-backend models first (cross-provider fallback), then same-backend
  diffBackend.sort(byTier)
  sameBackend.sort(byTier)

  for (const m of diffBackend) chain.push(m.id)
  for (const m of sameBackend) chain.push(m.id)

  return chain
}

function isFallbackableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return msg.includes('timeout') ||
           msg.includes('econnrefused') ||
           msg.includes('econnreset') ||
           msg.includes('fetch failed') ||
           msg.includes('network') ||
           msg.includes('all retry attempts exhausted')
  }
  return false
}

/**
 * Try each model in the chain until one succeeds.
 * fetchFn receives the model ID and should return a Response.
 */
export async function withFallback(
  chain: string[],
  fetchFn: (modelId: string) => Promise<Response>,
  healthFilter?: (modelId: string) => boolean,
): Promise<FallbackResult> {
  const attempted: string[] = []
  let lastError: unknown = null
  let lastResponse: Response | null = null

  for (const modelId of chain) {
    // Skip known-unhealthy models (except the primary — always try it)
    if (attempted.length > 0 && healthFilter && !healthFilter(modelId)) {
      console.error(`[fallback] Skipping ${modelId} — marked unhealthy`)
      continue
    }

    attempted.push(modelId)
    try {
      const response = await fetchFn(modelId)

      // Success or client error — don't fall back
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return {
          response,
          servedBy: modelId,
          fallbackUsed: attempted.length > 1,
          attemptedModels: attempted,
        }
      }

      // Server error — try next model
      lastResponse = response
      console.error(`[fallback] ${modelId} returned ${response.status}, trying next model`)
    } catch (err) {
      if (err && typeof err === 'object' && !('modelId' in err)) {
        Object.assign(err as Record<string, unknown>, { modelId })
      }
      lastError = err
      if (!isFallbackableError(err)) {
        throw err
      }
      console.error(`[fallback] ${modelId} failed (${err instanceof Error ? err.message : 'unknown'}), trying next model`)
    }
  }

  if (lastResponse) {
    return {
      response: lastResponse,
      servedBy: attempted[attempted.length - 1] ?? chain[chain.length - 1] ?? 'unknown',
      fallbackUsed: attempted.length > 1,
      attemptedModels: attempted,
    }
  }

  throw lastError ?? new Error(`All models in fallback chain exhausted: ${attempted.join(' → ')}`)
}
