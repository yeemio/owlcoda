/**
 * Model registry unit tests — resolveModelRoute, normalizeModel comprehensive, overlayAvailability, responseModelName.
 */
import { describe, it, expect } from 'vitest'
import {
  LocalRuntimeProtocolUnresolvedError,
  resolveModelRoute,
  normalizeModel,
  overlayAvailability,
  responseModelName,
  resolveModelContextWindow,
  resolveConfiguredModel,
  getDefaultConfiguredModel,
  type ModelRegistryConfig,
  type ConfiguredModel,
} from '../src/model-registry.js'

function makeRegistryConfig(models: ConfiguredModel[], overrides?: Partial<ModelRegistryConfig>): ModelRegistryConfig {
  return {
    models,
    routerUrl: 'http://127.0.0.1:8009',
    responseModelStyle: 'platform',
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}

function makeModel(overrides: Partial<ConfiguredModel> = {}): ConfiguredModel {
  return {
    id: 'test-model',
    label: 'Test Model',
    backendModel: 'test-model-backend',
    aliases: [],
    tier: 'general',
    contextWindow: 32768,
    ...overrides,
  }
}

describe('resolveModelRoute', () => {
  it('routes to routerUrl when no endpoint configured', () => {
    const config = makeRegistryConfig([makeModel()])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('http://127.0.0.1:8009/v1/chat/completions')
    expect(route.translate).toBe(true)
    expect(route.backendModel).toBe('test-model-backend')
  })

  it('routes local models to anthropic messages when localRuntimeProtocol is anthropic_messages', () => {
    const config = makeRegistryConfig([makeModel()], { localRuntimeProtocol: 'anthropic_messages' })
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('http://127.0.0.1:8009/v1/messages')
    expect(route.translate).toBe(false)
    expect(route.backendModel).toBe('test-model-backend')
  })

  it('fails closed when local runtime protocol is auto and unresolved for local models', () => {
    const config = makeRegistryConfig([makeModel()], { localRuntimeProtocol: 'auto' })
    expect(() => resolveModelRoute(config, 'test-model')).toThrow(LocalRuntimeProtocolUnresolvedError)
  })

  it('routes to custom endpoint when configured', () => {
    const m = makeModel({ endpoint: 'https://api.example.com', apiKey: 'sk-123' })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('https://api.example.com/v1/messages')
    expect(route.translate).toBe(false)
    expect(route.headers['x-api-key']).toBe('sk-123')
    expect(route.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('strips trailing slashes from endpoint URL', () => {
    const m = makeModel({ endpoint: 'https://api.example.com///' })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('https://api.example.com/v1/messages')
  })

  it('uses direct OpenAI-compatible chat completions endpoints as-is', () => {
    const m = makeModel({
      endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'sk-kimi',
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(route.translate).toBe(true)
    expect(route.headers['Authorization']).toBe('Bearer sk-kimi')
    expect(route.headers['x-api-key']).toBeUndefined()
  })

  it('preserves custom headers on direct endpoint models', () => {
    const m = makeModel({
      endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
      headers: {
        'User-Agent': 'KimiCLI/1.33.0',
        'X-Msh-Platform': 'kimi_cli',
      },
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.headers['User-Agent']).toBe('KimiCLI/1.33.0')
    expect(route.headers['X-Msh-Platform']).toBe('kimi_cli')
  })

  it('does not set x-api-key when endpoint has no apiKey', () => {
    const m = makeModel({ endpoint: 'https://api.example.com' })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.headers['x-api-key']).toBeUndefined()
    expect(route.translate).toBe(false)
  })

  it('always sets Content-Type header', () => {
    const config = makeRegistryConfig([makeModel()])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.headers['Content-Type']).toBe('application/json')
  })

  it('propagates per-model timeoutMs', () => {
    const m = makeModel({ timeoutMs: 120_000 })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.timeoutMs).toBe(120_000)
  })

  it('timeoutMs is undefined when not configured on model', () => {
    const config = makeRegistryConfig([makeModel()])
    const route = resolveModelRoute(config, 'test-model')
    expect(route.timeoutMs).toBeUndefined()
  })
})

describe('normalizeModel comprehensive', () => {
  it('defaults all fields from empty object', () => {
    const m = normalizeModel({})
    expect(m.id).toBe('')
    expect(m.label).toBe('')
    expect(m.backendModel).toBe('')
    expect(m.aliases).toEqual([])
    expect(m.tier).toBe('general')
    expect(m.default).toBeUndefined()
    expect(m.channel).toBeUndefined()
    expect(m.role).toBeUndefined()
    expect(m.endpoint).toBeUndefined()
    expect(m.apiKey).toBeUndefined()
    expect(m.apiKeyEnv).toBeUndefined()
    expect(m.headers).toBeUndefined()
    expect(m.contextWindow).toBe(32768)
  })

  it('preserves all explicitly set fields', () => {
    const m = normalizeModel({
      id: 'my-id',
      label: 'My Label',
      backendModel: 'my-backend',
      aliases: ['a1', 'a2'],
      tier: 'heavy',
      default: true,
      channel: 'stable',
      role: 'primary',
      endpoint: 'https://x.com',
      apiKey: 'key-1',
      apiKeyEnv: 'KIMI_API_KEY',
      headers: { 'User-Agent': 'KimiCLI/1.33.0', 'X-Test': 'ok', ignore: 42 },
      contextWindow: 65536,
    })
    expect(m.id).toBe('my-id')
    expect(m.label).toBe('My Label')
    expect(m.backendModel).toBe('my-backend')
    expect(m.aliases).toEqual(['a1', 'a2'])
    expect(m.tier).toBe('heavy')
    expect(m.default).toBe(true)
    expect(m.channel).toBe('stable')
    expect(m.role).toBe('primary')
    expect(m.endpoint).toBe('https://x.com')
    expect(m.apiKey).toBe('key-1')
    expect(m.apiKeyEnv).toBe('KIMI_API_KEY')
    expect(m.headers).toEqual({ 'User-Agent': 'KimiCLI/1.33.0', 'X-Test': 'ok' })
    expect(m.contextWindow).toBe(65536)
  })

  it('reads apiKey from apiKeyEnv when direct apiKey is absent', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env'
    try {
      const m = normalizeModel({ id: 'kimi-code', apiKeyEnv: 'KIMI_API_KEY' })
      expect(m.apiKeyEnv).toBe('KIMI_API_KEY')
      expect(m.apiKey).toBe('sk-kimi-from-env')
    } finally {
      delete process.env['KIMI_API_KEY']
    }
  })

  it('filters non-string values from aliases', () => {
    const m = normalizeModel({ id: 'x', aliases: ['good', 123, null, 'also-good'] })
    expect(m.aliases).toEqual(['good', 'also-good'])
  })

  it('label defaults to id when empty', () => {
    const m = normalizeModel({ id: 'my-id' })
    expect(m.label).toBe('my-id')
  })

  it('backendModel defaults to id when empty', () => {
    const m = normalizeModel({ id: 'my-id' })
    expect(m.backendModel).toBe('my-id')
  })

  it('default=false yields undefined', () => {
    const m = normalizeModel({ id: 'x', default: false })
    expect(m.default).toBeUndefined()
  })

  it('non-string channel yields undefined', () => {
    const m = normalizeModel({ id: 'x', channel: 42 })
    expect(m.channel).toBeUndefined()
  })

  it('contextWindow 0 is preserved', () => {
    const m = normalizeModel({ id: 'x', contextWindow: 0 })
    expect(m.contextWindow).toBe(0)
  })

  it('upgrades stale 32k defaults for known long-context cloud aliases', () => {
    expect(normalizeModel({
      id: 'minimax-m27',
      backendModel: 'MiniMax-M2.7-highspeed',
      aliases: ['minimax', 'm27'],
      contextWindow: 32768,
    }).contextWindow).toBe(204800)

    expect(normalizeModel({
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      aliases: ['kimi'],
      contextWindow: 32768,
    }).contextWindow).toBe(256000)
  })

  it('resolves contextWindow through aliases and backend names', () => {
    const config = makeRegistryConfig([
      normalizeModel({
        id: 'minimax-m27',
        backendModel: 'MiniMax-M2.7-highspeed',
        aliases: ['minimax', 'm27'],
        contextWindow: 32768,
      }),
    ])

    expect(resolveModelContextWindow(config, 'm27')).toBe(204800)
    expect(resolveModelContextWindow(config, 'MiniMax-M2.7-highspeed')).toBe(204800)
  })
})

describe('overlayAvailability', () => {
  it('marks all unknown when router returns empty set', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set())
    expect(models[0].availability).toBe('unknown')
    expect(models[1].availability).toBe('unknown')
  })

  it('marks available when router has matching id', () => {
    const models = [makeModel({ id: 'a', backendModel: 'a-back' })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set(['a']))
    expect(models[0].availability).toBe('available')
  })

  it('marks available via backendModel match', () => {
    const models = [makeModel({ id: 'a', backendModel: 'real-name' })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set(['real-name']))
    expect(models[0].availability).toBe('available')
  })

  it('marks available via alias match', () => {
    const models = [makeModel({ id: 'a', aliases: ['my-alias'] })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set(['my-alias']))
    expect(models[0].availability).toBe('available')
  })

  it('marks available when model has custom endpoint', () => {
    const models = [makeModel({ id: 'a', endpoint: 'https://custom.api' })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set(['something-else']))
    expect(models[0].availability).toBe('available')
  })

  it('marks unavailable when no match found', () => {
    const models = [makeModel({ id: 'a', backendModel: 'a-back', aliases: ['alias-a'] })]
    const config = makeRegistryConfig(models)
    overlayAvailability(config, new Set(['other-model']))
    expect(models[0].availability).toBe('unavailable')
  })
})

describe('responseModelName', () => {
  it('platform style returns resolved model id', () => {
    const models = [makeModel({ id: 'platform-id', aliases: ['primary'] })]
    const config = makeRegistryConfig(models, { responseModelStyle: 'platform' })
    expect(responseModelName(config, 'platform-id')).toBe('platform-id')
  })

  it('requested style returns original request model name', () => {
    const models = [makeModel({ id: 'real-id', aliases: ['alias'] })]
    const config = makeRegistryConfig(models, { responseModelStyle: 'requested' })
    expect(responseModelName(config, 'alias')).toBe('alias')
  })

  it('requested style preserves explicit alias names', () => {
    const models = [makeModel({ id: 'real-id', aliases: ['primary'] })]
    const config = makeRegistryConfig(models, { responseModelStyle: 'requested' })
    expect(responseModelName(config, 'primary')).toBe('primary')
  })
})

describe('resolveConfiguredModel', () => {
  it('resolves by exact id', () => {
    const models = [makeModel({ id: 'exact', backendModel: 'backend-exact' })]
    const config = makeRegistryConfig(models)
    const r = resolveConfiguredModel(config, 'exact')
    expect(r.backendModel).toBe('backend-exact')
  })

  it('resolves by alias', () => {
    const models = [makeModel({ id: 'x', aliases: ['my-alias'], backendModel: 'x-back' })]
    const config = makeRegistryConfig(models)
    const r = resolveConfiguredModel(config, 'my-alias')
    expect(r.backendModel).toBe('x-back')
  })

  it('strips date suffix for matching', () => {
    const models = [makeModel({ id: 'default', aliases: [], backendModel: 'model-back' })]
    const config = makeRegistryConfig(models)
    const r = resolveConfiguredModel(config, 'default-20260101')
    expect(r.backendModel).toBe('model-back')
  })

  it('falls back to default when no match', () => {
    const models = [makeModel({ id: 'default-m', default: true, backendModel: 'default-back' })]
    const config = makeRegistryConfig(models)
    const r = resolveConfiguredModel(config, 'nonexistent')
    expect(r.backendModel).toBe('default-back')
  })

  it('passes through unknown model when no models configured', () => {
    const config = makeRegistryConfig([])
    const r = resolveConfiguredModel(config, 'totally-unknown')
    expect(r.id).toBe('totally-unknown')
    expect(r.backendModel).toBe('totally-unknown')
  })
})

describe('getDefaultConfiguredModel', () => {
  it('returns model marked as default', () => {
    const models = [
      makeModel({ id: 'a' }),
      makeModel({ id: 'b', default: true }),
    ]
    const config = makeRegistryConfig(models)
    const r = getDefaultConfiguredModel(config)
    expect(r?.id).toBe('b')
  })

  it('returns first model when none marked default', () => {
    const models = [makeModel({ id: 'first' }), makeModel({ id: 'second' })]
    const config = makeRegistryConfig(models)
    const r = getDefaultConfiguredModel(config)
    expect(r?.id).toBe('first')
  })

  it('returns null when no models', () => {
    const config = makeRegistryConfig([])
    expect(getDefaultConfiguredModel(config)).toBeNull()
  })
})
