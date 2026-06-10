/**
 * Model warmup — send a lightweight probe to each configured model at startup
 * to pre-load weights into memory and reduce first-request latency.
 *
 * Only warms models that have direct endpoints (discovered backends).
 * Router models are already expected to be warm.
 */

import type { OwlCodaConfig, ConfiguredModel } from './config.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  formatProviderDiagnostic,
  upstreamRequestIdFromHeaders,
} from './provider-error.js'

export interface WarmupResult {
  modelId: string
  backendModel: string
  status: 'warm' | 'failed' | 'skipped'
  latencyMs: number
  error?: string
}

/**
 * Warm up a single model by sending a tiny completion request.
 */
async function warmModel(model: ConfiguredModel, timeoutMs = 10_000): Promise<WarmupResult> {
  if (!model.endpoint) {
    return { modelId: model.id, backendModel: model.backendModel, status: 'skipped', latencyMs: 0 }
  }

  const start = Date.now()
  try {
    const res = await fetch(model.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { 'Authorization': `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.backendModel,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const latencyMs = Date.now() - start
    if (res.ok) {
      // Drain body to free resources
      await res.text()
      return { modelId: model.id, backendModel: model.backendModel, status: 'warm', latencyMs }
    }
    const diagnostic = createProviderHttpDiagnostic(res.status, await res.text(), {
      model: model.id,
      endpointUrl: model.endpoint,
      headers: model.headers,
      upstreamRequestId: upstreamRequestIdFromHeaders(res.headers),
    })
    return {
      modelId: model.id,
      backendModel: model.backendModel,
      status: 'failed',
      latencyMs,
      error: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
    }
  } catch (err) {
    const diagnostic = classifyProviderRequestError(err, {
      model: model.id,
      endpointUrl: model.endpoint,
      headers: model.headers,
    })
    return {
      modelId: model.id,
      backendModel: model.backendModel,
      status: 'failed',
      latencyMs: Date.now() - start,
      error: formatProviderDiagnostic(diagnostic, { includeRequestId: true }),
    }
  }
}

/**
 * Warm up all configured models with direct endpoints.
 * Runs in parallel with limited concurrency.
 */
export async function warmupModels(
  config: OwlCodaConfig,
  opts?: { concurrency?: number; timeoutMs?: number },
): Promise<WarmupResult[]> {
  const concurrency = opts?.concurrency ?? 3
  const timeoutMs = opts?.timeoutMs ?? 10_000
  const models = config.models.filter(m => m.endpoint)

  if (models.length === 0) return []

  const results: WarmupResult[] = []
  // Process in batches of concurrency
  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map(m => warmModel(m, timeoutMs))
    )
    results.push(...batchResults)
  }

  return results
}

/**
 * Format warmup results for console logging.
 */
export function formatWarmupResults(results: WarmupResult[]): string {
  if (results.length === 0) return 'No models to warm up'

  const warm = results.filter(r => r.status === 'warm')
  const failed = results.filter(r => r.status === 'failed')

  const lines: string[] = [`Model warmup: ${warm.length}/${results.length} ready`]

  for (const r of warm) {
    lines.push(`  ✓ ${r.modelId} (${r.latencyMs}ms)`)
  }
  for (const r of failed) {
    lines.push(`  ✗ ${r.modelId}: ${r.error ?? 'unknown error'}`)
  }

  return lines.join('\n')
}
