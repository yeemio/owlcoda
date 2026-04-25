/**
 * OwlCoda Search Surface — Phase 04 Round 25A.
 *
 * Exposes a local search API for external consumers (e.g. vm-brand / openclaw).
 * Backed by Router's DuckDuckGo HTML search (no external API key required).
 *
 * This is a standing service, not a per-session model capability.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { logInfo, logError } from '../logger.js'
import { assignRequestId } from '../middleware/request-id.js'
import { traceRequest, traceResponse, isTraceEnabled } from '../trace.js'
import { logWarn } from '../logger.js'
import { recordOutcome } from '../error-budget.js'

const MAX_RESULTS = 10
const DEFAULT_RESULTS = 5

interface SearchRequest {
  query: string
  max_results?: number
}

interface RouterSearchResult {
  title: string
  url: string
}

interface RouterSearchResponse {
  ok: boolean
  query: string
  provider: string
  results: RouterSearchResult[]
  result_count: number
  warning?: string | null
  error?: { message: string; type: string }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(res)
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  const errorType = statusCode === 400 ? 'invalid_request_error' : 'api_error'
  sendJson(res, statusCode, {
    type: 'error',
    error: { type: errorType, message },
  })
}

export async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  config: OwlCodaConfig,
): Promise<void> {
  const requestId = assignRequestId(res)
  const startTime = Date.now()

  const traceId = isTraceEnabled()
    ? await traceRequest('POST', '/v1/search', req.headers as Record<string, string>, '[body read below]')
    : null

  let body: string
  try {
    body = await readBodyJson(req)
  } catch {
    sendError(res, 400, 'Invalid JSON body')
    return
  }

  let parsed: SearchRequest
  try {
    parsed = JSON.parse(body) as SearchRequest
  } catch {
    sendError(res, 400, 'Invalid JSON body')
    return
  }

  // Validate query
  if (!parsed.query || typeof parsed.query !== 'string' || !parsed.query.trim()) {
    sendError(res, 400, 'query is required and must be a non-empty string')
    return
  }
  const query = parsed.query.trim()

  // Clamp max_results
  let maxResults: number
  if (parsed.max_results === undefined || parsed.max_results === null) {
    maxResults = DEFAULT_RESULTS
  } else if (
    typeof parsed.max_results !== 'number' ||
    !Number.isFinite(parsed.max_results) ||
    parsed.max_results < 1
  ) {
    sendError(res, 400, 'max_results must be a positive integer (1-10)')
    return
  } else {
    maxResults = Math.round(parsed.max_results)
    if (maxResults > MAX_RESULTS) maxResults = MAX_RESULTS
  }

  logInfo('search', `query="${query}" max_results=${maxResults}`, { requestId })

  // Forward to Router
  let routerResp: RouterSearchResponse
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const fetchResp = await fetch(`${config.routerUrl}/v1/search?q=${encodeURIComponent(query)}&max_results=${maxResults}`, {
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer local',
        'Content-Type': 'application/json',
      },
    })
    clearTimeout(timeout)

    if (!fetchResp.ok) {
      const errBody = await fetchResp.text().catch(() => '')
      logError('search', `Router returned ${fetchResp.status}: ${errBody}`, { requestId })
      sendError(res, 502, `search backend error: ${fetchResp.status}`)
      return
    }

    routerResp = await fetchResp.json() as RouterSearchResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('search', `Router unreachable: ${msg}`, { requestId })
    sendError(res, 503, `search service unavailable: ${msg}`)
    return
  }

  // Handle upstream failure
  if (!routerResp.ok || routerResp.error) {
    const msg = routerResp.error?.message ?? routerResp.warning ?? 'search failed'
    logError('search', `Search failed: ${msg}`, { requestId })
    sendError(res, 503, msg)
    return
  }

  const duration = Date.now() - startTime
  recordOutcome('search', true)

  // Normalize response shape — always include snippet (empty from DuckDuckGo HTML)
  const results = (routerResp.results ?? []).map((r: RouterSearchResult) => ({
    title: r.title,
    url: r.url,
    snippet: '', // DuckDuckGo HTML does not provide snippets; this is a known limitation
  }))

  logInfo('search', `${results.length} results in ${duration}ms`, { requestId })

  sendJson(res, 200, {
    ok: true,
    query,
    provider: routerResp.provider ?? 'duckduckgo_html',
    results,
    result_count: routerResp.result_count ?? results.length,
    warning: routerResp.warning ?? null,
  })

  if (traceId !== null) {
    traceResponse(traceId, 'POST', '/v1/search', 200, duration, `${results.length} results`).catch(e => logWarn('search', `Trace response failed: ${e}`))
  }
}

async function readBodyJson(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
