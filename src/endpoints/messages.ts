import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from '../types.js'
import { translateRequest } from '../translate/request.js'
import { translateResponse } from '../translate/response.js'
import { StreamTranslator } from '../translate/stream.js'
import { parseSSEStream, readStreamChunkWithDeadline } from '../utils/sse.js'
import { isModelExplicitlyConfigured, LocalRuntimeProtocolUnresolvedError, resolveModelRoute } from '../config.js'
import { detailLooksLikeToolPairingError, summarizeMessagesShape } from '../native/protocol/tool-pairing.js'
import { readBody } from '../server.js'
import { makeAnthropicError } from '../utils/errors.js'
import { setRateLimitHeaders } from '../utils/ratelimit.js'
import { activeStreams, getShutdownSignal } from '../server.js'
import { addTokenUsage } from '../trace.js'
import { runRequestHooks, runResponseHooks, runErrorHooks } from '../plugins/index.js'
import { withRetry } from '../middleware/retry.js'
import { checkRateLimit } from '../middleware/rate-limit.js'
import { buildFallbackChain, isAutomaticFallbackEnabled, withFallback } from '../middleware/fallback.js'
import { resolveHeadersTimeoutMs, readCloudHeadersTimeoutMsFromEnv } from './headers-timeout.js'
import { isModelHealthy } from '../health-monitor.js'
import { isCircuitOpen, recordSuccess, recordFailure } from '../middleware/circuit-breaker.js'
import { logAuditEntry } from '../audit.js'
import { estimateCost, formatCostEstimate } from '../cost-estimator.js'
import { routeByIntent } from '../intent-router.js'
import { recordRoutingShadow } from '../difficulty-router.js'
import { recordRequestMetrics } from '../perf-tracker.js'
import { validateMessagesBody } from '../middleware/validate.js'
import { recordOutcome } from '../error-budget.js'
import { computeAdaptiveTimeoutMs } from '../middleware/adaptive-timeout.js'
import {
  buildNonStreamingRetryBody,
  fetchNonStreamingFallback,
  isFallbackEnabled,
  synthesizeSseFromResponse,
} from '../middleware/stream-fallback.js'
import {
  buildStreamingRetryBody,
  fetchStreamingFallback,
  isNonStreamFallbackEnabled,
} from '../middleware/non-stream-fallback.js'
import { createTrace } from '../request-trace.js'
import { cacheKey, getCached, putCache } from '../response-cache.js'
import { injectSkills } from '../skills/injection.js'
import { collectProxyExchange } from '../data/proxy-collector.js'
import { logWarn } from '../logger.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  createStreamFirstTokenTimeoutDiagnostic,
  createStreamIdleTimeoutDiagnostic,
  createStreamInterruptedDiagnostic,
  diagnosticToAnthropicError,
  inferProviderName,
  type ProviderDiagnosticContext,
  type ProviderRequestDiagnostic,
  upstreamRequestIdFromHeaders,
} from '../provider-error.js'
import { isAdaptiveAgentConcurrencyEnabled, diagnosticLooksLikeRateLimit } from '../native/adaptive-concurrency.js'
import {
  admitRequest,
  admissionKeyFromUpstream,
  recordAdmissionSuccess,
  recordAdmissionRateLimit,
  AdmissionBackpressureError,
} from './admission.js'

const MAX_STREAM_PRECOMMIT_BUFFER_BYTES = 64 * 1024

/**
 * Extract token-usage deltas from a single parsed Anthropic SSE event.
 *
 * Anthropic carries input + cache tokens in `message_start.message.usage` and
 * streams output in `message_delta.usage`. Pure so the streaming accumulator
 * (and tests) can rely on it; cache fields default to 0 for non-caching
 * providers / events without usage.
 */
export function extractAnthropicSseUsageDelta(
  parsed: unknown,
): { input: number; output: number; cacheRead: number; cacheCreation: number } {
  const delta = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const p = parsed as { message?: { usage?: Record<string, number> }; usage?: Record<string, number> } | null
  const msgUsage = p?.message?.usage
  if (msgUsage) {
    delta.input += msgUsage['input_tokens'] ?? 0
    delta.output += msgUsage['output_tokens'] ?? 0
    delta.cacheRead += msgUsage['cache_read_input_tokens'] ?? 0
    delta.cacheCreation += msgUsage['cache_creation_input_tokens'] ?? 0
  }
  const deltaUsage = p?.usage
  if (deltaUsage) {
    delta.output += deltaUsage['output_tokens'] ?? 0
    delta.input += deltaUsage['input_tokens'] ?? 0
  }
  return delta
}

export interface CloudSseUsage { input: number; output: number; cacheRead: number; cacheCreation: number }

/** Fold one SSE event's usage into a running total across the stream's events. */
export function foldAnthropicSseUsage(acc: CloudSseUsage, parsed: unknown): CloudSseUsage {
  const d = extractAnthropicSseUsageDelta(parsed)
  // input/cache are request-fixed; output is cumulative. Take the max of each so
  // message_start + message_delta (which now also carries input) never double-counts.
  return {
    input: Math.max(acc.input, d.input),
    output: Math.max(acc.output, d.output),
    cacheRead: Math.max(acc.cacheRead, d.cacheRead),
    cacheCreation: Math.max(acc.cacheCreation, d.cacheCreation),
  }
}

/** Flag a response as having hit an upstream rate-limit, for the admission AIMD signal. */
function markAdmissionRateLimited(res: ServerResponse): void {
  ;(res as { __owlcodaAdmissionRateLimited?: boolean }).__owlcodaAdmissionRateLimited = true
}

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

  // 0.13.97: timeout setup moved INSIDE handleMessagesInner so it can branch
  // on `body.stream`. Streaming requests must not be killed by a wall-clock
  // budget (active SSE responses get aborted mid-output even with chunks
  // arriving). Non-streaming continues to honor `middleware.requestTimeoutMs`
  // because there's no incremental output to preserve there.
  await handleMessagesInner(req, res, config, trace)
}

async function handleMessagesInner(
  req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
  trace: ReturnType<typeof createTrace>,
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
  if (typeof body.model === 'string' && body.model.trim().length > 0) {
    ;(res as ServerResponse & { __owlcodaAuditModel?: string }).__owlcodaAuditModel = body.model.trim()
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
      projectRoot: process.cwd(),
      topK: config.skillTopK,
      threshold: config.skillThreshold,
    })
    if (skillResult.injectedIds.length > 0) {
      body.system = skillResult.system as typeof body.system
      res.setHeader('x-owlcoda-skills', skillResult.injectedIds.join(','))
      res.setHeader('x-owlcoda-skill-scores', skillResult.matchedSkills.map(m => `${m.skill.id}:${Math.round(m.score * 1000) / 1000}`).join(','))
    }
  }

  // 3c. Cross-process admission gate (opt-in). The daemon is the single
  // chokepoint every client routes through, so bounding concurrent in-flight
  // requests per upstream here stops multiple client processes from
  // collectively bursting a shared upstream. Default-off ⇒ admitRequest is a
  // zero-overhead no-op and this block is skipped. The slot is released when
  // the response finishes or closes (covers stream + non-stream + abort);
  // release is idempotent so binding both events is safe.
  if (isAdaptiveAgentConcurrencyEnabled()) {
    let admissionKey: string
    try {
      const admissionRoute = resolveModelRoute(config, body.model)
      admissionKey = admissionKeyFromUpstream(admissionRoute.endpointUrl, admissionRoute.backendModel)
    } catch {
      admissionKey = admissionKeyFromUpstream(body.model, body.model)
    }
    const reqAbort = new AbortController()
    const onReqClose = () => reqAbort.abort()
    req.on('close', onReqClose)
    let releaseAdmission: (() => void) | null = null
    try {
      releaseAdmission = await admitRequest(admissionKey, reqAbort.signal)
    } catch (admitErr) {
      req.off('close', onReqClose)
      if (admitErr instanceof AdmissionBackpressureError) {
        const err = makeAnthropicError(429, 'rate_limit_error', 'Upstream admission backpressure; retry shortly.')
        res.writeHead(err.httpStatus, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, Math.ceil(admitErr.retryAfterMs / 1000))),
        })
        res.end(JSON.stringify(err.body))
        return
      }
      // Aborted (client already disconnected) — nothing to send.
      return
    }
    req.off('close', onReqClose)
    const release = releaseAdmission
    const settledKey = admissionKey
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      // Feed the daemon AIMD: rate-limit (incl. 400-wrapped, flagged via marker)
      // halves the limit; a clean 2xx counts as a success toward raising it.
      const rateLimited =
        (res as { __owlcodaAdmissionRateLimited?: boolean }).__owlcodaAdmissionRateLimited === true ||
        res.statusCode === 429 ||
        res.statusCode === 529
      if (rateLimited) {
        recordAdmissionRateLimit(settledKey)
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        recordAdmissionSuccess(settledKey)
      }
      release()
    }
    res.once('finish', settle)
    res.once('close', settle)
  }

  // 4. Stream handling
  if (body.stream) {
    // 0.13.97: streaming gets its own AbortController. The ONLY abort source
    // is server shutdown — never a wall-clock request budget. Active streams
    // produce incremental output; killing them mid-flight at a fixed budget
    // discards work the user already saw and reports it as a "no usable
    // response" failure even though there is one.
    //
    // Per-chunk idle is owned by readStreamChunkWithDeadline (passes
    // `streamBodyTimeoutMs`); first-token watchdog is owned by
    // handleMessagesStream itself.
    const streamController = new AbortController()
    const shutdown = getShutdownSignal()
    if (shutdown) {
      if (shutdown.aborted) {
        streamController.abort()
      } else {
        shutdown.addEventListener('abort', () => streamController.abort(), { once: true })
      }
    }
    return handleMessagesStream(req, res, body, config, streamController.signal)
  }

  // 3b/4-onwards: non-streaming path. Apply the wall-clock request budget
  // from middleware.requestTimeoutMs (default 120s) — this is correct for
  // non-streaming because the response is one-shot JSON; if it doesn't come
  // back in N seconds, there's nothing to preserve.
  //
  // 0.14.1: the flat 120s budget is too tight for long-context inputs
  // (a 17K-token doc-review request on a cloud non-streaming route can
  // legitimately need ~150-200s before any output materializes). Run
  // the request body through `computeAdaptiveTimeoutMs` which extends
  // the base budget by `adaptiveTimeoutExtensionPer10kMs` per 10K
  // estimated input tokens, capped at `adaptiveTimeoutCapMs`. Opt out
  // by setting `middleware.adaptiveTimeoutEnabled = false`.
  const baseTimeoutMs = config.middleware?.requestTimeoutMs ?? 120_000
  const adaptive = computeAdaptiveTimeoutMs({
    baseMs: baseTimeoutMs,
    body,
    middleware: config.middleware,
  })
  const timeoutMs = adaptive.timeoutMs
  const timeoutController = new AbortController()
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = timeoutController.signal
  try {
    await handleMessagesNonStream(req, res, body, config, trace, signal, requestId)
  } catch (err) {
    if (timeoutController.signal.aborted) {
      trace.mark('request_timeout')
      // 0.14.4: before surfacing the timeout diagnostic, try the
      // streaming fallback. The native REPL hardcodes stream:false on
      // every turn (conversation.ts:2692), so when the model genuinely
      // needs more wall-clock than any reasonable non-streaming budget
      // can grant (the 33K MES-AI case), the only escape is to convert
      // the request to streaming. We assemble the SSE events back into
      // a JSON response and write it as if the original non-streaming
      // request had succeeded.
      //
      // Skip when:
      //   - the response headers have already been sent (handleMessages
      //     NonStream got far enough that we can't change content type
      //     — extremely unlikely on this path, but defensive)
      //   - the user disabled the fallback via middleware config
      //   - resolveModelRoute fails (no route to retry against)
      if (!res.headersSent && isNonStreamFallbackEnabled(config.middleware)) {
        try {
          const fallbackRoute = resolveModelRoute(config, body.model)
          // Generous fallback budget: 2× the adaptive non-streaming
          // budget. We're explicitly trying to survive cases where the
          // non-streaming budget was insufficient, so a tighter budget
          // wouldn't help. Capped to the adaptive cap × 2.
          const fallbackBudgetMs = Math.min(timeoutMs * 2, (config.middleware?.adaptiveTimeoutCapMs ?? 600_000) * 2)
          trace.mark('nonstream_fallback_start')
          const assembled = await fetchStreamingFallback(
            {
              endpointUrl: fallbackRoute.endpointUrl,
              headers: fallbackRoute.headers,
              translate: Boolean(fallbackRoute.translate),
              backendModel: fallbackRoute.backendModel,
            },
            buildStreamingRetryBody(body),
            signal,
            fallbackBudgetMs,
          )
          if (assembled) {
            trace.mark('nonstream_fallback_ok')
            res.setHeader('x-owlcoda-fallback-source', 'streaming-assembled')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(assembled))
            return
          }
          trace.mark('nonstream_fallback_fail')
        } catch {
          // Route resolve failed or fallback threw — surface the
          // original timeout diagnostic below.
          trace.mark('nonstream_fallback_error')
        }
      }
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

async function handleMessagesNonStream(
  _req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicMessagesRequest,
  config: OwlCodaConfig,
  trace: ReturnType<typeof createTrace>,
  signal: AbortSignal,
  requestId: string,
): Promise<void> {
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

  // 4·shadow. Difficulty-routing shadow (opt-in OWLCODA_ROUTING_SHADOW, default
  // off). Behavior-neutral: records what difficulty routing WOULD pick vs the
  // model actually used; never changes effectiveModel.
  recordRoutingShadow(config, body, effectiveModel)

  // 4a. Model routing (local or cloud)
  let route
  if (!isModelExplicitlyConfigured(config, effectiveModel)) {
    const mapped = makeAnthropicError(404, 'not_found_error', `Model not found: ${effectiveModel}`)
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    return
  }
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
  const fallbackEnabled = isAutomaticFallbackEnabled(mwCfg)
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
    // 0.14.5: P0-4.2 — extend streaming fallback to the per-route /
    // upstream-timeout path too. The 0.14.4 fallback hook lives in
    // the outer handleMessagesInner catch (timeoutController.signal.
    // aborted), but a separate failure mode reaches here: when the
    // per-route AbortSignal.timeout fires (line 353) OR when the
    // upstream provider returns its own timeout error (some cloud
    // APIs like deepseek-v4-pro have shorter internal non-streaming
    // budgets than our adaptive wall-clock). In both cases the
    // diagnostic surfaces as `kind: 'timeout'`. Try the same
    // streaming retry rescue path before emitting the 504.
    if (
      !res.headersSent &&
      diagnostic.kind === 'timeout' &&
      isNonStreamFallbackEnabled(config.middleware)
    ) {
      const localBaseTimeoutMs = config.middleware?.requestTimeoutMs ?? 120_000
      const localAdaptive = computeAdaptiveTimeoutMs({
        baseMs: localBaseTimeoutMs,
        body,
        middleware: config.middleware,
      })
      const fallbackBudgetMs = Math.min(
        localAdaptive.timeoutMs * 2,
        (config.middleware?.adaptiveTimeoutCapMs ?? 600_000) * 2,
      )
      trace.mark('nonstream_fallback_start_innercatch')
      const assembled = await fetchStreamingFallback(
        {
          endpointUrl: failedRoute.endpointUrl,
          headers: failedRoute.headers,
          translate: Boolean(failedRoute.translate),
          backendModel: failedRoute.backendModel,
        },
        buildStreamingRetryBody(body),
        signal,
        fallbackBudgetMs,
      )
      if (assembled) {
        trace.mark('nonstream_fallback_ok_innercatch')
        res.setHeader('x-owlcoda-fallback-source', 'streaming-assembled-innercatch')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(assembled))
        // 0.14.6: fallback succeeded — log a SUCCESS audit entry, not
        // a failure. 0.14.5 wrongly called logFailureAuditEntry here,
        // which records `kind: 'timeout'` for a request that actually
        // succeeded from the client's POV. logAuditEntry shape matches
        // the normal success path at messages.ts:533.
        const traceResultOk = trace.end()
        logAuditEntry({
          timestamp: new Date().toISOString(),
          requestId,
          model: body.model,
          servedBy: failedModelId,
          inputTokens: assembled.usage?.input_tokens ?? 0,
          outputTokens: assembled.usage?.output_tokens ?? 0,
          durationMs: traceResultOk.totalMs,
          status: 200,
          fallbackUsed: true,
          streaming: false,
        }).catch(e => logWarn('audit', `Failed to log audit entry: ${e}`))
        return
      }
      trace.mark('nonstream_fallback_fail_innercatch')
    }
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
    if (diagnosticLooksLikeRateLimit(diagnostic)) markAdmissionRateLimited(res)
    // 2026-06-11: a tool_use/tool_result pairing 400 means some client
    // shipped a structurally invalid history. The daemon is the only
    // chokepoint that sees every sender — log the content-free message
    // shape so the offending request builder can be identified.
    if (upstream.status < 500 && detailLooksLikeToolPairingError(diagnostic.detail)) {
      logWarn('tool-pairing', `upstream ${upstream.status} tool-pairing violation`, {
        requestId,
        model: body.model,
        shape: summarizeMessagesShape(body.messages ?? []),
      })
    }
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
    cacheReadTokens: respUsage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: respUsage?.cache_creation_input_tokens ?? 0,
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

  // Difficulty-routing shadow (opt-in, default off; behavior-neutral).
  recordRoutingShadow(config, body, effectiveStreamModel)

  let route
  if (!isModelExplicitlyConfigured(config, effectiveStreamModel)) {
    const mapped = makeAnthropicError(404, 'not_found_error', `Model not found: ${effectiveStreamModel}`)
    res.writeHead(mapped.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mapped.body))
    return
  }
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
  let streamAttemptedModels: string[] = []
  let streamFailure: ProviderRequestDiagnostic | null = null
  let streamCompletedSuccessfully = false
  let streamFailureRecorded = false
  const recordStreamFailureOnce = (modelId: string): void => {
    if (streamFailureRecorded) return
    recordFailure(modelId)
    recordOutcome(modelId, false)
    streamFailureRecorded = true
  }
  const retryOpts = {
    ...(mwCfg.retryMaxAttempts != null ? { maxRetries: mwCfg.retryMaxAttempts } : {}),
    ...(mwCfg.retryBaseDelayMs != null ? { baseDelayMs: mwCfg.retryBaseDelayMs } : {}),
  }
  const fallbackEnabled = isAutomaticFallbackEnabled(mwCfg)
  const streamFallbackChain = fallbackEnabled
    ? buildFallbackChain(config, route.backendModel)
    : [route.backendModel]
  const streamHealthFilter = (modelId: string) => isModelHealthy(modelId) && !isCircuitOpen(modelId)

  trace.mark('fetch_start')
  try {
    const result = await withFallback(streamFallbackChain, async (modelId) => {
      streamAttemptedModels.push(modelId)
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
      // 0.13.100: stream fetch signal MUST NOT include AbortSignal.timeout
      // (routerTimeoutMs). 0.13.97's catch reclassified the resulting
      // error correctly but the underlying signal still aborted the body
      // stream at routerTimeoutMs (default 600s, but kimi-cloud 120s
      // user config reproduces it). Headers timeout must be replaced with
      // a manually-cleared timer that fires only BEFORE response arrives;
      // once fetch returns Response, the body stream's deadline belongs
      // entirely to first-token watchdog + per-chunk idle (handleMessagesStream).
      return withRetry(async () => {
        const headersAbort = new AbortController()
        // Fail-fast on stuck connect. Cloud → 30s; loopback runtimes get a
        // longer budget (capped by route timeout) so slow local CPU prefill
        // with a large agent tool payload isn't aborted into the fallback
        // chain (Issue #2). The timer is cleared the instant a Response
        // arrives, so this only bounds the headers phase.
        const headersTimeoutMs = resolveHeadersTimeoutMs({
          endpointUrl: modelRoute.endpointUrl,
          routeTimeoutMs: modelRoute.timeoutMs ?? config.routerTimeoutMs,
          cloudHeadersTimeoutMs: readCloudHeadersTimeoutMsFromEnv(),
        })
        const headersTimer = setTimeout(
          () => headersAbort.abort(new Error(`headers timeout after ${headersTimeoutMs}ms`)),
          headersTimeoutMs,
        )
        try {
          return await fetch(modelRoute.endpointUrl, {
            method: 'POST',
            headers: modelRoute.headers,
            body: JSON.stringify(reqBody),
            signal: AbortSignal.any([
              signal,
              headersAbort.signal,
              ...(getShutdownSignal() ? [getShutdownSignal()!] : []),
            ]),
          })
        } finally {
          // Once fetch returns (Response received OR fetch threw), clear
          // the headers timer. headersAbort.signal stays NON-aborted (we
          // never called .abort()), so the composed signal — still
          // attached to the body stream — won't fire from this source.
          clearTimeout(headersTimer)
        }
      }, retryOpts)
    }, streamHealthFilter)
    upstream = result.response
    servedByModel = result.servedBy
    streamFallbackUsed = result.fallbackUsed
    streamAttemptedModels = result.attemptedModels
  } catch (err) {
    trace.mark('fetch_error')
    const failedModelId = typeof (err as { modelId?: unknown })?.modelId === 'string' ? (err as { modelId: string }).modelId : route.backendModel
    const failedRoute = resolveModelRoute(config, failedModelId)
    const diagnosticContext = buildProviderDiagnosticContext(failedRoute, body.model, streamRequestId)
    let diagnostic = classifyEndpointRequestFailure(err, {
      route: failedRoute,
      model: body.model,
      requestId: streamRequestId,
      requestSignal: signal,
      requestTimeoutMs: timeoutMsForConfig(config),
      routeTimeoutMs: failedRoute.timeoutMs ?? config.routerTimeoutMs,
    })
    diagnostic = normalizeStreamBodyFailure(err, diagnostic, diagnosticContext, false)
    // Some routers close the streaming socket before response headers, so the
    // body-reader fallback below never runs. Retry the same route non-streaming.
    if (
      diagnostic.kind === 'stream_interrupted_before_first_token' &&
      isFallbackEnabled(config.middleware)
    ) {
      const fallbackBaseMs = config.middleware?.requestTimeoutMs ?? 120_000
      const fallbackBudget = computeAdaptiveTimeoutMs({
        baseMs: fallbackBaseMs,
        body,
        middleware: config.middleware,
      })
      const retryBody = buildNonStreamingRetryBody(body)
      const retryHeaders = { ...failedRoute.headers, accept: 'application/json' }
      trace.mark('stream_fallback_start_fetchcatch')
      const fallbackAttempt = await fetchNonStreamingFallback(
        failedRoute.endpointUrl,
        retryHeaders,
        retryBody,
        signal,
        fallbackBudget.timeoutMs,
        {
          translate: Boolean(failedRoute.translate),
          backendModel: failedRoute.backendModel,
          requestModel: body.model,
          config,
        },
      )
      const fallbackJson = fallbackAttempt.response
      if (fallbackJson) {
        trace.mark('stream_fallback_ok_fetchcatch')
        streamFallbackUsed = true
        const earlierFailedModels = [...new Set(streamAttemptedModels)]
          .filter(modelId => modelId !== failedModelId)
        for (const modelId of earlierFailedModels) {
          recordFailure(modelId)
          recordOutcome(modelId, false)
        }
        if (fallbackJson.usage) {
          addTokenUsage(
            fallbackJson.usage.input_tokens,
            fallbackJson.usage.output_tokens,
            fallbackJson.usage.cache_read_input_tokens ?? 0,
            fallbackJson.usage.cache_creation_input_tokens ?? 0,
          )
        }
        const now = Math.floor(Date.now() / 1000)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'x-owlcoda-served-by': failedModelId,
          'x-owlcoda-fallback': 'true',
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-5h-reset': String(now + 5 * 3600),
          'anthropic-ratelimit-unified-7d-utilization': '0',
          'anthropic-ratelimit-unified-7d-reset': String(now + 7 * 86400),
          'anthropic-ratelimit-unified-status': 'allowed',
        })
        synthesizeSseFromResponse(res, fallbackJson)
        res.end()
        recordSuccess(failedModelId)
        recordOutcome(failedModelId, true)
        const traceResultOk = trace.end()
        await logAuditEntry({
          timestamp: new Date().toISOString(),
          requestId: streamRequestId,
          model: body.model,
          servedBy: failedModelId,
          inputTokens: fallbackJson.usage?.input_tokens ?? 0,
          outputTokens: fallbackJson.usage?.output_tokens ?? 0,
          durationMs: traceResultOk.totalMs,
          status: 200,
          fallbackUsed: true,
          streaming: true,
        })
        return
      }
      trace.mark('stream_fallback_fail_fetchcatch')
    }
    const failedAttemptedModels = streamAttemptedModels.length > 0
      ? [...new Set(streamAttemptedModels)]
      : [failedModelId]
    for (const modelId of failedAttemptedModels) {
      recordFailure(modelId)
      recordOutcome(modelId, false)
    }
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
      fallbackUsed: streamAttemptedModels.length > 1,
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
    if (diagnosticLooksLikeRateLimit(diagnostic)) markAdmissionRateLimited(res)
    // 2026-06-11: same tool-pairing shape dump as the non-streaming path —
    // the observed incident (deepseek 400 × 7) came through here.
    if (upstream.status < 500 && detailLooksLikeToolPairingError(diagnostic.detail)) {
      logWarn('tool-pairing', `upstream ${upstream.status} tool-pairing violation`, {
        requestId: streamRequestId,
        model: body.model,
        shape: summarizeMessagesShape(body.messages ?? []),
      })
    }
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
  for (const [name, value] of Object.entries(streamHeaders)) {
    res.setHeader(name, value)
  }

  activeStreams.add(res)
  const streamCleanup = (): void => { activeStreams.delete(res) }
  res.on('close', streamCleanup)
  res.on('error', streamCleanup)
  _req.on('error', streamCleanup)

  const servedRoute = resolveModelRoute(config, servedByModel)
  const mwForStream = config.middleware ?? {}
  // Per-chunk idle deadline for readStreamChunkWithDeadline. Order:
  //   1. middleware.streamIdleTimeoutMs (0.13.97, when user wants streaming
  //      idle to diverge from the route's overall HTTP timeout)
  //   2. servedRoute.timeoutMs (per-route override)
  //   3. config.routerTimeoutMs (default 600_000)
  const streamBodyTimeoutMs = mwForStream.streamIdleTimeoutMs
    ?? servedRoute.timeoutMs
    ?? config.routerTimeoutMs

  // 0.13.97: first-token watchdog. Aborts the stream if no chunk arrives
  // within streamFirstTokenTimeoutMs (default 90_000). Cleared on first
  // iteration of the SSE loop. We OR its signal with the inbound `signal`
  // (carrying shutdown only) and pass the combined signal into
  // readStreamChunkWithDeadline / parseSSEStream — so abort propagation
  // matches the existing pathway.
  // 0.14.1: scale the first-token watchdog by estimated input tokens.
  // A 17K-token input on a slow cloud route routinely needs >90s for
  // first chunk; the flat 90s default was killing legitimate work.
  // Same opt-out flag as the non-streaming wall-clock.
  const streamFirstTokenBaseMs = mwForStream.streamFirstTokenTimeoutMs ?? 90_000
  const streamFirstTokenAdaptive = computeAdaptiveTimeoutMs({
    baseMs: streamFirstTokenBaseMs,
    body,
    middleware: mwForStream,
  })
  const streamFirstTokenTimeoutMs = streamFirstTokenAdaptive.timeoutMs
  const firstTokenController = new AbortController()
  const streamTotalTimeoutMs = mwForStream.streamTotalTimeoutMs ?? 600_000
  const totalRuntimeController = new AbortController()
  let firstTokenWatchdogFired = false
  let totalRuntimeWatchdogFired = false
  let firstChunkArrived = false
  const firstTokenTimer = setTimeout(() => {
    if (firstChunkArrived) return
    firstTokenWatchdogFired = true
    firstTokenController.abort()
  }, streamFirstTokenTimeoutMs)
  const totalRuntimeTimer = setTimeout(() => {
    totalRuntimeWatchdogFired = true
    totalRuntimeController.abort()
  }, streamTotalTimeoutMs)
  const markFirstChunkArrived = (): void => {
    if (firstChunkArrived) return
    firstChunkArrived = true
    clearTimeout(firstTokenTimer)
  }
  const combinedSignal = AbortSignal.any([signal, firstTokenController.signal, totalRuntimeController.signal])
  const fallbackSignal = AbortSignal.any([signal, totalRuntimeController.signal])

  const translator = servedRoute.translate
    ? new StreamTranslator(body.model, inputTokenEstimate)
    : null

  const upstreamContentType = upstream.headers.get('content-type') ?? ''

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
  // Per-model cache accounting for the streaming path — set alongside
  // finalInput/Output in each of the three usage branches (translator /
  // cloud / fallback) so /cost shows prefix-cache hits for streamed turns
  // (the common case for local backends like owlmlx).
  let finalCacheReadTokens = 0
  let finalCacheWriteTokens = 0
  // Buffer protocol-only frames until the first visible output or a normal
  // terminal event. Before that commit point a failed upstream can be replaced
  // without exposing two message lifecycles or stale served-by headers.
  let streamPartialOutputSeen = false
  let streamProtocolCommitted = false
  let pendingStreamFrames: string[] = []
  let pendingStreamFrameBytes = 0
  const commitPendingStreamFrames = (): void => {
    streamProtocolCommitted = true
    for (const frame of pendingStreamFrames) res.write(frame)
    pendingStreamFrames = []
    pendingStreamFrameBytes = 0
  }
  const writeStreamFrames = (
    frames: string[],
    state: { visibleOutput?: boolean; terminal?: boolean } = {},
  ): void => {
    if (state.visibleOutput) streamPartialOutputSeen = true
    if (streamProtocolCommitted) {
      for (const frame of frames) res.write(frame)
      return
    }

    if (state.visibleOutput || state.terminal) {
      commitPendingStreamFrames()
      for (const frame of frames) res.write(frame)
      return
    }

    for (const frame of frames) {
      if (streamProtocolCommitted) {
        res.write(frame)
        continue
      }
      const frameBytes = Buffer.byteLength(frame, 'utf8')
      if (pendingStreamFrameBytes + frameBytes >= MAX_STREAM_PRECOMMIT_BUFFER_BYTES) {
        commitPendingStreamFrames()
        res.write(frame)
        continue
      }
      pendingStreamFrames.push(frame)
      pendingStreamFrameBytes += frameBytes
    }
  }

  trace.mark('stream_start')
  try {
    // Some OpenAI-compatible providers ignore stream=true and return a normal
    // JSON completion. Keep this path inside the shared outcome finalizer so
    // success/failure, metrics, audit, cleanup, and watchdog ownership remain
    // identical to the ordinary streaming body paths.
    if (translator && upstreamContentType.includes('application/json')) {
      const jsonStream = upstream.body
      if (!jsonStream) throw new Error('No response body')
      const jsonReader = jsonStream.getReader()
      const jsonDecoder = new TextDecoder()
      let jsonText = ''
      try {
        while (true) {
          const { done, value } = await readStreamChunkWithDeadline(jsonReader, {
            timeoutMs: streamBodyTimeoutMs,
            signal: combinedSignal,
          })
          if (done) break
          markFirstChunkArrived()
          jsonText += jsonDecoder.decode(value, { stream: true })
        }
        jsonText += jsonDecoder.decode()
      } finally {
        jsonReader.releaseLock()
      }
      const jsonBody = JSON.parse(jsonText) as Record<string, unknown>
      const anthropicResp = translateResponse(jsonBody as any, body.model, config)
      const sseText = anthropicResp.content.find((block: any) => block.type === 'text')
      const textContent = sseText ? (sseText as any).text as string : ''
      const toolUseBlocks = anthropicResp.content.filter((block: any) => block.type === 'tool_use')
      const jsonTranslator = new StreamTranslator(body.model, inputTokenEstimate)
      const translatedEvents: string[] = []

      if (textContent) {
        const roleChunk = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        translatedEvents.push(...jsonTranslator.processLine(roleChunk))
        const textChunk = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] })
        translatedEvents.push(...jsonTranslator.processLine(textChunk))
      }
      if (toolUseBlocks.length > 0) {
        const openaiToolCalls = toolUseBlocks.map((block: any, index: number) => ({
          index,
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }))
        const toolChunk = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: openaiToolCalls }, finish_reason: null }] })
        translatedEvents.push(...jsonTranslator.processLine(toolChunk))
      }
      const finishReason = toolUseBlocks.length > 0 ? 'tool_calls' : 'stop'
      const finalChunk = JSON.stringify({ id: 'tr-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: anthropicResp.usage.input_tokens, completion_tokens: anthropicResp.usage.output_tokens, total_tokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens } })
      translatedEvents.push(...jsonTranslator.processLine(finalChunk))
      translatedEvents.push(...jsonTranslator.flush())

      const containsVisibleOutput = translatedEvents.some(event => event.includes('content_block_delta') || event.includes('"tool_use"'))
      writeStreamFrames(translatedEvents, { visibleOutput: containsVisibleOutput, terminal: true })
      finalInputTokens = anthropicResp.usage.input_tokens
      finalOutputTokens = anthropicResp.usage.output_tokens
      finalCacheReadTokens = anthropicResp.usage.cache_read_input_tokens ?? 0
      finalCacheWriteTokens = anthropicResp.usage.cache_creation_input_tokens ?? 0
      addTokenUsage(finalInputTokens, finalOutputTokens, finalCacheReadTokens, finalCacheWriteTokens)
      streamCompletedSuccessfully = true
      return
    }

    const stream = upstream.body
    if (!stream) throw new Error('No response body')

    if (translator) {
      // Local model: parse OpenAI SSE and translate to Anthropic SSE
      let sawVisibleOutput = false
      let sawTerminalEvent = false
      for await (const dataContent of parseSSEStream(stream, { timeoutMs: streamBodyTimeoutMs, signal: combinedSignal })) {
        markFirstChunkArrived()
        const events = translator.processLine(dataContent)
        const eventsContainVisibleOutput = events.some(event => event.includes('content_block_delta') || event.includes('"tool_use"'))
        if (eventsContainVisibleOutput) {
          sawVisibleOutput = true
          streamPartialOutputSeen = true
        }
        const eventsContainTerminal = events.some(event => event.includes('message_stop'))
        if (eventsContainTerminal) {
          sawTerminalEvent = true
        }
        writeStreamFrames(events, {
          visibleOutput: eventsContainVisibleOutput,
          terminal: eventsContainTerminal,
        })
      }
      if (!sawTerminalEvent) {
        throw createStreamInterruptedError(!sawVisibleOutput)
      }
      const finalEvents = translator.flush()
      writeStreamFrames(finalEvents, { terminal: true })
      const usage = translator.getFinalUsage()
      finalInputTokens = usage.inputTokens
      finalOutputTokens = usage.outputTokens
      finalCacheReadTokens = usage.cacheReadTokens
      // OpenAI server-side prompt-cache hits (cached_tokens) → cacheRead so
      // /cost surfaces them on the translated streaming path too.
      addTokenUsage(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, 0)
      streamCompletedSuccessfully = true
    } else {
      // Cloud model: normalize response to SSE format
      // Some providers return proper SSE (event: X\ndata: Y\n\n)
      // Others return raw JSON lines — detect and normalize
      const rawReader = stream.getReader()
      const rawDecoder = new TextDecoder()
      let lineBuffer = ''
      let lineBufferBytes = 0
      let sseBuffer = ''
      let sseBufferBytes = 0
      let unknownWireBuffer = ''
      let unknownWireBufferBytes = 0
      let cloudWireFormat: 'unknown' | 'sse' | 'raw' = 'unknown'
      let cloudInputTokens = 0
      let cloudOutputTokens = 0
      let cloudCacheReadTokens = 0
      let cloudCacheCreationTokens = 0
      let sawVisibleOutput = false
      let sawTerminalEvent = false

      // Accumulate token usage (input/output + Anthropic prompt-cache hits) from
      // each parsed SSE event, so /cost surfaces cache savings on the cloud
      // streaming path too — not just the non-stream path.
      const extractUsage = (parsed: unknown) => {
        const folded = foldAnthropicSseUsage(
          { input: cloudInputTokens, output: cloudOutputTokens, cacheRead: cloudCacheReadTokens, cacheCreation: cloudCacheCreationTokens },
          parsed,
        )
        cloudInputTokens = folded.input
        cloudOutputTokens = folded.output
        cloudCacheReadTokens = folded.cacheRead
        cloudCacheCreationTokens = folded.cacheCreation
      }

      // Cross-chunk buffer for SSE parsing. Previous versions used
      // `chunk.includes('message_stop')` / `chunk.split('\n').filter(...)`
      // which broke at TCP packet boundaries: a `data:{...}` line split
      // across two chunks had JSON.parse fail on the first half and
      // the tail in the second chunk didn't start with `data:` so the
      // filter dropped it. Result: every usage event from kimi silently
      // lost, audit always reported outputTokens=0. Buffer to `\n\n`
      // event delimiters so we only parse complete frames.
      const inspectParsedEvent = (parsed: { type?: string; content_block?: { type?: string } }): {
        visibleOutput: boolean
        terminal: boolean
      } => {
        const terminal = parsed.type === 'message_stop'
        const visibleOutput = parsed.type === 'content_block_delta' ||
          (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use')
        if (visibleOutput) {
          sawVisibleOutput = true
          streamPartialOutputSeen = true
        }
        if (terminal) sawTerminalEvent = true
        extractUsage(parsed)
        return { visibleOutput, terminal }
      }
      const inspectSSEEvent = (block: string): { visibleOutput: boolean; terminal: boolean } => {
        let eventType: string | undefined
        const dataLines: string[] = []
        for (const line of block.split(/\r\n|\n|\r/)) {
          if (!line || line.startsWith(':')) continue
          const colonIndex = line.indexOf(':')
          const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
          const rawValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
          const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
          if (field === 'event') eventType = value
          if (field === 'data') dataLines.push(value)
        }
        if (dataLines.length === 0) return { visibleOutput: false, terminal: false }

        const payload = dataLines.join('\n')
        if (payload === '[DONE]') {
          sawTerminalEvent = true
          return { visibleOutput: false, terminal: true }
        }
        try {
          const parsed = JSON.parse(payload) as { type?: string; content_block?: { type?: string } }
          const normalized = eventType && !parsed.type
            ? { ...parsed, type: eventType }
            : parsed
          return inspectParsedEvent(normalized)
        } catch {
          return { visibleOutput: false, terminal: false }
        }
      }
      const failParserBufferLimit = (bufferName: string): never => {
        commitPendingStreamFrames()
        throw new Error(
          `stream ${bufferName} parser buffer limit exceeded at ${MAX_STREAM_PRECOMMIT_BUFFER_BYTES} UTF-8 bytes`,
        )
      }
      const appendParserBuffer = (
        buffer: string,
        bufferBytes: number,
        addition: string,
        bufferName: string,
      ): { buffer: string; bytes: number } => {
        const additionBytes = Buffer.byteLength(addition, 'utf8')
        if (bufferBytes + additionBytes >= MAX_STREAM_PRECOMMIT_BUFFER_BYTES) {
          return failParserBufferLimit(bufferName)
        }
        return {
          buffer: buffer + addition,
          bytes: bufferBytes + additionBytes,
        }
      }
      const detectCloudWireFormat = (input: string): 'unknown' | 'sse' | 'raw' => {
        const prefix = input.trimStart()
        if (!prefix) return 'unknown'
        const sseFieldNames = ['event', 'data', 'id', 'retry']
        const sseFieldPrefixes = ['event:', 'data:', 'id:', 'retry:']
        if (sseFieldPrefixes.some(field => prefix.startsWith(field)) || prefix.startsWith(':')) {
          return 'sse'
        }
        const firstLineEnd = prefix.search(/[\r\n]/)
        if (firstLineEnd >= 0 && sseFieldNames.includes(prefix.slice(0, firstLineEnd))) {
          return 'sse'
        }
        if (sseFieldPrefixes.some(field => field.startsWith(prefix))) {
          return 'unknown'
        }
        return 'raw'
      }
      const processRawLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const parsed = JSON.parse(trimmed) as { type?: string; content_block?: { type?: string } }
          const eventType = parsed.type ?? 'message'
          const inspected = inspectParsedEvent(parsed)
          writeStreamFrames([`event: ${eventType}\ndata: ${trimmed}\n\n`], inspected)
        } catch {
          writeStreamFrames([`data: ${trimmed}\n\n`])
        }
      }
      const processSSEChunk = (input: string): void => {
        // Search the buffered remainder and the newly arrived bytes as one
        // stream. Each SSE event ends with two legal line endings; the two
        // endings may be CRLF, LF, CR, or a legal mixture of those forms.
        const combined = sseBuffer + input
        const delimiter = /(?:\r\n|\r(?!\n)|\n){2}/g
        let cursor = 0
        let match: RegExpExecArray | null
        while ((match = delimiter.exec(combined)) !== null) {
          const block = combined.slice(cursor, match.index)
          const inspected = inspectSSEEvent(block)
          writeStreamFrames([`${block}${match[0]}`], inspected)
          cursor = match.index + match[0].length
        }

        const remaining = combined.slice(cursor)
        if (remaining) {
          const appended = appendParserBuffer('', 0, remaining, 'SSE frame')
          sseBuffer = appended.buffer
          sseBufferBytes = appended.bytes
        } else {
          sseBuffer = ''
          sseBufferBytes = 0
        }
      }
      const processRawChunk = (input: string): void => {
        let remaining = input
        if (lineBuffer) {
          const delimiterIndex = remaining.indexOf('\n')
          if (delimiterIndex === -1) {
            const appended = appendParserBuffer(lineBuffer, lineBufferBytes, remaining, 'raw line')
            lineBuffer = appended.buffer
            lineBufferBytes = appended.bytes
            return
          }
          const appended = appendParserBuffer(
            lineBuffer,
            lineBufferBytes,
            remaining.slice(0, delimiterIndex),
            'raw line',
          )
          processRawLine(appended.buffer)
          lineBuffer = ''
          lineBufferBytes = 0
          remaining = remaining.slice(delimiterIndex + 1)
        }

        let delimiterIndex = remaining.indexOf('\n')
        while (delimiterIndex !== -1) {
          processRawLine(remaining.slice(0, delimiterIndex))
          remaining = remaining.slice(delimiterIndex + 1)
          delimiterIndex = remaining.indexOf('\n')
        }
        if (remaining) {
          const appended = appendParserBuffer('', 0, remaining, 'raw line')
          lineBuffer = appended.buffer
          lineBufferBytes = appended.bytes
        }
      }

      try {
        while (true) {
          const { done, value } = await readStreamChunkWithDeadline(rawReader, { timeoutMs: streamBodyTimeoutMs, signal: combinedSignal })
          if (done) break
          markFirstChunkArrived()
          const chunk = rawDecoder.decode(value, { stream: true })

          let chunkToProcess = chunk
          if (cloudWireFormat === 'unknown' && chunk.length > 0) {
            const appended = appendParserBuffer(
              unknownWireBuffer,
              unknownWireBufferBytes,
              chunk,
              'wire-format detection',
            )
            unknownWireBuffer = appended.buffer
            unknownWireBufferBytes = appended.bytes
            cloudWireFormat = detectCloudWireFormat(unknownWireBuffer)
            if (cloudWireFormat === 'unknown') continue
            chunkToProcess = unknownWireBuffer
            unknownWireBuffer = ''
            unknownWireBufferBytes = 0
          }

          if (cloudWireFormat === 'sse') {
            // Already SSE format — buffer to complete event boundaries so
            // control-only frames do not commit the downstream response before
            // cross-model recovery is no longer safe.
            processSSEChunk(chunkToProcess)
          } else {
            // Raw JSON lines — normalize each line to SSE format
            processRawChunk(chunkToProcess)
          }
        }
        if (cloudWireFormat === 'unknown' && unknownWireBuffer) {
          cloudWireFormat = 'raw'
          processRawChunk(unknownWireBuffer)
          unknownWireBuffer = ''
          unknownWireBufferBytes = 0
        }
        // Flush remaining buffer (raw-JSON branch: treat leftover as one frame).
        if (lineBuffer.trim()) {
          processRawLine(lineBuffer)
        }
        // Drain trailing SSE buffer (SSE branch: parse any leftover block that
        // wasn't terminated by \n\n before upstream closed).
        if (sseBuffer.trim()) {
          const inspected = inspectSSEEvent(sseBuffer)
          writeStreamFrames([`${sseBuffer}\n\n`], inspected)
        }
        if (!sawTerminalEvent) {
          throw createStreamInterruptedError(!sawVisibleOutput)
        }
        // Record cloud token usage in proxy metrics + hoist for the outer
        // finally block (audit / recordRequestMetrics both need these).
        finalInputTokens = cloudInputTokens
        finalOutputTokens = cloudOutputTokens
        finalCacheReadTokens = cloudCacheReadTokens
        finalCacheWriteTokens = cloudCacheCreationTokens
        if (cloudInputTokens > 0 || cloudOutputTokens > 0 || cloudCacheReadTokens > 0 || cloudCacheCreationTokens > 0) {
          addTokenUsage(cloudInputTokens, cloudOutputTokens, cloudCacheReadTokens, cloudCacheCreationTokens)
        }
        streamCompletedSuccessfully = true
      } finally {
        rawReader.releaseLock()
      }
    }
  } catch (err) {
    trace.mark('stream_error')
    // 0.13.97: classify in priority order:
    //   1. first-token watchdog fired with no chunk seen → stream_first_token_timeout
    //   2. per-chunk idle deadline (TimeoutError from sse.ts) → stream_idle_timeout
    //      if at least one chunk arrived; else stream_first_token_timeout
    //      (semantically equivalent: nothing got through)
    //   3. ProviderRequestError attached to thrown err → take its diagnostic
    //   4. fall through to existing classifyEndpointRequestFailure
    // Then stamp partialOutputSeen if missing.
    const diagCtx = buildProviderDiagnosticContext(servedRoute, body.model, streamRequestId, upstream.headers)
    const errName = err instanceof Error ? err.name : ''
    // 0.13.98 bugfix: TimeoutError comes from two sources during streaming:
    //   (1) sse.ts:80 per-chunk reader timer ("Stream read timed out after Xms")
    //   (2) Node fetch's AbortSignal.timeout(routerTimeoutMs) attached to the
    //       fetch signal, propagating to the body stream on abort
    //       ("The operation was aborted due to timeout")
    // 0.13.97's catch only matched (1) by message text and missed (2). Both
    // are semantically "stream couldn't deliver bytes within deadline". Match
    // by name alone — there's no other TimeoutError source on this path.
    const isPerChunkIdle = errName === 'TimeoutError'
    let failure: ProviderRequestDiagnostic
    if (totalRuntimeWatchdogFired) {
      const detail = `total-runtime watchdog fired after ${streamTotalTimeoutMs}ms`
      failure = {
        provider: diagCtx.provider ?? 'unknown-provider',
        model: body.model,
        kind: 'timeout',
        message: `${body.model} request failed: ${detail}`,
        status: 504,
        requestId: streamRequestId,
        retryable: true,
        detail,
        partialOutputSeen: streamPartialOutputSeen,
      }
    } else if (firstTokenWatchdogFired) {
      failure = createStreamFirstTokenTimeoutDiagnostic(diagCtx, { timeoutMs: streamFirstTokenTimeoutMs })
    } else if (isPerChunkIdle) {
      failure = streamPartialOutputSeen
        ? createStreamIdleTimeoutDiagnostic(diagCtx, { timeoutMs: streamBodyTimeoutMs })
        : createStreamFirstTokenTimeoutDiagnostic(diagCtx, { timeoutMs: streamBodyTimeoutMs })
    } else if (err instanceof Error && 'diagnostic' in err) {
      failure = (err as { diagnostic: ProviderRequestDiagnostic }).diagnostic
    } else {
      failure = classifyEndpointRequestFailure(err, {
        route: servedRoute,
        model: body.model,
        requestId: streamRequestId,
        upstreamHeaders: upstream.headers,
        requestSignal: signal,
        requestTimeoutMs: timeoutMsForConfig(config),
        routeTimeoutMs: servedRoute.timeoutMs ?? config.routerTimeoutMs,
      })
    }
    failure = normalizeStreamBodyFailure(err, failure, diagCtx, streamPartialOutputSeen)
    if (failure.partialOutputSeen === undefined) {
      failure = { ...failure, partialOutputSeen: streamPartialOutputSeen }
    }
    // Streaming → non-streaming fallback stays eligible until the downstream
    // protocol commits visible output or a normal terminal event. Control-only
    // chunks remain buffered, so recovery can replace them without duplicating
    // the Anthropic message lifecycle. The body deadline is the adaptive
    // non-streaming budget.
    //
    // Trigger conditions:
    //   - downstream protocol is still uncommitted, AND
    //   - first-token watchdog fired (`firstTokenWatchdogFired`) OR
    //   - per-chunk idle fired with zero visible output (`!streamPartialOutputSeen`)
    //   - AND fallback is enabled in middleware (default ON)
    //
    // If the fallback fetch fails OR returns a non-message JSON, fall
    // through to the existing wording emission below.
    const preFirstTokenStreamClose =
      failure.kind === 'stream_interrupted_before_first_token' && !streamPartialOutputSeen
    const fallbackEligible = !streamProtocolCommitted && !totalRuntimeWatchdogFired && isFallbackEnabled(mwForStream) &&
      (firstTokenWatchdogFired || (isPerChunkIdle && !streamPartialOutputSeen) || preFirstTokenStreamClose)
    let fallbackSucceeded = false
    if (fallbackEligible) {
      const fallbackBaseMs = config.middleware?.requestTimeoutMs ?? 120_000
      const fallbackBudget = computeAdaptiveTimeoutMs({
        baseMs: fallbackBaseMs,
        body,
        middleware: config.middleware,
      })
      const retryBody = buildNonStreamingRetryBody(body)
      const recoveryModels = [
        servedByModel,
        ...streamFallbackChain.filter(modelId => !streamAttemptedModels.includes(modelId)),
      ]
      let fallbackJson: AnthropicMessagesResponse | null = null
      let fallbackServedBy = servedByModel
      for (const modelId of recoveryModels) {
        if (modelId !== servedByModel && !streamHealthFilter(modelId)) continue
        const fallbackRoute = resolveModelRoute(config, modelId)
        const retryHeaders = { ...fallbackRoute.headers, accept: 'application/json' }
        trace.mark(modelId === servedByModel ? 'stream_fallback_start' : 'stream_cross_model_fallback_start')
        const fallbackAttempt = await fetchNonStreamingFallback(
          fallbackRoute.endpointUrl,
          retryHeaders,
          retryBody,
          fallbackSignal,
          fallbackBudget.timeoutMs,
          {
            translate: Boolean(fallbackRoute.translate),
            backendModel: fallbackRoute.backendModel,
            requestModel: body.model,
            config,
          },
        )
        fallbackJson = fallbackAttempt.response
        if (fallbackJson) {
          fallbackServedBy = modelId
          break
        }
        if (fallbackAttempt.status != null && fallbackAttempt.status >= 400 && fallbackAttempt.status < 500) {
          break
        }
      }
      if (fallbackJson) {
        trace.mark('stream_fallback_ok')
        pendingStreamFrames = []
        pendingStreamFrameBytes = 0
        if (fallbackServedBy !== servedByModel) {
          recordStreamFailureOnce(servedByModel)
          servedByModel = fallbackServedBy
        }
        if (!res.headersSent) {
          res.setHeader('x-owlcoda-served-by', servedByModel)
          res.setHeader('x-owlcoda-fallback', 'true')
        }
        synthesizeSseFromResponse(res, fallbackJson)
        if (fallbackJson.usage) {
          finalInputTokens = fallbackJson.usage.input_tokens
          finalOutputTokens = fallbackJson.usage.output_tokens
          finalCacheReadTokens = fallbackJson.usage.cache_read_input_tokens ?? 0
          finalCacheWriteTokens = fallbackJson.usage.cache_creation_input_tokens ?? 0
          addTokenUsage(
            finalInputTokens,
            finalOutputTokens,
            fallbackJson.usage.cache_read_input_tokens ?? 0,
            fallbackJson.usage.cache_creation_input_tokens ?? 0,
          )
        }
        streamFallbackUsed = true
        fallbackSucceeded = true
        streamCompletedSuccessfully = true
        // Same-model recovery is a successful (slow-first-token) stream from
        // the client's perspective. Cross-model recovery records the failed
        // provider above; deferred headers identify the model that completed.
      } else {
        trace.mark('stream_fallback_fail')
        if (totalRuntimeWatchdogFired) {
          failure = {
            provider: diagCtx.provider ?? 'unknown-provider',
            model: body.model,
            kind: 'timeout',
            message: `${body.model} request failed: total-runtime watchdog fired during non-streaming fallback after ${streamTotalTimeoutMs}ms`,
            detail: `total-runtime watchdog fired during non-streaming fallback after ${streamTotalTimeoutMs}ms`,
            status: 504,
            requestId: streamRequestId,
            retryable: false,
            partialOutputSeen: streamPartialOutputSeen,
          }
        }
      }
    }
    if (!fallbackSucceeded) {
      streamFailure = failure
      recordStreamFailureOnce(servedByModel)
      await runErrorHooks({ endpoint: '/v1/messages (stream)', errorType: 'stream_error', message: failure.message.slice(0, 200) })
      try {
        commitPendingStreamFrames()
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: diagnosticToAnthropicError(failure).body.error.type,
            message: failure.message,
            diagnostic: failure,
          },
        })}\n\n`
        res.write(errorEvent)
      } catch { /* ignore write failure */ }
    }
  } finally {
    // 0.13.97: clear first-token watchdog so it can't fire after stream
    // completion / error path took over. markFirstChunkArrived also clears
    // the timer, but that's only on first-chunk arrival; if an error fires
    // BEFORE first chunk and BEFORE the watchdog itself fired, the timer
    // would still be live. Idempotent.
    clearTimeout(firstTokenTimer)
    clearTimeout(totalRuntimeTimer)
    trace.mark('stream_end')
    const streamTraceResult = trace.end()
    res.end()
    activeStreams.delete(res)

    if (streamCompletedSuccessfully) {
      recordSuccess(servedByModel)
      recordOutcome(servedByModel, true)
    }

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
      cacheReadTokens: finalCacheReadTokens,
      cacheWriteTokens: finalCacheWriteTokens,
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

function normalizeStreamBodyFailure(
  err: unknown,
  failure: ProviderRequestDiagnostic,
  context: ProviderDiagnosticContext,
  partialOutputSeen: boolean,
): ProviderRequestDiagnostic {
  if (!isStreamBodyTransportClose(err, failure)) {
    return failure
  }

  const normalized = createStreamInterruptedDiagnostic(context, {
    beforeFirstToken: !partialOutputSeen,
    detail: failure.detail,
  })
  return {
    ...normalized,
    rawCauseCode: failure.rawCauseCode,
    errno: failure.errno,
    syscall: failure.syscall,
    upstreamRequestId: failure.upstreamRequestId ?? normalized.upstreamRequestId,
    partialOutputSeen,
  }
}

function isStreamBodyTransportClose(err: unknown, failure: ProviderRequestDiagnostic): boolean {
  if (failure.kind === 'stream_interrupted' || failure.kind === 'stream_interrupted_before_first_token') {
    return true
  }
  if (failure.kind !== 'unknown_fetch_error' && failure.kind !== 'connect_error') {
    return false
  }

  const message = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''
  const rawCode = failure.rawCauseCode ?? errorCauseCode(err)
  return rawCode === 'UND_ERR_SOCKET'
    || name === 'SocketError'
    || /terminated|socket|stream closed|premature close|other side closed|fetch failed/i.test(message)
}

function errorCauseCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const cause = (err as { cause?: unknown }).cause
  if (!cause || typeof cause !== 'object') return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
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
