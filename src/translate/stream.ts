import { randomUUID } from 'node:crypto'
import { logWarn } from '../logger.js'

interface OpenAIChunkDelta {
  role?: string
  content?: string | null
  /**
   * Moonshot/Kimi extension — thinking-model reasoning stream. Appears
   * before content/tool_calls; must be translated into Anthropic
   * `thinking` content blocks so the client stores them on the assistant
   * turn and kimi accepts subsequent continuations (it 400s when prior
   * assistant tool_call messages lack reasoning_content).
   */
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface OpenAIChunk {
  id: string
  object: string
  choices: Array<{
    index: number
    delta: OpenAIChunkDelta
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

enum StreamState {
  INIT = 'INIT',
  THINKING_BLOCK = 'THINKING_BLOCK',
  TEXT_BLOCK = 'TEXT_BLOCK',
  TOOL_BLOCK = 'TOOL_BLOCK',
  DONE = 'DONE',
}

export class StreamTranslator {
  private state = StreamState.INIT
  private blockIndex = 0
  private messageId: string
  private requestModel: string
  private inputTokenEstimate: number
  private outputCharCount = 0
  private upstreamUsage: { prompt_tokens: number; completion_tokens: number } | null = null
  private currentToolCalls: Map<number, { id: string; name: string }> = new Map()
  // State remains INIT across initial role-only chunks (kimi opens with
  // `{role:'assistant',content:''}` before emitting reasoning_content),
  // so we can't use the state transition to gate message_start emission.
  private messageStartEmitted = false

  constructor(requestModel: string, inputTokenEstimate: number) {
    this.requestModel = requestModel
    this.inputTokenEstimate = inputTokenEstimate
    this.messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  }

  processLine(dataContent: string): string[] {
    if (dataContent === '[DONE]') return this.flush()

    let chunk: OpenAIChunk
    try {
      chunk = JSON.parse(dataContent)
    } catch (e) {
      logWarn('stream', `Failed to parse SSE chunk: ${String(e).slice(0, 80)}`)
      return []
    }

    const choice = chunk.choices?.[0]
    if (!choice) return []

    const delta = choice.delta
    const finishReason = choice.finish_reason

    if (chunk.usage) {
      this.upstreamUsage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
      }
    }

    const events: string[] = []

    if (this.state === StreamState.INIT) {
      if (!this.messageStartEmitted) {
        events.push(this.makeMessageStart())
        events.push(this.makeEvent('ping', { type: 'ping' }))
        this.messageStartEmitted = true
      }

      // Thinking reasoning_content takes priority over content/tool_calls
      // when both appear — kimi always emits reasoning BEFORE content.
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning_content !== '') {
        events.push(this.makeEvent('content_block_start', {
          type: 'content_block_start', index: this.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }))
        events.push(this.makeEvent('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        }))
        this.outputCharCount += delta.reasoning_content.length
        this.state = StreamState.THINKING_BLOCK
      } else if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        events.push(this.makeEvent('content_block_start', {
          type: 'content_block_start', index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        }))
        events.push(this.makeEvent('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }))
        this.outputCharCount += delta.content.length
        this.state = StreamState.TEXT_BLOCK
      } else if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name) {
            this.currentToolCalls.set(tc.index, { id: tc.id, name: tc.function.name })
            events.push(this.makeEvent('content_block_start', {
              type: 'content_block_start', index: this.blockIndex,
              content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
            }))
          }
          if (tc.function?.arguments) {
            events.push(this.makeEvent('content_block_delta', {
              type: 'content_block_delta', index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }))
            this.outputCharCount += tc.function.arguments.length
          }
        }
        this.state = StreamState.TOOL_BLOCK
      }
      // Role-only or empty-content initial chunk — STAY IN INIT.
      // kimi thinking models open with `{role:'assistant',content:''}` and
      // only then begin emitting `reasoning_content` chunks; if we opened a
      // text block here, subsequent reasoning_content arrives in the
      // TEXT_BLOCK branch (which has no thinking handling) and gets silently
      // dropped. The finishReason / flush paths already handle INIT
      // gracefully (emit an empty text block if nothing else showed up), so
      // staying in INIT costs nothing and preserves the thinking path.
    } else if (this.state === StreamState.THINKING_BLOCK) {
      // Continuing reasoning_content within the same thinking block.
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning_content !== '') {
        events.push(this.makeEvent('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        }))
        this.outputCharCount += delta.reasoning_content.length
      }

      // Thinking → text transition: close thinking, open text.
      if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        events.push(this.makeEvent('content_block_stop', {
          type: 'content_block_stop', index: this.blockIndex,
        }))
        this.blockIndex++
        events.push(this.makeEvent('content_block_start', {
          type: 'content_block_start', index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        }))
        events.push(this.makeEvent('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }))
        this.outputCharCount += delta.content.length
        this.state = StreamState.TEXT_BLOCK
      }

      // Thinking → tool_use transition: close thinking, open tool.
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        events.push(this.makeEvent('content_block_stop', {
          type: 'content_block_stop', index: this.blockIndex,
        }))
        this.blockIndex++
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name) {
            this.currentToolCalls.set(tc.index, { id: tc.id, name: tc.function.name })
            events.push(this.makeEvent('content_block_start', {
              type: 'content_block_start', index: this.blockIndex,
              content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
            }))
          }
          if (tc.function?.arguments) {
            events.push(this.makeEvent('content_block_delta', {
              type: 'content_block_delta', index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }))
            this.outputCharCount += tc.function.arguments.length
          }
        }
        this.state = StreamState.TOOL_BLOCK
      }
    } else if (this.state === StreamState.TEXT_BLOCK) {
      if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
        events.push(this.makeEvent('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }))
        this.outputCharCount += delta.content.length
      }

      if (delta.tool_calls && delta.tool_calls.length > 0) {
        // Transition from text to tool
        events.push(this.makeEvent('content_block_stop', {
          type: 'content_block_stop', index: this.blockIndex,
        }))
        this.blockIndex++

        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name) {
            this.currentToolCalls.set(tc.index, { id: tc.id, name: tc.function.name })
            events.push(this.makeEvent('content_block_start', {
              type: 'content_block_start', index: this.blockIndex,
              content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
            }))
          }
          if (tc.function?.arguments) {
            events.push(this.makeEvent('content_block_delta', {
              type: 'content_block_delta', index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }))
            this.outputCharCount += tc.function.arguments.length
          }
        }
        this.state = StreamState.TOOL_BLOCK
      }
    } else if (this.state === StreamState.TOOL_BLOCK) {
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.function?.name && !this.currentToolCalls.has(tc.index)) {
            // Close previous tool block
            events.push(this.makeEvent('content_block_stop', {
              type: 'content_block_stop', index: this.blockIndex,
            }))
            this.blockIndex++
            this.currentToolCalls.set(tc.index, { id: tc.id, name: tc.function.name })
            events.push(this.makeEvent('content_block_start', {
              type: 'content_block_start', index: this.blockIndex,
              content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
            }))
          }
          if (tc.function?.arguments) {
            events.push(this.makeEvent('content_block_delta', {
              type: 'content_block_delta', index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }))
            this.outputCharCount += tc.function.arguments.length
          }
        }
      }
    }

    // Handle finish reason (all states)
    if (finishReason && this.state !== StreamState.DONE) {
      if (this.state === StreamState.INIT) {
        // No content was emitted yet, emit empty text block
        events.push(this.makeEvent('content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        }))
        events.push(this.makeEvent('content_block_stop', {
          type: 'content_block_stop', index: 0,
        }))
      } else {
        events.push(this.makeEvent('content_block_stop', {
          type: 'content_block_stop', index: this.blockIndex,
        }))
      }

      events.push(this.makeEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: this.mapFinishReason(finishReason), stop_sequence: null },
        usage: { output_tokens: this.estimatedOutputTokens },
      }))
      events.push(this.makeEvent('message_stop', { type: 'message_stop' }))
      this.state = StreamState.DONE
    }

    return events
  }

  flush(): string[] {
    if (this.state === StreamState.DONE) return []

    const events: string[] = []

    if (this.state === StreamState.INIT) {
      if (!this.messageStartEmitted) {
        events.push(this.makeMessageStart())
        this.messageStartEmitted = true
      }
      events.push(this.makeEvent('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      }))
      events.push(this.makeEvent('content_block_stop', {
        type: 'content_block_stop', index: 0,
      }))
    } else if (
      this.state === StreamState.TEXT_BLOCK ||
      this.state === StreamState.TOOL_BLOCK ||
      this.state === StreamState.THINKING_BLOCK
    ) {
      events.push(this.makeEvent('content_block_stop', {
        type: 'content_block_stop', index: this.blockIndex,
      }))
    }

    events.push(this.makeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.estimatedOutputTokens },
    }))
    events.push(this.makeEvent('message_stop', { type: 'message_stop' }))
    this.state = StreamState.DONE
    return events
  }

  private makeEvent(eventType: string, data: object): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  }

  private makeMessageStart(): string {
    return this.makeEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokenEstimate,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })
  }

  private get estimatedOutputTokens(): number {
    if (this.upstreamUsage) return this.upstreamUsage.completion_tokens
    return Math.max(1, Math.ceil(this.outputCharCount / 4))
  }

  private mapFinishReason(fr: string): string {
    switch (fr) {
      case 'stop': return 'end_turn'
      case 'tool_calls': return 'tool_use'
      case 'length': return 'max_tokens'
      default: return 'end_turn'
    }
  }

  getFinalUsage(): { inputTokens: number; outputTokens: number } {
    return {
      inputTokens: this.upstreamUsage?.prompt_tokens ?? this.inputTokenEstimate,
      outputTokens: this.estimatedOutputTokens,
    }
  }
}
