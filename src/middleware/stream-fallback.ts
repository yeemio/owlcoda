/**
 * 0.14.2 — streaming → non-streaming fallback synthesizer.
 *
 * When a streaming /v1/messages request fires the first-token watchdog
 * (no visible chunk arrived within the adaptive budget), the previous
 * behaviour was to surface a `stream_first_token_timeout` recovery
 * wording event. That's correct for "the model is genuinely dead" but
 * burns a turn when the issue is just that the route streams poorly
 * (e.g. some cloud kimi-code variants buffer the entire response
 * server-side before flushing).
 *
 * Strategy:
 *   1. On first-token watchdog fire with zero chunks seen, re-issue the
 *      same body with `stream: false` against the *same* model/route
 *   2. On success → synthesize a complete Anthropic SSE event sequence
 *      from the non-streaming JSON and write it through the still-open
 *      `text/event-stream` response
 *   3. On failure → fall through to the existing recovery wording path
 *
 * Why we don't need a header rewrite: the streaming response headers
 * (text/event-stream, transfer-encoding chunked, etc) were already
 * written at handleMessagesStream entry. The synthesized events are
 * standard Anthropic SSE — clients consume them identically to a
 * real stream. From the client's POV the request just had high
 * latency to first chunk.
 *
 * Anti-pattern guard (project memory):
 *   - We don't port legacy internal build's tengu `SystemAPIErrorMessage` heartbeat —
 *     that's an upstream-specific protocol
 *   - We don't gate this on a "foreground vs background" source flag —
 *     owlcoda has no such distinction (all queries are foreground in
 *     the local-first model)
 *   - We don't add telemetry callbacks — log to local trace only
 *
 * Disable: set `middleware.streamFallbackToNonStreamingEnabled = false`
 * to skip the fallback and use the 0.14.1 wording-only path.
 */

import type { ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  OpenAIChatResponse,
} from '../types.js'
import { translateRequest } from '../translate/request.js'
import { translateResponse } from '../translate/response.js'

/** Whether the fallback should be attempted on first-token watchdog fire. */
export function isFallbackEnabled(
  middleware: { streamFallbackToNonStreamingEnabled?: boolean } | undefined,
): boolean {
  if (!middleware) return true
  return middleware.streamFallbackToNonStreamingEnabled !== false
}

/** Build the non-streaming retry body. Same shape as `body` but with
 *  `stream` removed (route should default to non-streaming when absent). */
export function buildNonStreamingRetryBody(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const { stream: _stream, ...rest } = body
  return rest as AnthropicMessagesRequest
}

/** Write a single Anthropic SSE event frame to `res`. The frame
 *  follows the `event: <type>\ndata: <json>\n\n` convention. */
function writeSseFrame(
  res: ServerResponse,
  eventType: string,
  data: Record<string, unknown>,
): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Synthesize an Anthropic SSE event sequence from a non-streaming
 * response and write it through `res`. Caller is responsible for
 * calling `res.end()` after this returns.
 *
 * Event sequence (matches Anthropic Messages streaming spec):
 *
 *   message_start  → carries id, model, role, usage (input only)
 *   for each content block:
 *     content_block_start  → {type, [name, id, ...]}
 *     content_block_delta  → carries the full text / thinking / input
 *                            in a single "delta" — clients accumulate
 *                            the same way they would for many small deltas
 *     content_block_stop
 *   message_delta  → stop_reason + usage.output_tokens
 *   message_stop
 *
 * `text` blocks emit `text_delta`, `thinking` blocks emit
 * `thinking_delta`, `tool_use` blocks emit a single `input_json_delta`
 * containing the JSON-stringified input. Unknown block types are
 * skipped silently (caller may want to log).
 */
export function synthesizeSseFromResponse(
  res: ServerResponse,
  json: AnthropicMessagesResponse,
): void {
  writeSseFrame(res, 'message_start', {
    type: 'message_start',
    message: {
      id: json.id,
      type: 'message',
      role: json.role,
      content: [],
      model: json.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: 0,
        cache_creation_input_tokens: json.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: json.usage?.cache_read_input_tokens ?? 0,
      },
    },
  })

  json.content.forEach((block, index) => {
    if (block.type === 'text') {
      writeSseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      writeSseFrame(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      })
      writeSseFrame(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    } else if (block.type === 'thinking') {
      writeSseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      })
      writeSseFrame(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      })
      writeSseFrame(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    } else if (block.type === 'tool_use') {
      writeSseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      writeSseFrame(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      })
      writeSseFrame(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    }
    // Unknown block types: silently skip. Anthropic SDK clients tolerate
    // gaps; surfacing as error here would lose recoverable output.
  })

  writeSseFrame(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: json.stop_reason,
      stop_sequence: json.stop_sequence,
    },
    usage: {
      output_tokens: json.usage?.output_tokens ?? 0,
    },
  })

  writeSseFrame(res, 'message_stop', { type: 'message_stop' })
}

/**
 * Attempt the non-streaming fallback fetch. Returns the parsed JSON on
 * success. On failure, the HTTP status is retained when available so
 * callers can preserve the fallback policy: retry another model on
 * transport/5xx failures, never on a 4xx request error.
 *
 * This is intentionally lean — the caller owns the health-filtered model
 * chain and retry policy. Each invocation makes one non-streaming attempt;
 * the caller may continue on transport/5xx failure while the downstream
 * protocol is still uncommitted, or stop on a 4xx request error.
 */
export interface NonStreamingFallbackAttempt {
  response: AnthropicMessagesResponse | null
  status?: number
}

export async function fetchNonStreamingFallback(
  endpointUrl: string,
  headers: Record<string, string>,
  retryBody: AnthropicMessagesRequest,
  signal: AbortSignal,
  timeoutMs: number,
  route?: {
    translate: boolean
    backendModel: string
    requestModel: string
    config: OwlCodaConfig
  },
): Promise<NonStreamingFallbackAttempt> {
  const fallbackController = new AbortController()
  const timer = setTimeout(() => fallbackController.abort(), timeoutMs)
  try {
    const combinedSignal = AbortSignal.any([signal, fallbackController.signal])
    const wireBody = route?.translate
      ? translateRequest(retryBody, route.backendModel)
      : { ...retryBody, model: route?.backendModel ?? retryBody.model }
    const resp = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(wireBody),
      signal: combinedSignal,
    })
    if (!resp.ok) return { response: null, status: resp.status }
    const json = (await resp.json()) as AnthropicMessagesResponse | OpenAIChatResponse
    if (route?.translate) {
      return {
        response: translateResponse(json as OpenAIChatResponse, route.requestModel, route.config),
        status: resp.status,
      }
    }
    const anthropicJson = json as AnthropicMessagesResponse
    if (!anthropicJson || typeof anthropicJson !== 'object' || anthropicJson.type !== 'message') {
      return { response: null, status: resp.status }
    }
    return { response: anthropicJson, status: resp.status }
  } catch {
    return { response: null }
  } finally {
    clearTimeout(timer)
  }
}
