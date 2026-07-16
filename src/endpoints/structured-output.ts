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
  evaluateStructuredOutputCapabilityGate,
  runModelOutputHarness,
  resolveStructuredOutputContract,
  type StructuredOutputExecutor,
  type StructuredOutputModelResponse,
  type StructuredOutputRequest,
  type StructuredOutputResponse,
} from '../model-output-harness.js'
import {
  findRunWorkspaceArtifact,
  persistStructuredOutputResult,
  readStructuredOutputArtifactInput,
} from '../structured-output-persistence.js'
import {
  StructuredOutputBudgetContractMismatchError,
  StructuredOutputBudgetExceededError,
  completeDurableStructuredOutputIdempotency,
  reserveStructuredOutputBudget,
  reserveDurableStructuredOutputIdempotency,
  settleStructuredOutputBudget,
  structuredOutputExecutionCounts,
  structuredOutputIdempotencyHash,
  validateStructuredOutputExecutionBudget,
} from '../structured-output-execution-economics.js'

interface StructuredOutputHttpResult {
  status: number
  body: Record<string, unknown>
}

interface IdempotencyReservation {
  requestHash: string
  promise: Promise<StructuredOutputHttpResult>
  settled: boolean
}
const idempotencyReservations = new Map<string, IdempotencyReservation>()

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

function resolveIdempotencyKey(
  req: http.IncomingMessage,
  body: StructuredOutputRequest | (Partial<StructuredOutputRequest> & { model: string }),
): string | undefined {
  const rawHeader = req.headers['idempotency-key']
  const header = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim()
  const bodyKey = body.idempotencyKey?.trim()
  if (header && bodyKey && header !== bodyKey) {
    throw new Error('Idempotency-Key header and idempotencyKey body field must match')
  }
  const key = header || bodyKey
  if (key && body.intentionalRepeat === true) {
    throw new Error('intentionalRepeat cannot be combined with an idempotency key')
  }
  if (key && (key.length < 8 || key.length > 200)) {
    throw new Error('Idempotency-Key must contain 8 to 200 characters')
  }
  return key
}

async function executeIdempotently(
  namespace: 'primary' | 'rerun',
  key: string | undefined,
  request: StructuredOutputRequest,
  work: () => Promise<StructuredOutputHttpResult>,
): Promise<StructuredOutputHttpResult> {
  if (!key) return work()
  const requestHash = structuredOutputIdempotencyHash(namespace, request)
  const cacheKey = `${namespace}:${key}`
  const existing = idempotencyReservations.get(cacheKey)
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return {
        status: 409,
        body: {
          type: 'error',
          error: {
            type: 'idempotency_conflict',
            message: 'Idempotency-Key is already reserved for a different canonical request',
            requestHash,
            reservedRequestHash: existing.requestHash,
          },
        },
      }
    }
    const replay = await existing.promise
    return {
      ...replay,
      body: {
        ...replay.body,
        idempotency: { key, requestHash, replayed: true, namespace },
      },
    }
  }

  const durable = Boolean(request.runRef && (request.persist === true || namespace === 'rerun'))
  const reservedWork = async (): Promise<StructuredOutputHttpResult> => {
    if (durable) {
      const durableReservation = await reserveDurableStructuredOutputIdempotency({
        runRef: request.runRef!,
        namespace,
        key,
        requestHash,
      })
      if (durableReservation.kind === 'conflict') {
        return {
          status: 409,
          body: {
            type: 'error',
            error: {
              type: 'idempotency_conflict',
              message: 'Idempotency-Key is durably reserved for a different canonical request',
              requestHash,
              reservedRequestHash: durableReservation.record.requestHash,
            },
          },
        }
      }
      if (durableReservation.kind === 'in_progress') {
        return {
          status: 409,
          body: {
            type: 'error',
            error: {
              type: 'idempotency_in_progress',
              message: 'Idempotency-Key has an unresolved durable provider reservation',
              requestHash,
              reservedAt: durableReservation.record.reservedAt,
            },
          },
        }
      }
      if (durableReservation.kind === 'replay') {
        return {
          status: durableReservation.record.status ?? 200,
          body: {
            ...(durableReservation.record.body ?? {}),
            idempotency: { key, requestHash, replayed: true, namespace },
          },
        }
      }
    }

    const result = await work()
    if (durable) {
      await completeDurableStructuredOutputIdempotency({
        runRef: request.runRef!,
        namespace,
        key,
        requestHash,
        status: result.status,
        body: result.body,
      })
    }
    return result
  }
  const reservation: IdempotencyReservation = {
    requestHash,
    promise: Promise.resolve().then(reservedWork),
    settled: false,
  }
  idempotencyReservations.set(cacheKey, reservation)
  pruneSettledIdempotencyReservations()
  let result: StructuredOutputHttpResult
  try {
    result = await reservation.promise
    reservation.settled = true
  } catch (err) {
    if (idempotencyReservations.get(cacheKey) === reservation) {
      idempotencyReservations.delete(cacheKey)
    }
    throw err
  }
  if (result.status === 409) return result
  const replayed = (result.body['idempotency'] as Record<string, unknown> | undefined)?.['replayed'] === true
  return {
    ...result,
    body: {
      ...result.body,
      idempotency: { key, requestHash, replayed, namespace },
    },
  }
}

export function resetStructuredOutputIdempotencyForTesting(): void {
  idempotencyReservations.clear()
}

function pruneSettledIdempotencyReservations(): void {
  if (idempotencyReservations.size <= 1_000) return
  for (const [key, reservation] of idempotencyReservations) {
    if (!reservation.settled) continue
    idempotencyReservations.delete(key)
    if (idempotencyReservations.size <= 900) break
  }
}

async function executeStructuredOutputRequest(
  request: StructuredOutputRequest,
  config: OwlCodaConfig,
  options: { rerun: boolean; persist: boolean },
): Promise<StructuredOutputHttpResult> {
  let reservation: Awaited<ReturnType<typeof reserveStructuredOutputBudget>> | undefined
  const executor = createStructuredOutputModelExecutor(config)
  if (request.executionBudget) {
    if (!request.runRef || !request.taskId || !options.persist) {
      throw new Error('executionBudget requires persist=true, runRef, and taskId')
    }
    const capabilityGate = evaluateStructuredOutputCapabilityGate(request, request.maxTokens ?? 1024)
    if (capabilityGate.ok) {
      try {
        reservation = await reserveStructuredOutputBudget({
          runRef: request.runRef,
          taskId: request.taskId,
          budget: request.executionBudget,
          requestedMaxTokens: capabilityGate.appliedMaxTokens,
          estimatedInputTokens: estimateStructuredOutputInputTokens(request),
          rerun: options.rerun,
        })
      } catch (err) {
        if (err instanceof StructuredOutputBudgetExceededError) {
          return {
            status: 429,
            body: {
              type: 'error',
              error: {
                type: err.code,
                message: err.message,
                dimension: err.dimension,
                executionEconomics: err.receipt,
                stopReceipt: err.receipt.stopReceipt,
              },
            },
          }
        }
        if (err instanceof StructuredOutputBudgetContractMismatchError) {
          return {
            status: 409,
            body: {
              type: 'error',
              error: { type: err.code, message: err.message },
            },
          }
        }
        throw err
      }
    }
  }

  let result: StructuredOutputResponse = await runModelOutputHarness(
    request,
    executor,
    reservation
      ? { maxTokens: reservation.appliedMaxTokens, hardTimeoutMs: reservation.remainingElapsedMs }
      : undefined,
  )
  const executionCounts = structuredOutputExecutionCounts(result.attempts, options.rerun)
  result = { ...result, executionCounts }
  if (reservation) {
    const executionEconomics = await settleStructuredOutputBudget({
      reservation,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      counts: executionCounts,
    })
    result = { ...result, executionEconomics }
  }
  if (request.idempotencyKey) {
    const namespace = options.rerun ? 'rerun' : 'primary'
    result = {
      ...result,
      idempotency: {
        key: request.idempotencyKey,
        requestHash: structuredOutputIdempotencyHash(namespace, request),
        replayed: false,
        namespace,
      },
    }
  }
  if (options.persist) {
    const persisted = await persistStructuredOutputResult(request, result)
    result = {
      ...result,
      persisted: true,
      artifactId: persisted.artifactId,
      attemptLedgerId: persisted.attemptLedgerId,
      runRef: request.runRef,
    }
  }
  if (options.rerun) {
    result = {
      ...result,
      rerun: true,
      parentArtifactId: request.previousArtifactId,
      rerunOf: request.previousArtifactId,
      ...(request.inputRef ? { inputRef: request.inputRef } : {}),
      ...(request.artifactRef ? { artifactRef: request.artifactRef } : {}),
    }
  }
  return { status: 200, body: result as unknown as Record<string, unknown> }
}

function estimateStructuredOutputInputTokens(request: StructuredOutputRequest): number {
  const bytes = Buffer.byteLength(JSON.stringify({
    model: request.model,
    system: request.system,
    user: request.user,
    schema: request.schema,
    policy: request.policy,
  }), 'utf8')
  // A BPE token cannot contain less than one source byte. Doubling the full
  // caller contract plus fixed overhead also covers the preset/schema summary
  // that the harness appends when it builds the actual provider messages.
  return Math.max(1, bytes * 2 + 4_096)
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

function structuredOutputSchemaName(request: StructuredOutputRequest): string {
  const raw = request.schemaId?.trim() || request.presetId?.trim() || 'structured_output'
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'structured_output'
}

function supportsProviderNativeSchema(request: StructuredOutputRequest): boolean {
  return request.modelCapabilities?.jsonMode.status === 'supported'
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
    const nativeSchema = supportsProviderNativeSchema(request) ? request.schema : undefined
    const anthropicBody: AnthropicMessagesRequest = {
      model: request.model,
      system: request.system,
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: request.user }],
      stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(nativeSchema
        ? { output_config: { format: { type: 'json_schema' as const, schema: nativeSchema } } }
        : {}),
    }
    const upstreamBody = route.translate
      ? {
          ...translateRequest(anthropicBody, route.backendModel),
          stream,
          ...(nativeSchema
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: structuredOutputSchemaName(request),
                    strict: false,
                    schema: nativeSchema,
                  },
                },
              }
            : {}),
        }
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
    const timeoutMs = Math.min(
      adaptiveBudget.timeoutMs,
      request.hardTimeoutMs ?? adaptiveBudget.timeoutMs,
    )
    const signal = AbortSignal.timeout(timeoutMs)
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
  let idempotencyKey: string | undefined
  try {
    idempotencyKey = resolveIdempotencyKey(req, body)
    if (body.executionBudget && (!body.persist || !body.runRef || !body.taskId)) {
      throw new Error('executionBudget requires persist=true, runRef, and taskId')
    }
    const executionBudget = body.executionBudget
      ? validateStructuredOutputExecutionBudget(body.executionBudget)
      : undefined
    harnessRequest = resolveStructuredOutputContract(withRegistryStructuredOutputCapabilities(config, {
      ...body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(executionBudget ? { executionBudget } : {}),
    }))
  } catch (err) {
    invalidRequest(res, err instanceof Error ? err.message : String(err))
    return
  }

  try {
    const result = await executeIdempotently('primary', idempotencyKey, harnessRequest, () =>
      executeStructuredOutputRequest(harnessRequest, config, {
        rerun: false,
        persist: harnessRequest.persist === true,
      }))
    sendJson(res, result.status, result.body)
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
  let idempotencyKey: string | undefined
  try {
    idempotencyKey = resolveIdempotencyKey(req, body)
    const executionBudget = body.executionBudget
      ? validateStructuredOutputExecutionBudget(body.executionBudget)
      : undefined
    await findRunWorkspaceArtifact(body.runRef, body.previousArtifactId)
    rerunRequest = resolveStructuredOutputContract(
      withRegistryStructuredOutputCapabilities(config, await buildRerunRequest({
        ...body,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(executionBudget ? { executionBudget } : {}),
      })),
    )
  } catch (err) {
    invalidRequest(res, err instanceof Error ? err.message : String(err))
    return
  }

  try {
    const result = await executeIdempotently('rerun', idempotencyKey, rerunRequest, () =>
      executeStructuredOutputRequest(rerunRequest, config, { rerun: true, persist: true }))
    sendJson(res, result.status, result.body)
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
