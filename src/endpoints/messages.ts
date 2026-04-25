import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import type { AnthropicMessagesRequest } from '../types.js'
import { translateRequest } from '../translate/request.js'
import { translateResponse } from '../translate/response.js'
import { StreamTranslator } from '../translate/stream.js'
import { parseSSEStream, readStreamChunkWithDeadline } from '../utils/sse.js'
import { LocalRuntimeProtocolUnresolvedError, resolveModelRoute } from '../config.js'
import { readBody } from '../server.js'
import { makeAnthropicError } from '../utils/errors.js'
import { setRateLimitHeaders } from '../utils/ratelimit.js'
import { activeStreams, getShutdownSignal } from '../server.js'
import { addTokenUsage } from '../trace.js'
import { runRequestHooks, runResponseHooks, runErrorHooks } from '../plugins/index.js'
import { withRetry } from '../middleware/retry.js'
import { checkRateLimit } from '../middleware/rate-limit.js'
import { buildFallbackChain, withFallback } from '../middleware/fallback.js'
import { isModelHealthy } from '../health-monitor.js'
import { isCircuitOpen, recordSuccess, recordFailure } from '../middleware/circuit-breaker.js'
import { logAuditEntry } from '../audit.js'
import { estimateCost, formatCostEstimate } from '../cost-estimator.js'
import { routeByIntent } from '../intent-router.js'
import { recordRequestMetrics } from '../perf-tracker.js'
import { validateMessagesBody } from '../middleware/validate.js'
import { recordOutcome } from '../error-budget.js'
import { createTrace } from '../request-trace.js'
import { cacheKey, getCached, putCache } from '../response-cache.js'
import { injectSkills } from '../skills/injection.js'
import { collectProxyExchange } from '../data/proxy-collector.js'
import { logWarn } from '../logger.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  createStreamInterruptedDiagnostic,
  diagnosticToAnthropicError,
  inferProviderName,
  type ProviderDiagnosticContext,
  type ProviderRequestDiagnostic,
  upstreamRequestIdFromHeaders,
} from '../provider-error.js'

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
): Promise<void> {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

  const requestId = res.getHeader('x-request-id') as string ?? ''
  const trace = createTrace(requestId)
  trace.mark('received')

  // Overall request timeout
  const timeoutMs = config.middleware?.requestTimeoutMs ?? 120_000
  const timeoutController = new AbortController()
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs)

  try {
    await handleMessagesInner(req, res, config, trace, timeoutController.signal)
  } catch (err) {
    if (timeoutController.signal.aborted) {
      trace.mark('request_timeout')
      const diagnostic = classifyProviderRequestError(new Error(`Request timed out after ${timeoutMs}ms`), {
        model: 'unknown-model',
        provider: 'router',
        requestId,
        status: 504,
      })
      const mapped = diagnosticToAnthropicError(diagnostic)
      if (!res.headersSent) {
        res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mapped.body))
      }
      return
    }
    throw err
  } finally {
    clearTimeout(timeoutTimer)
  }
}

async function handleMessagesInner(
  req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
  trace: ReturnType<typeof createTrace>,
  signal: AbortSignal,
): Promise<void> {
  const requestId = res.getHeader('x-request-id') as string ?? ''
  const maxBodyBytes = config.middleware?.maxRequestBodyBytes ?? 10_485_760
  let rawBody: string
  try {
    rawBody = await readBody(req, maxBodyBytes)
  } catch (sizeErr) {
    if (sizeErr instanceof Error && sizeErr.message.includes('too large')) {
      const err = makeAnthropicError(413, 'invalid_request_error', 'Request body too large')
      res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(err.body))
      return
    }
    throw sizeErr
  }
  let body: AnthropicMessagesRequest
  try {
    body = JSON.parse(rawBody)
  } catch {
    const err = makeAnthropicError(400, 'invalid_request_error', 'Invalid JSON in request body')
    res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(err.body))
    return
  }

  // 2. Validation (structured)
  const validation = validateMessagesBody(body)
  if (!validation.valid) {
    const err = makeAnthropicError(400, 'invalid_request_error', validation.error)
    res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(err.body))
    return
  }

  trace.mark('validated')

  // 3. Plugin request hooks
  await runRequestHooks({
    method: 'POST',
    endpoint: '/v1/messages',
    model: body.model,
    messageCount: body.messages.length,
    body,
  })

  // 3a. Skill injection — match learned skills and augment system prompt
  if (config.skillInjection !== false) {
    const skillResult = await injectSkills(body.system, body.messages, {
      topK: config.skillTopK,
      threshold: config.skillThreshold,
    })
    if (skillResult.injectedIds.length > 0) {
      body.system = skillResult.system as typeof body.system
      res.setHeader('x-owlcoda-skills', skillResult.injectedIds.join(','))
      res.setHeader('x-owlcoda-skill-scores', skillResult.matchedSkills.map(m => `${m.skill.id}:${Math.round(m.score * 1000) / 1000}`).join(','))
    }
  }

  // 4. Stream handling
  if (body.stream) {
    return handleMessagesStream(req, res, body, config, signal)
  }

  // 3b. Check response cache for non-streaming requests
  const cKey = cacheKey(body.model, body.messages, {
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    system: body.system,
  })
  const cached = getCached(cKey)
  if (cached) {
    trace.mark('cache_hit')
    const traceResult = trace.end()
    setRateLimitHeaders(res)
    res.setHeader('x-owlcoda-cache', 'hit')
    res.setHeader('x-owlcoda-duration-ms', String(traceResult.totalMs))
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json' })
    res.end(cached.body)
    return
  }

  // 4. Intent-based model routing (opt-in via middleware.intentRouting)
  const mwCfg = config.middleware ?? {}
  let effectiveModel = body.model
  let intentHeader: string | undefined
  if (mwCfg.intentRouting) {
    const intentResult = routeByIntent(config, body)
    if (intentResult.modelId && intentResult.modelId !== body.model) {
      effectiveModel = intentResult.modelId
      intentHeader = `${intentResult.intent} (${intentResult.signal.confidence.toFixed(2)})`
    }
  }

  // 4a. Model routing (local or cloud)
  let route
  try {
    route = resolveModelRoute(config, effectiveModel)
  } catch (err) {
    if (err instanceof LocalRuntimeProtocolUnresolvedError) {
      const mapped = makeAnthropicError(503, 'api_error', err.message)
      res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mapped.body))
      return
    }
    throw err
  }
  trace.mark('routed')

  // 4b. Rate limit admission gate (config-driven)
  const rlConfig = mwCfg.rateLimitRpm
    ? { maxRequests: mwCfg.rateLimitRpm, windowMs: 60_000 }
    : undefined
  const rl = checkRateLimit(route.backendModel, rlConfig)
  if (!rl.allowed) {
    const retryAfterSec = Math.ceil((rl.retryAfterMs ?? 1000) / 1000)
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSec),
    })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: `Rate limit exceeded for model ${route.backendModel}. Retry after ${rl.retryAfterMs}ms.` },
    }))
    return
  }

  // 5. Build fallback chain and execute with fallback
  const retryOpts = {
    ...(mwCfg.retryMaxAttempts != null ? { maxRetries: mwCfg.retryMaxAttempts } : {}),
    ...(mwCfg.retryBaseDelayMs != null ? { baseDelayMs: mwCfg.retryBaseDelayMs } : {}),
  }
  const fallbackEnabled = mwCfg.fallbackEnabled !== false // default true
  const fallbackChain = fallbackEnabled
    ? buildFallbackChain(config, route.backendModel)
    : [route.backendModel]
  const healthFilter = (modelId: string) => isModelHealthy(modelId) && !isCircuitOpen(modelId)

  let fallbackResult: import('../middleware/fallback.js').FallbackResult
  trace.mark('fetch_start')
  try {
    fallbackResult = await withFallback(fallbackChain, async (modelId) => {
      const modelRoute = resolveModelRoute(config, modelId)
      const requestBody = modelRoute.translate
        ? translateRequest(body, modelRoute.backendModel)
        : {
            ...body,
            model: modelRoute.backendModel,
          }

      return withRetry(() => fetch(modelRoute.endpointUrl, {
        method: 'POST',
        headers: modelRoute.headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.any([signal, AbortSignal.timeout(modelRoute.timeoutMs ?? config.routerTimeoutMs), ...(getShutdownSignal() ? [getShutdownSignal()!] : [])]),
      }), retryOpts)
    }, healthFilter)
  } catch (err) {
    // All models in fallback chain failed
    for (const m of fallbackChain) recordFailure(m)
    trace.mark('fetch_error')
    const failedModelId = typeof (err as { modelId?: unknown })?.modelId === 'string' ? (err as { modelId: string }).modelId : route.backendModel
    const failedRoute = resolveModelRoute(config, failedModelId)
    const diagnostic = classifyEndpointRequestFailure(err, {
      route: failedRoute,
      model: body.model,
      requestId,
      requestSignal: signal,
      requestTimeoutMs: timeoutMsForConfig(config),
      routeTimeoutMs: failedRoute.timeoutMs ?? config.routerTimeoutMs,
    })
    const mapped = diagnosticToAnthropicError(diagnostic)
    const traceResult = trace.end()
    await runErrorHooks({ endpoint: '/v1/messages', errorType: 'fetch_error', message: mapped.body.error.message })
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    await logFailureAuditEntry({
      requestId,
      model: body.model,
      servedBy: failedModelId,
      durationMs: traceResult.totalMs,
      streaming: false,
      fallbackUsed: fallbackChain.length > 1,
      failure: diagnostic,
    })
    return
  }

  const { response: upstream, servedBy, fallbackUsed } = fallbackResult
  trace.mark('fetch_end')
  recordSuccess(servedBy)
  recordOutcome(servedBy, upstream.ok)

  // 7. Handle upstream errors
  if (!upstream.ok) {
    recordFailure(servedBy)
    trace.mark('upstream_error')
    const detail = await upstream.text()
    const upstreamRoute = resolveModelRoute(config, servedBy)
    const diagnostic = createProviderHttpDiagnostic(upstream.status, detail, {
      ...buildProviderDiagnosticContext(upstreamRoute, body.model, requestId),
      upstreamRequestId: upstreamRequestIdFromHeaders(upstream.headers),
    })
    const mapped = diagnosticToAnthropicError(diagnostic)
    const traceResult = trace.end()
    await runErrorHooks({ endpoint: '/v1/messages', errorType: 'upstream_error', message: diagnostic.detail.slice(0, 200) })
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    await logFailureAuditEntry({
      requestId,
      model: body.model,
      servedBy,
      durationMs: traceResult.totalMs,
      streaming: false,
      fallbackUsed,
      failure: diagnostic,
    })
    return
  }

  // 8. Translate response (skip for cloud models)
  const servedRoute = resolveModelRoute(config, servedBy)
  const upstreamResp = await upstream.json() as any
  const anthropicResp = servedRoute.translate
    ? translateResponse(upstreamResp, body.model, config)
    : upstreamResp
  trace.mark('translated')

  // Track token usage
  const respUsage = anthropicResp?.usage
  if (respUsage) {
    addTokenUsage(
      respUsage.input_tokens ?? 0,
      respUsage.output_tokens ?? 0,
      respUsage.cache_read_input_tokens ?? 0,
      respUsage.cache_creation_input_tokens ?? 0,
    )
  }

  // Plugin response hooks
  await runResponseHooks({
    method: 'POST',
    endpoint: '/v1/messages',
    model: body.model,
    statusCode: 200,
    durationMs: 0,
    inputTokens: respUsage?.input_tokens ?? 0,
    outputTokens: respUsage?.output_tokens ?? 0,
    body: anthropicResp,
  })

  // 9. Return
  const traceResult = trace.end()
  setRateLimitHeaders(res)
  res.setHeader('x-owlcoda-served-by', servedBy)
  res.setHeader('x-owlcoda-duration-ms', String(traceResult.totalMs))
  if (fallbackUsed) res.setHeader('x-owlcoda-fallback', 'true')
  if (intentHeader) res.setHeader('x-owlcoda-intent', intentHeader)

  // Cost estimation header
  const inputTok = respUsage?.input_tokens ?? 0
  const outputTok = respUsage?.output_tokens ?? 0
  if (inputTok > 0 || outputTok > 0) {
    const cost = estimateCost(inputTok, outputTok, servedBy)
    res.setHeader('x-owlcoda-estimated-cost', formatCostEstimate(cost))
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const responseJson = JSON.stringify(anthropicResp)
  res.end(responseJson)

  // Store in response cache (fire-and-forget)
  putCache(cKey, responseJson, 200)

  // Performance tracking
  recordRequestMetrics({
    modelId: servedBy,
    inputTokens: inputTok,
    outputTokens: outputTok,
    durationMs: traceResult.totalMs,
    success: true,
  })

  // Audit log (fire-and-forget)
  logAuditEntry({
    timestamp: new Date().toISOString(),
    requestId: res.getHeader('x-request-id') as string ?? '',
    model: body.model,
    servedBy,
    inputTokens: respUsage?.input_tokens ?? 0,
    outputTokens: respUsage?.output_tokens ?? 0,
    durationMs: traceResult.totalMs,
    status: 200,
    fallbackUsed,
    streaming: false,
  }).catch(e => logWarn('audit', `Failed to log audit entry: ${e}`))

  // Training data collection from proxy exchanges (fire-and-forget)
  collectProxyExchange({
    requestMessages: body.messages,
    responseContent: anthropicResp?.content,
    model: body.model,
  }).catch(e => logWarn('training', `Failed to collect proxy exchange: ${e}`))
}

async function handleMessagesStream(
  _req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicMessagesRequest,
  config: OwlCodaConfig,
  signal: AbortSignal,
): Promise<void> {
  const streamRequestId = res.getHeader('x-request-id') as string ?? ''
  const trace = createTrace(streamRequestId)
  trace.mark('received')

  // Intent-based model routing (opt-in)
  const mwCfg = config.middleware ?? {}
  let effectiveStreamModel = body.model
  let streamIntentHeader: string | undefined
  if (mwCfg.intentRouting) {
    const intentResult = routeByIntent(config, body)
    if (intentResult.modelId && intentResult.modelId !== body.model) {
      effectiveStreamModel = intentResult.modelId
      streamIntentHeader = `${intentResult.intent} (${intentResult.signal.confidence.toFixed(2)})`
    }
  }

  let route
  try {
    route = resolveModelRoute(config, effectiveStreamModel)
  } catch (err) {
    if (err instanceof LocalRuntimeProtocolUnresolvedError) {
      const mapped = makeAnthropicError(503, 'api_error', err.message)
      res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mapped.body))
      return
    }
    throw err
  }
  trace.mark('routed')

  // Rate limit admission gate (config-driven)
  const rlConfig = mwCfg.rateLimitRpm
    ? { maxRequests: mwCfg.rateLimitRpm, windowMs: 60_000 }
    : undefined
  const rl = checkRateLimit(route.backendModel, rlConfig)
  if (!rl.allowed) {
    const retryAfterSec = Math.ceil((rl.retryAfterMs ?? 1000) / 1000)
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSec),
    })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: `Rate limit exceeded for model ${route.backendModel}. Retry after ${rl.retryAfterMs}ms.` },
    }))
    return
  }

  const inputTokenEstimate = Math.ceil(JSON.stringify(body.messages).length / 4)

  let upstream: Response
  let servedByModel = route.backendModel
  let streamFallbackUsed = false
  let streamFailure: ProviderRequestDiagnostic | null = null
  const retryOpts = {
    ...(mwCfg.retryMaxAttempts != null ? { maxRetries: mwCfg.retryMaxAttempts } : {}),
    ...(mwCfg.retryBaseDelayMs != null ? { baseDelayMs: mwCfg.retryBaseDelayMs } : {}),
  }
  const fallbackEnabled = mwCfg.fallbackEnabled !== false
  const streamFallbackChain = fallbackEnabled
    ? buildFallbackChain(config, route.backendModel)
    : [route.backendModel]
  const streamHealthFilter = (modelId: string) => isModelHealthy(modelId) && !isCircuitOpen(modelId)

  trace.mark('fetch_start')
  try {
    const result = await withFallback(streamFallbackChain, async (modelId) => {
      const modelRoute = resolveModelRoute(config, modelId)
      let reqBody: any
      if (!modelRoute.translate) {
        // Cloud model: forward full Anthropic body with correct backend model name
        reqBody = {
          ...body,
          model: modelRoute.backendModel,
          stream: true,
        }
      } else {
        const openaiReq = translateRequest(body, modelRoute.backendModel)
        openaiReq.stream = true
        reqBody = openaiReq
      }
      return withRetry(() => fetch(modelRoute.endpointUrl, {
        method: 'POST',
        headers: modelRoute.headers,
        body: JSON.stringify(reqBody),
        signal: AbortSignal.any([signal, AbortSignal.timeout(modelRoute.timeoutMs ?? config.routerTimeoutMs), ...(getShutdownSignal() ? [getShutdownSignal()!] : [])]),
      }), retryOpts)
    }, streamHealthFilter)
    upstream = result.response
    servedByModel = result.servedBy
    streamFallbackUsed = result.fallbackUsed
  } catch (err) {
    for (const m of streamFallbackChain) recordFailure(m)
    recordOutcome(route.backendModel, false)
    trace.mark('fetch_error')
    const failedModelId = typeof (err as { modelId?: unknown })?.modelId === 'string' ? (err as { modelId: string }).modelId : route.backendModel
    const failedRoute = resolveModelRoute(config, failedModelId)
    const diagnostic = classifyEndpointRequestFailure(err, {
      route: failedRoute,
      model: body.model,
      requestId: streamRequestId,
      requestSignal: signal,
      requestTimeoutMs: timeoutMsForConfig(config),
      routeTimeoutMs: failedRoute.timeoutMs ?? config.routerTimeoutMs,
    })
    const mapped = diagnosticToAnthropicError(diagnostic)
    const traceResult = trace.end()
    await runErrorHooks({ endpoint: '/v1/messages (stream)', errorType: 'fetch_error', message: mapped.body.error.message })
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    await logFailureAuditEntry({
      requestId: streamRequestId,
      model: body.model,
      servedBy: failedModelId,
      durationMs: traceResult.totalMs,
      streaming: true,
      fallbackUsed: streamFallbackChain.length > 1,
      failure: diagnostic,
    })
    return
  }

  if (!upstream.ok) {
    recordFailure(servedByModel)
    recordOutcome(servedByModel, false)
    trace.mark('upstream_error')
    const detail = await upstream.text()
    const upstreamRoute = resolveModelRoute(config, servedByModel)
    const diagnostic = createProviderHttpDiagnostic(upstream.status, detail, {
      ...buildProviderDiagnosticContext(upstreamRoute, body.model, streamRequestId),
      upstreamRequestId: upstreamRequestIdFromHeaders(upstream.headers),
    })
    const mapped = diagnosticToAnthropicError(diagnostic)
    const traceResult = trace.end()
    await runErrorHooks({ endpoint: '/v1/messages (stream)', errorType: 'upstream_error', message: diagnostic.detail.slice(0, 200) })
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    await logFailureAuditEntry({
      requestId: streamRequestId,
      model: body.model,
      servedBy: servedByModel,
      durationMs: traceResult.totalMs,
      streaming: true,
      fallbackUsed: streamFallbackUsed,
      failure: diagnostic,
    })
    return
  }

  trace.mark('fetch_end')
  const now = Math.floor(Date.now() / 1000)
  const streamHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'x-owlcoda-served-by': servedByModel,
    'anthropic-ratelimit-unified-5h-utilization': '0',
    'anthropic-ratelimit-unified-5h-reset': String(now + 5 * 3600),
    'anthropic-ratelimit-unified-7d-utilization': '0',
    'anthropic-ratelimit-unified-7d-reset': String(now + 7 * 86400),
    'anthropic-ratelimit-unified-status': 'allowed',
  }
  if (streamFallbackUsed) streamHeaders['x-owlcoda-fallback'] = 'true'
  if (streamIntentHeader) streamHeaders['x-owlcoda-intent'] = streamIntentHeader
  res.writeHead(200, streamHeaders)

  activeStreams.add(res)
  const streamCleanup = (): void => { activeStreams.delete(res) }
  res.on('close', streamCleanup)
  res.on('error', streamCleanup)
  _req.on('error', streamCleanup)
  recordSuccess(servedByModel)
  recordOutcome(servedByModel, true)

  const servedRoute = resolveModelRoute(config, servedByModel)
  const streamBodyTimeoutMs = servedRoute.timeoutMs ?? config.routerTimeoutMs
  const translator = servedRoute.translate
    ? new StreamTranslator(body.model, inputTokenEstimate)
    : null

  // If upstream returned non-streaming JSON despite the streaming request, translate and emit SSE inline
  const upstreamContentType = upstream.headers.get('content-type') ?? ''
  if (translator && upstreamContentType.includes('application/json')) {
    try {
      const jsonBody = await upstream.json() as Record<string, unknown>
      const anthropicResp = translateResponse(jsonBody as any, body.model, config)
      // Emit as a minimal SSE stream so the client sees proper events
      const sseText = anthropicResp.content.find((b: any) => b.type === 'text')
      const textContent = sseText ? (sseText as any).text as string : ''
      const toolUseBlocks = anthropicResp.content.filter((b: any) => b.type === 'tool_use')
      const st = new StreamTranslator(body.model, inputTokenEstimate)
      if (textContent) {
        const chunkData = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        for (const ev of st.processLine(chunkData)) res.write(ev)
        const chunkData2 = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] })
        for (const ev of st.processLine(chunkData2)) res.write(ev)
      }
      if (toolUseBlocks.length > 0) {
        const openaiToolCalls = toolUseBlocks.map((b: any, i: number) => ({
          index: i,
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }))
        const chunkData = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: openaiToolCalls }, finish_reason: null }] })
        for (const ev of st.processLine(chunkData)) res.write(ev)
      }
      const finishReason = toolUseBlocks.length > 0 ? 'tool_calls' : 'stop'
      const finalChunk = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: anthropicResp.usage.input_tokens, completion_tokens: anthropicResp.usage.output_tokens, total_tokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens } })
      for (const ev of st.processLine(finalChunk)) res.write(ev)
      for (const ev of st.flush()) res.write(ev)
    } catch (translateErr) {
      const finalEvents = new StreamTranslator(body.model, inputTokenEstimate).flush()
      for (const event of finalEvents) res.write(event)
    }
    res.end()
    trace.mark('stream_end')
    addTokenUsage(0, 0)
    activeStreams.delete(res)
    return
  }

  // Hoisted so the `finally` block (recordRequestMetrics + audit log) can
  // see the real usage for both branches. Previously cloudInputTokens /
  // cloudOutputTokens lived inside the else-branch and were invisible
  // downstream — audit always logged `outputTokens: 0` for Anthropic
  // cloud streams, and recordRequestMetrics fell back to the crude
  // `JSON.stringify(messages).length / 4` estimate that ignores system
  // + tools. The translator path had the same bug in the audit log
  // (hardcoded `outputTokens: 0` below).
  let finalInputTokens = 0
  let finalOutputTokens = 0

  trace.mark('stream_start')
  try {
    const stream = upstream.body
    if (!stream) throw new Error('No response body')

    if (translator) {
      // Local model: parse OpenAI SSE and translate to Anthropic SSE
      let sawVisibleOutput = false
      let sawTerminalEvent = false
      for await (const dataContent of parseSSEStream(stream, { timeoutMs: streamBodyTimeoutMs, signal })) {
        const events = translator.processLine(dataContent)
        if (events.some(event => event.includes('content_block_delta') || event.includes('"tool_use"'))) {
          sawVisibleOutput = true
        }
        if (events.some(event => event.includes('message_stop'))) {
          sawTerminalEvent = true
        }
        for (const event of events) {
          res.write(event)
        }
      }
      if (!sawTerminalEvent) {
        throw createStreamInterruptedError(!sawVisibleOutput)
      }
      const finalEvents = translator.flush()
      for (const event of finalEvents) {
        res.write(event)
      }
      const usage = translator.getFinalUsage()
      finalInputTokens = usage.inputTokens
      finalOutputTokens = usage.outputTokens
      addTokenUsage(usage.inputTokens, usage.outputTokens)
    } else {
      // Cloud model: normalize response to SSE format
      // Some providers return proper SSE (event: X\ndata: Y\n\n)
      // Others return raw JSON lines — detect and normalize
      const rawReader = stream.getReader()
      const rawDecoder = new TextDecoder()
      let lineBuffer = ''
      let cloudInputTokens = 0
      let cloudOutputTokens = 0
      let sawVisibleOutput = false
      let sawTerminalEvent = false

      // Helper to extract token usage from parsed event data
      const extractUsage = (parsed: any) => {
        // message_start: { type: "message_start", message: { usage: { input_tokens, output_tokens } } }
        if (parsed?.message?.usage) {
          cloudInputTokens += parsed.message.usage.input_tokens ?? 0
          cloudOutputTokens += parsed.message.usage.output_tokens ?? 0
        }
        // message_delta: { type: "message_delta", usage: { output_tokens } }
        if (parsed?.usage?.output_tokens) {
          cloudOutputTokens += parsed.usage.output_tokens
        }
        if (parsed?.usage?.input_tokens) {
          cloudInputTokens += parsed.usage.input_tokens
        }
      }

      // Cross-chunk buffer for SSE parsing. Previous versions used
      // `chunk.includes('message_stop')` / `chunk.split('\n').filter(...)`
      // which broke at TCP packet boundaries: a `data:{...}` line split
      // across two chunks had JSON.parse fail on the first half and
      // the tail in the second chunk didn't start with `data:` so the
      // filter dropped it. Result: every usage event from kimi silently
      // lost, audit always reported outputTokens=0. Buffer to `\n\n`
      // event delimiters so we only parse complete frames.
      let sseBuffer = ''
      const parseSSEEvent = (block: string): void => {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trimStart()
          if (!payload) continue
          if (payload === '[DONE]') {
            sawTerminalEvent = true
            continue
          }
          try {
            const parsed = JSON.parse(payload) as { type?: string }
            if (parsed.type === 'message_stop') sawTerminalEvent = true
            if (parsed.type === 'content_block_delta' || parsed.type === 'content_block_start') {
              sawVisibleOutput = true
            }
            extractUsage(parsed)
          } catch { /* partial/non-JSON data line — ignore */ }
        }
      }

      try {
        while (true) {
          const { done, value } = await readStreamChunkWithDeadline(rawReader, { timeoutMs: streamBodyTimeoutMs, signal })
          if (done) break
          const chunk = rawDecoder.decode(value, { stream: true })

          // Check if this looks like proper SSE (has event: or data: prefix)
          if (chunk.includes('event:') || chunk.includes('data:') || sseBuffer.length > 0) {
            // Already SSE format — pass through verbatim, but buffer for
            // cross-chunk event parsing.
            res.write(chunk)
            sseBuffer += chunk
            let delimIdx = sseBuffer.indexOf('\n\n')
            while (delimIdx !== -1) {
              const block = sseBuffer.slice(0, delimIdx)
              sseBuffer = sseBuffer.slice(delimIdx + 2)
              parseSSEEvent(block)
              delimIdx = sseBuffer.indexOf('\n\n')
            }
          } else {
            // Raw JSON lines — normalize each line to SSE format
            lineBuffer += chunk
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop()! // Keep incomplete last line
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              // Extract event type from JSON to create proper SSE event name
              try {
                const parsed = JSON.parse(trimmed) as { type?: string }
                const eventType = parsed.type ?? 'message'
                if (eventType === 'message_stop') sawTerminalEvent = true
                if (eventType === 'content_block_delta' || eventType === 'content_block_start') sawVisibleOutput = true
                res.write(`event: ${eventType}\ndata: ${trimmed}\n\n`)
                extractUsage(parsed)
              } catch {
                // Not valid JSON — pass through as data
                res.write(`data: ${trimmed}\n\n`)
              }
            }
          }
        }
        // Flush remaining buffer (raw-JSON branch: treat leftover as one frame).
        if (lineBuffer.trim()) {
          try {
            const parsed = JSON.parse(lineBuffer.trim()) as { type?: string }
            const eventType = parsed.type ?? 'message'
            if (eventType === 'message_stop') sawTerminalEvent = true
            if (eventType === 'content_block_delta' || eventType === 'content_block_start') sawVisibleOutput = true
            res.write(`event: ${eventType}\ndata: ${lineBuffer.trim()}\n\n`)
            extractUsage(parsed)
          } catch {
            res.write(`data: ${lineBuffer.trim()}\n\n`)
          }
        }
        // Drain trailing SSE buffer (SSE branch: parse any leftover block that
        // wasn't terminated by \n\n before upstream closed).
        if (sseBuffer.trim()) {
          parseSSEEvent(sseBuffer)
        }
        if (!sawTerminalEvent) {
          throw createStreamInterruptedError(!sawVisibleOutput)
        }
        // Record cloud token usage in proxy metrics + hoist for the outer
        // finally block (audit / recordRequestMetrics both need these).
        finalInputTokens = cloudInputTokens
        finalOutputTokens = cloudOutputTokens
        if (cloudInputTokens > 0 || cloudOutputTokens > 0) {
          addTokenUsage(cloudInputTokens, cloudOutputTokens)
        }
      } finally {
        rawReader.releaseLock()
      }
    }
  } catch (err) {
    trace.mark('stream_error')
    streamFailure = err instanceof Error && 'diagnostic' in err
      ? (err as { diagnostic: ProviderRequestDiagnostic }).diagnostic
      : classifyEndpointRequestFailure(err, {
        route: servedRoute,
        model: body.model,
        requestId: streamRequestId,
        upstreamHeaders: upstream.headers,
        requestSignal: signal,
        requestTimeoutMs: timeoutMsForConfig(config),
        routeTimeoutMs: servedRoute.timeoutMs ?? config.routerTimeoutMs,
      })
    recordFailure(servedByModel)
    recordOutcome(servedByModel, false)
    await runErrorHooks({ endpoint: '/v1/messages (stream)', errorType: 'stream_error', message: streamFailure.message.slice(0, 200) })
    try {
      const errorEvent = `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: {
          type: diagnosticToAnthropicError(streamFailure).body.error.type,
          message: streamFailure.message,
          diagnostic: streamFailure,
        },
      })}\n\n`
      res.write(errorEvent)
    } catch { /* ignore write failure */ }
  } finally {
    trace.mark('stream_end')
    const streamTraceResult = trace.end()
    res.end()

    // Performance tracking for streaming. finalInputTokens / finalOutputTokens
    // are populated by both branches above (translator path + cloud path), so
    // this no longer underreports output=0 on Anthropic cloud streams.
    // Fall back to the body.messages-only estimate when we genuinely saw no
    // usage events (e.g. upstream closed before any message_start).
    const metricsInputTokens = finalInputTokens > 0 ? finalInputTokens : inputTokenEstimate
    recordRequestMetrics({
      modelId: servedByModel,
      inputTokens: metricsInputTokens,
      outputTokens: finalOutputTokens,
      durationMs: streamTraceResult.totalMs,
      success: streamFailure === null,
    })

    if (streamFailure) {
      await logFailureAuditEntry({
        requestId: streamRequestId,
        model: body.model,
        servedBy: servedByModel,
        durationMs: streamTraceResult.totalMs,
        streaming: true,
        fallbackUsed: streamFallbackUsed,
        failure: streamFailure,
      })
    } else {
      // Audit log for streaming (fire-and-forget). Uses the same hoisted
      // counters as recordRequestMetrics so cloud/translator paths both
      // report real tokens; the previous hardcoded `outputTokens: 0` made
      // it impossible to distinguish "kimi returned no content" from
      // "our metric code didn't know how to read the counter".
      logAuditEntry({
        timestamp: new Date().toISOString(),
        requestId: res.getHeader('x-request-id') as string ?? '',
        model: body.model,
        servedBy: servedByModel,
        inputTokens: metricsInputTokens,
        outputTokens: finalOutputTokens,
        durationMs: streamTraceResult.totalMs,
        status: 200,
        fallbackUsed: streamFallbackUsed,
        streaming: true,
      }).catch(e => logWarn('audit', `Failed to log streaming audit entry: ${e}`))
    }

    // Training data collection from streaming proxy exchanges (fire-and-forget)
    // Note: body.messages contains conversation history; response not captured in streaming mode
    collectProxyExchange({
      requestMessages: body.messages,
      responseContent: null,
      model: body.model,
    }).catch(e => logWarn('training', `Failed to collect streaming proxy exchange: ${e}`))
  }
}

function buildProviderDiagnosticContext(
  route: ReturnType<typeof resolveModelRoute>,
  model: string,
  requestId: string,
  upstreamHeaders?: Headers,
): ProviderDiagnosticContext {
  return {
    model,
    provider: inferProviderName({
      endpointUrl: route.endpointUrl,
      headers: route.headers,
    }),
    endpointUrl: route.endpointUrl,
    headers: route.headers,
    requestId,
    upstreamRequestId: upstreamRequestIdFromHeaders(upstreamHeaders),
  }
}

function classifyEndpointRequestFailure(
  err: unknown,
  options: {
    route: ReturnType<typeof resolveModelRoute>
    model: string
    requestId: string
    upstreamHeaders?: Headers
    requestSignal: AbortSignal
    requestTimeoutMs: number
    routeTimeoutMs?: number
  },
): ProviderRequestDiagnostic {
  const context = buildProviderDiagnosticContext(
    options.route,
    options.model,
    options.requestId,
    options.upstreamHeaders,
  )
  if (!isAbortLikeError(err)) {
    return classifyProviderRequestError(err, context)
  }

  // Endpoint aborts are server-owned signals, not REPL Ctrl+C. Preserve the
  // origin so long-running cmux/workspace requests do not masquerade as user
  // cancellations after the proxy's 120s or per-model timeout fires.
  if (options.requestSignal.aborted) {
    return classifyProviderRequestError(
      new Error(`Request timed out after ${options.requestTimeoutMs}ms`),
      { ...context, status: 504 },
    )
  }

  const shutdownSignal = getShutdownSignal()
  if (shutdownSignal?.aborted) {
    return classifyProviderRequestError(
      new Error('Server shutdown aborted request'),
      { ...context, status: 503, detail: 'server shutdown aborted request' },
    )
  }

  const routeTimeoutMs = options.routeTimeoutMs ?? 120_000
  return classifyProviderRequestError(
    new Error(`Request timed out after ${routeTimeoutMs}ms`),
    { ...context, status: 504 },
  )
}

function timeoutMsForConfig(config: OwlCodaConfig): number {
  return config.middleware?.requestTimeoutMs ?? 120_000
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError'
    || err.message === 'This operation was aborted'
    || err.message === 'Request aborted'
}

function createStreamInterruptedError(beforeFirstToken: boolean): Error {
  const err = new Error(beforeFirstToken ? 'stream closed before first token' : 'stream closed before completion')
  err.name = 'StreamInterruptedError'
  return err
}

async function logFailureAuditEntry(options: {
  requestId: string
  model: string
  servedBy?: string
  durationMs: number
  streaming: boolean
  fallbackUsed: boolean
  failure: ProviderRequestDiagnostic
}): Promise<void> {
  await logAuditEntry({
    timestamp: new Date().toISOString(),
    requestId: options.requestId,
    model: options.model,
    servedBy: options.servedBy,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: options.durationMs,
    status: options.failure.status ?? 500,
    fallbackUsed: options.fallbackUsed,
    streaming: options.streaming,
    failure: options.failure,
  }).catch(e => logWarn('audit', `Failed to log audit entry: ${e}`))
}
