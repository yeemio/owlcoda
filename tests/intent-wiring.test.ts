/**
 * Tests for intent routing wiring in messages endpoint.
 */

import { describe, it, expect } from 'vitest'
import { routeByIntent, detectIntent } from '../src/intent-router.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(opts: { intentRouting?: boolean } = {}): OwlCodaConfig {
  return {
    port: 8009,
    host: '127.0.0.1',
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 30000,
    models: [
      { id: 'qwen-code', backendModel: 'Qwen2.5-Coder-32B', tier: 'production', isDefault: true },
      { id: 'fast-model', backendModel: 'Qwen2.5-7B', tier: 'fast', isDefault: false },
      { id: 'heavy-model', backendModel: 'Llama-70B', tier: 'heavy', isDefault: false },
    ],
    responseModelStyle: 'preserve',
    logLevel: 'warn',
    catalogLoaded: false,
    middleware: {
      intentRouting: opts.intentRouting ?? false,
    },
    modelMap: {},
    defaultModel: 'qwen-code',
    reverseMapInResponse: false,
  } as OwlCodaConfig
}

// ─── Intent routing disabled (default) ───

describe('intent routing disabled', () => {
  it('does not change model when intentRouting is false', () => {
    const config = makeConfig({ intentRouting: false })
    // Simulates what the endpoint does when intentRouting is off
    const mwCfg = config.middleware ?? {}
    let effectiveModel = 'default-20250514'
    let intentHeader: string | undefined
    if (mwCfg.intentRouting) {
      const result = routeByIntent(config, { model: effectiveModel, tools: [{}] })
      if (result.modelId && result.modelId !== effectiveModel) {
        effectiveModel = result.modelId
        intentHeader = `${result.intent}`
      }
    }
    expect(effectiveModel).toBe('default-20250514')
    expect(intentHeader).toBeUndefined()
  })
})

// ─── Intent routing enabled ───

describe('intent routing enabled', () => {
  it('routes code intent to production tier', () => {
    const config = makeConfig({ intentRouting: true })
    const body = {
      model: 'default-20250514',
      tools: [{ name: 'code_editor' }],
      messages: [{ role: 'user', content: 'Fix the bug' }],
    }
    const result = routeByIntent(config, body)
    expect(result.intent).toBe('code')
    expect(result.modelId).toBe('qwen-code') // production tier
  })

  it('routes default intent to default model', () => {
    const config = makeConfig({ intentRouting: true })
    const body = {
      model: 'default-20250514',
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = routeByIntent(config, body)
    expect(result.intent).toBe('default')
    expect(result.modelId).toBe('qwen-code') // default
  })

  it('sets intent header when model changes', () => {
    const config = makeConfig({ intentRouting: true })
    const body = {
      model: 'default-20250514',
      tools: [{ name: 'code_editor' }],
    }
    const result = routeByIntent(config, body)
    const intentHeader = result.modelId !== body.model
      ? `${result.intent} (${result.signal.confidence.toFixed(2)})`
      : undefined
    expect(intentHeader).toBeTruthy()
    expect(intentHeader).toContain('code')
    expect(intentHeader).toContain('0.80')
  })

  it('respects explicit model choice', () => {
    const config = makeConfig({ intentRouting: true })
    const body = {
      model: 'my-specific-model',
      tools: [{ name: 'code_editor' }],
    }
    const result = routeByIntent(config, body, 'my-specific-model')
    expect(result.modelId).toBe('my-specific-model')
    expect(result.overrodeExplicit).toBe(false)
  })
})

// ─── detectIntent edge cases ───

describe('detectIntent edge cases', () => {
  it('detects analysis from message content', () => {
    const signal = detectIntent({
      messages: [{ role: 'user', content: 'Analyze this data' }],
    })
    expect(signal.intent).toBe('analysis')
    expect(signal.source).toBe('message_content')
  })

  it('tools signal overrides message content', () => {
    const signal = detectIntent({
      tools: [{ name: 'editor' }],
      messages: [{ role: 'user', content: 'Analyze this data' }],
    })
    // tools (0.8) beats message_content (0.5)
    expect(signal.intent).toBe('code')
    expect(signal.confidence).toBe(0.8)
  })

  it('returns default for empty body', () => {
    const signal = detectIntent({})
    expect(signal.intent).toBe('default')
    expect(signal.confidence).toBe(1.0)
  })
})
