/**
 * Config hot-reload — watch config.json for changes, apply validated updates.
 * Uses fs.watchFile for cross-platform reliability.
 */

import { watchFile, unwatchFile, readFileSync } from 'node:fs'
import type { OwlCodaConfig } from './config.js'
import { normalizeModel, appendBuiltinEndpointModels } from './config.js'
import { getOwlcodaConfigPath } from './paths.js'
import { configureCircuitBreaker } from './middleware/circuit-breaker.js'
import { setSloTarget } from './error-budget.js'
import { logInfo, logWarn, logError } from './logger.js'
import { validateConfig as validateSchema } from './config-validate.js'

let watching = false

export interface ConfigWatcherOptions {
  onReload?: () => void
}

function validateConfig(raw: unknown): string | null {
  const result = validateSchema(raw)
  if (!result.valid) {
    // Log all warnings but only block on critical shape errors
    for (const err of result.errors) {
      logWarn('config-watcher', `Validation: ${err}`)
    }
    if (!raw || typeof raw !== 'object') return 'Config must be a JSON object'
  }
  return null
}

export function applyReloadableFields(config: OwlCodaConfig, raw: Record<string, unknown>): string[] {
  const applied: string[] = []

  // Only reload safe fields — port/host require restart
  if (raw.routerTimeoutMs !== undefined && typeof raw.routerTimeoutMs === 'number') {
    config.routerTimeoutMs = raw.routerTimeoutMs
    applied.push('routerTimeoutMs')
  }
  if (raw.localRuntimeProtocol !== undefined) {
    const protocol = raw.localRuntimeProtocol as string
    if (protocol === 'auto' || protocol === 'openai_chat' || protocol === 'anthropic_messages') {
      config.localRuntimeProtocol = protocol
      applied.push('localRuntimeProtocol')
    }
  }
  if (raw.logLevel !== undefined) {
    config.logLevel = raw.logLevel as OwlCodaConfig['logLevel']
    applied.push('logLevel')
  }
  if (raw.responseModelStyle !== undefined) {
    const style = raw.responseModelStyle as string
    config.responseModelStyle = (
      style === 'owlcoda' || style === 'compatibility_alias'
        ? 'platform'
        : style
    ) as OwlCodaConfig['responseModelStyle']
    applied.push('responseModelStyle')
  }
  if (Array.isArray(raw.models) && raw.models.length > 0) {
    config.models = (raw.models as Record<string, unknown>[]).map(normalizeModel)
    appendBuiltinEndpointModels(config)
    applied.push(`models (${raw.models.length} entries)`)
  }
  if (raw.middleware && typeof raw.middleware === 'object') {
    config.middleware = raw.middleware as OwlCodaConfig['middleware']
    applied.push('middleware')

    // Apply circuit breaker config changes immediately
    const mw = config.middleware
    if (mw.circuitBreakerThreshold != null || mw.circuitBreakerCooldownMs != null) {
      configureCircuitBreaker({
        ...(mw.circuitBreakerThreshold != null ? { threshold: mw.circuitBreakerThreshold } : {}),
        ...(mw.circuitBreakerCooldownMs != null ? { cooldownMs: mw.circuitBreakerCooldownMs } : {}),
      })
    }
    if (mw.sloTargetPercent != null) {
      setSloTarget(mw.sloTargetPercent / 100)
    }
  }
  if (raw.adminToken !== undefined && typeof raw.adminToken === 'string') {
    config.adminToken = raw.adminToken
    applied.push('adminToken')
  }

  return applied
}

export function startConfigWatcher(config: OwlCodaConfig, options: ConfigWatcherOptions = {}): void {
  if (watching) return

  const configPath = getOwlcodaConfigPath()

  watchFile(configPath, { interval: 3000 }, () => {
    try {
      const content = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content)

      const error = validateConfig(parsed)
      if (error) {
        logError('config', 'Hot-reload rejected', { error })
        return
      }

      const applied = applyReloadableFields(config, parsed)
      if (applied.length > 0) {
        options.onReload?.()
        logInfo('config', 'Hot-reload applied', { fields: applied })
      }
    } catch (err) {
      logError('config', 'Hot-reload failed', { error: err instanceof Error ? err.message : String(err) })
    }
  })

  watching = true
  logInfo('config', 'Watching for config changes')
}

export function stopConfigWatcher(): void {
  if (!watching) return
  try {
    const configPath = getOwlcodaConfigPath()
    unwatchFile(configPath)
  } catch { /* ignore */ }
  watching = false
}

export function isConfigWatching(): boolean {
  return watching
}
