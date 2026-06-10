/**
 * Tests for streaming path intent routing and cost header integration.
 */

import { describe, it, expect } from 'vitest'
import { routeByIntent } from '../src/intent-router.js'
import { estimateCost, formatCostEstimate } from '../src/cost-estimator.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(intentRouting = false): OwlCodaConfig {
  return {
    port: 8009,
    host: '127.0.0.1',
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 30000,
    models: [
      { id: 'code-model', backendModel: 'Qwen2.5-Coder-32B', tier: 'production', isDefault: true },
      { id: 'fast-model', backendModel: 'Qwen2.5-7B', tier: 'fast', isDefault: false },
    ],
    responseModelStyle: 'preserve',
    logLevel: 'warn',
    catalogLoaded: false,
    middleware: { intentRouting },
    modelMap: {},
    defaultModel: 'code-model',
    reverseMapInResponse: false,
  } as OwlCodaConfig
}

// ─── Stream intent routing ───

describe('stream intent routing', () => {
  it('resolves intent when intentRouting enabled', () => {
    const config = makeConfig(true)
    const body = {
      model: 'default-20250514',
      tools: [{ name: 'code_editor' }],
      messages: [{ role: 'user', content: 'Fix the bug' }],
      stream: true,
    }
    const result = routeByIntent(config, body)
    expect(result.intent).toBe('code')
    expect(result.modelId).toBe('code-model')
  })

  it('skips intent when intentRouting disabled', () => {
    const config = makeConfig(false)
    const mwCfg = config.middleware ?? {}
    let effectiveStreamModel = 'default-20250514'
    if (mwCfg.intentRouting) {
      const result = routeByIntent(config, { model: effectiveStreamModel, tools: [{}] })
      if (result.modelId !== effectiveStreamModel) effectiveStreamModel = result.modelId
    }
    expect(effectiveStreamModel).toBe('default-20250514')
  })

  it('generates intent header for stream responses', () => {
    const config = makeConfig(true)
    const body = {
      model: 'default-20250514',
      tools: [{ name: 'editor' }],
      stream: true,
    }
    const result = routeByIntent(config, body)
    const header = result.modelId !== body.model
      ? `${result.intent} (${result.signal.confidence.toFixed(2)})`
      : undefined
    expect(header).toBeDefined()
    expect(header).toContain('code')
  })
})

// ─── Stream cost tracking ───

describe('stream cost tracking', () => {
  it('computes cost from accumulated stream tokens', () => {
    // Simulates what happens after stream ends and translator reports usage
    const inputTokens = 2500
    const outputTokens = 1200
    const backendModel = 'Qwen2.5-Coder-32B'

    const cost = estimateCost(inputTokens, outputTokens, backendModel)
    expect(cost.totalCost).toBeGreaterThan(0)
    expect(cost.source).toBe('estimated') // 32B extracted from "Coder-32B"
  })

  it('formats cost for stream completion log', () => {
    const cost = estimateCost(5000, 3000, 'model-27B')
    const formatted = formatCostEstimate(cost)
    expect(formatted).toBeTruthy()
    expect(formatted).toContain('¥')
  })

  it('handles zero output tokens (empty stream)', () => {
    const cost = estimateCost(1000, 0, 'model-7B')
    expect(cost.outputCost).toBe(0)
    expect(cost.totalCost).toBeGreaterThan(0) // input cost only
  })
})

// ─── Stream headers construction ───

describe('stream response headers', () => {
  it('builds header object with optional intent', () => {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'x-owlcoda-served-by': 'Qwen2.5-32B',
    }
    const intentHeader = 'code (0.80)'
    if (intentHeader) headers['x-owlcoda-intent'] = intentHeader

    expect(headers['x-owlcoda-intent']).toBe('code (0.80)')
    expect(headers['Content-Type']).toBe('text/event-stream')
  })

  it('omits intent header when no intent detected', () => {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'x-owlcoda-served-by': 'Qwen2.5-32B',
    }
    const intentHeader: string | undefined = undefined
    if (intentHeader) headers['x-owlcoda-intent'] = intentHeader

    expect(headers['x-owlcoda-intent']).toBeUndefined()
  })
})
