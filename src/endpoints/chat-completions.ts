/**
 * OpenAI Chat Completions passthrough endpoint.
 * Forwards /v1/chat/completions requests to the router as-is (already OpenAI format).
 * This lets OwlCoda double as an OpenAI-compatible API server for non-Anthropic clients.
 */

import * as http from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { resolveModel } from '../model-registry.js'
import { logInfo, logError } from '../logger.js'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  inferProviderName,
  upstreamRequestIdFromHeaders,
} from '../provider-error.js'

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

  // Resolve model through the registry
  const resolved = resolveModel(config, requestedModel)
  if (!resolved) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Model not found: ${requestedModel}`, type: 'not_found_error' } }))
    return
  }

  // Rewrite model to backend model
  body.model = resolved

  const isStreaming = body.stream === true
  logInfo('openai-compat', 'Forwarding /v1/chat/completions', { model: requestedModel, backend: resolved, stream: isStreaming })

  // Forward to router
  const routerUrl = `${config.routerUrl}/v1/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  try {
    const routerResp = await fetch(routerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.routerTimeoutMs || 120000),
    })

    if (!routerResp.ok) {
      const detail = await routerResp.text()
      const diagnostic = createProviderHttpDiagnostic(routerResp.status, detail, {
        model: requestedModel || String(body.model ?? resolved),
        provider: inferProviderName({ endpointUrl: routerUrl, headers }),
        endpointUrl: routerUrl,
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
      provider: inferProviderName({ endpointUrl: routerUrl, headers }),
      endpointUrl: routerUrl,
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
