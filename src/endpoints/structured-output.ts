import * as http from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import {
  LocalRuntimeProtocolUnresolvedError,
  resolveModelCapabilitiesForRequest,
  resolveModelRoute,
} from '../model-registry.js'
import type { AnthropicMessagesRequest, AnthropicMessagesResponse, AnthropicTextBlock, AnthropicThinkingBlock } from '../types.js'
import { translateRequest } from '../translate/request.js'
import { translateResponse } from '../translate/response.js'
import { computeAdaptiveTimeoutMs } from '../middleware/adaptive-timeout.js'
import { readBody } from '../server.js'
import { parseSSEStream } from '../utils/sse.js'
import {
  applyStructuredOutputPresetDefaults,
  runModelOutputHarness,
  type StructuredOutputExecutor,
  type StructuredOutputModelResponse,
  type StructuredOutputRequest,
} from '../model-output-harness.js'
import {
  findRunWorkspaceArtifact,
  persistStructuredOutputResult,
  readStructuredOutputArtifactInput,
} from '../structured-output-persistence.js'

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

function validateStructuredOutputRerunBody(body: unknown): body is Partial<StructuredOutputRequest> & { model: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const record = body as Record<string, unknown>
  return typeof record.model === 'string' && record.model.length > 0
}

function withRegistryStructuredOutputCapabilities(
  config: OwlCodaConfig,
  request: StructuredOutputRequest,
): StructuredOutputRequest {
  return {
    ...request,
    modelCapabilities: resolveModelCapabilitiesForRequest(config, request.model).structuredOutput,
  }
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

type StreamDeltaSource = 'provider_sse' | 'translated_sse'

function shouldStreamStructuredOutput(request: StructuredOutputRequest): boolean {
  return request.modelCapabilities?.streaming.status === 'supported'
    && typeof request.idleTimeoutMs === 'number'
    && request.idleTimeoutMs > 0
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function mapOpenAIStopReason(finishReason: unknown): string | null {
  if (finishReason === null || finishReason === undefined) return null
  if (finishReason === 'stop') return 'end_turn'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use'
  return String(finishReason)
}

async function collectOpenAICompatibleStream(args: {
  stream: ReadableStream<Uint8Array>
  timeoutMs: number
  signal: AbortSignal
  request: Parameters<StructuredOutputExecutor>[0]
}): Promise<Omit<StructuredOutputModelResponse, 'durationMs' | 'streamingMode' | 'streamDeltaSource'>> {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  for await (const data of parseSSEStream(args.stream, { timeoutMs: args.timeoutMs, signal: args.signal })) {
    if (data === '[DONE]') continue
    const event = objectRecord(JSON.parse(data))
    if (!event) continue
    const choices = Array.isArray(event.choices) ? event.choices : []
    const choice = objectRecord(choices[0])
    const delta = objectRecord(choice?.delta)
    let emittedDelta = false

    if (delta) {
      const thinking = delta.reasoning_content
      if (typeof thinking === 'string' && thinking.length > 0) {
        thinkingParts.push(thinking)
        args.request.onOutputDelta?.({ type: 'thinking', text: thinking })
        emittedDelta = true
      }

      const content = delta.content
      if (typeof content === 'string') {
        if (content.length > 0) {
          textParts.push(content)
          args.request.onOutputDelta?.({ type: 'text', text: content })
        } else {
          args.request.onOutputDelta?.({ type: 'heartbeat' })
        }
        emittedDelta = true
      }
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      stopReason = mapOpenAIStopReason(choice.finish_reason)
    }

    const usage = objectRecord(event.usage)
    if (usage) {
      if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens
    }

    if (!emittedDelta && !usage && !stopReason) {
      args.request.onOutputDelta?.({ type: 'heartbeat' })
    }
  }

  return {
    text: textParts.join(''),
    ...(thinkingParts.length > 0 ? { thinkingText: thinkingParts.join('') } : {}),
    stopReason,
    inputTokens,
    outputTokens,
  }
}

async function collectAnthropicMessagesStream(args: {
  stream: ReadableStream<Uint8Array>
  timeoutMs: number
  signal: AbortSignal
  request: Parameters<StructuredOutputExecutor>[0]
}): Promise<Omit<StructuredOutputModelResponse, 'durationMs' | 'streamingMode' | 'streamDeltaSource'>> {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  for await (const data of parseSSEStream(args.stream, { timeoutMs: args.timeoutMs, signal: args.signal })) {
    const event = objectRecord(JSON.parse(data))
    if (!event) continue
    if (event.type === 'error') {
      const error = objectRecord(event.error)
      throw new Error(typeof error?.message === 'string' ? error.message : 'structured output provider stream error')
    }

    if (event.type === 'message_start') {
      const message = objectRecord(event.message)
      const usage = objectRecord(message?.usage)
      if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens
      args.request.onOutputDelta?.({ type: 'heartbeat' })
      continue
    }

    if (event.type === 'content_block_delta') {
      const delta = objectRecord(event.delta)
      const text = delta?.text
      const thinking = delta?.thinking
      if (typeof text === 'string' && text.length > 0) {
        textParts.push(text)
        args.request.onOutputDelta?.({ type: 'text', text })
      } else if (typeof thinking === 'string' && thinking.length > 0) {
        thinkingParts.push(thinking)
        args.request.onOutputDelta?.({ type: 'thinking', text: thinking })
      } else {
        args.request.onOutputDelta?.({ type: 'heartbeat' })
      }
      continue
    }

    if (event.type === 'message_delta') {
      const delta = objectRecord(event.delta)
      if (delta?.stop_reason !== undefined && delta.stop_reason !== null) {
        stopReason = String(delta.stop_reason)
      }
      const usage = objectRecord(event.usage)
      if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
      args.request.onOutputDelta?.({ type: 'heartbeat' })
      continue
    }

    args.request.onOutputDelta?.({ type: 'heartbeat' })
  }

  return {
    text: textParts.join(''),
    ...(thinkingParts.length > 0 ? { thinkingText: thinkingParts.join('') } : {}),
    stopReason,
    inputTokens,
    outputTokens,
  }
}

export function createStructuredOutputModelExecutor(config: OwlCodaConfig): StructuredOutputExecutor {
  return async (request): Promise<StructuredOutputModelResponse> => {
    const route = resolveModelRoute(config, request.model)
    const stream = shouldStreamStructuredOutput(request)
    const anthropicBody: AnthropicMessagesRequest = {
      model: request.model,
      system: request.system,
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: request.user }],
      stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    }
    const upstreamBody = route.translate
      ? { ...translateRequest(anthropicBody, route.backendModel), stream }
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
    const signal = AbortSignal.timeout(adaptiveBudget.timeoutMs)
    const started = Date.now()
    const upstream = await fetch(route.endpointUrl, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(upstreamBody),
      signal,
    })

    if (!upstream.ok) {
      const detail = await upstream.text()
      throw new Error(`structured output upstream ${upstream.status}: ${detail.slice(0, 500)}`)
    }

    if (stream) {
      if (!upstream.body) {
        throw new Error('structured output upstream stream body is unavailable')
      }
      const streamDeltaSource: StreamDeltaSource = route.translate ? 'translated_sse' : 'provider_sse'
      const streamed = route.translate
        ? await collectOpenAICompatibleStream({
            stream: upstream.body,
            timeoutMs: adaptiveBudget.timeoutMs,
            signal,
            request,
          })
        : await collectAnthropicMessagesStream({
            stream: upstream.body,
            timeoutMs: adaptiveBudget.timeoutMs,
            signal,
            request,
          })
      return {
        ...streamed,
        durationMs: Date.now() - started,
        streamingMode: 'streaming',
        streamDeltaSource,
      }
    }

    const json = await upstream.json() as unknown
    const durationMs = Date.now() - started
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
      streamingMode: 'non_streaming',
      streamDeltaSource: 'none',
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
  if (body.persist === true && !body.runRef) {
    invalidRequest(res, 'runRef is required when persist=true')
    return
  }

  let harnessRequest: StructuredOutputRequest
  try {
    harnessRequest = applyStructuredOutputPresetDefaults(withRegistryStructuredOutputCapabilities(config, body))
  } catch (err) {
    invalidRequest(res, err instanceof Error ? err.message : String(err))
    return
  }

  try {
    let result = await runModelOutputHarness(harnessRequest, createStructuredOutputModelExecutor(config))
    if (harnessRequest.persist === true) {
      const persisted = await persistStructuredOutputResult(harnessRequest, result)
      result = {
        ...result,
        persisted: true,
        artifactId: persisted.artifactId,
        attemptLedgerId: persisted.attemptLedgerId,
        runRef: harnessRequest.runRef,
      }
    }
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

export async function handleStructuredOutputRerun(
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

  if (!validateStructuredOutputRerunBody(body)) {
    invalidRequest(res, 'model is required')
    return
  }
  if (!body.runRef) {
    invalidRequest(res, 'runRef is required for structured output rerun')
    return
  }
  if (!body.previousArtifactId) {
    invalidRequest(res, 'previousArtifactId is required for structured output rerun')
    return
  }
  if (!body.role) {
    invalidRequest(res, 'role is required for structured output rerun')
    return
  }
  if (!body.user && !body.inputRef && !body.artifactRef) {
    invalidRequest(res, 'user, inputRef, or artifactRef is required for structured output rerun')
    return
  }

  let rerunRequest: StructuredOutputRequest
  try {
    await findRunWorkspaceArtifact(body.runRef, body.previousArtifactId)
    rerunRequest = applyStructuredOutputPresetDefaults(
      withRegistryStructuredOutputCapabilities(config, await buildRerunRequest(body)),
    )
  } catch (err) {
    invalidRequest(res, err instanceof Error ? err.message : String(err))
    return
  }

  try {
    let result = await runModelOutputHarness(rerunRequest, createStructuredOutputModelExecutor(config))
    const persisted = await persistStructuredOutputResult(rerunRequest, result)
    result = {
      ...result,
      persisted: true,
      artifactId: persisted.artifactId,
      attemptLedgerId: persisted.attemptLedgerId,
      runRef: rerunRequest.runRef,
      rerun: true,
      parentArtifactId: rerunRequest.previousArtifactId,
      rerunOf: rerunRequest.previousArtifactId,
      ...(rerunRequest.inputRef ? { inputRef: rerunRequest.inputRef } : {}),
      ...(rerunRequest.artifactRef ? { artifactRef: rerunRequest.artifactRef } : {}),
    }
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

async function buildRerunRequest(
  body: Partial<StructuredOutputRequest> & { model: string },
): Promise<StructuredOutputRequest> {
  const user = typeof body.user === 'string' && body.user.trim()
    ? body.user
    : await userFromArtifactRef(body)

  return {
    ...body,
    user,
    persist: true,
  } as StructuredOutputRequest
}

async function userFromArtifactRef(
  body: Partial<StructuredOutputRequest> & { model: string },
): Promise<string> {
  const ref = body.inputRef ?? body.artifactRef
  if (!body.runRef || !ref) {
    throw new Error('user, inputRef, or artifactRef is required for structured output rerun')
  }
  const input = await readStructuredOutputArtifactInput(body.runRef, ref)
  return [
    `Rerun structured output role artifact from ${body.inputRef ? 'inputRef' : 'artifactRef'} ${input.record.id}.`,
    'Use the referenced artifact payload as the input for this rerun.',
    JSON.stringify(input.payload, null, 2),
  ].join('\n\n')
}
