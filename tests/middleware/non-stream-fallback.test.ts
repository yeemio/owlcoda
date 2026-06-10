/**
 * Unit tests for the non-streaming → streaming fallback SSE assembler.
 *
 * The assembler walks Anthropic Messages streaming events and rebuilds
 * a single AnthropicMessagesResponse. Critical scenarios:
 *
 *   - message_start → fields propagate (id, model, role, usage)
 *   - text/thinking/tool_use deltas accumulate correctly
 *   - tool_use input_json_delta parses on stop
 *   - message_delta updates stop_reason + output_tokens
 *   - missing message_stop → null (incomplete stream)
 *   - error event mid-stream → null
 *   - malformed events → degrade gracefully
 *
 * We drive the assembler with a ReadableStream<Uint8Array> built from
 * literal SSE byte chunks. The byte format follows what real upstreams
 * emit: `event: <type>\ndata: <json>\n\n`.
 */
import { describe, it, expect } from 'vitest'
import {
  assembleJsonFromOpenAiSseStream,
  assembleJsonFromSseStream,
  buildStreamingRetryBody,
  isNonStreamFallbackEnabled,
} from '../../src/middleware/non-stream-fallback.js'
import type { AnthropicMessagesRequest } from '../../src/types.js'

/** Build a ReadableStream<Uint8Array> from a sequence of literal
 *  SSE event objects. Each object becomes one `event: TYPE\ndata:
 *  JSON\n\n` frame. */
function sseStreamFrom(events: Array<{ event?: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = events.map(e =>
    encoder.encode(
      `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`,
    ),
  )
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

describe('isNonStreamFallbackEnabled', () => {
  it('defaults to true (undefined middleware)', () => {
    expect(isNonStreamFallbackEnabled(undefined)).toBe(true)
  })
  it('defaults to true (empty middleware)', () => {
    expect(isNonStreamFallbackEnabled({})).toBe(true)
  })
  it('respects explicit false', () => {
    expect(isNonStreamFallbackEnabled({ nonStreamFallbackToStreamingEnabled: false })).toBe(false)
  })
  it('respects explicit true', () => {
    expect(isNonStreamFallbackEnabled({ nonStreamFallbackToStreamingEnabled: true })).toBe(true)
  })
})

describe('buildStreamingRetryBody', () => {
  it('sets stream:true on body', () => {
    const body: AnthropicMessagesRequest = {
      model: 'm', messages: [], max_tokens: 100,
    }
    expect(buildStreamingRetryBody(body).stream).toBe(true)
  })
  it('preserves all other fields', () => {
    const body: AnthropicMessagesRequest = {
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100, temperature: 0.5, top_p: 0.9, stop_sequences: ['STOP'],
    }
    const out = buildStreamingRetryBody(body)
    expect(out.model).toBe('m')
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.stop_sequences).toEqual(['STOP'])
  })
  it('overwrites existing stream:false', () => {
    const body: AnthropicMessagesRequest = {
      model: 'm', messages: [], max_tokens: 100, stream: false,
    }
    expect(buildStreamingRetryBody(body).stream).toBe(true)
  })
})

describe('assembleJsonFromSseStream — text-only (the 33K user case)', () => {
  it('assembles message_start + 1 text block + message_delta + message_stop', async () => {
    const stream = sseStreamFrom([
      { event: 'message_start', data: { type: 'message_start', message: {
        id: 'msg_x', type: 'message', role: 'assistant', content: [],
        model: 'kimi-code', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 33700, output_tokens: 0 },
      }}},
      { event: 'content_block_start', data: {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      }},
      { event: 'content_block_delta', data: {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      }},
      { event: 'content_block_delta', data: {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'world.' },
      }},
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 }},
      { event: 'message_delta', data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1400 },
      }},
      { event: 'message_stop', data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect(out!.id).toBe('msg_x')
    expect(out!.model).toBe('kimi-code')
    expect(out!.role).toBe('assistant')
    expect(out!.stop_reason).toBe('end_turn')
    expect(out!.usage.input_tokens).toBe(33700)
    expect(out!.usage.output_tokens).toBe(1400)
    expect(out!.content).toHaveLength(1)
    expect(out!.content[0]).toEqual({ type: 'text', text: 'Hello world.' })
  })
})

describe('assembleJsonFromSseStream — thinking block', () => {
  it('accumulates thinking_delta + signature_delta', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 10, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'reasoning ' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'continues.' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'signature_delta', signature: 'sig123' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 50 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect(out!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'reasoning continues.',
      signature: 'sig123',
    })
  })
})

describe('assembleJsonFromSseStream — tool_use block', () => {
  it('accumulates input_json_delta partial_json and parses on stop', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 10, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'tool_x', name: 'edit', input: {} }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '"/foo",' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '"text":"bar"}' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect(out!.content[0]).toEqual({
      type: 'tool_use',
      id: 'tool_x',
      name: 'edit',
      input: { path: '/foo', text: 'bar' },
    })
    expect(out!.stop_reason).toBe('tool_use')
  })

  it('falls back to empty input on malformed partial_json', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'fn', input: {} }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{garbage' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect((out!.content[0] as { input: Record<string, unknown> }).input).toEqual({})
  })
})

describe('assembleJsonFromSseStream — multi-block content', () => {
  it('preserves block order across indices', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'first' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'content_block_start', index: 1,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 1,
        delta: { type: 'text_delta', text: 'second' }}},
      { data: { type: 'content_block_stop', index: 1 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect(out!.content).toHaveLength(2)
    expect((out!.content[0] as { text: string }).text).toBe('first')
    expect((out!.content[1] as { text: string }).text).toBe('second')
  })
})

describe('assembleJsonFromSseStream — failure modes', () => {
  it('returns null when stream closes before message_stop', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'partial...' }}},
      // No content_block_stop, no message_delta, no message_stop
    ])
    expect(await assembleJsonFromSseStream(stream)).toBeNull()
  })

  it('returns null on error event mid-stream', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 },
      }}},
      { data: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' }}},
    ])
    expect(await assembleJsonFromSseStream(stream)).toBeNull()
  })

  it('returns null when model field is missing', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'x' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 }}},
      { data: { type: 'message_stop' }},
    ])
    expect(await assembleJsonFromSseStream(stream)).toBeNull()
  })

  it('synthesizes id when message_start lacks it', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        model: 'k', role: 'assistant', usage: { input_tokens: 1, output_tokens: 0 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'x' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect(out!.id).toMatch(/^msg_assembled_/)
  })

  it('ignores unknown event types (ping etc)', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'ping' }},
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant', usage: { input_tokens: 1, output_tokens: 0 },
      }}},
      { data: { type: 'unknown_thing', whatever: 1 }},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'kept' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out).not.toBeNull()
    expect((out!.content[0] as { text: string }).text).toBe('kept')
  })
})

describe('assembleJsonFromSseStream — usage propagation', () => {
  it('takes output_tokens from message_delta usage', async () => {
    const stream = sseStreamFrom([
      { data: { type: 'message_start', message: {
        id: 'm', model: 'k', role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 0,
          cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
      }}},
      { data: { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }}},
      { data: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'x' }}},
      { data: { type: 'content_block_stop', index: 0 }},
      { data: { type: 'message_delta',
        delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 250 }}},
      { data: { type: 'message_stop' }},
    ])
    const out = await assembleJsonFromSseStream(stream)
    expect(out!.usage.input_tokens).toBe(100)
    expect(out!.usage.output_tokens).toBe(250)
    expect(out!.usage.cache_creation_input_tokens).toBe(30)
    expect(out!.usage.cache_read_input_tokens).toBe(40)
  })
})

/**
 * 0.14.7 — OpenAI Chat Completion SSE protocol coverage. DeepSeek,
 * Kimi, Qwen, Moonshot etc all emit `{choices:[{delta:{content:"x"}}]}`
 * style chunks. The assembleJsonFromOpenAiSseStream variant pipes
 * them through StreamTranslator (same component handleMessagesStream
 * uses live) and assembles a normal AnthropicMessagesResponse out.
 *
 * Test approach: emit OpenAI SSE chunks ending in `[DONE]` (the
 * OpenAI streaming termination marker that triggers translator
 * flush) and verify the assembled JSON.
 */
function openAiSseStreamFrom(chunks: Array<Record<string, unknown> | '[DONE]'>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const frames = chunks.map(c =>
    encoder.encode(
      c === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(c)}\n\n`,
    ),
  )
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f)
      controller.close()
    },
  })
}

describe('assembleJsonFromOpenAiSseStream — OpenAI protocol fallback (deepseek/kimi/qwen)', () => {
  it('assembles text-only response from OpenAI delta chunks', async () => {
    const stream = openAiSseStreamFrom([
      // First chunk: role-only (OpenAI convention)
      { id: 'cc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]},
      { id: 'cc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }]},
      { id: 'cc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'world.' }, finish_reason: null }]},
      { id: 'cc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 33700, completion_tokens: 1400, total_tokens: 35100 }},
      '[DONE]',
    ])
    const out = await assembleJsonFromOpenAiSseStream(stream, 'deepseek-v4-pro', 33700)
    expect(out).not.toBeNull()
    expect(out!.role).toBe('assistant')
    expect(out!.content).toHaveLength(1)
    expect(out!.content[0]).toMatchObject({ type: 'text', text: 'Hello world.' })
    expect(out!.stop_reason).toBe('end_turn')
    // input_tokens comes from upstream usage when available (35100 case)
    // OR from the StreamTranslator estimate (33700) — either is acceptable
    expect(out!.usage.input_tokens).toBeGreaterThan(0)
    expect(out!.usage.output_tokens).toBeGreaterThan(0)
  })

  it('handles thinking-content (kimi/moonshot reasoning_content extension)', async () => {
    const stream = openAiSseStreamFrom([
      { id: 'cc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]},
      { id: 'cc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'thinking... ' }, finish_reason: null }]},
      { id: 'cc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'done.' }, finish_reason: null }]},
      { id: 'cc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Answer.' }, finish_reason: null }]},
      { id: 'cc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]},
      '[DONE]',
    ])
    const out = await assembleJsonFromOpenAiSseStream(stream, 'kimi-code', 1000)
    expect(out).not.toBeNull()
    // Expected: thinking block first, then text block
    const types = out!.content.map(b => b.type)
    expect(types).toContain('thinking')
    expect(types).toContain('text')
    const thinkingBlock = out!.content.find(b => b.type === 'thinking') as { thinking: string } | undefined
    expect(thinkingBlock?.thinking).toBe('thinking... done.')
    const textBlock = out!.content.find(b => b.type === 'text') as { text: string } | undefined
    expect(textBlock?.text).toBe('Answer.')
  })

  it('handles tool_calls (function-calling delta)', async () => {
    const stream = openAiSseStreamFrom([
      { id: 'cc-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }]},
      { id: 'cc-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'edit', arguments: '' }}],
      }, finish_reason: null }]},
      { id: 'cc-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"path":"/foo",' }}],
      }, finish_reason: null }]},
      { id: 'cc-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '"text":"bar"}' }}],
      }, finish_reason: null }]},
      { id: 'cc-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]},
      '[DONE]',
    ])
    const out = await assembleJsonFromOpenAiSseStream(stream, 'deepseek-v4-pro', 500)
    expect(out).not.toBeNull()
    const toolBlock = out!.content.find(b => b.type === 'tool_use') as {
      type: 'tool_use'; id: string; name: string; input: Record<string, unknown>
    } | undefined
    expect(toolBlock).toBeDefined()
    expect(toolBlock!.id).toBe('call_abc')
    expect(toolBlock!.name).toBe('edit')
    expect(toolBlock!.input).toEqual({ path: '/foo', text: 'bar' })
    expect(out!.stop_reason).toBe('tool_use')
  })

  it('returns null when stream closes without [DONE] (incomplete)', async () => {
    const stream = openAiSseStreamFrom([
      { id: 'cc-4', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }]},
      // No finish_reason chunk, no [DONE]
    ])
    expect(await assembleJsonFromOpenAiSseStream(stream, 'deepseek-v4-pro', 100)).toBeNull()
  })
})
