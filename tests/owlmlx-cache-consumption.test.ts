/**
 * owlmlx prefix-cache integration contract (regression lock).
 *
 * owlmlx (the local MLX runtime) exposes an opt-in no-header automatic
 * prefix-cache lane (server env OWLMLX_SESSION_CACHE_AUTO_PREFIX_ENABLED=1).
 * Per its B-2 spec the intended downstream-consumer path is ZERO client change:
 * owlmlx reports prefix-cache hits using the STANDARD OpenAI-compatible field
 * `usage.prompt_tokens_details.cached_tokens` (and the Anthropic-compat
 * `cache_read_input_tokens`), and never fabricates the field when there is no
 * real hit. owlcoda is detected→routed as `openai_chat` (translate=true), so
 * owlmlx hits flow through translateResponse / StreamTranslator into owlcoda's
 * cacheRead accounting → /tokens and /cost.
 *
 * These tests lock that contract end-to-end so a future translate refactor
 * cannot silently break owlmlx cache visibility.
 */
import { describe, it, expect } from 'vitest'
import { translateResponse } from '../src/translate/response.js'
import { StreamTranslator } from '../src/translate/stream.js'
import type { OwlCodaConfig } from '../src/config.js'

const mockConfig: OwlCodaConfig = {
  port: 8019, host: '127.0.0.1', routerUrl: 'http://127.0.0.1:8066',
  routerTimeoutMs: 600000,
  models: [
    { id: 'owlmlx-local', label: 'owlmlx', backendModel: 'owlmlx-local', aliases: ['default'], tier: 'production', default: true },
  ],
  responseModelStyle: 'platform',
  catalogLoaded: false,
  modelMap: {}, defaultModel: '', reverseMapInResponse: true, logLevel: 'info',
  localRuntimeProtocol: 'openai_chat',
  middleware: {},
}

describe('owlmlx prefix-cache consumption contract', () => {
  it('non-stream: maps owlmlx cached_tokens → cache_read_input_tokens (disjoint from input)', () => {
    const result = translateResponse({
      id: 'cmpl', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 8,
        total_tokens: 1208,
        // owlmlx no-header auto-prefix hit, standard OpenAI field
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    }, 'default', mockConfig)
    expect(result.usage.cache_read_input_tokens).toBe(1024)
    expect(result.usage.input_tokens).toBe(176) // 1200 - 1024, kept disjoint
    expect(result.usage.cache_creation_input_tokens).toBe(0)
  })

  it('non-stream: no fabrication when owlmlx reports no hit (field absent)', () => {
    const result = translateResponse({
      id: 'cmpl', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 },
    }, 'default', mockConfig)
    expect(result.usage.cache_read_input_tokens).toBe(0)
    expect(result.usage.input_tokens).toBe(1200)
  })

  it('stream: maps owlmlx final-usage cached_tokens → cacheReadTokens', () => {
    const t = new StreamTranslator('default', 100)
    t.processLine(JSON.stringify({
      id: 'chunk', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    }))
    // owlmlx emits the cache hit in the final usage chunk (no-header auto lane)
    t.processLine(JSON.stringify({
      id: 'chunk', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    }))
    const usage = t.getFinalUsage()
    expect(usage.cacheReadTokens).toBe(1024)
    expect(usage.inputTokens).toBe(176)
    expect(usage.outputTokens).toBe(8)
  })
})
