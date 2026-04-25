import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ModelConfigMutator, type BindDiscoveredModelPatch, normalizeConfigModels } from '../src/model-config-mutator.js'

function withConfig(content: Record<string, unknown>, workdir: string): string {
  const path = join(workdir, 'config.json')
  writeFileSync(path, JSON.stringify(content, null, 2) + '\n', 'utf-8')
  return path
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

describe('ModelConfigMutator', () => {
  let workdir: string

  beforeEach(() => {
    workdir = mkdtempSync('/tmp/model-config-mutator-')
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('writes setApiKey to existing config model and clears legacy defaultModel', async () => {
    const path = withConfig({
      models: [
        {
          id: 'router-model',
          label: 'Router Model',
          backendModel: 'router-model',
          aliases: ['rm'],
          tier: 'general',
          default: true,
        },
        {
          id: 'cloud-model',
          label: 'Cloud Model',
          backendModel: 'cloud-model',
          aliases: [],
          tier: 'cloud',
          endpoint: 'https://api.example.com',
          apiKey: 'old',
          default: false,
        },
      ],
      defaultModel: 'router-model',
      modelMap: {},
      reverseMapInResponse: true,
      modelMapLoaded: true,
    }, workdir)

    let invalidated = 0
    const mutator = new ModelConfigMutator({ configPath: path, onInvalidate: () => { invalidated += 1 } })
    await mutator.setApiKey('cloud-model', 'new-key')

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models.find(m => m.id === 'cloud-model')?.apiKey).toBe('new-key')
    expect(updated).not.toHaveProperty('defaultModel')
    expect(invalidated).toBe(1)
    expect(updated.modelMap).toHaveProperty('cloud-model', 'cloud-model')
    expect(updated.modelMap).toHaveProperty('rm', 'router-model')
  })

  it('invokes onWrite with normalized models and rewritten config', async () => {
    const path = withConfig({
      models: [
        {
          id: 'cloud-model',
          label: 'Cloud Model',
          backendModel: 'cloud-model',
          aliases: ['cm'],
          tier: 'cloud',
          endpoint: 'https://api.example.com/v1',
        },
      ],
      defaultModel: 'legacy-default',
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    let writtenModels: Array<{ id: string, aliases: string[] }> = []
    let writtenConfig: Record<string, unknown> | null = null
    const mutator = new ModelConfigMutator({
      configPath: path,
      onWrite: (models, rawConfig) => {
        writtenModels = models.map(model => ({ id: model.id, aliases: model.aliases }))
        writtenConfig = rawConfig
      },
    })

    await mutator.updateModelFields('cloud-model', { aliases: ['updated'] })

    expect(writtenModels).toEqual([{ id: 'cloud-model', aliases: ['updated'] }])
    expect(writtenConfig).not.toBeNull()
    expect(writtenConfig).not.toHaveProperty('defaultModel')
  })

  it('writes apiKeyEnv for direct key-mode and removes inline apiKey', async () => {
    const path = withConfig({
      models: [
        {
          id: 'cloud-model',
          label: 'Cloud Model',
          backendModel: 'cloud-model',
          aliases: ['cm'],
          tier: 'cloud',
          endpoint: 'https://api.example.com',
          apiKey: 'old',
        },
      ],
      defaultModel: 'legacy-default',
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.setApiKeyEnv('cm', 'OPENAI_API_KEY')

    const updated = readJson(path)
    const model = (updated.models as Array<Record<string, unknown>>).find(m => m.id === 'cloud-model')!
    expect(model.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(model.apiKey).toBeUndefined()
    expect(updated).not.toHaveProperty('defaultModel')
  })

  it('sets default model consistently and removes legacy defaultModel', async () => {
    const path = withConfig({
      models: [
        { id: 'first', label: 'First', backendModel: 'first', aliases: ['a'], tier: 'general', default: true },
        { id: 'second', label: 'Second', backendModel: 'second', aliases: ['b'], tier: 'general' },
      ],
      defaultModel: 'first',
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.setDefaultModel('second')

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models.find(m => m.id === 'first')?.default).toBeUndefined()
    expect(models.find(m => m.id === 'second')?.default).toBe(true)
    expect(updated).not.toHaveProperty('defaultModel')
  })

  it('binds discovered model if absent and preserve existing entries', async () => {
    const path = withConfig({
      models: [
        { id: 'configured', label: 'Configured', backendModel: 'configured', aliases: [], tier: 'general', default: true },
      ],
      modelMap: { configured: 'configured' },
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    const patch: BindDiscoveredModelPatch = {
      label: 'Discovered Local',
      aliases: ['discovered-local'],
      backendModel: 'discovered-local',
      tier: 'local',
      contextWindow: 4096,
    }
    await mutator.bindDiscoveredModel('discovered-local', patch)

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    const discovered = models.find(m => m.id === 'discovered-local')
    expect(discovered).toBeTruthy()
    expect(discovered?.label).toBe('Discovered Local')
    expect(discovered?.aliases).toEqual(['discovered-local'])
    expect(updated.modelMap).toHaveProperty('discovered-local')
  })

  it('binds discovered model onto an existing config model when targetModelId is provided', async () => {
    const path = withConfig({
      models: [
        {
          id: 'saved-local',
          label: 'Saved Local',
          backendModel: 'old-local',
          aliases: ['saved'],
          tier: 'general',
          default: true,
        },
      ],
      modelMap: { saved: 'old-local' },
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.bindDiscoveredModel('discovered-local', {
      targetModelId: 'saved-local',
      label: 'Bound Local',
      aliases: ['saved', 'local'],
      contextWindow: 8192,
    })

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('saved-local')
    expect(models[0]?.backendModel).toBe('discovered-local')
    expect(models[0]?.label).toBe('Bound Local')
    expect(models[0]?.aliases).toEqual(['saved', 'local'])
    expect(models[0]?.contextWindow).toBe(8192)
    expect(updated.modelMap).toMatchObject({
      'saved-local': 'discovered-local',
      saved: 'discovered-local',
      local: 'discovered-local',
    })
  })

  it('throws when target model not found', async () => {
    const path = withConfig({
      models: [{ id: 'exists', label: 'Exists', backendModel: 'exists', aliases: [], tier: 'general', default: true }],
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await expect(mutator.setApiKey('missing', 'nope')).rejects.toThrowError(/not found/)
  })

  it('creates endpoint models and keeps legacy defaultModel removed', async () => {
    const path = withConfig({
      models: [],
      defaultModel: 'legacy-default',
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.createEndpointModel({
      id: 'new-cloud',
      label: 'New Cloud',
      backendModel: 'gpt-4.1',
      aliases: ['nc'],
      endpoint: 'https://api.example.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      headers: { 'X-Test': '1' },
      timeoutMs: 4000,
    })

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('new-cloud')
    expect(models[0]?.endpoint).toBe('https://api.example.com/v1')
    expect(models[0]?.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(updated).not.toHaveProperty('defaultModel')
  })

  it('creates config file and parent directory on first admin model save', async () => {
    const path = join(workdir, 'fresh-home', 'config.json')
    const mutator = new ModelConfigMutator({ configPath: path })

    await mutator.createEndpointModel({
      id: 'minimax-m27',
      label: 'MiniMax M2.7-highspeed',
      backendModel: 'MiniMax-M2.7-highspeed',
      endpoint: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-test',
    })

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('minimax-m27')
    expect(models[0]?.apiKey).toBe('sk-test')
    expect(updated.modelMap).toHaveProperty('minimax-m27', 'MiniMax-M2.7-highspeed')
    expect(updated.reverseMapInResponse).toBe(true)
  })

  it('rejects endpoint model create when both apiKey and apiKeyEnv are provided', async () => {
    const path = withConfig({
      models: [],
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await expect(mutator.createEndpointModel({
      id: 'bad-cloud',
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-inline',
      apiKeyEnv: 'OPENAI_API_KEY',
    })).rejects.toThrowError(/either apiKey or apiKeyEnv/i)
  })

  it('updates only whitelisted model fields', async () => {
    const path = withConfig({
      models: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        backendModel: 'cloud-model',
        aliases: ['cm'],
        tier: 'cloud',
        endpoint: 'https://api.example.com/v1',
        contextWindow: 8192,
      }],
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.updateModelFields('cloud-model', {
      label: 'Updated Cloud',
      aliases: ['updated'],
      timeoutMs: 2000,
      role: 'planner',
    })

    const updated = readJson(path)
    const model = (updated.models as Array<Record<string, unknown>>)[0]!
    expect(model.label).toBe('Updated Cloud')
    expect(model.aliases).toEqual(['updated'])
    expect(model.timeoutMs).toBe(2000)
    expect(model.role).toBe('planner')
  })

  it('rejects non-positive numeric model fields', async () => {
    const path = withConfig({
      models: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        backendModel: 'cloud-model',
        aliases: ['cm'],
        tier: 'cloud',
        endpoint: 'https://api.example.com/v1',
      }],
      modelMap: {},
      reverseMapInResponse: true,
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await expect(mutator.updateModelFields('cloud-model', { timeoutMs: -2 })).rejects.toThrow(/timeoutMs must be a positive number/)
    await expect(mutator.createEndpointModel({
      id: 'bad-timeout',
      endpoint: 'https://api.example.com/v1',
      timeoutMs: 0,
    })).rejects.toThrow(/timeoutMs must be a positive number/)
  })

  it('rejects forbidden patch fields', async () => {
    const path = withConfig({
      models: [{
        id: 'cloud-model',
        label: 'Cloud Model',
        backendModel: 'cloud-model',
        aliases: ['cm'],
        tier: 'cloud',
        endpoint: 'https://api.example.com/v1',
      }],
      modelMap: {},
      reverseMapInResponse: true,
      defaultModel: 'legacy-default',
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await expect(mutator.updateModelFields('cloud-model', { default: true } as never)).rejects.toThrow(/cannot be patched/)

    const updated = readJson(path)
    expect(updated.defaultModel).toBe('legacy-default')
    expect((updated.models as Array<Record<string, unknown>>)[0]?.label).toBe('Cloud Model')
  })

  it('removes models and reassigns default when needed', async () => {
    const path = withConfig({
      models: [
        { id: 'first', label: 'First', backendModel: 'first', aliases: [], tier: 'general', default: true },
        { id: 'second', label: 'Second', backendModel: 'second', aliases: [], tier: 'general' },
      ],
      modelMap: {},
      reverseMapInResponse: true,
      defaultModel: 'first',
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.removeModel('first')

    const updated = readJson(path)
    const models = updated.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('second')
    expect(models[0]?.default).toBe(true)
    expect(updated).not.toHaveProperty('defaultModel')
  })

  it('updates routerUrl and localRuntimeProtocol without disturbing models', async () => {
    const path = withConfig({
      routerUrl: 'http://127.0.0.1:8009',
      localRuntimeProtocol: 'auto',
      models: [
        { id: 'first', label: 'First', backendModel: 'first', aliases: [], tier: 'general', default: true },
      ],
      modelMap: { first: 'first' },
      reverseMapInResponse: true,
      defaultModel: 'first',
    }, workdir)

    const mutator = new ModelConfigMutator({ configPath: path })
    await mutator.updateRuntimeSettings({
      routerUrl: 'http://127.0.0.1:11435/v1/',
      localRuntimeProtocol: 'openai_chat',
    })

    const updated = readJson(path)
    expect(updated.routerUrl).toBe('http://127.0.0.1:11435/v1')
    expect(updated.localRuntimeProtocol).toBe('openai_chat')
    expect((updated.models as Array<Record<string, unknown>>)[0]?.id).toBe('first')
    expect(updated).not.toHaveProperty('defaultModel')
  })
})
