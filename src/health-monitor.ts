/**
 * Background health monitor — proactively checks model availability.
 * Runs at configurable interval, caches results for fast lookups.
 */

import type { OwlCodaConfig } from './config.js'
import { logWarn } from './logger.js'
import { probeRuntimeSurface } from './runtime-probe.js'

export interface ModelHealthStatus {
  status: 'healthy' | 'unhealthy' | 'unknown'
  lastCheck: string
  latencyMs: number
}

const healthCache = new Map<string, ModelHealthStatus>()
let monitorInterval: ReturnType<typeof setInterval> | null = null
let configRef: OwlCodaConfig | null = null

async function probeModel(routerUrl: string, modelId: string): Promise<ModelHealthStatus> {
  const start = Date.now()
  try {
    const probe = await probeRuntimeSurface(routerUrl, 5000)
    if (!probe.ok) {
      return { status: 'unhealthy', lastCheck: new Date().toISOString(), latencyMs: Date.now() - start }
    }
    if (probe.source === 'loaded_inventory_only' || probe.source === 'runtime_status' || probe.source === 'healthz') {
      return { status: 'unknown', lastCheck: new Date().toISOString(), latencyMs: Date.now() - start }
    }
    const found = probe.modelIds.includes(modelId)
    return {
      status: found ? 'healthy' : 'unhealthy',
      lastCheck: new Date().toISOString(),
      latencyMs: Date.now() - start,
    }
  } catch {
    return { status: 'unhealthy', lastCheck: new Date().toISOString(), latencyMs: Date.now() - start }
  }
}

let probeInProgress = false

async function runHealthCheck(): Promise<void> {
  if (!configRef || probeInProgress) return
  probeInProgress = true
  try {
    for (const model of configRef.models) {
      // Cloud endpoint models: don't probe /v1/models — cloud providers
      // (minimax, anthropic, etc.) don't serve that endpoint.
      // Mark as passive 'unknown' to avoid false unhealthy.
      if (model.endpoint) {
        healthCache.set(model.id, {
          status: 'unknown',
          lastCheck: new Date().toISOString(),
          latencyMs: 0,
        })
        continue
      }

      const probeUrl = configRef.routerUrl
      const status = await probeModel(probeUrl, model.backendModel)
      healthCache.set(model.id, status)
    }
    // Prune entries for models no longer in config
    for (const key of healthCache.keys()) {
      if (!configRef.models.some(m => m.id === key)) {
        healthCache.delete(key)
      }
    }
  } finally {
    probeInProgress = false
  }
}

export function startHealthMonitor(config: OwlCodaConfig, intervalMs = 60_000): void {
  if (monitorInterval) return
  configRef = config

  // Initial check
  runHealthCheck().catch(e => logWarn('health', `Initial health check failed: ${e}`))

  monitorInterval = setInterval(() => {
    runHealthCheck().catch(e => logWarn('health', `Periodic health check failed: ${e}`))
  }, intervalMs)
  monitorInterval.unref() // Don't keep process alive

  console.error(`[health] Monitor started (interval: ${intervalMs / 1000}s)`)
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
  configRef = null
}

export function getModelHealth(modelId: string): ModelHealthStatus {
  return healthCache.get(modelId) ?? { status: 'unknown', lastCheck: '', latencyMs: 0 }
}

export function getAllModelHealth(): Record<string, ModelHealthStatus> {
  return Object.fromEntries(healthCache)
}

export function isModelHealthy(modelId: string): boolean {
  const h = healthCache.get(modelId)
  return !h || h.status !== 'unhealthy' // unknown counts as maybe-healthy
}

/**
 * Reset cache (for testing).
 */
export function resetHealthCache(): void {
  healthCache.clear()
  stopHealthMonitor()
}
