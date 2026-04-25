import { describe, it, expect } from 'vitest'
import { parseResponse, parseResponseBody, isErrorResult } from '../../../src/native/protocol/response.js'
import type { AnthropicMessagesResponse } from '../../../src/native/protocol/types.js'

describe('Native Protocol — Response Parser', () => {
  const textResponse: AnthropicMessagesResponse = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'default',
    content: [
      { type: 'text', text: 'Hello! How can I help?' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8 },
  }

  const toolResponse: AnthropicMessagesResponse = {
    id: 'msg_456',
    type: 'message',
    role: 'assistant',
    model: 'default',
    content: [
      { type: 'text', text: 'Let me check that.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'bash',
        input: { command: 'ls' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 15 },
  }

  // ── parseResponse ──

  it('parses text-only response', () => {
    const result = parseResponse(textResponse)
    expect(result.text).toBe('Hello! How can I help?')
    expect(result.textBlocks).toHaveLength(1)
    expect(result.toolUseBlocks).toHaveLength(0)
    expect(result.hasToolUse).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(8)
  })

  it('parses tool_use response', () => {
    const result = parseResponse(toolResponse)
    expect(result.text).toBe('Let me check that.')
    expect(result.toolUseBlocks).toHaveLength(1)
    expect(result.toolUseBlocks[0]!.name).toBe('bash')
    expect(result.toolUseBlocks[0]!.input).toEqual({ command: 'ls' })
    expect(result.hasToolUse).toBe(true)
    expect(result.stopReason).toBe('tool_use')
  })

  it('handles empty content', () => {
    const empty: AnthropicMessagesResponse = {
      ...textResponse,
      content: [],
    }
    const result = parseResponse(empty)
    expect(result.text).toBe('')
    expect(result.hasToolUse).toBe(false)
  })

  // ── parseResponseBody ──

  it('parses valid response body', () => {
    const result = parseResponseBody(textResponse)
    expect(isErrorResult(result)).toBe(false)
    if (!isErrorResult(result)) {
      expect(result.text).toBe('Hello! How can I help?')
    }
  })

  it('parses error response body', () => {
    const errorBody = {
      type: 'error',
      error: { type: 'api_error', message: 'Server error' },
    }
    const result = parseResponseBody(errorBody)
    expect(isErrorResult(result)).toBe(true)
    if (isErrorResult(result)) {
      expect(result.error).toBe('Server error')
    }
  })

  it('returns error for null body', () => {
    const result = parseResponseBody(null)
    expect(isErrorResult(result)).toBe(true)
  })

  it('returns error for unexpected format', () => {
    const result = parseResponseBody({ type: 'unknown', content: 'wat' })
    expect(isErrorResult(result)).toBe(true)
  })

  // ── isErrorResult ──

  it('correctly identifies error vs success', () => {
    expect(isErrorResult({ error: 'fail' })).toBe(true)
    expect(isErrorResult(parseResponse(textResponse))).toBe(false)
  })
})
