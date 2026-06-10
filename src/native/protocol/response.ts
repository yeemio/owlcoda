/**
 * OwlCoda Native Response Parser
 *
 * Parses Anthropic Messages API responses into structured AssistantResponse.
 */

import type {
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AssistantResponse,
} from './types.js'
import type { AnthropicThinkingBlock } from '../../types.js'

/** Parse a non-streaming Anthropic Messages API response. */
export function parseResponse(raw: AnthropicMessagesResponse): AssistantResponse {
  const thinkingBlocks: AnthropicThinkingBlock[] = []
  const textBlocks: AnthropicTextBlock[] = []
  const toolUseBlocks: AnthropicToolUseBlock[] = []

  for (const block of raw.content) {
    const type = (block as { type?: string }).type
    if (type === 'text') {
      textBlocks.push(block as AnthropicTextBlock)
    } else if (type === 'tool_use') {
      toolUseBlocks.push(block as AnthropicToolUseBlock)
    } else if (type === 'thinking') {
      // Thinking-model providers (e.g. kimi-for-coding) require the block
      // to round-trip on future turns. Keep it or the next request 400s
      // with "reasoning_content is missing".
      thinkingBlocks.push(block as unknown as AnthropicThinkingBlock)
    }
  }

  const text = textBlocks.map((b) => b.text).join('')

  return {
    thinkingBlocks,
    textBlocks,
    toolUseBlocks,
    stopReason: raw.stop_reason,
    usage: {
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
    },
    hasToolUse: toolUseBlocks.length > 0,
    text,
  }
}

/** Parse a raw JSON response body (handles error responses). */
export function parseResponseBody(body: unknown): AssistantResponse | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid response body' }
  }

  const obj = body as Record<string, unknown>

  // Check for error response
  if (obj['type'] === 'error') {
    const errObj = obj['error'] as Record<string, unknown> | undefined
    return { error: errObj?.['message'] as string ?? 'Unknown API error' }
  }

  // Must be a messages response
  if (obj['type'] !== 'message' || !Array.isArray(obj['content'])) {
    return { error: 'Unexpected response format' }
  }

  return parseResponse(obj as unknown as AnthropicMessagesResponse)
}

/** Type guard for error results. */
export function isErrorResult(
  result: AssistantResponse | { error: string },
): result is { error: string } {
  return 'error' in result
}
