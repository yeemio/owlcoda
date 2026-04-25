/**
 * Backend auto-discovery — probes known local LLM backends in parallel
 * and returns a unified list of discovered models.
 *
 * Usage:
 *   const result = await discoverBackends()
 *   // result.models — all discovered models
 *   // result.reachableBackends — which backends responded
 */

import type { BackendAdapter, BackendConfig, BackendType, DiscoveredModel, DiscoveryResult } from './types.js'
import { OllamaAdapter } from './ollama.js'
import { LMStudioAdapter } from './lmstudio.js'
import { VLLMAdapter } from './vllm.js'

/** Default backends to probe when no explicit config is given */
const DEFAULT_BACKENDS: BackendType[] = ['ollama', 'lmstudio', 'vllm']

/**
 * Create an adapter instance for a given backend config.
 */
export function createAdapter(config: BackendConfig): BackendAdapter {
  switch (config.type) {
    case 'ollama':
      return new OllamaAdapter(config.baseUrl)
    case 'lmstudio':
      return new LMStudioAdapter(config.baseUrl)
    case 'vllm':
      return new VLLMAdapter(config.baseUrl)
    case 'openai-compat':
      // Generic OpenAI-compatible — use LM Studio adapter (same protocol)
      return new LMStudioAdapter(config.baseUrl ?? 'http://127.0.0.1:8080')
    default:
      throw new Error(`Unknown backend type: ${config.type}`)
  }
}

/**
 * Discover all models from configured backends.
 * Probes all backends in parallel and returns a unified result.
 */
export async function discoverBackends(
  configs?: BackendConfig[],
  timeoutMs = 5000,
): Promise<DiscoveryResult> {
  const start = Date.now()

  // If no configs given, use defaults
  const backendConfigs = configs ?? DEFAULT_BACKENDS.map(type => ({
    type,
    enabled: true,
  }))

  // Filter to enabled backends
  const enabled = backendConfigs.filter(c => c.enabled !== false)
  const adapters = enabled.map(c => createAdapter(c))

  // Probe all in parallel
  const results = await Promise.allSettled(
    adapters.map(async (adapter): Promise<{ adapter: BackendAdapter; models: DiscoveredModel[] }> => {
      const reachable = await adapter.isReachable(timeoutMs)
      if (!reachable) return { adapter, models: [] }
      const models = await adapter.discover(timeoutMs)
      return { adapter, models }
    }),
  )

  const allModels: DiscoveredModel[] = []
  const reachable: BackendType[] = []
  const unreachable: BackendType[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { adapter, models } = result.value
      if (models.length > 0) {
        reachable.push(adapter.name)
        allModels.push(...models)
      } else {
        unreachable.push(adapter.name)
      }
    } else {
      // Promise rejected — shouldn't happen since we catch inside, but be safe
      unreachable.push('ollama') // can't know which one
    }
  }

  return {
    models: allModels,
    reachableBackends: reachable,
    unreachableBackends: unreachable,
    durationMs: Date.now() - start,
  }
}

/**
 * Quick check: is any local backend reachable?
 * Useful for preflight checks.
 */
export async function anyBackendReachable(timeoutMs = 2000): Promise<boolean> {
  const adapters = DEFAULT_BACKENDS.map(type => createAdapter({ type }))
  const results = await Promise.allSettled(
    adapters.map(a => a.isReachable(timeoutMs)),
  )
  return results.some(r => r.status === 'fulfilled' && r.value === true)
}
