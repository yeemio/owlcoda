/**
 * Tests for model recommendation engine.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { recommendModel, formatRecommendation, type Intent } from '../src/model-recommender.js'
import { recordRequestMetrics, resetModelMetrics } from '../src/perf-tracker.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(models: Array<{ id: string; backendModel: string }>): OwlCodaConfig {
  return {
    routerUrl: 'http://localhost:8009',
    host: '127.0.0.1',
    port: 4011,
    models: models.map(m => ({
      id: m.id,
      backendModel: m.backendModel,
      displayName: m.id,
    })),
    modelMap: Object.fromEntries(models.map(m => [m.id, m.backendModel])),
  } as OwlCodaConfig
}

beforeEach(() => resetModelMetrics())

describe('model recommendation', () => {
  it('returns recommendation for code intent', () => {
    const config = makeConfig([
      { id: 'coder-7B', backendModel: 'Qwen2.5-Coder-7B-instruct' },
      { id: 'chat-7B', backendModel: 'Qwen2.5-7B-chat' },
    ])
    const rec = recommendModel(config, 'code')
    expect(rec.intent).toBe('code')
    expect(rec.recommended.modelId).toBe('coder-7B') // "coder" keyword match
    expect(rec.recommended.score).toBeGreaterThan(50)
  })

  it('prefers larger models for code tasks', () => {
    const config = makeConfig([
      { id: 'small-coder', backendModel: 'Coder-7B' },
      { id: 'large-coder', backendModel: 'Coder-70B' },
    ])
    const rec = recommendModel(config, 'code')
    // Both match "coder", but large-coder gets model size bonus
    expect(rec.recommended.modelId).toBe('large-coder')
  })

  it('prefers cost-efficient models for chat', () => {
    const config = makeConfig([
      { id: 'small', backendModel: 'chat-7B' },
      { id: 'large', backendModel: 'chat-70B' },
    ])
    const rec = recommendModel(config, 'chat')
    // Both match "chat", but small gets cost-efficient bonus
    expect(rec.recommended.modelId).toBe('small')
  })

  it('boosts models with good perf data', () => {
    const config = makeConfig([
      { id: 'fast-model', backendModel: 'model-a-7B' },
      { id: 'slow-model', backendModel: 'model-b-7B' },
    ])

    // Record fast perf for model-a
    recordRequestMetrics({ modelId: 'fast-model', inputTokens: 100, outputTokens: 500, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'fast-model', inputTokens: 100, outputTokens: 500, durationMs: 500, success: true })

    // Record slow perf for model-b
    recordRequestMetrics({ modelId: 'slow-model', inputTokens: 100, outputTokens: 50, durationMs: 5000, success: true })
    recordRequestMetrics({ modelId: 'slow-model', inputTokens: 100, outputTokens: 50, durationMs: 5000, success: true })

    const rec = recommendModel(config, 'general')
    expect(rec.recommended.modelId).toBe('fast-model')
  })

  it('penalizes models with low success rate', () => {
    const config = makeConfig([
      { id: 'reliable', backendModel: 'model-x-7B' },
      { id: 'unreliable', backendModel: 'model-y-7B' },
    ])

    // Reliable: 2 successes
    recordRequestMetrics({ modelId: 'reliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'reliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: true })

    // Unreliable: 1 success, 3 failures
    recordRequestMetrics({ modelId: 'unreliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'unreliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: false })
    recordRequestMetrics({ modelId: 'unreliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: false })
    recordRequestMetrics({ modelId: 'unreliable', inputTokens: 100, outputTokens: 50, durationMs: 500, success: false })

    const rec = recommendModel(config, 'general')
    expect(rec.recommended.modelId).toBe('reliable')
  })

  it('returns alternatives sorted by score', () => {
    const config = makeConfig([
      { id: 'model-a', backendModel: 'a-7B' },
      { id: 'model-b', backendModel: 'b-7B' },
      { id: 'model-c', backendModel: 'c-7B' },
    ])
    const rec = recommendModel(config, 'general')
    expect(rec.alternatives.length).toBeLessThanOrEqual(3)
    if (rec.alternatives.length >= 2) {
      expect(rec.alternatives[0]!.score).toBeGreaterThanOrEqual(rec.alternatives[1]!.score)
    }
  })

  it('handles empty model list', () => {
    const config = makeConfig([])
    const rec = recommendModel(config, 'code')
    expect(rec.recommended.modelId).toBe('none')
    expect(rec.recommended.score).toBe(0)
  })

  it('formats recommendation for display', () => {
    const config = makeConfig([
      { id: 'coder', backendModel: 'Qwen2.5-Coder-7B' },
    ])
    const rec = recommendModel(config, 'code')
    const output = formatRecommendation(rec)
    expect(output).toContain('Intent: code')
    expect(output).toContain('Recommended: coder')
  })

  it('validates all intent types', () => {
    const config = makeConfig([
      { id: 'model-a', backendModel: 'model-7B' },
    ])
    const intents: Intent[] = ['code', 'analysis', 'search', 'chat', 'general']
    for (const intent of intents) {
      const rec = recommendModel(config, intent)
      expect(rec.intent).toBe(intent)
      expect(rec.recommended).toBeTruthy()
    }
  })
})
