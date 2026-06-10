/**
 * Localhost runtime discovery — probes the known local-tier provider templates
 * (Ollama, LM Studio, vLLM, owlmlx, ...) at their default localhost endpoints
 * and reports which ones answer. Used by the Local Runtime wizard to surface
 * "we detected X already running on this machine" hints without forcing users
 * to type ports.
 */

import { getProviderTemplates, type ProviderTemplate } from './provider-probe.js'

export interface DiscoveredRuntime {
  templateId: string
  label: string
  endpoint: string
  reachable: boolean
  latencyMs: number
  status?: number
  detail: string
}

export interface LocalhostDiscoveryDeps {
  fetch: typeof globalThis.fetch
  now: () => number
}

export interface LocalhostDiscoveryOptions {
  timeoutMs?: number
  deps?: Partial<LocalhostDiscoveryDeps>
}

const DEFAULT_TIMEOUT_MS = 1500

function defaultDeps(): LocalhostDiscoveryDeps {
  return {
    fetch: globalThis.fetch,
    now: () => Date.now(),
  }
}

function buildDiscoveryUrl(template: ProviderTemplate): string {
  const base = template.endpoint.replace(/\/+$/, '')
  const path = template.testPath ?? '/models'
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

async function probeLocalRuntime(
  template: ProviderTemplate,
  deps: LocalhostDiscoveryDeps,
  timeoutMs: number,
): Promise<DiscoveredRuntime> {
  const url = buildDiscoveryUrl(template)
  const start = deps.now()
  if (!deps.fetch) {
    return {
      templateId: template.id,
      label: template.label,
      endpoint: template.endpoint,
      reachable: false,
      latencyMs: 0,
      detail: `${template.label} not probed: fetch API unavailable`,
    }
  }
  try {
    const response = await deps.fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Math.max(0, deps.now() - start)
    return {
      templateId: template.id,
      label: template.label,
      endpoint: template.endpoint,
      reachable: response.ok,
      latencyMs,
      status: response.status,
      detail: response.ok
        ? `${template.label} reachable at ${url} (HTTP ${response.status})`
        : `${template.label} responded HTTP ${response.status} at ${url}`,
    }
  } catch (err) {
    const latencyMs = Math.max(0, deps.now() - start)
    const message = err instanceof Error ? err.message : 'unreachable'
    return {
      templateId: template.id,
      label: template.label,
      endpoint: template.endpoint,
      reachable: false,
      latencyMs,
      detail: `${template.label} unreachable at ${url}: ${message}`,
    }
  }
}

/**
 * Probe every local-tier provider template at its default endpoint in parallel.
 * Returns one DiscoveredRuntime per local template. Order matches the order
 * local templates appear in PROVIDER_TEMPLATES.
 */
export async function discoverLocalRuntimes(
  options: LocalhostDiscoveryOptions = {},
): Promise<DiscoveredRuntime[]> {
  const deps: LocalhostDiscoveryDeps = { ...defaultDeps(), ...options.deps }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const localTemplates = getProviderTemplates().filter(template => template.tier === 'local')
  return Promise.all(
    localTemplates.map(template => probeLocalRuntime(template, deps, timeoutMs)),
  )
}
