/**
 * GET /v1/backends — discover and list available local LLM backends.
 *
 * Returns a JSON object with:
 *   - backends: array of { name, baseUrl, reachable, models[] }
 *   - totalModels: number
 *   - durationMs: number
 *
 * This is a live probe — it contacts each configured backend in parallel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { discoverBackends } from '../backends/discovery.js'
import type { BackendConfig, BackendType } from '../backends/types.js'
import type { ModelStatus, ModelTruthAggregator } from '../model-truth.js'

interface BackendInfo {
  name: BackendType
  baseUrl: string
  reachable: boolean
  models: Array<{
    id: string
    label: string
    parameterSize?: string
    quantization?: string
    contextWindow?: number
    availability?: string
    configured?: boolean
    discovered?: boolean
  }>
}

function statusToBackendName(status: ModelStatus): BackendType {
  if (status.raw.discovered?.backend) return status.raw.discovered.backend
  return 'openai-compat'
}

export async function handleBackends(
  _req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
  modelTruth?: ModelTruthAggregator,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (modelTruth) {
    const snapshot = await modelTruth.getSnapshot()
    const backendMap = new Map<BackendType, BackendInfo>()
    const configs = config.backends ?? defaultConfigs()

    for (const backend of configs) {
      if (backend.enabled === false) continue
      backendMap.set(backend.type, {
        name: backend.type,
        baseUrl: backend.baseUrl ?? defaultBaseUrl(backend.type),
        reachable: false,
        models: [],
      })
    }

    for (const status of snapshot.statuses) {
      if (status.providerKind !== 'local' && !status.raw.discovered) continue
      const backendName = statusToBackendName(status)
      const existing = backendMap.get(backendName) ?? {
        name: backendName,
        baseUrl: status.raw.discovered?.baseUrl ?? defaultBaseUrl(backendName),
        reachable: false,
        models: [],
      }
      backendMap.set(backendName, existing)
      existing.reachable = existing.reachable || status.presentIn.discovered || status.presentIn.router
      existing.models.push({
        id: status.id,
        label: status.label,
        parameterSize: status.raw.discovered?.parameterSize,
        quantization: status.raw.discovered?.quantization,
        contextWindow: status.raw.discovered?.contextWindow ?? status.raw.config?.contextWindow,
        availability: status.availability.kind,
        configured: status.presentIn.config,
        discovered: status.presentIn.discovered,
      })
    }

    const backends = Array.from(backendMap.values())
    const body = {
      backends,
      totalModels: backends.reduce((sum, backend) => sum + backend.models.length, 0),
      reachableBackends: backends.filter(backend => backend.reachable).map(backend => backend.name),
      unreachableBackends: backends.filter(backend => !backend.reachable).map(backend => backend.name),
      durationMs: 0,
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }

  const configs = config.backends ?? defaultConfigs()
  const result = await discoverBackends(configs, 5000)

  // Group models by backend
  const backendMap = new Map<BackendType, BackendInfo>()
  for (const c of configs) {
    if (c.enabled === false) continue
    backendMap.set(c.type, {
      name: c.type,
      baseUrl: c.baseUrl ?? defaultBaseUrl(c.type),
      reachable: result.reachableBackends.includes(c.type),
      models: [],
    })
  }
  for (const m of result.models) {
    const info = backendMap.get(m.backend)
    if (info) {
      info.models.push({
        id: m.id,
        label: m.label,
        parameterSize: m.parameterSize,
        quantization: m.quantization,
        contextWindow: m.contextWindow,
      })
    }
  }

  const body = {
    backends: Array.from(backendMap.values()),
    totalModels: result.models.length,
    reachableBackends: result.reachableBackends,
    unreachableBackends: result.unreachableBackends,
    durationMs: result.durationMs,
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ─── Defaults ───

function defaultConfigs(): BackendConfig[] {
  return [
    { type: 'ollama', enabled: true },
    { type: 'lmstudio', enabled: true },
    { type: 'vllm', enabled: true },
  ]
}

function defaultBaseUrl(type: BackendType): string {
  switch (type) {
    case 'ollama': return 'http://127.0.0.1:11434'
    case 'lmstudio': return 'http://127.0.0.1:1234'
    case 'vllm': return 'http://127.0.0.1:8000'
    case 'openai-compat': return 'http://127.0.0.1:8080'
  }
}
