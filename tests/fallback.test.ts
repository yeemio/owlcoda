import { describe, it, expect } from 'vitest'
import { buildFallbackChain, withFallback } from '../src/middleware/fallback.js'
import type { OwlCodaConfig } from '../src/config.js'

function mockConfig(models: Array<{ id: string; tier: string }>): OwlCodaConfig {
  return {
    models: models.map(m => ({
      id: m.id,
      label: m.id,
      backendModel: m.id,
      aliases: [],
      tier: m.tier,
    })),
  } as any
}

function mockResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response
}

describe('buildFallbackChain', () => {
  it('puts requested model first', () => {
    const config = mockConfig([
      { id: 'model-a', tier: 'fast' },
      { id: 'model-b', tier: 'balanced' },
      { id: 'model-c', tier: 'heavy' },
    ])
    const chain = buildFallbackChain(config, 'model-c')
    expect(chain[0]).toBe('model-c')
  })

  it('orders fallbacks by tier priority', () => {
    const config = mockConfig([
      { id: 'heavy', tier: 'heavy' },
      { id: 'fast', tier: 'fast' },
      { id: 'balanced', tier: 'balanced' },
    ])
    const chain = buildFallbackChain(config, 'heavy')
    expect(chain).toEqual(['heavy', 'balanced', 'fast'])
  })

  it('excludes embedding models', () => {
    const config = mockConfig([
      { id: 'model-a', tier: 'balanced' },
      { id: 'embed', tier: 'embedding' },
    ])
    const chain = buildFallbackChain(config, 'model-a')
    expect(chain).not.toContain('embed')
  })
})

describe('withFallback', () => {
  it('returns first model on success', async () => {
    const result = await withFallback(
      ['a', 'b'],
      () => Promise.resolve(mockResponse(200)),
    )
    expect(result.servedBy).toBe('a')
    expect(result.fallbackUsed).toBe(false)
  })

  it('falls back on 500', async () => {
    let calls = 0
    const result = await withFallback(
      ['a', 'b'],
      (model) => {
        calls++
        if (model === 'a') return Promise.resolve(mockResponse(500))
        return Promise.resolve(mockResponse(200))
      },
    )
    expect(result.servedBy).toBe('b')
    expect(result.fallbackUsed).toBe(true)
    expect(calls).toBe(2)
  })

  it('does not fall back on 400', async () => {
    const result = await withFallback(
      ['a', 'b'],
      () => Promise.resolve(mockResponse(400)),
    )
    expect(result.servedBy).toBe('a')
    expect(result.fallbackUsed).toBe(false)
  })

  it('returns the last failing response when all models exhaust', async () => {
    // Behavior changed in the kimi provider-error round: rather than throwing
    // (which lost the upstream status/headers and forced callers to guess),
    // withFallback now returns the last non-ok response so the caller can
    // produce a proper structured diagnostic + Anthropic error mapping.
    const result = await withFallback(
      ['a', 'b'],
      () => Promise.resolve(mockResponse(500)),
    )
    expect(result.response.ok).toBe(false)
    expect(result.response.status).toBe(500)
    expect(result.attemptedModels).toEqual(['a', 'b'])
    expect(result.fallbackUsed).toBe(true)
  })

  it('skips unhealthy models via healthFilter', async () => {
    const attempted: string[] = []
    const result = await withFallback(
      ['a', 'b', 'c'],
      (model) => {
        attempted.push(model)
        if (model === 'a') return Promise.resolve(mockResponse(500))
        return Promise.resolve(mockResponse(200))
      },
      (model) => model !== 'b', // b is unhealthy
    )
    expect(result.servedBy).toBe('c')
    expect(attempted).not.toContain('b')
  })
})
