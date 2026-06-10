/**
 * OpenAI Chat Completions passthrough endpoint.
 *
 * Forwards /v1/chat/completions to the right upstream per the requested
 * model: cloud OpenAI-compatible endpoints (kimi / deepseek / mimo / etc.)
 * get their own `endpoint` + Bearer auth applied, local runtimes go to
 * `routerUrl`. Routing decisions are delegated to `resolveModelRoute`,
 * the same function `/v1/messages` uses — so the per-model `endpoint`
 * field works the same way on both surfaces.
 *
 * 2026-05-29: previously this endpoint unconditionally forwarded every
 * request to `${routerUrl}/v1/chat/completions` regardless of which
 * model was requested. That made cloud-tier models 404 because the
 * local MLX router doesn't host them, violating the README +
 * system-architecture + goal-contract promise that
 * /v1/chat/completions is an OpenAI-compatible passthrough across the
 * full configured model registry. Fix: call resolveModelRoute and
 * forward to the resolved upstream with the route's auth headers.
 *
 * Anthropic-protocol endpoints (translate=false routes) need an
 * OpenAI→Anthropic body translation that this endpoint does not
 * implement yet. We surface a clear 400 pointing the caller at
 * /v1/messages instead of silently failing or producing a confusing
 * 4xx from the upstream.
 */

import * as http from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { LocalRuntimeProtocolUnresolvedError, resolveModel, resolveModelRoute } from '../model-registry.js'
import { logInfo, logError } from '../logger.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  inferProviderName,
  upstreamRequestIdFromHeaders,
} from '../provider-error.js'
import { computeAdaptiveTimeoutMs } from '../middleware/adaptive-timeout.js'

export async function handleChatCompletions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: OwlCodaConfig,
  rawBody: string,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }))
    return
  }

  const requestedModel = typeof body.model === 'string' ? body.model : ''

  // Model id alias resolution (kept for the per-model 404 path).
  const resolved = resolveModel(config, requestedModel)
  if (!resolved) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Model not found: ${requestedModel}`, type: 'not_found_error' } }))
    return
  }

  // Per-model routing: cloud `endpoint` + auth, or local routerUrl. Same
  // resolver `/v1/messages` uses so the surfaces stay in lockstep.
  let route: ReturnType<typeof resolveModelRoute>
  try {
    route = resolveModelRoute(config, requestedModel || resolved)
  } catch (err) {
    if (err instanceof LocalRuntimeProtocolUnresolvedError) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: err.message,
          type: 'service_unavailable',
        },
      }))
      return
    }
    throw err
  }

  // Anthropic-shape upstream (e.g. minimaxi /anthropic): we would need an
  // OpenAI→Anthropic body+response translation pipeline to forward an
  // OpenAI-style /v1/chat/completions request here. Until that adapter
  // lands, surface a clear error pointing the caller at /v1/messages
  // instead of returning a confusing 4xx from the upstream.
  if (!route.translate) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        message:
          `Model "${requestedModel}" routes to an Anthropic-protocol endpoint (${route.endpointUrl}); ` +
          'use POST /v1/messages with the Anthropic Messages schema instead. ' +
          '/v1/chat/completions can only forward to OpenAI-compatible upstreams.',
        type: 'protocol_mismatch',
      },
    }))
    return
  }

  // Rewrite to the backend model id the upstream expects.
  body.model = route.backendModel

  const isStreaming = body.stream === true
  const upstreamUrl = route.endpointUrl
  const upstreamHeaders: Record<string, string> = { ...route.headers }
  logInfo('openai-compat', 'Forwarding /v1/chat/completions', {
    model: requestedModel,
    backend: route.backendModel,
    upstream: upstreamUrl,
    stream: isStreaming,
  })

  // 0.14.9: chat-completions endpoint shared the same flat 120s budget
  // that /v1/messages had before 0.14.1 — long-context inputs (kimi
  // 700K, deepseek 256K, etc) couldn't fit. Use the same input-token
  // aware adaptive budget. estimateInputChars walks message contents
  // (OpenAI string or array form) regardless of role, so OpenAI body
  // shape (system-as-role-in-messages) feeds in correctly without
  // special-casing. Per-model `timeoutMs` overrides the adaptive base
  // when set.
  const baseTimeoutMs = route.timeoutMs
    ?? config.middleware?.requestTimeoutMs
    ?? (config.routerTimeoutMs || 120_000)
  const adaptiveBudget = computeAdaptiveTimeoutMs({
    baseMs: baseTimeoutMs,
    body: body as { system?: unknown; messages?: unknown },
    middleware: config.middleware,
  })

  try {
    const routerResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(adaptiveBudget.timeoutMs),
    })

    if (!routerResp.ok) {
      const detail = await routerResp.text()
      const diagnostic = createProviderHttpDiagnostic(routerResp.status, detail, {
        model: requestedModel || String(body.model ?? resolved),
        provider: inferProviderName({ endpointUrl: upstreamUrl, headers: upstreamHeaders }),
        endpointUrl: upstreamUrl,
        upstreamRequestId: upstreamRequestIdFromHeaders(routerResp.headers),
      })
      res.writeHead(routerResp.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: diagnostic.message,
          type: diagnostic.status === 429 ? 'rate_limit_error' : 'api_error',
          diagnostic,
        },
      }))
      return
    }

    // Forward status and content-type
    const contentType = routerResp.headers.get('content-type') || 'application/json'
    res.writeHead(routerResp.status, { 'Content-Type': contentType })

    if (!routerResp.body) {
      const text = await routerResp.text()
      res.end(text)
      return
    }

    // Stream the response through
    const reader = routerResp.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
  } catch (err) {
    const diagnostic = classifyProviderRequestError(err, {
      model: requestedModel || String(body.model ?? resolved),
      provider: inferProviderName({ endpointUrl: upstreamUrl, headers: upstreamHeaders }),
      endpointUrl: upstreamUrl,
    })
    logError('openai-compat', 'Router error', { error: diagnostic.message, kind: diagnostic.kind, requestId: diagnostic.requestId })
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: diagnostic.message,
          type: diagnostic.kind === 'timeout' ? 'timeout_error' : 'api_error',
          diagnostic,
        },
      }))
    }
  }
}
