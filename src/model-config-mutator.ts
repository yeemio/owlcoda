/**
 * Unified write-path for model config mutations.
 * Keeps all mutations on one path for model credentials/default/model binding.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConfiguredModel, LocalRuntimeProtocol } from './config.js'
import { normalizeModel } from './config.js'
import { getOwlcodaConfigPath } from './paths.js'

export interface ModelConfigMutatorOptions {
  configPath?: string
  onInvalidate?: () => void
  onWrite?: (models: ConfiguredModel[], rawConfig: Record<string, unknown>) => void
}

export interface BindDiscoveredModelPatch {
  targetModelId?: string
  id?: string
  label?: string
  aliases?: string[]
  role?: string
  tier?: string
  backendModel?: string
  endpoint?: string
  contextWindow?: number
  timeoutMs?: number
  headers?: Record<string, string>
}

export interface CreateEndpointModelPatch {
  id: string
  label?: string
  aliases?: string[]
  backendModel?: string
  endpoint: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  contextWindow?: number
  role?: string
  timeoutMs?: number
}

export interface UpdateModelFieldsPatch {
  label?: string
  aliases?: string[]
  backendModel?: string
  endpoint?: string
  headers?: Record<string, string>
  contextWindow?: number
  role?: string
  timeoutMs?: number
  default?: never
  apiKey?: never
  apiKeyEnv?: never
  id?: never
}

export interface UpdateRuntimeSettingsPatch {
  routerUrl?: string
  localRuntimeProtocol?: LocalRuntimeProtocol
}

const ALLOWED_PATCH_FIELDS = new Set([
  'label',
  'aliases',
  'backendModel',
  'endpoint',
  'headers',
  'contextWindow',
  'role',
  'timeoutMs',
])

const FORBIDDEN_PATCH_FIELDS = new Set(['default', 'apiKey', 'apiKeyEnv', 'id'])
const ALLOWED_RUNTIME_PROTOCOLS = new Set<LocalRuntimeProtocol>([
  'auto',
  'openai_chat',
  'anthropic_messages',
])

function defaultConfigPath(): string {
  return getOwlcodaConfigPath()
}

export class ModelConfigMutator {
  private readonly configPath: string
  private readonly onInvalidate?: () => void
  private readonly onWrite?: (models: ConfiguredModel[], rawConfig: Record<string, unknown>) => void

  constructor(options: ModelConfigMutatorOptions = {}) {
    this.configPath = options.configPath ?? defaultConfigPath()
    this.onInvalidate = options.onInvalidate
    this.onWrite = options.onWrite
  }

  async setApiKey(modelId: string, apiKey: string): Promise<void> {
    await this.writeMutatedConfig(config => {
      const idx = findModelIndex(config, modelId)
      if (idx < 0) throw new Error(`Model "${modelId}" not found`)

      const model = config[idx]!
      model.apiKey = apiKey
      model.apiKeyEnv = undefined
    })
  }

  async setApiKeyEnv(modelId: string, envName: string): Promise<void> {
    if (!envName) throw new Error('apiKeyEnv cannot be empty')
    await this.writeMutatedConfig(config => {
      const idx = findModelIndex(config, modelId)
      if (idx < 0) throw new Error(`Model "${modelId}" not found`)

      const model = config[idx]!
      model.apiKeyEnv = envName
      model.apiKey = undefined
    })
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await this.writeMutatedConfig(config => {
      const idx = findModelIndex(config, modelId)
      if (idx < 0) throw new Error(`Model "${modelId}" not found`)

      config.forEach((model, index) => {
        model.default = index === idx ? true : undefined
      })
    })
  }

  async bindDiscoveredModel(discoveredId: string, discoveredPatch: BindDiscoveredModelPatch = {}): Promise<void> {
    await this.writeMutatedConfig(config => {
      if (discoveredPatch.targetModelId) {
        const targetIndex = findModelIndexByExactId(config, discoveredPatch.targetModelId)
        if (targetIndex < 0) {
          throw new Error(`Target model "${discoveredPatch.targetModelId}" not found`)
        }
        const duplicateIndex = findModelIndexByExactId(config, discoveredId)
        if (duplicateIndex >= 0 && duplicateIndex !== targetIndex) {
          throw new Error(`Discovered model "${discoveredId}" is already configured`)
        }

        const target = config[targetIndex]!
        if (discoveredPatch.label !== undefined) target.label = discoveredPatch.label
        if (discoveredPatch.aliases !== undefined) target.aliases = [...discoveredPatch.aliases]
        if (discoveredPatch.role !== undefined) target.role = discoveredPatch.role
        if (discoveredPatch.tier !== undefined) target.tier = discoveredPatch.tier
        target.backendModel = discoveredPatch.backendModel ?? discoveredId
        if (discoveredPatch.endpoint !== undefined) target.endpoint = discoveredPatch.endpoint
        if (discoveredPatch.contextWindow !== undefined) target.contextWindow = discoveredPatch.contextWindow
        if (discoveredPatch.timeoutMs !== undefined) target.timeoutMs = discoveredPatch.timeoutMs
        if (discoveredPatch.headers !== undefined) target.headers = discoveredPatch.headers
        return
      }

      const exists = findModelIndex(config, discoveredId)
      if (exists >= 0) {
        return
      }

      config.push({
        id: discoveredPatch.id ?? discoveredId,
        label: discoveredPatch.label ?? discoveredId,
        backendModel: discoveredPatch.backendModel ?? discoveredId,
        aliases: discoveredPatch.aliases ?? [],
        tier: discoveredPatch.tier ?? 'discovered',
        default: undefined,
        role: discoveredPatch.role,
        endpoint: discoveredPatch.endpoint,
        contextWindow: discoveredPatch.contextWindow,
        timeoutMs: discoveredPatch.timeoutMs,
        headers: discoveredPatch.headers,
      })
    })
  }

  async createEndpointModel(patch: CreateEndpointModelPatch): Promise<void> {
    if (!patch.id) throw new Error('Model id is required')
    if (!patch.endpoint) throw new Error('Endpoint is required')
    validateCreatePatch(patch)
    await this.writeMutatedConfig(config => {
      const exists = findModelIndex(config, patch.id)
      if (exists >= 0) {
        throw new Error(`Model "${patch.id}" already exists`)
      }
      config.push({
        id: patch.id,
        label: patch.label ?? patch.id,
        backendModel: patch.backendModel ?? patch.id,
        aliases: patch.aliases ?? [],
        tier: 'cloud',
        endpoint: patch.endpoint,
        apiKey: patch.apiKey,
        apiKeyEnv: patch.apiKeyEnv,
        headers: patch.headers,
        contextWindow: patch.contextWindow,
        role: patch.role,
        timeoutMs: patch.timeoutMs,
      })
    })
  }

  async removeModel(modelId: string): Promise<void> {
    await this.writeMutatedConfig(config => {
      const idx = findModelIndex(config, modelId)
      if (idx < 0) throw new Error(`Model "${modelId}" not found`)
      const removed = config[idx]
      config.splice(idx, 1)
      if (removed?.default && config.length > 0 && !config.some(model => model.default)) {
        config[0]!.default = true
      }
    })
  }

  async updateModelFields(modelId: string, patch: UpdateModelFieldsPatch): Promise<void> {
    validatePatchFields(patch)
    await this.writeMutatedConfig(config => {
      const idx = findModelIndex(config, modelId)
      if (idx < 0) throw new Error(`Model "${modelId}" not found`)
      const model = config[idx]!
      if (patch.label !== undefined) model.label = patch.label
      if (patch.aliases !== undefined) model.aliases = [...patch.aliases]
      if (patch.backendModel !== undefined) model.backendModel = patch.backendModel
      if (patch.endpoint !== undefined) model.endpoint = patch.endpoint
      if (patch.headers !== undefined) model.headers = patch.headers
      if (patch.contextWindow !== undefined) model.contextWindow = patch.contextWindow
      if (patch.role !== undefined) model.role = patch.role
      if (patch.timeoutMs !== undefined) model.timeoutMs = patch.timeoutMs
    })
  }

  async updateRuntimeSettings(patch: UpdateRuntimeSettingsPatch): Promise<void> {
    validateRuntimePatch(patch)
    await this.writeRawConfigMutation(raw => {
      if (patch.routerUrl !== undefined) {
        raw.routerUrl = normalizeRouterUrl(patch.routerUrl)
      }
      if (patch.localRuntimeProtocol !== undefined) {
        raw.localRuntimeProtocol = patch.localRuntimeProtocol
      }
    })
  }

  private async writeMutatedConfig(mutator: (models: ConfiguredModel[]) => void): Promise<void> {
    await this.writeRawConfigMutation((_raw, models) => {
      mutator(models)
    })
  }

  private async writeRawConfigMutation(
    mutator: (raw: Record<string, unknown>, models: ConfiguredModel[]) => void,
  ): Promise<void> {
    const raw = this.readConfigFile()
    const models = parseConfigModels(raw)
    mutator(raw, models)
    const normalized = normalizeConfigModels(models)

    raw.models = normalized
    delete raw.defaultModel
    raw.modelMap = rebuildModelMap(normalized)

    this.writeConfigFile(raw)
    this.onWrite?.(normalized, raw)
    this.onInvalidate?.()
  }

  private readConfigFile(): Record<string, unknown> {
    if (!existsSync(this.configPath)) {
      return createEmptyConfig()
    }
    const content = readFileSync(this.configPath, 'utf-8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Config file is invalid')
    }
    if (!Array.isArray(parsed.models)) {
      throw new Error('Config file missing models array')
    }
    return parsed
  }

  private writeConfigFile(raw: Record<string, unknown>): void {
    mkdirSync(dirname(this.configPath), { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  }
}

function createEmptyConfig(): Record<string, unknown> {
  return {
    models: [],
    modelMap: {},
    reverseMapInResponse: true,
  }
}

function normalizeRouterUrl(routerUrl: string): string {
  const trimmed = routerUrl.trim()
  if (!trimmed) throw new Error('routerUrl is required')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('routerUrl must be a valid absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('routerUrl must start with http:// or https://')
  }
  return trimmed.replace(/\/+$/, '')
}

function rebuildModelMap(models: ConfiguredModel[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const model of models) {
    map[model.id] = model.backendModel
    for (const alias of model.aliases) {
      map[alias] = model.backendModel
    }
  }
  return map
}

function parseConfigModels(raw: Record<string, unknown>): ConfiguredModel[] {
  const models = raw.models
  if (!Array.isArray(models)) return []
  return models.map(m => normalizeModel(m as Record<string, unknown>))
}

function findModelIndex(models: ConfiguredModel[], modelId: string): number {
  return models.findIndex(m => m.id === modelId || m.aliases.includes(modelId))
}

function findModelIndexByExactId(models: ConfiguredModel[], modelId: string): number {
  return models.findIndex(m => m.id === modelId)
}

function validatePatchFields(patch: UpdateModelFieldsPatch): void {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_FIELDS.has(key)) {
      throw new Error(`Field "${key}" cannot be patched`)
    }
    if (!ALLOWED_PATCH_FIELDS.has(key)) {
      throw new Error(`Field "${key}" is not allowed`)
    }
  }
}

function validateRuntimePatch(patch: UpdateRuntimeSettingsPatch): void {
  if (patch.routerUrl === undefined && patch.localRuntimeProtocol === undefined) {
    throw new Error('At least one runtime setting is required')
  }
  if (patch.routerUrl !== undefined) {
    normalizeRouterUrl(patch.routerUrl)
  }
  if (
    patch.localRuntimeProtocol !== undefined
    && !ALLOWED_RUNTIME_PROTOCOLS.has(patch.localRuntimeProtocol)
  ) {
    throw new Error(`Unsupported localRuntimeProtocol "${patch.localRuntimeProtocol}"`)
  }
}

function validateCreatePatch(patch: CreateEndpointModelPatch): void {
  if (patch.apiKey && patch.apiKeyEnv) {
    throw new Error('Provide either apiKey or apiKeyEnv, not both')
  }
}

export function normalizeConfigModels(models: ConfiguredModel[]): ConfiguredModel[] {
  return models.map(m => {
    const normalized = normalizeModel(m as unknown as Record<string, unknown>)
    return {
      ...normalized,
      default: normalized.default,
      id: normalized.id,
    }
  })
}
