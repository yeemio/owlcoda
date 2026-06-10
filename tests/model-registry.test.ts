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
  isModelExplicitlyConfigured,
  resolveModelContextCapability,
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

  it('does not double /v1 when routerUrl already carries it (anthropic_messages path)', () => {
    // Open Coding Lab dogfood: a routerUrl built programmatically (bypassing
    // loadConfig's normalize) as Ollama's documented `…:11434/v1` doubled to
    // `/v1/v1/messages` and 404'd. resolveModelRoute must normalize defensively.
    const config = makeRegistryConfig([makeModel()], {
      routerUrl: 'http://localhost:11434/v1',
      localRuntimeProtocol: 'anthropic_messages',
    })
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('http://localhost:11434/v1/messages')
  })

  it('does not double /v1 when routerUrl already carries it (openai chat path)', () => {
    const config = makeRegistryConfig([makeModel()], { routerUrl: 'http://localhost:11434/v1/' })
    const route = resolveModelRoute(config, 'test-model')
    expect(route.endpointUrl).toBe('http://localhost:11434/v1/chat/completions')
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

  it('routes Kimi Code official base URL to chat completions instead of Anthropic messages', () => {
    const m = makeModel({
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      aliases: ['kimi'],
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'kimi-code')
    expect(route.endpointUrl).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(route.translate).toBe(true)
    expect(route.headers['Authorization']).toBe('Bearer sk-kimi')
    expect(route.headers['x-api-key']).toBeUndefined()
    expect(route.headers['anthropic-version']).toBeUndefined()
  })

  it('honors explicit Anthropic provider on Kimi-hosted messages endpoints', () => {
    const m = makeModel({
      id: 'kimi-2.6',
      backendModel: 'kimi-2.6',
      provider: 'anthropic',
      aliases: ['kimi'],
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'kimi-2.6')
    expect(route.endpointUrl).toBe('https://api.kimi.com/coding/v1/messages')
    expect(route.translate).toBe(false)
    expect(route.headers['x-api-key']).toBe('sk-kimi')
    expect(route.headers['anthropic-version']).toBe('2023-06-01')
    expect(route.headers['Authorization']).toBeUndefined()
  })

  it('routes OpenAI-compatible /v1 base URLs to chat completions', () => {
    const m = makeModel({
      id: 'mimo-v25-pro',
      backendModel: 'mimo-v2.5-pro',
      aliases: ['mimo'],
      endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1',
      apiKey: 'tp-mimo',
      tier: 'cloud',
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'mimo')
    expect(route.endpointUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions')
    expect(route.translate).toBe(true)
    expect(route.headers['Authorization']).toBe('Bearer tp-mimo')
    expect(route.headers['x-api-key']).toBeUndefined()
    expect(route.headers['anthropic-version']).toBeUndefined()
  })

  it('upgrades the legacy Kimi Code base URL to official /coding/v1 chat completions', () => {
    const m = makeModel({
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      endpoint: 'https://api.kimi.com/coding',
      apiKey: 'sk-kimi',
    })
    const config = makeRegistryConfig([m])
    const route = resolveModelRoute(config, 'kimi-code')
    expect(route.endpointUrl).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(route.translate).toBe(true)
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
    // Unknown/empty model → modern conservative default (raised from 32768).
    expect(m.contextWindow).toBe(200000)
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
      provider: 'anthropic',
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
    expect(m.provider).toBe('anthropic')
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

  it('normalizes Xiaomi MiMo display-style backend ids to provider-supported lowercase ids', () => {
    const m = normalizeModel({
      id: 'mimo-v25-pro',
      label: 'MiMo V2.5 Pro',
      backendModel: 'MiMo-V2.5-Pro',
      endpoint: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
    })

    expect(m.backendModel).toBe('mimo-v2.5-pro')
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

  it('recognizes official 1M OpenAI model ids; unknown models use the conservative fallback', () => {
    const config = makeRegistryConfig([makeModel({ id: 'default-local', contextWindow: 204800 })])

    expect(resolveModelContextWindow(config, 'gpt-4.1')).toBe(1_000_000)
    expect(resolveModelContextWindow(config, 'gpt-4.1-mini')).toBe(1_000_000)

    const unknown = resolveModelContextCapability(config, 'unknown-cloud-model')
    expect(unknown.contextWindow).toBe(200000)
    expect(unknown.source).toBe('fallback')
  })

  it('recognizes mimo-v2.5 as 1M context even when config carries the stale 32K default', () => {
    const config = makeRegistryConfig([
      normalizeModel({ id: 'mimo-v2.5-pro', contextWindow: 32768 }),
    ])
    expect(resolveModelContextWindow(config, 'mimo-v2.5-pro')).toBe(1_000_000)
  })

  it('gives unknown models a 200K conservative default instead of 32K', () => {
    const config = makeRegistryConfig([])
    const cap = resolveModelContextCapability(config, 'some-unknown-model-xyz')
    expect(cap.contextWindow).toBe(200000)
    expect(cap.source).toBe('fallback')
  })

  it('recognizes Gemini 1M and 2M-style context windows by exact model id', () => {
    const config = makeRegistryConfig([])
    expect(resolveModelContextWindow(config, 'gemini-2.5-pro')).toBe(1_048_576)
    expect(resolveModelContextWindow(config, 'gemini-3.1-pro-preview-customtools')).toBe(1_048_576)
    expect(resolveModelContextWindow(config, 'models/gemini-1.5-pro')).toBe(2_097_152)
  })

  it('keeps Kimi K2 family at 256K context instead of 1M', () => {
    const config = makeRegistryConfig([])
    expect(resolveModelContextWindow(config, 'kimi-k2.6')).toBe(256000)
    expect(resolveModelContextWindow(config, 'kimi-k2-0905-preview')).toBe(256000)
    expect(resolveModelContextWindow(config, 'kimi-k2-thinking-turbo')).toBe(256000)
  })

  it('distinguishes Claude 1M routes from 200K routes', () => {
    const config = makeRegistryConfig([])
    expect(resolveModelContextWindow(config, 'claude-sonnet-4.6')).toBe(1_000_000)
    expect(resolveModelContextWindow(config, 'claude-opus-4.7')).toBe(1_000_000)
    expect(resolveModelContextWindow(config, 'claude-sonnet-4.5')).toBe(200000)
  })

  it('preserves explicit non-default configured context overrides', () => {
    const config = makeRegistryConfig([
      normalizeModel({
        id: 'gpt-4.1-small-budget',
        backendModel: 'gpt-4.1',
        contextWindow: 64_000,
      }),
    ])
    const capability = resolveModelContextCapability(config, 'gpt-4.1-small-budget')
    expect(capability.contextWindow).toBe(64_000)
    expect(capability.source).toBe('configured')
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

  it('honors an explicit Kimi default set by the user', () => {
    const models = [
      makeModel({ id: 'kimi-code', backendModel: 'kimi-for-coding', aliases: ['kimi'], default: true }),
      makeModel({ id: 'minimax-m27', backendModel: 'MiniMax-M2.7-highspeed', aliases: ['minimax'] }),
    ]
    const config = makeRegistryConfig(models)
    const r = getDefaultConfiguredModel(config)
    expect(r?.id).toBe('kimi-code')
  })

  it('allows signed-off Kimi as the automatic default when it is first configured', () => {
    const models = [
      makeModel({ id: 'kimi-code', backendModel: 'kimi-for-coding', aliases: ['kimi'] }),
      makeModel({ id: 'minimax-m27', backendModel: 'MiniMax-M2.7-highspeed', aliases: ['minimax'] }),
    ]
    const config = makeRegistryConfig(models)
    const r = getDefaultConfiguredModel(config)
    expect(r?.id).toBe('kimi-code')
  })

  it('returns null when no models', () => {
    const config = makeRegistryConfig([])
    expect(getDefaultConfiguredModel(config)).toBeNull()
  })
})

describe('isModelExplicitlyConfigured', () => {
  // Open Coding Lab dogfood: the model asked for `gpt-4o`, which is not
  // configured locally. resolveConfiguredModel silently falls back to the
  // default (the gateway behavior cloud-name → local routing depends on), so
  // the caller had no way to know it was NOT actually running gpt-4o. This
  // predicate is the opt-in strict check a benchmark/lab runner uses to fail
  // fast instead of silently testing the wrong model. It deliberately does NOT
  // change the lenient default.
  it('returns true for an exactly configured model id', () => {
    const config = makeRegistryConfig([makeModel({ id: 'qwen2.5-coder' })])
    expect(isModelExplicitlyConfigured(config, 'qwen2.5-coder')).toBe(true)
  })

  it('returns true for a configured alias', () => {
    const config = makeRegistryConfig([makeModel({ id: 'qwen2.5-coder', aliases: ['qwen'] })])
    expect(isModelExplicitlyConfigured(config, 'qwen')).toBe(true)
  })

  it('returns false for an unconfigured model that would silently fall back to default', () => {
    const config = makeRegistryConfig([makeModel({ id: 'qwen2.5-coder', default: true })])
    expect(isModelExplicitlyConfigured(config, 'gpt-4o')).toBe(false)
    // ...even though resolveConfiguredModel happily returns the default:
    expect(resolveConfiguredModel(config, 'gpt-4o').id).toBe('qwen2.5-coder')
  })

  it('returns false when no models are configured', () => {
    const config = makeRegistryConfig([])
    expect(isModelExplicitlyConfigured(config, 'gpt-4o')).toBe(false)
  })
})
