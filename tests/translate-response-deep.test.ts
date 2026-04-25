/**
 * Deep translate-response tests — edge cases, multi-tool, model styles.
 * Complements the basic translate-response.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { translateResponse } from '../src/translate/response.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(overrides?: Partial<OwlCodaConfig>): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600000,
    models: [
      {
        id: 'distilled-27b',
        label: 'Qwen2.5 Coder 32B',
        backendModel: 'distilled-27b',
        aliases: ['default', 'distilled'],
        tier: 'production',
        default: true,
      },
      {
        id: 'qwen3-35b',
        label: 'Qwen 35B',
        backendModel: 'Qwen3.5-35B-A3B-4bit',
        aliases: ['fast'],
        tier: 'fast',
      },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'info',
    ...overrides,
  } as OwlCodaConfig
}

function makeOpenAIResp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  }
}

describe('translateResponse — edge cases', () => {
  it('generates unique message IDs', () => {
    const config = makeConfig()
    const r1 = translateResponse(makeOpenAIResp(), 'default', config)
    const r2 = translateResponse(makeOpenAIResp(), 'default', config)
    expect(r1.id).toMatch(/^msg_/)
    expect(r2.id).toMatch(/^msg_/)
    expect(r1.id).not.toBe(r2.id)
  })

  it('handles multiple tool_calls in one response', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } },
              { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"foo.txt"}' } },
              { id: 'call_3', type: 'function', function: { name: 'Write', arguments: '{"path":"bar.txt","content":"hello"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    expect(result.content).toHaveLength(3)
    expect(result.content.map((c: { type: string }) => c.type)).toEqual(['tool_use', 'tool_use', 'tool_use'])
    expect(result.stop_reason).toBe('tool_use')
  })

  it('handles mixed text + tool_calls', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Let me run that command.',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"pwd"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Let me run that command.' })
    expect(result.content[1]!.type).toBe('tool_use')
  })

  it('handles missing usage object gracefully', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({ usage: undefined })
    const result = translateResponse(resp, 'default', config)
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
    expect(result.usage.cache_creation_input_tokens).toBe(0)
    expect(result.usage.cache_read_input_tokens).toBe(0)
  })

  it('handles null finish_reason', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'streaming...' },
          finish_reason: null,
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    expect(result.stop_reason).toBe('end_turn')
  })

  it('handles unknown finish_reason string', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'content_filter',
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    expect(result.stop_reason).toBe('end_turn')
  })

  it('preserves tool call IDs from upstream', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_abc123', type: 'function', function: { name: 'Bash', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    expect(result.content[0]).toMatchObject({ type: 'tool_use', id: 'call_abc123', name: 'Bash' })
  })

  it('parses complex tool arguments JSON', () => {
    const config = makeConfig()
    const complexArgs = JSON.stringify({
      command: 'grep -r "pattern" src/',
      options: { recursive: true, ignoreCase: false },
      paths: ['/a', '/b', '/c'],
    })
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: complexArgs } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const result = translateResponse(resp, 'default', config)
    const toolBlock = result.content[0] as { type: string; input: Record<string, unknown> }
    expect(toolBlock.input.command).toBe('grep -r "pattern" src/')
    expect(toolBlock.input.paths).toEqual(['/a', '/b', '/c'])
  })

  it('handles malformed tool arguments JSON gracefully', () => {
    const config = makeConfig()
    const resp = makeOpenAIResp({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_bad', type: 'function', function: { name: 'Bash', arguments: '{not valid json' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })
    // Should not throw — gracefully degrades
    const result = translateResponse(resp, 'default', config)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]!.type).toBe('tool_use')
    const toolBlock = result.content[0] as { type: string; input: Record<string, unknown> }
    expect(toolBlock.input._raw).toBe('{not valid json')
  })

  it('always includes stop_sequence: null', () => {
    const config = makeConfig()
    const result = translateResponse(makeOpenAIResp(), 'default', config)
    expect(result.stop_sequence).toBeNull()
  })

  it('sets type to "message" and role to "assistant"', () => {
    const config = makeConfig()
    const result = translateResponse(makeOpenAIResp(), 'default', config)
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
  })
})

describe('translateResponse — responseModelStyle variants', () => {
  it('platform style returns configured model ID', () => {
    const config = makeConfig({ responseModelStyle: 'platform' })
    const result = translateResponse(makeOpenAIResp(), 'default', config)
    expect(result.model).toBe('distilled-27b')
  })

  it('requested style returns the alias as-is', () => {
    const config = makeConfig({ responseModelStyle: 'requested' })
    const result = translateResponse(makeOpenAIResp(), 'default', config)
    expect(result.model).toBe('default')
  })
})
