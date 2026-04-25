/**
 * Local platform preflight — check router and backend health before launch.
 * Reuse-first: never restart or kill healthy services.
 */

import { get as httpGet } from 'node:http'
import type { OwlCodaConfig } from './config.js'
import { probeRuntimeSurface } from './runtime-probe.js'
import { requiresResolvedLocalRuntimeProtocol } from './model-registry.js'
import { ModelTruthAggregator, type ModelStatus } from './model-truth.js'

export type PreflightStatus = 'healthy_reused' | 'missing' | 'degraded' | 'blocked'

export interface ServiceCheck {
  name: string
  url: string
  status: PreflightStatus
  detail: string
  responseTimeMs?: number
}

export interface PreflightResult {
  router: ServiceCheck
  backends: ServiceCheck[]
  overall: PreflightStatus
  canProceed: boolean
  summary: string
}

interface RunPreflightOptions {
  skipCache?: boolean
  modelTruth?: ModelTruthAggregator
}

function httpProbe(url: string, timeoutMs: number = 3000): Promise<{ ok: boolean; statusCode?: number; body?: string; timeMs: number }> {
  const start = Date.now()
  return new Promise(resolve => {
    const req = httpGet(url, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          ok: (res.statusCode ?? 500) < 400,
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf-8'),
          timeMs: Date.now() - start,
        })
      })
    })
    req.on('error', () => {
      resolve({ ok: false, timeMs: Date.now() - start })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ ok: false, timeMs: Date.now() - start })
    })
  })
}

/**
 * Check router health by probing /healthz.
 */
export async function checkRouterHealth(routerUrl: string, config?: OwlCodaConfig): Promise<ServiceCheck> {
  const runtimeProbe = await probeRuntimeSurface(routerUrl, 3000)
  if (runtimeProbe.ok) {
    const unresolvedAutoProtocol = config
      ? config.models.some(model => requiresResolvedLocalRuntimeProtocol(config, model.id))
      : false
    if (config && runtimeProbe.localRuntimeProtocol) {
      config.localRuntimeProtocol = runtimeProbe.localRuntimeProtocol
    }
    if (runtimeProbe.source === 'loaded_inventory_only') {
      return {
        name: 'Local runtime',
        url: routerUrl,
        status: 'blocked',
        detail: runtimeProbe.detail,
      }
    }
    if (runtimeProbe.source === 'healthz' && unresolvedAutoProtocol) {
      return {
        name: 'Local runtime',
        url: routerUrl,
        status: 'blocked',
        detail: 'Reachable only via /healthz; runtime protocol unresolved. Expose /v1/openai/models (owlmlx) or /v1/models (generic OpenAI runtimes), or set localRuntimeProtocol explicitly.',
      }
    }
    return {
      name: 'Local runtime',
      url: routerUrl,
      status: 'healthy_reused',
      detail: `Healthy via ${runtimeProbe.source} (${runtimeProbe.detail})`,
    }
  }
  const probe = await httpProbe(`${routerUrl}/healthz`)
  return {
    name: 'Local runtime',
    url: routerUrl,
    status: 'missing',
    detail: `Not reachable at ${routerUrl}. Start the local runtime and expose its formal visibility surface.`,
    responseTimeMs: probe.timeMs,
  }
}

/**
 * Check if a specific backend model is available via the router's /v1/models endpoint.
 * If router is down, marks as degraded instead of checking directly.
 */
export async function checkBackendModel(
  routerUrl: string,
  backendModel: string,
  routerHealthy: boolean,
  config?: OwlCodaConfig,
): Promise<ServiceCheck> {
  if (!routerHealthy) {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'degraded',
      detail: 'Cannot verify — local runtime is down',
    }
  }

  const runtimeProbe = await probeRuntimeSurface(routerUrl, 3000)
  if (!runtimeProbe.ok) {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'degraded',
      detail: 'Runtime surface not responding',
    }
  }
  if (config && runtimeProbe.localRuntimeProtocol) {
    config.localRuntimeProtocol = runtimeProbe.localRuntimeProtocol
  }
  if (runtimeProbe.source === 'healthz' && config && requiresResolvedLocalRuntimeProtocol(config, backendModel)) {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'blocked',
      detail: 'Runtime liveness confirmed, but the local runtime protocol is unresolved for local model routing',
    }
  }
  if (runtimeProbe.source === 'loaded_inventory_only') {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'blocked',
      detail: 'Loaded inventory is reachable, but no formal visibility surface is available',
    }
  }
  const found = runtimeProbe.modelIds.includes(backendModel)
  if (found) {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'healthy_reused',
      detail: `Model available via ${runtimeProbe.source}${runtimeProbe.source === 'deprecated_router_models' ? ' (deprecated router fallback)' : ''}`,
    }
  }
  const availability = runtimeProbe.modelIds.slice(0, 5).join(', ')
  return {
    name: `Backend (${backendModel})`,
    url: routerUrl,
    status: 'degraded',
    detail: runtimeProbe.modelIds.length > 0
      ? `Model "${backendModel}" not listed in the runtime visibility surface. Available: ${availability}${runtimeProbe.modelIds.length > 5 ? '...' : ''}`
      : `Runtime surface reachable via ${runtimeProbe.source}, but no formal visibility inventory is exposed`,
  }
}

/**
 * Run full preflight check: router + all configured backend models.
 */
export async function runPreflight(
  config: OwlCodaConfig,
  options: RunPreflightOptions = {},
): Promise<PreflightResult> {
  const {
    router,
    backends,
    overall,
    summary,
    canProceed,
  } = await runPreflightWithTruth(config, options)

  return { router, backends, overall, summary, canProceed }
}

async function runPreflightWithTruth(
  config: OwlCodaConfig,
  options: RunPreflightOptions = {},
): Promise<PreflightResult> {
  const aggregator = options.modelTruth ?? new ModelTruthAggregator(() => config, {
    ttlMs: 5_000,
    routerProbeTimeoutMs: 3_000,
    discoveryTimeoutMs: 3_000,
  })
  const snapshot = await aggregator.getSnapshot({ skipCache: options.skipCache })

  if (snapshot.runtimeOk && snapshot.runtimeLocalProtocol) {
    config.localRuntimeProtocol = snapshot.runtimeLocalProtocol
  }

  const localModels = config.models.filter(model => !model.endpoint)
  const cloudModels = config.models.filter(model => model.endpoint)
  const backendModels = [...new Set(localModels.map(model => model.backendModel))]

  const unresolvedProtocol = config.models.some(model => requiresResolvedLocalRuntimeProtocol(config, model.id))
  const router: ServiceCheck = buildRouterCheckFromSnapshot(snapshot, config.routerUrl, unresolvedProtocol)

  const backends: ServiceCheck[] = []

  const statusByConfigId = new Map<string, ModelStatus>()
  for (const status of snapshot.statuses) {
    if (status.raw.config?.id) {
      statusByConfigId.set(status.raw.config.id, status)
    }
  }

  for (const bm of backendModels) {
    let modelStatus: ModelStatus | undefined
    for (const status of snapshot.statuses) {
      if (status.raw.config?.backendModel === bm) {
        modelStatus = status
        break
      }
    }
    if (!modelStatus) {
      // Fallback by direct id (handles older local configs)
      modelStatus = statusByConfigId.get(bm)
    }
    const check = checkBackendModelFromTruth(config.routerUrl, bm, router, modelStatus)
    backends.push(check)
  }

  // Cloud endpoint models: mark as healthy (direct endpoint, no router needed)
  for (const cm of cloudModels) {
    backends.push({
      name: `Cloud (${cm.id})`,
      url: cm.endpoint!,
      status: 'healthy_reused',
      detail: `Direct endpoint → ${cm.endpoint}`,
    })
  }

  let overall: PreflightStatus = 'healthy_reused'
  if (router.status === 'missing' || router.status === 'blocked') {
    overall = 'blocked'
  } else if (backends.some(entry => entry.status === 'missing')) {
    overall = 'blocked'
  } else if (backends.some(entry => entry.status === 'blocked')) {
    overall = 'blocked'
  } else if (backends.some(entry => entry.status === 'degraded')) {
    overall = 'degraded'
  }

  const canProceed = overall !== 'blocked'
  const summary = buildPreflightSummary(router, overall, backends.length)

  return {
    router,
    backends,
    overall,
    canProceed,
    summary,
  }
}

function buildRouterCheckFromSnapshot(
  snapshot: {
    runtimeOk: boolean
    runtimeSource: string | null
    runtimeProbeDetail: string
    runtimeModelCount: number
    platformVisibility?: { deprecatedFallback?: boolean } | null
  },
  routerUrl: string,
  unresolvedProtocol: boolean,
): ServiceCheck {
  if (!snapshot.runtimeOk) {
    return {
      name: 'Local runtime',
      url: routerUrl,
      status: 'missing',
      detail: 'Not reachable at runtime path. Start the local runtime and expose its formal visibility surface.',
    }
  }

  const sourceLabel = snapshot.runtimeSource ?? 'runtime'
  if (sourceLabel === 'loaded_inventory_only') {
    return {
      name: 'Local runtime',
      url: routerUrl,
      status: 'blocked',
      detail: snapshot.runtimeProbeDetail,
    }
  }
  if (sourceLabel === 'healthz' && unresolvedProtocol) {
    return {
      name: 'Local runtime',
      url: routerUrl,
      status: 'blocked',
      detail: 'Reachable only via /healthz; runtime protocol unresolved. Expose /v1/openai/models (owlmlx) or /v1/models (generic OpenAI runtimes), or set localRuntimeProtocol explicitly.',
    }
  }

  const detail = sourceLabel === 'runtime_status'
    || sourceLabel === 'models'
    || sourceLabel === 'openai_models'
    || sourceLabel === 'deprecated_router_models'
    || sourceLabel === 'healthz'
    ? `Healthy via ${sourceLabel}${snapshot.platformVisibility?.deprecatedFallback ? ' (deprecated fallback)' : ''} (${snapshot.runtimeProbeDetail})`
    : `Healthy via ${sourceLabel}`

  return {
    name: 'Local runtime',
    url: routerUrl,
    status: 'healthy_reused',
    detail,
  }
}

function checkBackendModelFromTruth(
  routerUrl: string,
  backendModel: string,
  router: ServiceCheck,
  modelStatus: ModelStatus | undefined,
): ServiceCheck {
  if (router.status !== 'healthy_reused') {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: router.status === 'missing' ? 'degraded' : router.status,
      detail: router.status === 'blocked'
        ? 'Runtime visibility surface unavailable.'
        : 'Cannot verify — local runtime is unavailable',
    }
  }

  if (!modelStatus) {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'degraded',
      detail: 'Model is not tracked in truth snapshot.',
    }
  }

  if (modelStatus.availability.kind === 'ok') {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'healthy_reused',
      detail: 'Model available in runtime visibility surface',
    }
  }

  if (modelStatus.availability.kind === 'router_missing') {
    return {
      name: `Backend (${backendModel})`,
      url: routerUrl,
      status: 'degraded',
      detail: modelStatus.availability.reason ?? 'Model not listed in runtime surface',
    }
  }

  return {
    name: `Backend (${backendModel})`,
    url: routerUrl,
    status: modelStatus.availability.kind === 'warming' ? 'degraded' : 'degraded',
    detail: modelStatus.availability.kind === 'unknown'
      ? (modelStatus.availability.reason ?? 'Model availability is unknown')
      : modelStatus.availability.kind === 'missing_key'
        ? 'Missing credentials'
        : modelStatus.availability.kind === 'alias_conflict'
          ? 'Model aliases conflict in configuration'
          : modelStatus.availability.kind === 'orphan_discovered'
            ? 'Model discovered locally but not configured'
            : modelStatus.availability.kind === 'endpoint_down'
              ? `Endpoint unavailable: ${modelStatus.availability.reason}`
              : `Model unavailable: ${modelStatus.availability.kind}`,
  }
}

function buildPreflightSummary(router: ServiceCheck, overall: PreflightStatus, totalBackends: number): string {
  if (overall === 'healthy_reused') {
    return 'All local services healthy — reusing existing infrastructure'
  }
  if (overall === 'degraded') {
    return totalBackends > 0
      ? 'Some backend models may not be available — proceeding with available models'
      : 'Local runtime is reachable but no local models are healthy'
  }
  return `Cannot proceed: ${router.status === 'missing'
    ? 'Local runtime not reachable'
    : router.status === 'blocked'
      ? 'Runtime visibility surface unavailable'
      : 'Critical backend missing'}`
}

/**
 * Format preflight results for CLI output.
 * Collapses unavailable models into a summary line to reduce noise.
 */
export function formatPreflightForCli(result: PreflightResult): string {
  const lines: string[] = ['Platform preflight:']

  const icon = (s: PreflightStatus) => {
    switch (s) {
      case 'healthy_reused': return '✓'
      case 'degraded': return '⚠'
      case 'missing': return '✗'
      case 'blocked': return '✗'
    }
  }

  lines.push(`  ${icon(result.router.status)} ${result.router.name}: ${result.router.detail}`)

  // Separate healthy vs degraded backends
  const healthy = result.backends.filter(b => b.status === 'healthy_reused')
  const degraded = result.backends.filter(b => b.status !== 'healthy_reused')

  for (const b of healthy) {
    lines.push(`  ${icon(b.status)} ${b.name}: ${b.detail}`)
  }

  // Collapse degraded/unavailable into a single summary
  if (degraded.length > 0) {
    const names = degraded.map(b => {
      const match = b.name.match(/\((.+)\)/)
      return match ? match[1] : b.name
    })
    if (degraded.length <= 2) {
      // Show individually if only 1-2
      for (const b of degraded) {
        lines.push(`  ${icon(b.status)} ${b.name}: ${b.detail}`)
      }
    } else {
      // Collapse 3+ into summary
      lines.push(`  ⚠ ${degraded.length} models not visible: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}`)
    }
  }

  lines.push('')
  if (healthy.length > 0) {
    lines.push(`  → ${healthy.length} model(s) available${degraded.length > 0 ? `, ${degraded.length} not visible` : ''}`)
  } else {
    lines.push(`  → ${result.summary}`)
  }

  return lines.join('\n')
}
