import { describe, it, expect } from 'vitest'
import { translateResponse } from '../src/translate/response.js'
import type { OwlCodaConfig } from '../src/config.js'

const mockConfig: OwlCodaConfig = {
  port: 8019, host: '127.0.0.1', routerUrl: 'http://127.0.0.1:8009',
  routerTimeoutMs: 600000,
  models: [
    { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['default', 'distilled'], tier: 'production', default: true },
  ],
  responseModelStyle: 'platform',
  catalogLoaded: false,
  modelMap: {}, defaultModel: '', reverseMapInResponse: true, logLevel: 'info',
}

describe('translateResponse', () => {
  it('translates basic text response', () => {
    const result = translateResponse({
      id: 'chatcmpl-123', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }, 'default', mockConfig)
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.model).toBe('qwen2.5-coder:32b')
    expect(result.id).toMatch(/^msg_/)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
    expect(result.usage.cache_creation_input_tokens).toBe(0)
  })

  it('maps OpenAI cached_tokens to cache_read_input_tokens, excluding them from input_tokens', () => {
    const result = translateResponse({
      id: 'c', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }, 'default', mockConfig)
    // OpenAI prompt_tokens includes cached; Anthropic input_tokens excludes cache_read.
    expect(result.usage.cache_read_input_tokens).toBe(80)
    expect(result.usage.input_tokens).toBe(20)
    expect(result.usage.cache_creation_input_tokens).toBe(0)
  })

  it('reports zero cache when the provider omits prompt_tokens_details (feature-detect)', () => {
    const result = translateResponse({
      id: 'c', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
    }, 'default', mockConfig)
    expect(result.usage.cache_read_input_tokens).toBe(0)
    expect(result.usage.input_tokens).toBe(30)
  })

  it('maps tool_calls finish_reason', () => {
    const result = translateResponse({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }]
      }, finish_reason: 'tool_calls' }],
    }, 'default', mockConfig)
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].name).toBe('Bash')
      expect(result.content[0].input).toEqual({ cmd: 'ls' })
    }
  })

  it('maps length to max_tokens', () => {
    const result = translateResponse({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }],
    }, 'default', mockConfig)
    expect(result.stop_reason).toBe('max_tokens')
  })

  it('handles empty content with fallback', () => {
    const result = translateResponse({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    }, 'default', mockConfig)
    expect(result.content.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves Kimi reasoning_content as Anthropic thinking content', () => {
    const result = translateResponse({
      id: 'x', object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'pong', reasoning_content: 'thinking first' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }, 'default', mockConfig)
    expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'thinking first' })
    expect(result.content[1]).toEqual({ type: 'text', text: 'pong' })
  })
})
