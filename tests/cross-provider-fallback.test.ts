/**
 * Tests for cross-provider fallback chain ordering.
 */

import { describe, it, expect } from 'vitest'
import { buildFallbackChain, withFallback } from '../src/middleware/fallback.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(): OwlCodaConfig {
  return {
    port: 8009,
    host: '127.0.0.1',
    routerUrl: 'http://localhost:8009',
    routerTimeoutMs: 30000,
    models: [
      // Ollama models
      { id: 'ollama-qwen', backendModel: 'qwen2.5:32b', tier: 'production', endpoint: 'http://localhost:11434/v1/chat/completions' },
      { id: 'ollama-llama', backendModel: 'llama3.3:70b', tier: 'heavy', endpoint: 'http://localhost:11434/v1/chat/completions' },
      // LM Studio models
      { id: 'lms-coder', backendModel: 'qwen2.5-coder-32b', tier: 'production', endpoint: 'http://localhost:1234/v1/chat/completions' },
      { id: 'lms-small', backendModel: 'qwen2.5-7b', tier: 'fast', endpoint: 'http://localhost:1234/v1/chat/completions' },
      // vLLM model
      { id: 'vllm-70b', backendModel: 'meta-llama/Llama-3.3-70B', tier: 'heavy', endpoint: 'http://localhost:8000/v1/chat/completions' },
      // Router model (no endpoint)
      { id: 'router-model', backendModel: 'deepseek-r1', tier: 'balanced' },
    ],
    responseModelStyle: 'preserve',
    logLevel: 'warn',
    catalogLoaded: false,
    middleware: {},
    modelMap: {},
    defaultModel: 'ollama-qwen',
    reverseMapInResponse: false,
  } as OwlCodaConfig
}

describe('cross-provider fallback chain', () => {
  it('puts different-backend models before same-backend', () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')

    // First is always the requested model
    expect(chain[0]).toBe('ollama-qwen')

    // Find positions of same-backend (ollama) vs different-backend models
    const ollamaLlamaIdx = chain.indexOf('ollama-llama')
    const lmsCoderIdx = chain.indexOf('lms-coder')
    const lmsSmallIdx = chain.indexOf('lms-small')
    const vllm70bIdx = chain.indexOf('vllm-70b')

    // Different-backend models should come before same-backend
    expect(lmsCoderIdx).toBeLessThan(ollamaLlamaIdx)
    expect(vllm70bIdx).toBeLessThan(ollamaLlamaIdx)
    expect(lmsSmallIdx).toBeLessThan(ollamaLlamaIdx)
  })

  it('sorts by tier within each backend group', () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')

    // LM Studio models: production (lms-coder) before fast (lms-small)
    const lmsCoderIdx = chain.indexOf('lms-coder')
    const lmsSmallIdx = chain.indexOf('lms-small')
    expect(lmsCoderIdx).toBeLessThan(lmsSmallIdx)
  })

  it('treats no-endpoint models as different from endpoint models', () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')

    // router-model has no endpoint, different from ollama endpoint
    const routerIdx = chain.indexOf('router-model')
    const ollamaLlamaIdx = chain.indexOf('ollama-llama')
    expect(routerIdx).toBeLessThan(ollamaLlamaIdx)
  })

  it('includes all non-embedding models', () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')
    expect(chain).toHaveLength(6) // all 6 models
  })

  it('deduplicates requested model', () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')
    const count = chain.filter(m => m === 'ollama-qwen').length
    expect(count).toBe(1)
  })

  it('works when all models share the same endpoint', () => {
    const config = {
      ...makeConfig(),
      models: [
        { id: 'a', backendModel: 'a', tier: 'production', endpoint: 'http://localhost:11434/v1/chat/completions' },
        { id: 'b', backendModel: 'b', tier: 'fast', endpoint: 'http://localhost:11434/v1/chat/completions' },
        { id: 'c', backendModel: 'c', tier: 'heavy', endpoint: 'http://localhost:11434/v1/chat/completions' },
      ],
    } as OwlCodaConfig
    const chain = buildFallbackChain(config, 'a')
    expect(chain[0]).toBe('a')
    // All same-backend, sorted by tier
    expect(chain[1]).toBe('b') // fast (2) before heavy (3)
    expect(chain[2]).toBe('c')
  })
})

describe('cross-provider fallback execution', () => {
  it('falls back to different backend on failure', async () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')

    const attempted: string[] = []
    const result = await withFallback(chain, async (modelId) => {
      attempted.push(modelId)
      // Ollama fails, LM Studio succeeds
      if (modelId.startsWith('ollama') || modelId === 'router-model') {
        return new Response('', { status: 500 })
      }
      return new Response('ok', { status: 200 })
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.servedBy).toMatch(/^lms-|^vllm-/)
    expect(attempted[0]).toBe('ollama-qwen')
  })

  it('uses same-backend fallback when different-backend also fails', async () => {
    const config = makeConfig()
    const chain = buildFallbackChain(config, 'ollama-qwen')

    const result = await withFallback(chain, async (modelId) => {
      // Only ollama-llama succeeds (same backend, but last resort)
      if (modelId === 'ollama-llama') {
        return new Response('ok', { status: 200 })
      }
      return new Response('', { status: 500 })
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.servedBy).toBe('ollama-llama')
  })
})
