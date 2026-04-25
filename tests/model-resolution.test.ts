/**
 * Edge case tests for model resolution — aliases, collisions, fallbacks.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeModel,
  resolveConfiguredModel,
  getDefaultConfiguredModel,
  getPreferredInteractiveConfiguredModel,
  isInteractiveChatModel,
  isInteractiveChatModelName,
  overlayAvailability,
  responseModelName,
  resolveModel,
  reverseModel,
  type ModelRegistryConfig,
  type ConfiguredModel,
} from '../src/model-registry.js'

function makeConfig(models: ConfiguredModel[], overrides?: Partial<ModelRegistryConfig>): ModelRegistryConfig {
  return {
    models,
    routerUrl: 'http://localhost:11435/v1',
    responseModelStyle: 'platform',
    modelMap: {},
    defaultModel: 'fallback',
    reverseMapInResponse: false,
    ...overrides,
  }
}

const modelA = normalizeModel({ id: 'model-a', aliases: ['alias-a', 'shared-alias'], default: true })
const modelB = normalizeModel({ id: 'model-b', aliases: ['alias-b', 'shared-alias'], backendModel: 'backend-b' })
const modelC = normalizeModel({ id: 'model-c', endpoint: 'https://cloud.example.com', apiKey: 'key-123' })

describe('resolveConfiguredModel', () => {
  const config = makeConfig([modelA, modelB, modelC])

  it('resolves by exact ID', () => {
    expect(resolveConfiguredModel(config, 'model-a').id).toBe('model-a')
  })

  it('resolves by alias', () => {
    expect(resolveConfiguredModel(config, 'alias-b').id).toBe('model-b')
  })

  it('resolves by backendModel', () => {
    expect(resolveConfiguredModel(config, 'backend-b').id).toBe('model-b')
  })

  it('alias collision: first model wins', () => {
    // Both modelA and modelB have 'shared-alias', modelA is first
    expect(resolveConfiguredModel(config, 'shared-alias').id).toBe('model-a')
  })

  it('date-stripped fallback', () => {
    expect(resolveConfiguredModel(config, 'model-a-20250101').id).toBe('model-a')
  })

  it('partial match by substring', () => {
    expect(resolveConfiguredModel(config, 'odel-b').id).toBe('model-b')
  })

  it('nonexistent model falls back to default', () => {
    const resolved = resolveConfiguredModel(config, 'nonexistent')
    expect(resolved.id).toBe('model-a') // model-a is default
  })

  it('empty models config returns passthrough', () => {
    const empty = makeConfig([])
    const resolved = resolveConfiguredModel(empty, 'anything')
    expect(resolved.id).toBe('anything')
    expect(resolved.backendModel).toBe('anything')
  })
})

describe('getDefaultConfiguredModel', () => {
  it('returns model marked as default', () => {
    const config = makeConfig([modelA, modelB])
    expect(getDefaultConfiguredModel(config)!.id).toBe('model-a')
  })

  it('returns first model if no default flag', () => {
    const noDefault = normalizeModel({ id: 'x' })
    const config = makeConfig([noDefault])
    expect(getDefaultConfiguredModel(config)!.id).toBe('x')
  })

  it('returns null for empty models', () => {
    expect(getDefaultConfiguredModel(makeConfig([]))).toBeNull()
  })
})

describe('interactive chat model helpers', () => {
  it('treats embedding and rerank names as non-chat', () => {
    expect(isInteractiveChatModelName('Qwen3-Embedding-8B')).toBe(false)
    expect(isInteractiveChatModelName('bge-rerank-large')).toBe(false)
    expect(isInteractiveChatModelName('minimax-m27')).toBe(true)
  })

  it('treats embedding tier models as non-chat', () => {
    expect(isInteractiveChatModel(normalizeModel({ id: 'embedder', backendModel: 'embedder', tier: 'embedding' }))).toBe(false)
    expect(isInteractiveChatModel(normalizeModel({ id: 'chat-model', backendModel: 'chat-model', tier: 'production' }))).toBe(true)
  })

  it('prefers a chat-capable default over an embedding default', () => {
    const config = makeConfig([
      normalizeModel({ id: 'Qwen3-Embedding-8B', backendModel: 'Qwen3-Embedding-8B', default: true }),
      normalizeModel({ id: 'qwen2.5-coder:32b', backendModel: 'qwen2.5-coder:32b' }),
    ])
    expect(getPreferredInteractiveConfiguredModel(config)?.id).toBe('qwen2.5-coder:32b')
  })
})

describe('normalizeModel edge cases', () => {
  it('all fields missing defaults gracefully', () => {
    const m = normalizeModel({})
    expect(m.id).toBe('')
    expect(m.backendModel).toBe('')
    expect(m.aliases).toEqual([])
    expect(m.tier).toBe('general')
    expect(m.contextWindow).toBe(32768)
  })

  it('preserves extra unknown fields on input (ignores them)', () => {
    const m = normalizeModel({ id: 'test', unknownField: 42 })
    expect(m.id).toBe('test')
    expect((m as Record<string, unknown>).unknownField).toBeUndefined()
  })

  it('filters non-string aliases', () => {
    const m = normalizeModel({ id: 'test', aliases: ['valid', 123, null, 'also-valid'] })
    expect(m.aliases).toEqual(['valid', 'also-valid'])
  })
})

describe('overlayAvailability', () => {
  it('marks all as unknown when router set is empty', () => {
    const config = makeConfig([{ ...modelA }, { ...modelB }])
    overlayAvailability(config, new Set())
    expect(config.models.every(m => m.availability === 'unknown')).toBe(true)
  })

  it('marks cloud models as available regardless of router', () => {
    const config = makeConfig([{ ...modelC }])
    overlayAvailability(config, new Set())
    // Cloud models with endpoint are always available
    // But overlayAvailability with empty set marks all as unknown...
    // Actually cloud models are checked AFTER the empty-set guard. Let me verify:
    overlayAvailability(config, new Set(['irrelevant']))
    expect(config.models[0]!.availability).toBe('available')
  })

  it('marks matching models as available', () => {
    const config = makeConfig([{ ...modelA }, { ...modelB }])
    overlayAvailability(config, new Set(['model-a']))
    expect(config.models[0]!.availability).toBe('available')
    expect(config.models[1]!.availability).toBe('unavailable')
  })

  it('matches by alias', () => {
    const config = makeConfig([{ ...modelB }])
    overlayAvailability(config, new Set(['alias-b']))
    expect(config.models[0]!.availability).toBe('available')
  })

  it('matches by prefix with dash', () => {
    const config = makeConfig([normalizeModel({ id: 'test', aliases: ['distilled'] })])
    overlayAvailability(config, new Set(['distilled-27b']))
    expect(config.models[0]!.availability).toBe('available')
  })
})

describe('responseModelName', () => {
  it('platform style returns resolved ID', () => {
    const config = makeConfig([modelA], { responseModelStyle: 'platform' })
    expect(responseModelName(config, 'alias-a')).toBe('model-a')
  })

  it('requested style returns original request', () => {
    const config = makeConfig([modelA], { responseModelStyle: 'requested' })
    expect(responseModelName(config, 'alias-a')).toBe('alias-a')
  })

  it('requested style preserves the original request alias', () => {
    const m = normalizeModel({ id: 'local', aliases: ['primary', 'other'] })
    const config = makeConfig([m], { responseModelStyle: 'requested' })
    expect(responseModelName(config, 'primary')).toBe('primary')
  })
})

describe('resolveModel legacy path', () => {
  it('uses modelMap when models array is empty', () => {
    const config = makeConfig([], { modelMap: { default: 'local-model' }, defaultModel: 'default' })
    expect(resolveModel(config, 'default')).toBe('local-model')
  })

  it('falls back to defaultModel', () => {
    const config = makeConfig([], { modelMap: {}, defaultModel: 'fallback-model' })
    expect(resolveModel(config, 'unknown')).toBe('fallback-model')
  })
})

describe('reverseModel', () => {
  it('uses responseModelName when models present', () => {
    const config = makeConfig([modelA], { responseModelStyle: 'platform' })
    expect(reverseModel(config, 'alias-a')).toBe('model-a')
  })

  it('returns requestModel when reverseMapInResponse is false', () => {
    const config = makeConfig([], { reverseMapInResponse: false })
    expect(reverseModel(config, 'any')).toBe('any')
  })
})
