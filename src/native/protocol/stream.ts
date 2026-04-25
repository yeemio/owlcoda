/**
 * OwlCoda Native SSE Stream Consumer
 *
 * Consumes Server-Sent Events from the Anthropic streaming API
 * and accumulates them into a complete AssistantResponse.
 */

import type {
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AssistantResponse,
  StreamAccumulator,
  StreamEvent,
} from './types.js'
import type { AnthropicThinkingBlock } from '../../types.js'

/** Create a fresh stream accumulator. */
export function createAccumulator(): StreamAccumulator {
  return {
    thinkingParts: [],
    textParts: [],
    toolUseBlocks: [],
    currentToolIndex: -1,
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0,
  }
}

/**
 * Parse raw SSE text into individual events.
 * Handles the `event: X\ndata: Y\n\n` format.
 */
export function parseSSE(chunk: string): StreamEvent[] {
  const events: StreamEvent[] = []
  const blocks = chunk.split(/\r?\n\r?\n/)

  for (const block of blocks) {
    if (!block.trim()) continue

    let event = 'message'
    let data = ''

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data: ')) {
        data = line.slice(6)
      } else if (line.startsWith('data:')) {
        data = line.slice(5)
      } else if (!data && line.startsWith('{')) {
        // Fallback: raw JSON line (some providers return JSON lines instead of SSE)
        try {
          const parsed = JSON.parse(line) as { type?: string }
          event = parsed.type ?? 'message'
          data = line
        } catch { /* not valid JSON, skip */ }
      }
    }

    if (data) {
      events.push({ event, data })
    }
  }

  return events
}

/**
 * Process a single SSE event and update the accumulator.
 * Returns a text delta if one was emitted (for real-time display).
 */
export function processEvent(
  acc: StreamAccumulator,
  sseEvent: StreamEvent,
): { textDelta?: string; toolName?: string; thinkingStart?: boolean; thinkingDelta?: string; thinkingEnd?: boolean } {
  if (sseEvent.data === '[DONE]') {
    return {}
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(sseEvent.data) as Record<string, unknown>
  } catch {
    return {}
  }

  const parsedType = typeof parsed['type'] === 'string' ? parsed['type'] as string : undefined
  const eventType = sseEvent.event && sseEvent.event !== 'message'
    ? sseEvent.event
    : (parsedType ?? sseEvent.event)

  // Anthropic SSE error events — surface instead of silently dropping
  if (eventType === 'error') {
    throw new Error(JSON.stringify(parsed))
  }

  switch (eventType) {
    case 'message_start': {
      const message = parsed['message'] as Record<string, unknown> | undefined
      const usage = message?.['usage'] as Record<string, number> | undefined
      if (usage) {
        acc.inputTokens = usage['input_tokens'] ?? 0
      }
      return {}
    }

    case 'content_block_start': {
      const contentBlock = parsed['content_block'] as Record<string, unknown> | undefined
      if (contentBlock?.['type'] === 'tool_use') {
        acc.currentToolIndex = acc.toolUseBlocks.length
        acc.toolUseBlocks.push({
          id: contentBlock['id'] as string,
          name: contentBlock['name'] as string,
          inputJson: '',
        })
        return { toolName: contentBlock['name'] as string }
      }
      if (contentBlock?.['type'] === 'text' && typeof contentBlock['text'] === 'string' && contentBlock['text']) {
        const text = contentBlock['text'] as string
        acc.textParts.push(text)
        return { textDelta: text }
      }
      // Track thinking blocks (extended thinking / chain-of-thought)
      if (contentBlock?.['type'] === 'thinking') {
        acc.inThinkingBlock = true
        return { thinkingStart: true }
      }
      return {}
    }

    case 'content_block_delta': {
      const delta = parsed['delta'] as Record<string, unknown> | undefined
      if (!delta) return {}

      if (delta['type'] === 'text_delta') {
        const text = delta['text'] as string
        acc.textParts.push(text)
        return { textDelta: text }
      }

      // Thinking text delta (extended thinking mode). Store on accumulator
      // so finalizeStream can emit a real AnthropicThinkingBlock on the
      // assistant turn — kimi-for-coding rejects subsequent turns with 400
      // if prior assistant tool_call messages don't carry reasoning_content.
      if (delta['type'] === 'thinking_delta') {
        const thinking = delta['thinking'] as string
        if (typeof thinking === 'string' && thinking.length > 0) {
          acc.thinkingParts.push(thinking)
        }
        return { thinkingDelta: thinking }
      }

      // Signature delta — Anthropic signs its thinking blocks. Kimi
      // doesn't emit this, but forward it for compatibility.
      if (delta['type'] === 'signature_delta') {
        const sig = delta['signature'] as string
        if (typeof sig === 'string' && sig.length > 0) {
          acc.thinkingSignature = (acc.thinkingSignature ?? '') + sig
        }
        return {}
      }

      if (delta['type'] === 'input_json_delta') {
        const partial = delta['partial_json'] as string
        if (acc.currentToolIndex >= 0 && acc.currentToolIndex < acc.toolUseBlocks.length) {
          acc.toolUseBlocks[acc.currentToolIndex]!.inputJson += partial
        }
        return {}
      }

      return {}
    }

    case 'content_block_stop': {
      if (acc.inThinkingBlock) {
        acc.inThinkingBlock = false
        return { thinkingEnd: true }
      }
      acc.currentToolIndex = -1
      return {}
    }

    case 'message_delta': {
      const delta = parsed['delta'] as Record<string, unknown> | undefined
      if (delta?.['stop_reason']) {
        acc.stopReason = delta['stop_reason'] as string
      }
      const usage = parsed['usage'] as Record<string, number> | undefined
      if (usage?.['output_tokens']) {
        acc.outputTokens = usage['output_tokens']
      }
      return {}
    }

    default:
      return {}
  }
}

/** Finalize the accumulator into a complete AssistantResponse. */
export function finalizeStream(acc: StreamAccumulator): AssistantResponse {
  const thinking = acc.thinkingParts.join('')
  const thinkingBlocks: AnthropicThinkingBlock[] = thinking
    ? [{
        type: 'thinking',
        thinking,
        ...(acc.thinkingSignature ? { signature: acc.thinkingSignature } : {}),
      }]
    : []

  const text = acc.textParts.join('')
  const textBlocks: AnthropicTextBlock[] = text
    ? [{ type: 'text', text }]
    : []

  const toolUseBlocks: AnthropicToolUseBlock[] = acc.toolUseBlocks.map((tb) => {
    let input: Record<string, unknown> = {}
    try {
      if (tb.inputJson) {
        input = JSON.parse(tb.inputJson) as Record<string, unknown>
      }
    } catch {
      // Malformed tool input — pass empty object
    }
    return {
      type: 'tool_use' as const,
      id: tb.id,
      name: tb.name,
      input,
    }
  })

  return {
    thinkingBlocks,
    textBlocks,
    toolUseBlocks,
    stopReason: acc.stopReason,
    usage: {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
    },
    hasToolUse: toolUseBlocks.length > 0,
    text,
  }
}

/**
 * Consume a full SSE stream from a ReadableStream.
 * Calls onTextDelta for real-time text display.
 */
export async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta?: (text: string) => void,
  onUsage?: (tokens: { input: number; output: number }) => void,
  onThinking?: (event: 'start' | 'delta' | 'end', text?: string) => void,
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  const acc = createAccumulator()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let aborted = signal?.aborted ?? false
  let sawVisibleEvent = false
  let sawTerminalEvent = false

  const abortReader = (): void => {
    aborted = true
    void reader.cancel().catch(() => {})
  }

  try {
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', abortReader, { once: true })
    }

    while (true) {
      if (aborted) break

      let chunk
      try {
        chunk = await reader.read()
      } catch (err: unknown) {
        if (aborted) break
        throw err
      }

      const { done, value } = chunk
      if (done) break
      if (aborted) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete events (delimited by \n\n)
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop()! // Keep incomplete part

      for (const part of parts) {
        if (!part.trim()) continue
        const events = parseSSE(part + '\n\n')
        for (const ev of events) {
          if (aborted) break
          if (ev.data === '[DONE]' || ev.event === 'message_stop' || ev.event === 'error') {
            sawTerminalEvent = true
          }
          const result = processEvent(acc, ev)
          if (result.textDelta || result.toolName || result.thinkingStart || result.thinkingDelta) {
            sawVisibleEvent = true
          }
          if (result.textDelta && onTextDelta) {
            onTextDelta(result.textDelta)
          }
          // Thinking block events
          if (onThinking) {
            if (result.thinkingStart) onThinking('start')
            if (result.thinkingDelta) onThinking('delta', result.thinkingDelta)
            if (result.thinkingEnd) onThinking('end')
          }
          // Report token count on usage updates
          if (onUsage && (acc.inputTokens > 0 || acc.outputTokens > 0)) {
            onUsage({ input: acc.inputTokens, output: acc.outputTokens })
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const events = parseSSE(buffer + '\n\n')
      for (const ev of events) {
        if (aborted) break
        if (ev.data === '[DONE]' || ev.event === 'message_stop' || ev.event === 'error') {
          sawTerminalEvent = true
        }
        const result = processEvent(acc, ev)
        if (result.textDelta || result.toolName || result.thinkingStart || result.thinkingDelta) {
          sawVisibleEvent = true
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abortReader)
    reader.releaseLock()
  }

  if (!aborted && !sawTerminalEvent) {
    const err = new Error(sawVisibleEvent ? 'stream closed before completion' : 'stream closed before first token')
    err.name = 'StreamInterruptedError'
    throw err
  }

  return finalizeStream(acc)
}
