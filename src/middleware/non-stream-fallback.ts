/**
 * 0.14.4 — non-streaming → streaming fallback with SSE-to-JSON assembler.
 *
 * The mirror of 0.14.2 (stream-fallback.ts). When the proxy's non-
 * streaming wall-clock timer fires (handleMessagesInner catch at
 * messages.ts:160-176), retry the same body with `stream: true`,
 * consume the SSE event stream, and assemble back into an
 * AnthropicMessagesResponse JSON shape so we can write a normal
 * non-streaming response to the client.
 *
 * Why this matters:
 *
 *   The native REPL (`src/native/conversation.ts:2692`) hardcodes
 *   `stream: false` on its main turn requests. When the model takes
 *   too long to produce a complete response (e.g. the 33K-input
 *   MES-AI architecture review that hit 300.5s on 0.14.1 / would have
 *   needed 400s+), there's no way for the proxy's adaptive budget to
 *   help — the model genuinely needs more wall-clock than any
 *   reasonable single-request budget. Streaming sidesteps this
 *   entirely: chunks arrive incrementally, the per-chunk idle timer
 *   is the only wall-clock bound (and it resets on each chunk).
 *
 *   We can't change the REPL request shape from here (different
 *   process), but we CAN convert the proxy's view: receive non-
 *   streaming from the client, route as streaming to the upstream,
 *   assemble events back to JSON. Client never sees the difference.
 *
 * This is opt-in via `middleware.nonStreamFallbackToStreamingEnabled`
 * (default true). Disable for routes whose streaming path is known
 * to be broken / OOM-prone (some kimi/deepseek long-context streams
 * have been reported to misbehave — see comments in conversation.ts
 * around kimi-code 700K context).
 *
 * Constraints (locked):
 *   - NOT a route-config knob. Single global switch.
 *   - NOT used when the original request already had stream:true.
 *     Streaming requests go through handleMessagesStream which has
 *     its own fallback layer (0.14.2).
 *   - NOT a multi-shot retry loop. Single best-effort attempt; if
 *     the streaming fallback also fails, surface the original
 *     non-streaming timeout diagnostic unchanged.
 *   - The assembler is defensive — malformed events / missing
 *     fields / partial JSON in tool_use deltas all degrade
 *     gracefully (best-effort).
 */

import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
} from '../types.js'
import { parseSSEStream } from '../utils/sse.js'
import { StreamTranslator } from '../translate/stream.js'
import { translateRequest } from '../translate/request.js'

export function isNonStreamFallbackEnabled(
  middleware: { nonStreamFallbackToStreamingEnabled?: boolean } | undefined,
): boolean {
  if (!middleware) return true
  return middleware.nonStreamFallbackToStreamingEnabled !== false
}

/** Build the streaming retry body. Same shape as `body` with
 *  `stream` forced to `true`. */
export function buildStreamingRetryBody(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  return { ...body, stream: true }
}

/** Block accumulator state used while walking SSE events. We track
 *  text/thinking/tool_use partials separately because tool_use input
 *  arrives as JSON-string fragments via `input_json_delta` and needs
 *  a final JSON.parse at content_block_stop. */
interface BlockAccumulator {
  type: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking' | string
  text?: string
  thinking?: string
  signature?: string
  // tool_use
  id?: string
  name?: string
  input?: Record<string, unknown>
  /** Accumulator for `input_json_delta.partial_json` fragments. Parsed
   *  to `input` on content_block_stop. */
  _partialJson?: string
}

/** Convert the assembled accumulator back to the canonical content
 *  block shape. tool_use blocks get their `_partialJson` parsed into
 *  `input` (best-effort — invalid JSON → empty object). */
function finalizeBlock(acc: BlockAccumulator): Record<string, unknown> {
  if (acc.type === 'tool_use') {
    let input: Record<string, unknown> = acc.input ?? {}
    if (acc._partialJson !== undefined) {
      try {
        const parsed = JSON.parse(acc._partialJson || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // tool_use with malformed input is still better than nothing —
        // surface an empty input rather than dropping the block
        input = {}
      }
    }
    return {
      type: 'tool_use',
      id: acc.id ?? '',
      name: acc.name ?? '',
      input,
    }
  }
  if (acc.type === 'text') {
    return { type: 'text', text: acc.text ?? '' }
  }
  if (acc.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: acc.thinking ?? '',
      ...(acc.signature ? { signature: acc.signature } : {}),
    }
  }
  // Unknown block type — pass through whatever fields we collected
  const { _partialJson: _drop, ...rest } = acc
  return rest as Record<string, unknown>
}

/**
 * Walk an async iterable of Anthropic event JSON payloads (already
 * parsed from `data: ...` lines) and assemble back into an
 * AnthropicMessagesResponse. This is the shared assembler used by
 * both the Anthropic-native path (`assembleJsonFromSseStream`) and
 * the OpenAI-translated path (`assembleJsonFromOpenAiSseStream`) —
 * the latter wraps OpenAI SSE chunks through `StreamTranslator`
 * before feeding them in.
 *
 * Returns null on incomplete / malformed / error-event streams.
 */
async function assembleJsonFromEventPayloads(
  payloads: AsyncIterable<string>,
): Promise<AnthropicMessagesResponse | null> {
  const result: Partial<AnthropicMessagesResponse> = {
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
  const blocks: BlockAccumulator[] = []
  let sawMessageStop = false

  try {
    for await (const payload of payloads) {
      const event = JSON.parse(payload) as Record<string, unknown>
      const type = event.type as string | undefined
      if (!type) continue

      if (type === 'message_start') {
        const msg = event.message as Record<string, unknown> | undefined
        if (msg) {
          if (typeof msg.id === 'string') result.id = msg.id
          if (typeof msg.model === 'string') result.model = msg.model
          if (msg.role === 'assistant' || msg.role === 'user') {
            result.role = msg.role as 'assistant'
          }
          const u = msg.usage as Record<string, unknown> | undefined
          if (u && result.usage) {
            if (typeof u.input_tokens === 'number') result.usage.input_tokens = u.input_tokens
            if (typeof u.output_tokens === 'number') result.usage.output_tokens = u.output_tokens
            if (typeof u.cache_creation_input_tokens === 'number') {
              result.usage.cache_creation_input_tokens = u.cache_creation_input_tokens
            }
            if (typeof u.cache_read_input_tokens === 'number') {
              result.usage.cache_read_input_tokens = u.cache_read_input_tokens
            }
          }
        }
      } else if (type === 'content_block_start') {
        const index = event.index as number | undefined
        const block = event.content_block as Record<string, unknown> | undefined
        if (typeof index !== 'number' || !block) continue
        const acc: BlockAccumulator = {
          type: (block.type as string) || 'text',
        }
        if (typeof block.text === 'string') acc.text = block.text
        if (typeof block.thinking === 'string') acc.thinking = block.thinking
        if (typeof block.id === 'string') acc.id = block.id
        if (typeof block.name === 'string') acc.name = block.name
        if (block.input && typeof block.input === 'object') {
          acc.input = block.input as Record<string, unknown>
        }
        if (acc.type === 'tool_use') {
          acc._partialJson = ''
        }
        blocks[index] = acc
      } else if (type === 'content_block_delta') {
        const index = event.index as number | undefined
        const delta = event.delta as Record<string, unknown> | undefined
        if (typeof index !== 'number' || !delta) continue
        const acc = blocks[index]
        if (!acc) continue
        const dtype = delta.type as string | undefined
        if (dtype === 'text_delta' && typeof delta.text === 'string') {
          acc.text = (acc.text ?? '') + delta.text
        } else if (dtype === 'thinking_delta' && typeof delta.thinking === 'string') {
          acc.thinking = (acc.thinking ?? '') + delta.thinking
        } else if (dtype === 'signature_delta' && typeof delta.signature === 'string') {
          acc.signature = (acc.signature ?? '') + delta.signature
        } else if (dtype === 'input_json_delta' && typeof delta.partial_json === 'string') {
          acc._partialJson = (acc._partialJson ?? '') + delta.partial_json
        }
      } else if (type === 'content_block_stop') {
        // Finalization happens after the loop.
      } else if (type === 'message_delta') {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta) {
          if (delta.stop_reason === 'end_turn' || delta.stop_reason === 'tool_use' ||
              delta.stop_reason === 'max_tokens' || delta.stop_reason === 'stop_sequence' ||
              delta.stop_reason === null) {
            result.stop_reason = delta.stop_reason as AnthropicMessagesResponse['stop_reason']
          }
          if (typeof delta.stop_sequence === 'string' || delta.stop_sequence === null) {
            result.stop_sequence = delta.stop_sequence as string | null
          }
        }
        const u = event.usage as Record<string, unknown> | undefined
        if (u && result.usage) {
          if (typeof u.output_tokens === 'number') result.usage.output_tokens = u.output_tokens
          if (typeof u.input_tokens === 'number') result.usage.input_tokens = u.input_tokens
        }
      } else if (type === 'message_stop') {
        sawMessageStop = true
        break
      } else if (type === 'error') {
        return null
      }
    }
  } catch {
    return null
  }

  if (!sawMessageStop) return null

  result.content = blocks
    .filter(b => b !== undefined && b !== null)
    .map(finalizeBlock) as unknown as AnthropicMessagesResponse['content']

  if (!result.id) result.id = `msg_assembled_${Date.now().toString(36)}`
  if (!result.model) return null

  return result as AnthropicMessagesResponse
}

/**
 * 0.14.7 — extract Anthropic SSE `data: ...` payloads from a stream
 * and yield each as a JSON string. Wraps `parseSSEStream` for the
 * assembler's input format.
 */
async function* anthropicPayloadsFromAnthropicSse(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<string> {
  for await (const payload of parseSSEStream(stream, { signal: options.signal })) {
    yield payload
  }
}

/**
 * 0.14.7 — translate OpenAI Chat Completion SSE chunks into the
 * Anthropic event-payload sequence the assembler expects. Wraps
 * `StreamTranslator` (the same component handleMessagesStream uses
 * for live forwarding) and yields the JSON `data: ...` portion of
 * each Anthropic event the translator emits.
 *
 * `inputTokenEstimate` feeds the translator's message_start usage.
 * For fallback purposes a rough estimate is fine — the translator
 * later corrects with upstream-supplied usage when available.
 */
async function* anthropicPayloadsFromOpenAiSse(
  stream: ReadableStream<Uint8Array>,
  requestModel: string,
  inputTokenEstimate: number,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<string> {
  const translator = new StreamTranslator(requestModel, inputTokenEstimate)
  const extractDataPayload = (sseFrame: string): string | null => {
    const match = sseFrame.match(/^event: \S+\ndata: (.+)\n\n$/s)
    return match ? match[1]! : null
  }
  // Strict-completion mode: the assembler must see an authentic
  // message_stop from upstream, NOT a synthetic one emitted by the
  // translator's flush() when the source closed prematurely. Track
  // whether [DONE] arrived OR a finish_reason chunk was seen; only
  // those signals authorize closing events. A stream that just got
  // EOF'd mid-content → no flush → assembler returns null (correct).
  let sawTerminator = false
  for await (const payload of parseSSEStream(stream, { signal: options.signal })) {
    if (payload === '[DONE]') {
      sawTerminator = true
      // StreamTranslator.processLine handles [DONE] by calling flush()
      // internally — collect those frames.
      for (const frame of translator.processLine(payload)) {
        const json = extractDataPayload(frame)
        if (json) yield json
      }
      continue
    }
    // Detect explicit finish_reason as a non-[DONE] terminator (some
    // providers omit [DONE] and signal completion via the last
    // chunk's finish_reason).
    try {
      const parsed = JSON.parse(payload) as { choices?: Array<{ finish_reason?: unknown }> }
      const fr = parsed.choices?.[0]?.finish_reason
      if (typeof fr === 'string') sawTerminator = true
    } catch { /* ignore */ }
    for (const frame of translator.processLine(payload)) {
      const json = extractDataPayload(frame)
      if (json) yield json
    }
  }
  // Don't synthesize message_stop if upstream never signaled completion.
  if (!sawTerminator) return
}

/**
 * Consume an SSE stream from an Anthropic Messages streaming response
 * and assemble it back into an AnthropicMessagesResponse JSON.
 *
 * Returns null if assembly fails (e.g. stream closed before
 * message_stop, malformed events, unexpected shape). Caller should
 * fall through to the original non-streaming timeout path on null.
 */
export async function assembleJsonFromSseStream(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessagesResponse | null> {
  return assembleJsonFromEventPayloads(anthropicPayloadsFromAnthropicSse(stream, options))
}

/**
 * 0.14.7 — OpenAI-protocol variant. For routes with `translate: true`
 * (most cloud relays like DeepSeek / Kimi / Qwen / Moonshot), the
 * upstream returns OpenAI Chat Completion SSE chunks. This variant
 * pipes them through StreamTranslator to produce Anthropic events
 * the assembler can consume.
 */
export async function assembleJsonFromOpenAiSseStream(
  stream: ReadableStream<Uint8Array>,
  requestModel: string,
  inputTokenEstimate: number,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessagesResponse | null> {
  return assembleJsonFromEventPayloads(
    anthropicPayloadsFromOpenAiSse(stream, requestModel, inputTokenEstimate, options),
  )
}

/**
 * Route metadata needed for protocol-aware fallback dispatch.
 * `translate=true` means owlcoda is the Anthropic-shape adapter for
 * an OpenAI-protocol upstream (kimi / deepseek / qwen / moonshot
 * etc); the body needs OpenAI shape and the SSE response is OpenAI
 * delta events. `translate=false` (or undefined) means a native
 * Anthropic upstream and both shapes pass through unchanged.
 */
export interface FallbackRouteInfo {
  endpointUrl: string
  headers: Record<string, string>
  translate: boolean
  backendModel: string
}

/**
 * Attempt the streaming fallback fetch. Returns the assembled
 * AnthropicMessagesResponse on success, or null to signal the caller
 * should proceed with the existing timeout-diagnostic path.
 *
 * 0.14.7: protocol-aware. For Anthropic-native routes, posts the
 * body unchanged and parses Anthropic SSE. For OpenAI-translated
 * routes (translate=true), translates the body via translateRequest
 * before posting, and pipes the OpenAI SSE response through
 * StreamTranslator before assembling.
 */
export async function fetchStreamingFallback(
  route: FallbackRouteInfo,
  retryBody: AnthropicMessagesRequest,
  signal: AbortSignal,
  budgetMs: number,
): Promise<AnthropicMessagesResponse | null> {
  const fallbackController = new AbortController()
  const timer = setTimeout(() => fallbackController.abort(), budgetMs)
  try {
    const combinedSignal = AbortSignal.any([signal, fallbackController.signal])
    const headersForStream = {
      ...route.headers,
      accept: 'text/event-stream',
    }
    // Protocol-aware body shape. Anthropic body → OpenAI body when
    // translate=true; this matches what handleMessagesNonStream does
    // before fetching the same upstream (messages.ts:342-347).
    const wireBody = route.translate
      ? translateRequest(retryBody, route.backendModel)
      : { ...retryBody, model: route.backendModel }
    const resp = await fetch(route.endpointUrl, {
      method: 'POST',
      headers: headersForStream,
      body: JSON.stringify(wireBody),
      signal: combinedSignal,
    })
    if (!resp.ok || !resp.body) return null
    if (route.translate) {
      // Pipe OpenAI SSE chunks through StreamTranslator → Anthropic
      // event payloads → assembler. Use a rough input-token estimate
      // for the translator's initial message_start; upstream usage
      // chunks correct it later if provided.
      const inputTokenEst = estimateInputTokensForTranslator(retryBody)
      return await assembleJsonFromOpenAiSseStream(
        resp.body,
        retryBody.model,
        inputTokenEst,
        { signal: combinedSignal },
      )
    }
    return await assembleJsonFromSseStream(resp.body, { signal: combinedSignal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Rough input-token count for StreamTranslator's message_start
 *  seed. Walks the body using the same chars/4 estimator as
 *  adaptive-timeout. Pure proxy; upstream usage chunks override. */
function estimateInputTokensForTranslator(body: AnthropicMessagesRequest): number {
  let chars = 0
  if (typeof body.system === 'string') chars += body.system.length
  else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof (block as { text?: unknown })?.text === 'string') {
        chars += ((block as { text: string }).text).length
      }
    }
  }
  for (const msg of body.messages ?? []) {
    const content = msg.content
    if (typeof content === 'string') chars += content.length
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as unknown as Record<string, unknown>
        if (typeof b.text === 'string') chars += (b.text as string).length
        else if (typeof b.content === 'string') chars += (b.content as string).length
      }
    }
  }
  return Math.ceil(chars / 4)
}
