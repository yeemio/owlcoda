/**
 * Tests for intent-based model routing.
 */

import { describe, it, expect } from 'vitest'
import { detectIntent, resolveIntentModel, routeByIntent, type Intent } from '../src/intent-router.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(models?: Array<{ id: string; tier: string; default?: boolean }>): OwlCodaConfig {
  const m = models ?? [
    { id: 'code-model', tier: 'production', default: true },
    { id: 'fast-model', tier: 'fast' },
    { id: 'heavy-model', tier: 'heavy' },
    { id: 'discovered-model', tier: 'discovered' },
  ]
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600_000,
    models: m.map(x => ({
      id: x.id,
      label: x.id,
      backendModel: x.id,
      aliases: [],
      tier: x.tier,
      default: x.default,
      contextWindow: 32768,
    })),
    responseModelStyle: 'platform',
    logLevel: 'info',
    catalogLoaded: false,
    middleware: {},
    modelMap: Object.fromEntries(m.map(x => [x.id, x.id])),
    defaultModel: m.find(x => x.default)?.id ?? m[0]?.id ?? '',
    reverseMapInResponse: true,
  }
}

// ─── detectIntent ───

describe('detectIntent', () => {
  it('detects code intent from tools', () => {
    const signal = detectIntent({ tools: [{ name: 'bash' }] })
    expect(signal.intent).toBe('code')
    expect(signal.confidence).toBe(0.8)
    expect(signal.source).toBe('tools')
  })

  it('detects code intent from system prompt', () => {
    const signal = detectIntent({ system: 'You are a code assistant and developer.' })
    expect(signal.intent).toBe('code')
    expect(signal.source).toBe('system_prompt')
  })

  it('detects analysis intent from system prompt', () => {
    const signal = detectIntent({ system: 'You are a research analyst. Analyze data carefully.' })
    expect(signal.intent).toBe('analysis')
  })

  it('detects search intent from system prompt', () => {
    const signal = detectIntent({ system: 'Search and find relevant information.' })
    expect(signal.intent).toBe('search')
  })

  it('detects code intent from user message', () => {
    const signal = detectIntent({
      messages: [
        { role: 'user', content: 'Please write code to sort an array.' },
      ],
    })
    expect(signal.intent).toBe('code')
    expect(signal.source).toBe('message_content')
  })

  it('detects analysis intent from user message', () => {
    const signal = detectIntent({
      messages: [
        { role: 'user', content: 'Analyze the performance metrics from this data.' },
      ],
    })
    expect(signal.intent).toBe('analysis')
  })

  it('returns default for generic messages', () => {
    const signal = detectIntent({
      messages: [
        { role: 'user', content: 'Hello, how are you?' },
      ],
    })
    expect(signal.intent).toBe('default')
    expect(signal.confidence).toBe(1.0)
    expect(signal.source).toBe('default')
  })

  it('handles empty body', () => {
    const signal = detectIntent({})
    expect(signal.intent).toBe('default')
  })

  it('tools take priority over system prompt', () => {
    const signal = detectIntent({
      tools: [{ name: 'editor' }],
      system: 'You analyze research papers.',
    })
    expect(signal.intent).toBe('code') // tools checked first
  })

  it('handles array system prompt', () => {
    const signal = detectIntent({
      system: [{ text: 'You are a programming expert.' }] as unknown,
    })
    expect(signal.intent).toBe('code')
  })

  it('handles array content blocks in messages', () => {
    const signal = detectIntent({
      messages: [
        { role: 'user', content: [{ text: 'Implement a binary search.' }] },
      ],
    })
    expect(signal.intent).toBe('code')
  })

  it('empty tools array does not trigger code intent', () => {
    const signal = detectIntent({ tools: [] })
    expect(signal.intent).toBe('default')
  })

  it('detects refactor intent from message', () => {
    const signal = detectIntent({
      messages: [{ role: 'user', content: 'Refactor this function to be cleaner.' }],
    })
    expect(signal.intent).toBe('code')
  })

  it('detects debug intent from message', () => {
    const signal = detectIntent({
      messages: [{ role: 'user', content: 'Debug this error: TypeError: undefined is not a function' }],
    })
    expect(signal.intent).toBe('code')
  })

  it('uses last user message for detection', () => {
    const signal = detectIntent({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'Fix the bug in line 42.' },
      ],
    })
    expect(signal.intent).toBe('code')
  })

  it('detects compare/explain as analysis', () => {
    const signal = detectIntent({
      messages: [{ role: 'user', content: 'Compare these two approaches and explain the tradeoffs.' }],
    })
    expect(signal.intent).toBe('analysis')
  })
})

// ─── resolveIntentModel ───

describe('resolveIntentModel', () => {
  it('resolves code intent to production tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'code')
    expect(modelId).toBe('code-model') // production tier
  })

  it('resolves fast intent to fast tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'fast')
    expect(modelId).toBe('fast-model')
  })

  it('resolves heavy intent to heavy tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'heavy')
    expect(modelId).toBe('heavy-model')
  })

  it('resolves default intent to production tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'default')
    expect(modelId).toBe('code-model')
  })

  it('falls back to default model when no tier match', () => {
    const config = makeConfig([
      { id: 'only-model', tier: 'custom', default: true },
    ])
    const modelId = resolveIntentModel(config, 'embedding')
    expect(modelId).toBe('only-model')
  })

  it('returns null for empty models', () => {
    const config = makeConfig([])
    const modelId = resolveIntentModel(config, 'code')
    expect(modelId).toBeNull()
  })

  it('resolves search intent to fast tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'search')
    expect(modelId).toBe('fast-model')
  })

  it('resolves analysis intent to heavy tier', () => {
    const config = makeConfig()
    const modelId = resolveIntentModel(config, 'analysis')
    expect(modelId).toBe('heavy-model')
  })
})

// ─── routeByIntent ───

describe('routeByIntent', () => {
  it('respects explicit model choice', () => {
    const config = makeConfig()
    const result = routeByIntent(config, { messages: [{ role: 'user', content: 'write code' }] }, 'my-model')
    expect(result.modelId).toBe('my-model')
    expect(result.overrodeExplicit).toBe(false)
  })

  it('routes code requests to production model', () => {
    const config = makeConfig()
    const result = routeByIntent(config, {
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'help me code' }],
    })
    expect(result.modelId).toBe('code-model')
    expect(result.intent).toBe('code')
  })

  it('routes generic requests to default model', () => {
    const config = makeConfig()
    const result = routeByIntent(config, {
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result.intent).toBe('default')
    expect(result.modelId).toBe('code-model') // default model
  })

  it('routes heavy requests to heavy model', () => {
    const config = makeConfig()
    const result = routeByIntent(config, {
      system: 'You are a deep research analyst.',
      messages: [{ role: 'user', content: 'Analyze this complex dataset.' }],
    })
    expect(result.intent).toBe('analysis')
    expect(result.modelId).toBe('heavy-model')
  })

  it('includes signal metadata in result', () => {
    const config = makeConfig()
    const result = routeByIntent(config, {
      tools: [{ name: 'editor' }],
    })
    expect(result.signal).toBeDefined()
    expect(result.signal.intent).toBe('code')
    expect(result.signal.confidence).toBe(0.8)
    expect(result.signal.source).toBe('tools')
  })

  it('handles empty config gracefully', () => {
    const config = makeConfig([])
    const result = routeByIntent(config, {
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result.modelId).toBe('')
  })
})
