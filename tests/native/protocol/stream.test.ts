import { describe, it, expect } from 'vitest'
import {
  createAccumulator,
  parseSSE,
  processEvent,
  finalizeStream,
} from '../../../src/native/protocol/stream.js'

describe('Native Protocol — SSE Stream Consumer', () => {
  // ── parseSSE ──

  it('parses a single SSE event', () => {
    const events = parseSSE('event: message_start\ndata: {"type":"message_start"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message_start')
    expect(events[0]!.data).toBe('{"type":"message_start"}')
  })

  it('parses SSE fields without a space after the colon', () => {
    const events = parseSSE('event:message_start\ndata:{"type":"message_start"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message_start')
    expect(events[0]!.data).toBe('{"type":"message_start"}')
  })

  it('parses multiple SSE events', () => {
    const raw = [
      'event: message_start\ndata: {"type":"message_start"}\n',
      'event: content_block_delta\ndata: {"type":"delta"}\n',
    ].join('\n')
    const events = parseSSE(raw)
    expect(events).toHaveLength(2)
  })

  it('parses CRLF-delimited SSE events', () => {
    const raw = 'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\r\n\r\n'
    const events = parseSSE(raw)
    expect(events).toHaveLength(2)
    expect(events[0]!.event).toBe('message_start')
    expect(events[1]!.event).toBe('content_block_delta')
  })

  it('handles empty chunks', () => {
    const events = parseSSE('')
    expect(events).toHaveLength(0)
  })

  it('handles data without event field', () => {
    const events = parseSSE('data: {"foo":"bar"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('message')
  })

  it('falls back to the payload type for data-only Anthropic events', () => {
    const acc = createAccumulator()
    const result = processEvent(acc, {
      event: 'message',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' },
      }),
    })
    expect(result.textDelta).toBe('Hi')
    expect(acc.textParts).toEqual(['Hi'])
  })

  it('ignores [DONE] sentinel in processEvent', () => {
    const acc = createAccumulator()
    const result = processEvent(acc, { event: 'message', data: '[DONE]' })
    expect(result).toEqual({})
  })

  // ── processEvent: message_start ──

  it('extracts input tokens from message_start', () => {
    const acc = createAccumulator()
    processEvent(acc, {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 42 } },
      }),
    })
    expect(acc.inputTokens).toBe(42)
  })

  // ── processEvent: content_block_start (tool_use) ──

  it('starts a tool use block', () => {
    const acc = createAccumulator()
    const result = processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_1', name: 'bash' },
      }),
    })
    expect(result.toolName).toBe('bash')
    expect(acc.toolUseBlocks).toHaveLength(1)
    expect(acc.toolUseBlocks[0]!.name).toBe('bash')
  })

  it('captures text emitted directly in content_block_start', () => {
    const acc = createAccumulator()
    const result = processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'text', text: 'Hello' },
      }),
    })
    expect(result.textDelta).toBe('Hello')
    expect(acc.textParts).toEqual(['Hello'])
  })

  // ── processEvent: content_block_delta (text) ──

  it('accumulates text deltas', () => {
    const acc = createAccumulator()
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' World' },
      }),
    })
    expect(acc.textParts).toEqual(['Hello', ' World'])
  })

  // ── processEvent: content_block_delta (input_json) ──

  it('accumulates tool input JSON deltas', () => {
    const acc = createAccumulator()
    // Start a tool block first
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        content_block: { type: 'tool_use', id: 'c1', name: 'bash' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        delta: { type: 'input_json_delta', partial_json: '{"com' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        delta: { type: 'input_json_delta', partial_json: 'mand":"ls"}' },
      }),
    })
    expect(acc.toolUseBlocks[0]!.inputJson).toBe('{"command":"ls"}')
  })

  // ── processEvent: message_delta ──

  it('captures stop reason and output tokens', () => {
    const acc = createAccumulator()
    processEvent(acc, {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 25 },
      }),
    })
    expect(acc.stopReason).toBe('end_turn')
    expect(acc.outputTokens).toBe(25)
  })

  // ── finalizeStream ──

  it('produces a complete AssistantResponse from text-only stream', () => {
    const acc = createAccumulator()
    acc.textParts.push('Hello', ' from', ' stream')
    acc.stopReason = 'end_turn'
    acc.inputTokens = 10
    acc.outputTokens = 5

    const response = finalizeStream(acc)
    expect(response.text).toBe('Hello from stream')
    expect(response.textBlocks).toHaveLength(1)
    expect(response.toolUseBlocks).toHaveLength(0)
    expect(response.hasToolUse).toBe(false)
    expect(response.stopReason).toBe('end_turn')
  })

  it('produces response with tool use from stream', () => {
    const acc = createAccumulator()
    acc.textParts.push('Let me check.')
    acc.toolUseBlocks.push({
      id: 'call_1',
      name: 'bash',
      inputJson: '{"command":"pwd"}',
    })
    acc.stopReason = 'tool_use'

    const response = finalizeStream(acc)
    expect(response.text).toBe('Let me check.')
    expect(response.hasToolUse).toBe(true)
    expect(response.toolUseBlocks).toHaveLength(1)
    expect(response.toolUseBlocks[0]!.name).toBe('bash')
    expect(response.toolUseBlocks[0]!.input).toEqual({ command: 'pwd' })
  })

  it('handles malformed tool input JSON gracefully', () => {
    const acc = createAccumulator()
    acc.toolUseBlocks.push({
      id: 'call_1',
      name: 'bash',
      inputJson: '{invalid json',
    })

    const response = finalizeStream(acc)
    expect(response.toolUseBlocks[0]!.input).toEqual({})
  })

  it('handles empty stream', () => {
    const acc = createAccumulator()
    const response = finalizeStream(acc)
    expect(response.text).toBe('')
    expect(response.textBlocks).toHaveLength(0)
    expect(response.hasToolUse).toBe(false)
  })

  // ── Full event sequence simulation ──

  it('handles a full text conversation stream', () => {
    const acc = createAccumulator()

    // Simulate a full streaming sequence
    processEvent(acc, {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 15 } },
      }),
    })
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'text', text: '' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        delta: { type: 'text_delta', text: 'The answer is ' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        delta: { type: 'text_delta', text: '42.' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop' }),
    })
    processEvent(acc, {
      event: 'message_delta',
      data: JSON.stringify({
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 6 },
      }),
    })

    const response = finalizeStream(acc)
    expect(response.text).toBe('The answer is 42.')
    expect(response.usage.inputTokens).toBe(15)
    expect(response.usage.outputTokens).toBe(6)
    expect(response.stopReason).toBe('end_turn')
  })

  it('handles split SSE data across chunks', () => {
    // Simulate data arriving in two partial chunks
    const chunk1 = 'event: content_block_delta\nda'
    const chunk2 = 'ta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'
    const events1 = parseSSE(chunk1)
    // Partial data — no complete event yet
    expect(events1).toHaveLength(0)
    // Second chunk completes the event
    const events2 = parseSSE(chunk1 + chunk2)
    expect(events2.length).toBeGreaterThanOrEqual(1)
  })

  it('handles message_start + message_stop with no content (empty response)', () => {
    const acc = createAccumulator()
    processEvent(acc, {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 100 } },
      }),
    })
    processEvent(acc, {
      event: 'message_delta',
      data: JSON.stringify({
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      }),
    })
    const response = finalizeStream(acc)
    expect(response.text).toBe('')
    expect(response.usage.inputTokens).toBe(100)
    expect(response.usage.outputTokens).toBe(0)
    expect(response.hasToolUse).toBe(false)
  })

  it('accumulates multiple tool_use blocks', () => {
    const acc = createAccumulator()
    // First tool
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool_1', name: 'bash' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop' }),
    })
    // Second tool
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool_2', name: 'read' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp"}' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop' }),
    })
    const response = finalizeStream(acc)
    expect(response.hasToolUse).toBe(true)
    expect(response.toolUseBlocks).toHaveLength(2)
    expect(response.toolUseBlocks[0]!.name).toBe('bash')
    expect(response.toolUseBlocks[1]!.name).toBe('read')
  })

  it('handles thinking content blocks', () => {
    const acc = createAccumulator()
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me consider...' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop' }),
    })
    processEvent(acc, {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'text' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'The answer is 42.' },
      }),
    })
    processEvent(acc, {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop' }),
    })
    const response = finalizeStream(acc)
    expect(response.text).toBe('The answer is 42.')
  })
})
