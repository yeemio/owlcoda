/**
 * Tests for mergeDiscoveredModels — the bridge between backend discovery
 * and OwlCoda's config system.
 */

import { describe, it, expect } from 'vitest'
import { mergeDiscoveredModels, loadConfig, type OwlCodaConfig } from '../src/config.js'
import type { DiscoveredModel } from '../src/backends/types.js'

function makeMinimalConfig(overrides?: Partial<OwlCodaConfig>): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600_000,
    models: [],
    responseModelStyle: 'platform',
    logLevel: 'info',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}

function makeDiscoveredModel(overrides?: Partial<DiscoveredModel>): DiscoveredModel {
  return {
    id: 'llama3.3:latest',
    label: 'Llama 3.3 70B Q4_K_M',
    backend: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    ...overrides,
  }
}

describe('mergeDiscoveredModels', () => {
  it('adds discovered models to empty config', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'llama3.3:latest', label: 'Llama 3.3' }),
      makeDiscoveredModel({ id: 'qwen2.5:32b', label: 'Qwen 2.5 32B', baseUrl: 'http://127.0.0.1:11434' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models).toHaveLength(2)
    expect(merged.models[0]!.id).toBe('llama3.3:latest')
    expect(merged.models[1]!.id).toBe('qwen2.5:32b')
  })

  it('sets endpoint to backend chatCompletions URL', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'test-model', baseUrl: 'http://127.0.0.1:11434' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models[0]!.endpoint).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('does not override existing models', () => {
    const config = makeMinimalConfig({
      models: [{
        id: 'llama3.3:latest',
        label: 'My Custom Llama',
        backendModel: 'llama3.3:latest',
        aliases: [],
        tier: 'production',
        contextWindow: 131072,
      }],
    })
    const discovered = [
      makeDiscoveredModel({ id: 'llama3.3:latest', label: 'Ollama Llama' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]!.label).toBe('My Custom Llama') // original preserved
  })

  it('appends new models while keeping existing ones', () => {
    const config = makeMinimalConfig({
      models: [{
        id: 'existing-model',
        label: 'Existing',
        backendModel: 'existing-model',
        aliases: [],
        tier: 'production',
        contextWindow: 32768,
      }],
    })
    const discovered = [
      makeDiscoveredModel({ id: 'new-model', label: 'New' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models).toHaveLength(2)
    expect(merged.models[0]!.id).toBe('existing-model')
    expect(merged.models[1]!.id).toBe('new-model')
  })

  it('updates modelMap with discovered models', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'test-model' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.modelMap['test-model']).toBe('test-model')
  })

  it('returns same config when no new models discovered', () => {
    const config = makeMinimalConfig({
      models: [{
        id: 'llama3.3:latest',
        label: 'Llama',
        backendModel: 'llama3.3:latest',
        aliases: [],
        tier: 'production',
        contextWindow: 32768,
      }],
    })
    const discovered = [
      makeDiscoveredModel({ id: 'llama3.3:latest' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged).toBe(config) // same reference — no changes
  })

  it('returns same config for empty discovered list', () => {
    const config = makeMinimalConfig()
    const merged = mergeDiscoveredModels(config, [])
    expect(merged).toBe(config)
  })

  it('uses contextWindow from discovered model', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'vllm-model', contextWindow: 131072 }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models[0]!.contextWindow).toBe(131072)
  })

  it('defaults contextWindow to 32768 when not provided', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'ollama-model', contextWindow: undefined }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models[0]!.contextWindow).toBe(32768)
  })

  it('sets tier to "discovered" for new models', () => {
    const config = makeMinimalConfig()
    const discovered = [makeDiscoveredModel({ id: 'auto-model' })]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models[0]!.tier).toBe('discovered')
  })

  it('handles multiple backends in one merge', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'ollama-model', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
      makeDiscoveredModel({ id: 'lmstudio-model', backend: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' }),
      makeDiscoveredModel({ id: 'vllm-model', backend: 'vllm', baseUrl: 'http://127.0.0.1:8000' }),
    ]
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models).toHaveLength(3)
    expect(merged.models[0]!.endpoint).toContain(':11434')
    expect(merged.models[1]!.endpoint).toContain(':1234')
    expect(merged.models[2]!.endpoint).toContain(':8000')
  })

  it('deduplicates by ID across backends', () => {
    const config = makeMinimalConfig()
    const discovered = [
      makeDiscoveredModel({ id: 'same-model', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
      makeDiscoveredModel({ id: 'same-model', backend: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' }),
    ]
    // mergeDiscoveredModels adds first one, skips duplicate
    const merged = mergeDiscoveredModels(config, discovered)
    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]!.endpoint).toContain(':11434') // first one wins
  })
})
