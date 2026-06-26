import * as http from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { LocalRuntimeProtocolUnresolvedError, resolveModelRoute } from '../model-registry.js'
import type { AnthropicMessagesRequest, AnthropicMessagesResponse, AnthropicTextBlock, AnthropicThinkingBlock } from '../types.js'
import { translateRequest } from '../translate/request.js'
import { translateResponse } from '../translate/response.js'
import { computeAdaptiveTimeoutMs } from '../middleware/adaptive-timeout.js'
import { readBody } from '../server.js'
import {
  runModelOutputHarness,
  type StructuredOutputExecutor,
  type StructuredOutputModelResponse,
  type StructuredOutputRequest,
} from '../model-output-harness.js'

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function invalidRequest(res: http.ServerResponse, message: string): void {
  sendJson(res, 400, {
    type: 'error',
    error: { type: 'invalid_request_error', message },
  })
}

function validateStructuredOutputBody(body: unknown): body is StructuredOutputRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const record = body as Record<string, unknown>
  return typeof record.model === 'string' && record.model.length > 0
    && typeof record.user === 'string' && record.user.length > 0
}

function textFromAnthropicResponse(resp: AnthropicMessagesResponse): { text: string; thinkingText: string } {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  for (const block of resp.content) {
    if (block.type === 'text') {
      textParts.push((block as AnthropicTextBlock).text)
    } else if (block.type === 'thinking') {
      thinkingParts.push((block as AnthropicThinkingBlock).thinking)
    }
  }
  return { text: textParts.join(''), thinkingText: thinkingParts.join('') }
}

export function createStructuredOutputModelExecutor(config: OwlCodaConfig): StructuredOutputExecutor {
  return async (request): Promise<StructuredOutputModelResponse> => {
    const route = resolveModelRoute(config, request.model)
    const anthropicBody: AnthropicMessagesRequest = {
      model: request.model,
      system: request.system,
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: request.user }],
      stream: false,
    }
    const upstreamBody = route.translate
      ? translateRequest(anthropicBody, route.backendModel)
      : {
          ...anthropicBody,
          model: route.backendModel,
        }

    const baseTimeoutMs = route.timeoutMs
      ?? config.middleware?.requestTimeoutMs
      ?? config.routerTimeoutMs
      ?? 120_000
    const adaptiveBudget = computeAdaptiveTimeoutMs({
      baseMs: baseTimeoutMs,
      body: anthropicBody,
      middleware: config.middleware,
    })
    const started = Date.now()
    const upstream = await fetch(route.endpointUrl, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(adaptiveBudget.timeoutMs),
    })
    const durationMs = Date.now() - started

    if (!upstream.ok) {
      const detail = await upstream.text()
      throw new Error(`structured output upstream ${upstream.status}: ${detail.slice(0, 500)}`)
    }

    const json = await upstream.json() as unknown
    const anthropicResp = route.translate
      ? translateResponse(json as Parameters<typeof translateResponse>[0], request.model, config)
      : json as AnthropicMessagesResponse
    const extracted = textFromAnthropicResponse(anthropicResp)

    return {
      text: extracted.text,
      ...(extracted.thinkingText ? { thinkingText: extracted.thinkingText } : {}),
      stopReason: anthropicResp.stop_reason,
      inputTokens: anthropicResp.usage?.input_tokens ?? 0,
      outputTokens: anthropicResp.usage?.output_tokens ?? 0,
      durationMs,
    }
  }
}

export async function handleStructuredOutput(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: OwlCodaConfig,
): Promise<void> {
  let rawBody = ''
  try {
    rawBody = await readBody(req, config.middleware?.maxRequestBodyBytes ?? 10_485_760)
  } catch (err) {
    invalidRequest(res, err instanceof Error ? err.message : String(err))
    return
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    invalidRequest(res, 'Invalid JSON in request body')
    return
  }

  if (!validateStructuredOutputBody(body)) {
    invalidRequest(res, 'model and user are required strings')
    return
  }

  try {
    const result = await runModelOutputHarness(body, createStructuredOutputModelExecutor(config))
    sendJson(res, 200, result)
  } catch (err) {
    if (err instanceof LocalRuntimeProtocolUnresolvedError) {
      sendJson(res, 503, {
        type: 'error',
        error: { type: 'api_error', message: err.message },
      })
      return
    }
    sendJson(res, 502, {
      type: 'error',
      error: {
        type: 'api_error',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  }
}
