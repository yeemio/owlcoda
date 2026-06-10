/**
 * Unit tests for the streaming → non-streaming fallback synthesizer.
 *
 * synthesizeSseFromResponse is the load-bearing piece — it converts a
 * non-streaming JSON response into a stream of canonical Anthropic SSE
 * events that downstream clients (anthropic-sdk, OpenAI translation
 * layer, etc) can consume identically to a real stream.
 *
 * Test approach: drive the function with a `WritableLike` that captures
 * each `write()` call. Each SSE frame is `event: <type>\ndata: <json>\n\n`,
 * so we split captured output on `\n\n` and parse each chunk to inspect
 * the event type + payload shape.
 */
import { describe, it, expect } from 'vitest'
import {
  buildNonStreamingRetryBody,
  isFallbackEnabled,
  synthesizeSseFromResponse,
} from '../../src/middleware/stream-fallback.js'
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
} from '../../src/types.js'

interface CapturedFrame {
  event: string
  data: Record<string, unknown>
}

function makeRes(): { res: import('node:http').ServerResponse; frames: CapturedFrame[] } {
  const buf: string[] = []
  const res = {
    write(chunk: string): boolean {
      buf.push(chunk)
      return true
    },
  } as unknown as import('node:http').ServerResponse
  const parse = (): CapturedFrame[] => {
    const out: CapturedFrame[] = []
    for (const chunk of buf) {
      // Each write is exactly one frame in our impl
      const match = chunk.match(/^event: (\S+)\ndata: (.+)\n\n$/s)
      if (!match) throw new Error(`malformed SSE frame: ${JSON.stringify(chunk)}`)
      out.push({ event: match[1]!, data: JSON.parse(match[2]!) })
    }
    return out
  }
  return {
    res,
    get frames() { return parse() },
  } as { res: import('node:http').ServerResponse; frames: CapturedFrame[] }
}

function mkResponse(
  content: AnthropicMessagesResponse['content'],
  overrides: Partial<AnthropicMessagesResponse> = {},
): AnthropicMessagesResponse {
  return {
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  }
}

describe('isFallbackEnabled', () => {
  it('defaults to true (no middleware block)', () => {
    expect(isFallbackEnabled(undefined)).toBe(true)
  })
  it('defaults to true (empty middleware block)', () => {
    expect(isFallbackEnabled({})).toBe(true)
  })
  it('respects explicit false', () => {
    expect(isFallbackEnabled({ streamFallbackToNonStreamingEnabled: false })).toBe(false)
  })
  it('respects explicit true', () => {
    expect(isFallbackEnabled({ streamFallbackToNonStreamingEnabled: true })).toBe(true)
  })
})

describe('buildNonStreamingRetryBody', () => {
  it('drops stream flag, keeps rest of body intact', () => {
    const body: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
      stream: true,
      temperature: 0.5,
    }
    const out = buildNonStreamingRetryBody(body)
    expect(out.stream).toBeUndefined()
    expect(out.model).toBe('m')
    expect(out.max_tokens).toBe(1024)
    expect(out.temperature).toBe(0.5)
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('handles body without stream flag (idempotent)', () => {
    const body: AnthropicMessagesRequest = {
      model: 'm',
      messages: [],
      max_tokens: 100,
    }
    const out = buildNonStreamingRetryBody(body)
    expect(out.stream).toBeUndefined()
  })
})

describe('synthesizeSseFromResponse — text-only response (user 17K-input case)', () => {
  it('emits canonical 6-event sequence for single text block', () => {
    const cap = makeRes()
    const resp = mkResponse([{ type: 'text', text: 'Hello world.' }])
    synthesizeSseFromResponse(cap.res, resp)
    const types = cap.frames.map(f => f.event)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('message_start carries id, model, role, input usage', () => {
    const cap = makeRes()
    const resp = mkResponse([{ type: 'text', text: 'a' }])
    synthesizeSseFromResponse(cap.res, resp)
    const start = cap.frames[0]!.data as {
      message: { id: string; model: string; role: string; usage: { input_tokens: number; output_tokens: number } }
    }
    expect(start.message.id).toBe('msg_x')
    expect(start.message.model).toBe('m')
    expect(start.message.role).toBe('assistant')
    expect(start.message.usage.input_tokens).toBe(100)
    expect(start.message.usage.output_tokens).toBe(0)  // delta lives in message_delta
  })

  it('content_block_delta carries full text as a single delta', () => {
    const cap = makeRes()
    const full = 'a long response text with many tokens'
    synthesizeSseFromResponse(cap.res, mkResponse([{ type: 'text', text: full }]))
    const delta = cap.frames.find(f => f.event === 'content_block_delta')!.data as {
      delta: { type: string; text: string }
    }
    expect(delta.delta.type).toBe('text_delta')
    expect(delta.delta.text).toBe(full)
  })

  it('message_delta carries stop_reason + output_tokens', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([{ type: 'text', text: 'x' }]))
    const md = cap.frames.find(f => f.event === 'message_delta')!.data as {
      delta: { stop_reason: string; stop_sequence: unknown }
      usage: { output_tokens: number }
    }
    expect(md.delta.stop_reason).toBe('end_turn')
    expect(md.delta.stop_sequence).toBe(null)
    expect(md.usage.output_tokens).toBe(50)
  })
})

describe('synthesizeSseFromResponse — multi-block content', () => {
  it('emits start/delta/stop per content block, indexed correctly', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]))
    const starts = cap.frames.filter(f => f.event === 'content_block_start')
    expect(starts.length).toBe(2)
    expect((starts[0]!.data as { index: number }).index).toBe(0)
    expect((starts[1]!.data as { index: number }).index).toBe(1)
  })
})

describe('synthesizeSseFromResponse — thinking blocks', () => {
  it('emits thinking_delta with full thinking text', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([
      { type: 'thinking', thinking: 'reasoning here' },
    ]))
    const delta = cap.frames.find(f => f.event === 'content_block_delta')!.data as {
      delta: { type: string; thinking: string }
    }
    expect(delta.delta.type).toBe('thinking_delta')
    expect(delta.delta.thinking).toBe('reasoning here')
  })
})

describe('synthesizeSseFromResponse — tool_use blocks', () => {
  it('emits input_json_delta with stringified input', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([
      { type: 'tool_use', id: 'tool_x', name: 'do_thing', input: { foo: 'bar', n: 42 } },
    ]))
    const start = cap.frames.find(f => f.event === 'content_block_start')!.data as {
      content_block: { type: string; id: string; name: string }
    }
    expect(start.content_block.type).toBe('tool_use')
    expect(start.content_block.id).toBe('tool_x')
    expect(start.content_block.name).toBe('do_thing')
    const delta = cap.frames.find(f => f.event === 'content_block_delta')!.data as {
      delta: { type: string; partial_json: string }
    }
    expect(delta.delta.type).toBe('input_json_delta')
    expect(JSON.parse(delta.delta.partial_json)).toEqual({ foo: 'bar', n: 42 })
  })

  it('handles tool_use with empty/undefined input', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([
      { type: 'tool_use', id: 'x', name: 'n', input: undefined as unknown as Record<string, unknown> },
    ]))
    const delta = cap.frames.find(f => f.event === 'content_block_delta')!.data as {
      delta: { partial_json: string }
    }
    expect(JSON.parse(delta.delta.partial_json)).toEqual({})
  })
})

describe('synthesizeSseFromResponse — defensive paths', () => {
  it('handles empty content array (yields only message_start + message_delta + message_stop)', () => {
    const cap = makeRes()
    synthesizeSseFromResponse(cap.res, mkResponse([]))
    expect(cap.frames.map(f => f.event)).toEqual([
      'message_start', 'message_delta', 'message_stop',
    ])
  })

  it('handles missing usage gracefully', () => {
    const cap = makeRes()
    const resp = mkResponse([{ type: 'text', text: 'x' }])
    delete (resp as Partial<AnthropicMessagesResponse>).usage
    synthesizeSseFromResponse(cap.res, resp)
    const start = cap.frames[0]!.data as {
      message: { usage: { input_tokens: number; output_tokens: number } }
    }
    expect(start.message.usage.input_tokens).toBe(0)
    const md = cap.frames.find(f => f.event === 'message_delta')!.data as {
      usage: { output_tokens: number }
    }
    expect(md.usage.output_tokens).toBe(0)
  })

  it('skips unknown block types silently (no error)', () => {
    const cap = makeRes()
    const resp = mkResponse([
      { type: 'text', text: 'kept' },
      // @ts-expect-error — intentionally bad type
      { type: 'image', source: { type: 'base64', media_type: 'png', data: '...' } },
      { type: 'text', text: 'also kept' },
    ])
    synthesizeSseFromResponse(cap.res, resp)
    const blockStops = cap.frames.filter(f => f.event === 'content_block_stop')
    expect(blockStops.length).toBe(2)  // only the two text blocks
  })
})

describe('synthesizeSseFromResponse — usage propagation', () => {
  it('passes cache_creation + cache_read tokens into message_start usage', () => {
    const cap = makeRes()
    const resp = mkResponse([{ type: 'text', text: 'x' }], {
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      },
    })
    synthesizeSseFromResponse(cap.res, resp)
    const usage = (cap.frames[0]!.data as {
      message: { usage: Record<string, number> }
    }).message.usage
    expect(usage.cache_creation_input_tokens).toBe(300)
    expect(usage.cache_read_input_tokens).toBe(400)
  })
})
