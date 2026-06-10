/**
 * Platform catalog adapter — reads the local-llm-platform catalog.json
 * and provides a unified model surface for OwlCoda.
 *
 * Model truth priority:
 *   1. Platform catalog.json — defines product semantics, defaults, intents
 *   2. Live router /v1/models — defines today's actual availability
 *   3. OwlCoda config — port/host/router overrides and test fallback only
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { get as httpGet } from 'node:http'

// ─── Catalog types ───

export interface CatalogModel {
  id: string
  channel: 'stable' | 'preview' | 'candidate' | 'experimental' | 'lab'
  backend: string
  priority_role: string
  tool_calling_support?: string
  product_surfaces?: string[]
  supports_search_tool?: boolean
  not_recommended_for?: string[]
}

export interface CatalogAlias {
  target: string
  surfaces?: string[]
}

export interface PlatformCatalog {
  version: number
  default_model: string
  intent_defaults: Record<string, string>
  models: CatalogModel[]
  aliases: Record<string, CatalogAlias>
  work_types?: Record<string, { primary_model?: string }>
}

// ─── Model surface (what OwlCoda actually uses) ───

export type ModelAvailability = 'available' | 'unavailable' | 'unknown'

export interface PlatformModel {
  /** Platform real model ID (e.g. "qwen2.5-coder:32b") */
  id: string
  /** Short display label for UI (e.g. "Qwen2.5 Coder 32B") */
  label: string
  /** Channel: stable / preview / lab / candidate / experimental */
  channel: string
  /** Backend engine (omlx, vllm, llama, kimi) */
  backend: string
  /** Product role (e.g. "default_chat_and_coding_primary") */
  role: string
  /** Whether the router reports this model as live today */
  availability: ModelAvailability
  /** Is this the platform default? */
  isDefault: boolean
  /** All aliases that resolve to this model (from catalog + compat) */
  aliases: string[]
  /** Tool calling support level */
  toolCalling: string
}

export interface ModelSurface {
  /** All platform models with availability overlay */
  models: PlatformModel[]
  /** Platform default model ID */
  defaultModel: string
  /** Intent → model ID mappings */
  intentDefaults: Record<string, string>
  /** All aliases → model ID (for resolution) */
  aliasMap: Record<string, string>
  /** Catalog version */
  catalogVersion: number
  /** Whether catalog was loaded from platform truth */
  catalogLoaded: boolean
  /** Router models that were live at probe time */
  routerModels: string[]
}

// ─── Catalog loading ───

// Conventional locations relative to the OwlCoda repo where a sibling
// catalog.json may live in a platform monorepo layout. For any other
// location set OWLCODA_CATALOG_PATH to point at it directly — that env
// var is checked first and takes precedence over this list.
const CATALOG_SEARCH_PATHS = [
  join('..', 'AI', 'Agent', 'registry', 'local-llm-platform', 'catalog.json'),
  join('..', '..', 'AI', 'Agent', 'registry', 'local-llm-platform', 'catalog.json'),
]

function findCatalogPath(fromDir?: string): string | null {
  // Env override — if set, it's authoritative (don't fall through)
  if (process.env['OWLCODA_CATALOG_PATH']) {
    const p = process.env['OWLCODA_CATALOG_PATH']
    return existsSync(p) ? p : null
  }
  // Search relative paths from the given directory
  const bases = fromDir ? [fromDir] : [process.cwd()]
  for (const base of bases) {
    for (const rel of CATALOG_SEARCH_PATHS) {
      const abs = resolve(base, rel)
      if (existsSync(abs)) return abs
    }
  }
  return null
}

export function loadCatalog(fromDir?: string): PlatformCatalog | null {
  const path = findCatalogPath(fromDir)
  if (!path) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as PlatformCatalog
  } catch {
    return null
  }
}

// ─── Router liveness probe ───

function probeRouterModels(routerUrl: string, timeoutMs: number = 3000): Promise<string[]> {
  return new Promise(resolve => {
    const req = httpGet(`${routerUrl}/v1/models`, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          const ids = (parsed.data ?? []).map((m: { id: string }) => m.id)
          resolve(ids)
        } catch {
          resolve([])
        }
      })
    })
    req.on('error', () => resolve([]))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]) })
  })
}

// ─── Label generation ───

function generateLabel(id: string): string {
  // Shorten long model IDs for display
  if (id.includes('qwen2.5-coder:32b')) return 'Qwen2.5 Coder 32B'
  if (id.includes('Qwen3.5-35B-A3B')) return 'Qwen 35B MoE'
  if (id.includes('Qwen3.5-122B')) return 'Qwen 122B MoE'
  if (id.includes('gpt-oss-120b')) return 'GPT-OSS 120B'
  if (id.includes('gpt-oss-20b')) return 'GPT-OSS 20B'
  if (id.includes('Mistral-Large')) return 'Mistral Large'
  if (id.includes('Mistral-Small-4-119B')) return 'Mistral Small 119B'
  if (id.includes('MiroThinker-1.7')) return 'MiroThinker Mini'
  if (id.includes('MiroThinker-v1.5')) return 'MiroThinker 30B'
  if (id.includes('Nemotron-Cascade')) return 'Nemotron Cascade'
  if (id.includes('Kimi-K2.5')) return 'Kimi K2.5'
  if (id.includes('Qwen3-VL')) return 'Qwen3 VL 30B'
  if (id.includes('Qwen3-Embedding')) return 'Qwen3 Embedding'
  return id.length > 30 ? id.slice(0, 27) + '...' : id
}

// ─── Build model surface ───

/**
 * Build the unified model surface from platform catalog + router availability.
 * This is the single source of truth for all model display/selection in OwlCoda.
 */
export async function buildModelSurface(routerUrl: string, fromDir?: string): Promise<ModelSurface> {
  const catalog = loadCatalog(fromDir)
  const routerModels = await probeRouterModels(routerUrl)
  const routerSet = new Set(routerModels)

  if (!catalog) {
    // Branch C: no catalog — use router models as visible set
    return buildFromRouterOnly(routerModels)
  }

  // Build alias map: alias → target model ID
  const aliasMap: Record<string, string> = {}
  for (const [alias, def] of Object.entries(catalog.aliases)) {
    aliasMap[alias] = def.target
  }

  // Build models with availability overlay
  const models: PlatformModel[] = catalog.models.map(cm => {
    // Check availability: model ID or any router alias that resolves to this model
    const isLive = routerSet.has(cm.id) || routerModels.some(rm => {
      // Check if router alias maps to this catalog model
      return aliasMap[rm] === cm.id
    })
    // Also check if a known router alias (like distilled-27b) is live for this model
    const routerAliasLive = routerModels.some(_rm => {
      // The router's model_alias_map may have short names that map to the full ID
      // We do a reverse lookup: if any alias in our aliasMap targets this model AND is in routerModels
      for (const [a, t] of Object.entries(aliasMap)) {
        if (t === cm.id && routerSet.has(a)) return true
      }
      return false
    })

    const availability: ModelAvailability = (isLive || routerAliasLive)
      ? 'available'
      : (routerModels.length === 0 ? 'unknown' : 'unavailable')

    // Collect all aliases that target this model
    const modelAliases: string[] = []
    for (const [a, t] of Object.entries(aliasMap)) {
      if (t === cm.id) modelAliases.push(a)
    }

    return {
      id: cm.id,
      label: generateLabel(cm.id),
      channel: cm.channel,
      backend: cm.backend,
      role: cm.priority_role,
      availability,
      isDefault: cm.id === catalog.default_model,
      aliases: modelAliases,
      toolCalling: cm.tool_calling_support ?? 'unknown',
    }
  })

  return {
    models,
    defaultModel: catalog.default_model,
    intentDefaults: catalog.intent_defaults,
    aliasMap,
    catalogVersion: catalog.version,
    catalogLoaded: true,
    routerModels,
  }
}

/**
 * Build model surface from router only (no catalog — Branch C fallback).
 */
function buildFromRouterOnly(routerModels: string[]): ModelSurface {
  // Filter out embedding/reranking models for chat
  const chatModels = routerModels.filter(id =>
    !id.toLowerCase().includes('embedding') &&
    !id.toLowerCase().includes('rerank')
  )

  const models: PlatformModel[] = chatModels.map((id, _i) => ({
    id,
    label: generateLabel(id),
    channel: 'unknown',
    backend: 'unknown',
    role: '',
    availability: 'available' as ModelAvailability,
    isDefault: id.toLowerCase().includes('distilled'),
    aliases: [],
    toolCalling: 'unknown',
  }))

  // Try to pick a default
  const defaultModel = models.find(m => m.isDefault)?.id ?? models[0]?.id ?? ''

  return {
    models,
    defaultModel,
    intentDefaults: {},
    aliasMap: {},
    catalogVersion: 0,
    catalogLoaded: false,
    routerModels,
  }
}

/**
 * Resolve a user-input model name to a platform model ID.
 * Priority: exact ID → alias → partial match → default.
 */
export function resolveModelName(surface: ModelSurface, input: string): string {
  // Exact match by ID
  if (surface.models.some(m => m.id === input)) return input
  // Alias match
  if (surface.aliasMap[input]) return surface.aliasMap[input]
  // Date-stripped match for timestamped aliases.
  const stripped = input.replace(/-\d{8}$/, '')
  if (stripped !== input && surface.aliasMap[stripped]) return surface.aliasMap[stripped]
  // Partial match (user types partial model name)
  const lower = input.toLowerCase()
  const partial = surface.models.find(m => m.id.toLowerCase().includes(lower))
  if (partial) return partial.id
  // Default
  return surface.defaultModel
}

/**
 * Get the backend model name that the router expects.
 * For most models this is the same as the platform ID.
 * For some, the router uses a short alias (e.g. distilled-27b).
 */
export function getRouterModelName(surface: ModelSurface, platformId: string): string {
  // If the router has this exact ID, use it
  if (surface.routerModels.includes(platformId)) return platformId
  // Check if any router model is an alias for this platform ID
  for (const rm of surface.routerModels) {
    if (surface.aliasMap[rm] === platformId) return rm
  }
  // Fallback: just use the platform ID and let the router's own alias_map handle it
  return platformId
}

/**
 * Synchronous model surface builder for test / config-only mode.
 * Uses only catalog (no router probe).
 */
export function buildModelSurfaceSync(fromDir?: string): ModelSurface {
  const catalog = loadCatalog(fromDir)
  if (!catalog) {
    return {
      models: [],
      defaultModel: '',
      intentDefaults: {},
      aliasMap: {},
      catalogVersion: 0,
      catalogLoaded: false,
      routerModels: [],
    }
  }

  const aliasMap: Record<string, string> = {}
  for (const [alias, def] of Object.entries(catalog.aliases)) {
    aliasMap[alias] = def.target
  }

  const models: PlatformModel[] = catalog.models.map(cm => ({
    id: cm.id,
    label: generateLabel(cm.id),
    channel: cm.channel,
    backend: cm.backend,
    role: cm.priority_role,
    availability: 'unknown' as ModelAvailability,
    isDefault: cm.id === catalog.default_model,
    aliases: Object.entries(aliasMap).filter(([_, t]) => t === cm.id).map(([a]) => a),
    toolCalling: cm.tool_calling_support ?? 'unknown',
  }))

  return {
    models,
    defaultModel: catalog.default_model,
    intentDefaults: catalog.intent_defaults,
    aliasMap,
    catalogVersion: catalog.version,
    catalogLoaded: true,
    routerModels: [],
  }
}
