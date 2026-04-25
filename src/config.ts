import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getOwlcodaConfigPath } from './paths.js'
import { loadCatalog, type PlatformCatalog } from './models/catalog.js'
import { validateConfig } from './config-validate.js'
import { needsMigration, migrateConfig } from './config-migrate.js'
import { normalizeModel } from './model-registry.js'
import { inferContextWindow } from './model-capabilities.js'
import type { ConfiguredModel, LocalRuntimeProtocol, ResponseModelStyle } from './model-registry.js'

// Re-export from model-registry for backward compatibility
export { normalizeModel } from './model-registry.js'
export type { ConfiguredModel, LocalRuntimeProtocol, ResponseModelStyle, ResolvedModel, ModelRoute } from './model-registry.js'
export {
  LocalRuntimeProtocolUnresolvedError,
  resolveConfiguredModel,
  getDefaultConfiguredModel,
  getPreferredInteractiveConfiguredModel,
  isInteractiveChatModel,
  isInteractiveChatModelName,
  hasResolvedLocalRuntimeProtocol,
  listConfiguredModels,
  probeRouterModels,
  overlayAvailability,
  resolveModelContextWindow,
  responseModelName,
  requiresResolvedLocalRuntimeProtocol,
  resolveModelRoute,
  resolveModel,
  reverseModel,
} from './model-registry.js'

export interface MiddlewareConfig {
  rateLimitRpm?: number
  retryMaxAttempts?: number
  retryBaseDelayMs?: number
  fallbackEnabled?: boolean
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  sloTargetPercent?: number
  requestTimeoutMs?: number
  maxRequestBodyBytes?: number
  intentRouting?: boolean
}

export interface OwlCodaConfig {
  port: number
  host: string
  routerUrl: string
  localRuntimeProtocol: LocalRuntimeProtocol
  routerTimeoutMs: number
  models: ConfiguredModel[]
  responseModelStyle: ResponseModelStyle
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFilePath?: string
  logFileMaxBytes?: number
  logFileKeep?: number
  adminToken?: string
  catalogLoaded: boolean
  middleware: MiddlewareConfig
  backends?: import('./backends/types.js').BackendConfig[]
  skillInjection?: boolean
  skillTopK?: number
  skillThreshold?: number
  /** L3 training-data collection master switch. Default: false (opt-in).
   *  When true, sessions with quality >= minQuality (default 60) are saved
   *  to ~/.owlcoda/training/collected.jsonl after PII sanitization.
   *  Override at runtime: OWLCODA_TRAINING_COLLECTION=1 (or =0). */
  trainingCollection?: boolean

  // Legacy fields (kept for backward compat loading, migrated internally)
  modelMap: Record<string, string>
  defaultModel: string
  reverseMapInResponse: boolean
}

const DEFAULTS: OwlCodaConfig = {
  port: 8019,
  host: '127.0.0.1',
  routerUrl: 'http://127.0.0.1:8009',
  localRuntimeProtocol: 'auto',
  routerTimeoutMs: 600_000,
  models: [],
  responseModelStyle: 'platform',
  logLevel: 'info',
  catalogLoaded: false,
  middleware: {},
  skillInjection: true,
  trainingCollection: false,
  // Legacy defaults
  modelMap: {},
  defaultModel: '',
  reverseMapInResponse: true,
}

function createDefaultConfig(): OwlCodaConfig {
  return {
    ...DEFAULTS,
    models: [],
    middleware: {},
    modelMap: {},
  }
}

const BUILTIN_KIMI_MODEL_ID = 'kimi-code'
const BUILTIN_KIMI_ALIAS = 'kimi'
const DEFAULT_KIMI_ENDPOINT = 'https://api.kimi.com/coding'
const DEFAULT_KIMI_BACKEND_MODEL = 'kimi-for-coding'

export function appendBuiltinEndpointModels(config: OwlCodaConfig): void {
  const kimiApiKey = process.env['KIMI_API_KEY'] || process.env['MOONSHOT_API_KEY']
  if (kimiApiKey) {
    const hasKimi = config.models.some(model =>
      model.id === BUILTIN_KIMI_MODEL_ID
      || model.aliases.includes(BUILTIN_KIMI_ALIAS)
      || model.endpoint === (process.env['OWLCODA_KIMI_ENDPOINT'] || DEFAULT_KIMI_ENDPOINT),
    )

    if (!hasKimi) {
      config.models.push(normalizeModel({
        id: BUILTIN_KIMI_MODEL_ID,
        label: 'Kimi Code',
        backendModel: process.env['OWLCODA_KIMI_BACKEND_MODEL'] || DEFAULT_KIMI_BACKEND_MODEL,
        aliases: [BUILTIN_KIMI_ALIAS],
        tier: 'cloud',
        endpoint: process.env['OWLCODA_KIMI_ENDPOINT'] || DEFAULT_KIMI_ENDPOINT,
        apiKey: kimiApiKey,
        contextWindow: 256_000,
        // User-Agent stays as a kimi-cli-shaped identifier so kimi's
        // quota / credential attribution continues to work. X-Msh-Platform
        // is INTENTIONALLY omitted from the default: sending
        // `X-Msh-Platform: kimi_cli` puts kimi into a legacy "kimi_cli
        // compatibility mode" that inherits the 1.33.0 CLI's think_v2
        // options. Kimi's server-side has since retired one of those
        // options (`keep_reasoning_content`) and responds to the
        // combination with HTTP 400 "unknown think_v2 option". A bare
        // OpenAI-shaped request (no platform hint) routes through the
        // generic chat-completions path and works correctly. Env var
        // `OWLCODA_KIMI_PLATFORM` still opts back in for users who
        // explicitly need the legacy mode.
        headers: (() => {
          const h: Record<string, string> = {
            'User-Agent': process.env['OWLCODA_KIMI_USER_AGENT'] || 'KimiCLI/1.33.0',
          }
          const platform = process.env['OWLCODA_KIMI_PLATFORM']
          if (platform && platform !== 'off' && platform !== '') {
            h['X-Msh-Platform'] = platform
          }
          return h
        })(),
      }))
    }
  }
}

// ─── Platform catalog → ConfiguredModel[] ───

function generateLabel(id: string): string {
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

function channelToTier(channel: string): string {
  switch (channel) {
    case 'stable': return 'production'
    case 'preview': return 'preview'
    case 'candidate': return 'candidate'
    case 'experimental': return 'experimental'
    case 'lab': return 'lab'
    default: return 'general'
  }
}

export function estimateContextWindow(id: string): number {
  const inferred = inferContextWindow({ id })
  if (inferred !== undefined) return inferred
  // Known context windows for common local model families (in tokens)
  if (id.includes('Qwen3')) return 40960
  if (id.includes('gpt-oss-120b')) return 131072
  if (id.includes('gpt-oss-20b')) return 131072
  if (id.includes('Mistral-Large')) return 131072
  if (id.includes('Mistral-Small')) return 131072
  if (id.includes('Nemotron')) return 131072
  if (id.includes('Kimi')) return 131072
  if (id.includes('MiroThinker')) return 32768
  return 32768 // conservative default for unknown models
}

function buildModelsFromCatalog(catalog: PlatformCatalog): ConfiguredModel[] {
  const aliasMap = catalog.aliases ?? {}

  return catalog.models.map(cm => {
    // Collect all aliases that target this model
    const aliases: string[] = []
    for (const [alias, def] of Object.entries(aliasMap)) {
      if (def.target === cm.id) aliases.push(alias)
    }
    return {
      id: cm.id,
      label: generateLabel(cm.id),
      backendModel: cm.id,
      aliases,
      tier: channelToTier(cm.channel),
      default: cm.id === catalog.default_model || undefined,
      channel: cm.channel,
      role: cm.priority_role,
      contextWindow: estimateContextWindow(cm.id),
    }
  })
}

// ─── Legacy modelMap → models migration ───

function inferTierFromAlias(alias: string): string {
  if (alias.includes('heavy') || alias.includes('opus')) return 'heavy'
  if (alias.includes('fast') || alias.includes('haiku')) return 'fast'
  if (alias.includes('balanced') || alias.includes('default') || alias.includes('sonnet')) return 'balanced'
  return 'general'
}

function migrateModelMap(
  modelMap: Record<string, string>,
  defaultModel: string,
): ConfiguredModel[] {
  const byBackend = new Map<string, string[]>()
  for (const [alias, backend] of Object.entries(modelMap)) {
    if (!byBackend.has(backend)) byBackend.set(backend, [])
    byBackend.get(backend)!.push(alias)
  }

  const models: ConfiguredModel[] = []
  for (const [backend, aliases] of byBackend) {
    const tier = inferTierFromAlias(aliases[0]!)
    const isDefault = aliases.some(a => modelMap[a] === defaultModel) || backend === defaultModel

    models.push(normalizeModel({
      id: backend,
      label: generateLabel(backend),
      backendModel: backend,
      aliases,
      tier,
      default: isDefault || undefined,
    }))
  }

  if (!models.some(m => m.default) && models.length > 0) {
    models[0]!.default = true
  }

  return models
}

// ─── Config Loading ───

function tryLoadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function loadConfig(configPath?: string): OwlCodaConfig {
  let fileConfig: Record<string, unknown> | null = null

  if (configPath) {
    fileConfig = tryLoadJson(configPath)
    if (!fileConfig) {
      throw new Error(`Config file not found or invalid: ${configPath}`)
    }
  }

  if (!fileConfig) {
    const homeConfig = getOwlcodaConfigPath()
    fileConfig = tryLoadJson(homeConfig)
  }

  if (!fileConfig) {
    const projectConfig = join(process.cwd(), 'config.json')
    fileConfig = tryLoadJson(projectConfig)
  }

  const merged = createDefaultConfig()

  if (fileConfig) {
    // Auto-migrate old config formats
    if (needsMigration(fileConfig)) {
      const migration = migrateConfig(fileConfig)
      // Migrations are idempotent plumbing — users rarely need to see them
      // on every command. Surface only when OWLCODA_LOG_LEVEL=debug.
      if (process.env['OWLCODA_LOG_LEVEL'] === 'debug') {
        for (const applied of migration.applied) {
          console.error(`[config] Migration: ${applied}`)
        }
      }
      fileConfig = migration.config as Record<string, unknown>
    }

    // Validate config before applying
    const validation = validateConfig(fileConfig)
    if (!validation.valid) {
      for (const err of validation.errors) {
        console.error(`[config] Warning: ${err}`)
      }
    }

    if (fileConfig.port !== undefined) merged.port = fileConfig.port as number
    if (fileConfig.host !== undefined) merged.host = fileConfig.host as string
    if (fileConfig.routerUrl !== undefined) merged.routerUrl = fileConfig.routerUrl as string
    if (fileConfig.localRuntimeProtocol !== undefined) {
      merged.localRuntimeProtocol = fileConfig.localRuntimeProtocol as LocalRuntimeProtocol
    }
    if (fileConfig.routerTimeoutMs !== undefined) merged.routerTimeoutMs = fileConfig.routerTimeoutMs as number
    if (fileConfig.logLevel !== undefined) merged.logLevel = fileConfig.logLevel as OwlCodaConfig['logLevel']
    if (fileConfig.logFilePath !== undefined) merged.logFilePath = fileConfig.logFilePath as string
    if (fileConfig.logFileMaxBytes !== undefined) merged.logFileMaxBytes = fileConfig.logFileMaxBytes as number
    if (fileConfig.logFileKeep !== undefined) merged.logFileKeep = fileConfig.logFileKeep as number
    if (fileConfig.adminToken !== undefined) merged.adminToken = fileConfig.adminToken as string
    if (fileConfig.responseModelStyle !== undefined) {
      // Accept legacy 'owlcoda' style as 'platform'
      const style = fileConfig.responseModelStyle as string
      merged.responseModelStyle = (
        style === 'owlcoda' || style === 'compatibility_alias'
          ? 'platform'
          : style
      ) as ResponseModelStyle
    }

    // New-format: models array from user config
    if (Array.isArray(fileConfig.models) && fileConfig.models.length > 0) {
      merged.models = (fileConfig.models as Record<string, unknown>[]).map(normalizeModel)
    }
    // Legacy: modelMap → migrate
    else if (fileConfig.modelMap && typeof fileConfig.modelMap === 'object') {
      merged.modelMap = fileConfig.modelMap as Record<string, string>
      merged.defaultModel = (fileConfig.defaultModel as string) ?? ''
      merged.models = migrateModelMap(merged.modelMap, merged.defaultModel)
    }

    if (fileConfig.reverseMapInResponse !== undefined) {
      merged.reverseMapInResponse = fileConfig.reverseMapInResponse as boolean
    }

    // Middleware config
    if (fileConfig.middleware && typeof fileConfig.middleware === 'object') {
      merged.middleware = fileConfig.middleware as MiddlewareConfig
    }

    // Backends config
    if (Array.isArray(fileConfig.backends)) {
      merged.backends = fileConfig.backends as import('./backends/types.js').BackendConfig[]
    }
  }

  // If no models from user config, try loading platform catalog
  if (merged.models.length === 0) {
    const catalog = loadCatalog()
    if (catalog) {
      merged.models = buildModelsFromCatalog(catalog)
      merged.catalogLoaded = true
    }
  }

  appendBuiltinEndpointModels(merged)

  // Env var overrides
  if (process.env['OWLCODA_PORT']) {
    const p = parseInt(process.env['OWLCODA_PORT'], 10)
    if (!isNaN(p)) merged.port = p
  }
  if (process.env['OWLCODA_ROUTER_URL']) {
    merged.routerUrl = process.env['OWLCODA_ROUTER_URL']
  }
  if (process.env['OWLCODA_LOCAL_RUNTIME_PROTOCOL']) {
    const protocol = process.env['OWLCODA_LOCAL_RUNTIME_PROTOCOL'] as LocalRuntimeProtocol
    if (['auto', 'openai_chat', 'anthropic_messages'].includes(protocol)) {
      merged.localRuntimeProtocol = protocol
    }
  }
  if (process.env['OWLCODA_LOG_LEVEL']) {
    const lvl = process.env['OWLCODA_LOG_LEVEL'] as OwlCodaConfig['logLevel']
    if (['debug', 'info', 'warn', 'error'].includes(lvl)) {
      merged.logLevel = lvl
    }
  }

  // Build modelMap from models for backward compat in translate layer
  if (merged.models.length > 0 && Object.keys(merged.modelMap).length === 0) {
    for (const m of merged.models) {
      merged.modelMap[m.id] = m.backendModel
      for (const alias of m.aliases) {
        merged.modelMap[alias] = m.backendModel
      }
    }
    const def = merged.models.find(m => m.default) ?? merged.models[0]
    if (def) merged.defaultModel = def.backendModel
  }

  return merged
}

// ─── Backend Discovery → Config Merge ───

/**
 * Merge discovered backend models into an existing config.
 * Discovered models are added if not already present (by ID).
 * Each discovered model gets its own endpoint URL so it routes directly
 * to its backend without going through the Router.
 */
export function mergeDiscoveredModels(
  config: OwlCodaConfig,
  discovered: import('./backends/types.js').DiscoveredModel[],
): OwlCodaConfig {
  const existingIds = new Set(config.models.map(m => m.id))
  const newModels: ConfiguredModel[] = []

  for (const dm of discovered) {
    if (existingIds.has(dm.id)) continue // don't override user-configured or already-seen models
    existingIds.add(dm.id) // prevent duplicates within discovered list

    newModels.push(normalizeModel({
      id: dm.id,
      label: dm.label,
      backendModel: dm.id,
      aliases: [],
      tier: 'discovered',
      endpoint: `${dm.baseUrl}/v1/chat/completions`,
      contextWindow: dm.contextWindow ?? 32768,
    }))
  }

  if (newModels.length === 0) return config

  const allModels = [...config.models, ...newModels]
  const updated = { ...config, models: allModels }

  // Rebuild modelMap
  for (const m of newModels) {
    updated.modelMap[m.id] = m.backendModel
    for (const alias of m.aliases) {
      updated.modelMap[alias] = m.backendModel
    }
  }

  return updated
}
