import * as http from 'node:http'
import type { OwlCodaConfig } from './config.js'
import { configureCircuitBreaker, resetCircuitBreaker, getAllCircuitStates } from './middleware/circuit-breaker.js'
import { createLogger } from './utils/logger.js'
import { handleMessages } from './endpoints/messages.js'
import { handleModels } from './endpoints/models.js'
import { handleCountTokens } from './endpoints/count-tokens.js'
import { handleBackends } from './endpoints/backends.js'
import { handlePerf } from './endpoints/perf.js'
import { handleCost } from './endpoints/cost.js'
import { handleRecommend } from './endpoints/recommend.js'
import {
  handleUsage,
  handleProfile,
  handleAccountSettings,
} from './endpoints/stubs.js'
import { VERSION } from './version.js'
import { traceRequest, traceResponse, isTraceEnabled, getTokenUsage } from './trace.js'
import { recordError } from './diagnostics.js'
import { assignRequestId } from './middleware/request-id.js'
import { getMetrics, recordRequestStart, recordRequestEnd, getActiveRequests } from './observability.js'
import { recordLatency, getAllLatencyStats } from './latency.js'
import { auditRequest, queryAudit, getAuditSummary } from './audit-log.js'
import { startConfigWatcher, stopConfigWatcher } from './config-watcher.js'
import { startHealthMonitor, stopHealthMonitor } from './health-monitor.js'
import { setSloTarget, getAllBudgets, getSloTarget, resetBudgets } from './error-budget.js'
import { getOpenApiSpec } from './openapi.js'
import { getRecentTraces } from './request-trace.js'
import { logInfo, logWarn, logError } from './logger.js'
import { readAuditLog } from './audit.js'
import { getCacheStats, clearCache } from './response-cache.js'
import { renderMetrics } from './prometheus.js'
import { initLogFile, closeLogFile } from './log-file.js'
import * as adminHandlers from './routes/admin.js'
import { handleSearch } from './routes/search.js'
import { pruneRateLimitBuckets } from './middleware/rate-limit.js'
import { handleSkills } from './endpoints/skills.js'
import { handleSkillStats } from './endpoints/skill-stats.js'
import { handleInsights, handleBatchInsights } from './endpoints/insights.js'
import { handleTraining } from './endpoints/training.js'
import { webSearch, checkSearXNG } from './web-search.js'
import type { AdminDeps } from './routes/admin.js'
import { probeRuntimeSurface } from './runtime-probe.js'
import { ModelTruthAggregator } from './model-truth.js'
import { loadCatalog } from './models/catalog.js'
import { appendBuiltinEndpointModels } from './config.js'
import { ModelConfigMutator } from './model-config-mutator.js'
import { ProviderProbe } from './provider-probe.js'
import { createAdminAuthManager, handleAdminApiRequest } from './admin-api.js'
import { handleAdminStatic } from './admin-static.js'

export const activeStreams = new Set<http.ServerResponse>()

// Global shutdown signal for aborting in-flight upstream requests
let shutdownController: AbortController | null = null
export function getShutdownSignal(): AbortSignal | undefined {
  return shutdownController?.signal
}
function initShutdownController(): void {
  shutdownController = new AbortController()
}
function triggerShutdownSignal(): void {
  shutdownController?.abort()
}
const serverStartTime = Date.now()

// Cached deep health probe (10s TTL)
let healthProbeCache: { ts: number; data: Record<string, unknown> } | null = null
const HEALTH_PROBE_TTL = 10_000
let probeInFlight = false

function getBasicHealthData(config: OwlCodaConfig): Record<string, unknown> {
  return {
    status: 'healthy',
    version: VERSION,
    pid: process.pid,
    host: config.host,
    port: config.port,
    routerUrl: config.routerUrl,
    runtimeToken: process.env['OWLCODA_RUNTIME_TOKEN'] ?? null,
  }
}

async function deepHealthProbe(config: OwlCodaConfig): Promise<Record<string, unknown>> {
  // Return cached if fresh
  if (healthProbeCache && Date.now() - healthProbeCache.ts < HEALTH_PROBE_TTL) {
    return healthProbeCache.data
  }

  // If no cache yet, return basic data immediately and probe in background
  if (!healthProbeCache && !probeInFlight) {
    probeInFlight = true
    doProbe(config).finally(() => { probeInFlight = false })
    return getBasicHealthData(config)
  }

  // If cache expired, do probe inline (fast — ECONNREFUSED is instant)
  return doProbe(config)
}

async function doProbe(config: OwlCodaConfig): Promise<Record<string, unknown>> {
  const start = Date.now()
  const runtimeProbe = await probeRuntimeSurface(config.routerUrl, 2000)
  const latency = Date.now() - start
  if (runtimeProbe.ok && runtimeProbe.localRuntimeProtocol) {
    config.localRuntimeProtocol = runtimeProbe.localRuntimeProtocol
  }
  const routerInfo: Record<string, unknown> = runtimeProbe.ok
    ? {
        reachable: true,
        latencyMs: latency,
        modelCount: runtimeProbe.modelCount ?? runtimeProbe.modelIds.length,
        source: runtimeProbe.source,
        readiness: runtimeProbe.readiness,
        backendHealthy: runtimeProbe.backendHealthy,
      }
    : { reachable: false, latencyMs: latency, modelCount: 0 }

  const circuits = getAllCircuitStates()
  const budgets: Record<string, Record<string, unknown>> = {}
  for (const [model, b] of getAllBudgets()) {
    budgets[model] = { successRate: b.successRate, budgetRemaining: b.budgetRemaining }
  }

  const openCircuits = Object.values(circuits).filter(c => c.state === 'open').length
  const totalModels = config.models.length
  let status: string
  if (!routerInfo.reachable) {
    status = 'unhealthy'
  } else if (openCircuits > 0 && openCircuits < totalModels) {
    status = 'degraded'
  } else if (openCircuits >= totalModels && totalModels > 0) {
    status = 'unhealthy'
  } else {
    status = 'healthy'
  }

  const data = {
    status,
    version: VERSION,
    pid: process.pid,
    host: config.host,
    port: config.port,
    routerUrl: config.routerUrl,
    router: routerInfo,
    circuitBreakers: circuits,
    errorBudgets: budgets,
    runtimeToken: process.env['OWLCODA_RUNTIME_TOKEN'] ?? null,
  }

  healthProbeCache = { ts: Date.now(), data }
  return data
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(res)
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: http.ServerResponse, statusCode: number, errorType: string, message: string): void {
  sendJson(res, statusCode, {
    type: 'error',
    error: { type: errorType, message },
  })
}

export function readBody(req: http.IncomingMessage, maxBytes: number = 10_485_760): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > maxBytes) {
        req.destroy()
        reject(new Error(`Request body too large (>${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const adminDeps: AdminDeps = {
  resetCircuitBreaker,
  resetBudgets,
  getAllCircuitStates,
  getRecentTraces,
  readAuditLog,
  getModelTruthSnapshot: async () => {
    throw new Error('model truth unavailable')
  },
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: OwlCodaConfig,
  modelTruth: ModelTruthAggregator,
  runtimeAdminDeps: AdminDeps,
  adminApiDeps: Parameters<typeof handleAdminApiRequest>[2],
): void {
  const method = req.method?.toUpperCase() ?? 'GET'
  const rawUrl = req.url ?? '/'
  const url = rawUrl.split('?')[0]!
  const requestId = assignRequestId(res)

  const startTime = Date.now()
  recordRequestStart()
  res.on('finish', () => {
    const duration = Date.now() - startTime
    recordRequestEnd(url, res.statusCode ?? 0, duration)
    recordLatency(url, duration)
    auditRequest({ method, path: url, model: url, statusCode: res.statusCode ?? 0, durationMs: duration })
    logInfo('http', `${method} ${rawUrl} → ${res.statusCode}`, { requestId: requestId.slice(0, 8), durationMs: duration })
  })

  if (method === 'OPTIONS') {
    setCorsHeaders(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'GET' && url === '/healthz') {
    deepHealthProbe(config).then(data => {
      const statusCode = data.status === 'healthy' ? 200 : data.status === 'degraded' ? 200 : 503
      sendJson(res, statusCode, data)
    }).catch(() => {
      sendJson(res, 503, { status: 'unhealthy', version: VERSION })
    })
    return
  }

  if (method === 'GET' && url === '/health') {
    const uptime = Math.round((Date.now() - serverStartTime) / 1000)
    sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      uptime,
      models: config.models.map(m => m.id),
    })
    return
  }

  if (method === 'GET' && url === '/v1/api-info') {
    const modelCount = config.models?.length ?? 0
    sendJson(res, 200, {
      name: 'OwlCoda',
      version: VERSION,
      modelCount,
      routerUrl: config.routerUrl,
      endpoints: [
        { method: 'POST', path: '/v1/messages', description: 'Messages API (streaming + non-streaming)' },
        { method: 'POST', path: '/v1/chat/completions', description: 'OpenAI Chat Completions API (passthrough to router)' },
        { method: 'GET', path: '/v1/models', description: 'List available models' },
        { method: 'GET', path: '/v1/backends', description: 'Discover local LLM backends (Ollama, LM Studio, vLLM)' },
        { method: 'GET', path: '/v1/perf', description: 'Per-model performance metrics (latency, TPS, success rate)' },
        { method: 'GET', path: '/v1/latency', description: 'Latency percentiles (p50/p90/p95/p99) per endpoint' },
        { method: 'GET', path: '/v1/audit', description: 'Request audit log with filtering (model, status, duration)' },
        { method: 'GET', path: '/v1/cache', description: 'Response cache stats and management (GET=stats, DELETE=clear)' },
        { method: 'DELETE', path: '/v1/cache', description: 'Clear response cache' },
        { method: 'GET', path: '/v1/cost', description: 'Session cost summary (per-model breakdown with real perf data)' },
        { method: 'GET', path: '/v1/recommend', description: 'Model recommendation for intent (code|analysis|chat|search|general)' },
        { method: 'GET', path: '/v1/skills', description: 'List learned skills (GET=list, POST=create)' },
        { method: 'GET', path: '/v1/skills/:id', description: 'Get/delete a specific skill' },
        { method: 'GET', path: '/v1/skill-stats', description: 'Skill injection stats (hit rate, top skills, timing)' },
        { method: 'DELETE', path: '/v1/skill-stats', description: 'Reset skill injection stats' },
        { method: 'GET', path: '/v1/insights', description: 'Batch session insights — summary across all sessions' },
        { method: 'GET', path: '/v1/insights/:sessionId', description: 'Session analysis: complexity, tools, skill matches' },
        { method: 'GET', path: '/v1/training/status', description: 'Training data collection stats' },
        { method: 'POST', path: '/v1/training/clear', description: 'Clear collected training data' },
        { method: 'GET', path: '/v1/training/export', description: 'Download collected training JSONL' },
        { method: 'POST', path: '/v1/search', description: 'Local web search (DuckDuckGo HTML, no API key)' },
        { method: 'GET', path: '/v1/usage', description: 'Token usage stats' },
        { method: 'POST', path: '/v1/messages/count_tokens', description: 'Token counting' },
        { method: 'GET', path: '/v1/api-info', description: 'API info, version, and endpoint list' },
        { method: 'GET', path: '/health', description: 'Health check' },
        { method: 'GET', path: '/healthz', description: 'Detailed health (internal)' },
        { method: 'GET', path: '/dashboard', description: 'Observability dashboard' },
        { method: 'GET', path: '/openapi.json', description: 'OpenAPI 3.0 specification' },
        { method: 'GET', path: '/metrics', description: 'Prometheus/OpenMetrics text format' },
        { method: 'GET', path: '/events/metrics', description: 'SSE live metrics stream (2s interval)' },
        { method: 'POST', path: '/admin/reset-circuit-breakers', description: 'Reset all circuit breakers (auth optional)' },
        { method: 'POST', path: '/admin/reset-budgets', description: 'Reset error budgets' },
        { method: 'POST', path: '/admin/reload-config', description: 'Reload config from disk' },
        { method: 'GET', path: '/admin/config', description: 'Current effective config' },
        { method: 'GET', path: '/admin/model-truth', description: 'Unified model truth snapshot' },
        { method: 'GET', path: '/admin/requests', description: 'Recent request traces' },
        { method: 'GET', path: '/admin/audit', description: 'Recent audit log entries' },
        { method: 'GET', path: '/v1/web-search', description: 'Web search via SearXNG (query: ?q=...)' },
        { method: 'GET', path: '/v1/web-search/status', description: 'SearXNG availability check' },
      ],
    })
    return
  }

  if (method === 'GET' && url === '/openapi.json') {
    sendJson(res, 200, getOpenApiSpec())
    return
  }

  if (method === 'GET' && url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(renderMetrics())
    return
  }

  if (method === 'GET' && url === '/dashboard') {
    const metrics = getMetrics()
    const budgets: Record<string, import('./error-budget.js').ErrorBudget> = {}
    for (const [model, b] of getAllBudgets()) {
      budgets[model] = b
    }
    sendJson(res, 200, { ...metrics, errorBudgets: budgets, sloTarget: getSloTarget(), recentTraces: getRecentTraces(10) })
    return
  }

  if (method === 'GET' && url === '/v1/captures') {
    import('./capture.js').then(({ getCaptures, getCaptureStats }) => {
      sendJson(res, 200, { captures: getCaptures(), stats: getCaptureStats() })
    }).catch(() => {
      sendJson(res, 500, { error: 'Failed to load capture module' })
    })
    return
  }

  if (method === 'GET' && url === '/events/metrics') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    activeStreams.add(res)
    // Send initial snapshot immediately
    const snapshot = JSON.stringify({ ...getMetrics(), usage: getTokenUsage() })
    res.write(`event: metrics\ndata: ${snapshot}\n\n`)
    // Push updates every 2 seconds
    const interval = setInterval(() => {
      try {
        const data = JSON.stringify({ ...getMetrics(), usage: getTokenUsage() })
        res.write(`event: metrics\ndata: ${data}\n\n`)
      } catch {
        clearInterval(interval)
        activeStreams.delete(res)
      }
    }, 2000)
    const cleanup = (): void => {
      clearInterval(interval)
      activeStreams.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
    return
  }

  if (method === 'GET' && url === '/v1/usage') {
    const usage = getTokenUsage()
    const elapsed = (Date.now() - new Date(usage.startedAt).getTime()) / 1000
    sendJson(res, 200, {
      ...usage,
      totalTokens: usage.inputTokens + usage.outputTokens,
      elapsedSeconds: Math.round(elapsed),
      traceEnabled: isTraceEnabled(),
      pricingNote: 'estimated_cloud_rates — actual cost is zero for local inference; displayed rates are vendor-reference cloud equivalents for comparison only',
    })
    return
  }

  if (method === 'POST' && url === '/v1/messages') {
    const traceId = isTraceEnabled()
      ? traceRequest(method, url, req.headers as Record<string, string>, '[body read in handler]')
      : Promise.resolve(null)
    traceId.then(tid => {
      handleMessages(req, res, config).then(() => {
        if (tid) {
          const duration = Date.now() - startTime
          traceResponse(tid, method, url, res.statusCode ?? 200, duration, '[streamed/non-streamed response]').catch(e => logWarn('trace', `Trace response failed: ${e}`))
        }
      }).catch(err => {
        logError('http', 'Unhandled error in handleMessages', { error: String(err) })
        recordError('/v1/messages', 'api_error', String(err))
        if (!res.headersSent) {
          sendError(res, 500, 'api_error', 'Internal server error')
        }
      })
    }).catch(e => logWarn('trace', `Trace ID resolve failed: ${e}`))
    return
  }

  if (method === 'GET' && url === '/v1/models') {
    handleModels(req, res, config, modelTruth).catch(err => {
      logError('http', 'Unhandled error in handleModels', { error: String(err) })
      if (!res.headersSent) {
        sendError(res, 500, 'api_error', 'Internal server error')
      }
    })
    return
  }

  if (method === 'POST' && url === '/v1/chat/completions') {
    // Read body
    let rawBody = ''
    req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
    req.on('end', () => {
      import('./endpoints/chat-completions.js').then(({ handleChatCompletions }) => {
        handleChatCompletions(req, res, config, rawBody).catch(err => {
          logError('http', 'Unhandled error in handleChatCompletions', { error: String(err) })
          if (!res.headersSent) {
            sendError(res, 500, 'api_error', 'Internal server error')
          }
        })
      }).catch(err => {
        logError('http', 'Failed to load chat-completions handler', { error: String(err) })
        sendError(res, 500, 'api_error', 'Internal server error')
      })
    })
    return
  }

  if (method === 'GET' && url === '/v1/backends') {
    handleBackends(req, res, config, modelTruth).catch(err => {
      logError('http', 'Unhandled error in handleBackends', { error: String(err) })
      if (!res.headersSent) {
        sendError(res, 500, 'api_error', 'Internal server error')
      }
    })
    return
  }

  if (method === 'GET' && url === '/v1/perf') {
    handlePerf(req, res)
    return
  }

  if (method === 'GET' && url === '/v1/latency') {
    const stats = getAllLatencyStats()
    sendJson(res, 200, { latency: stats })
    return
  }

  if (method === 'GET' && (url === '/v1/audit' || url?.startsWith('/v1/audit?'))) {
    const urlObj = new URL(rawUrl || '/v1/audit', `http://${req.headers.host || 'localhost'}`)
    const filter: Record<string, unknown> = {}
    if (urlObj.searchParams.get('model')) filter.model = urlObj.searchParams.get('model')
    if (urlObj.searchParams.get('path')) filter.path = urlObj.searchParams.get('path')
    if (urlObj.searchParams.get('minStatus')) filter.minStatus = Number(urlObj.searchParams.get('minStatus'))
    if (urlObj.searchParams.get('limit')) filter.limit = Number(urlObj.searchParams.get('limit'))
    const auditEntries = queryAudit(filter as any)
    const summary = getAuditSummary()
    sendJson(res, 200, { entries: auditEntries, summary })
    return
  }

  if (method === 'GET' && url === '/v1/cost') {
    handleCost(req, res)
    return
  }

  if ((method === 'GET' || method === 'DELETE') && url === '/v1/cache') {
    if (method === 'DELETE') {
      clearCache()
      sendJson(res, 200, { status: 'cleared' })
    } else {
      sendJson(res, 200, getCacheStats())
    }
    return
  }

  if (method === 'GET' && (url === '/v1/recommend' || url?.startsWith('/v1/recommend?'))) {
    handleRecommend(req, res, config)
    return
  }

  if (url === '/v1/skill-stats') {
    handleSkillStats(req, res).catch(err => {
      logError('skill-stats', 'Unhandled error in handleSkillStats', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  if (url === '/v1/skills' || url?.startsWith('/v1/skills/')) {
    handleSkills(req, res).catch(err => {
      logError('skills', 'Unhandled error in handleSkills', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  if (url === '/v1/insights' && method === 'GET') {
    handleBatchInsights(req, res).catch(err => {
      logError('insights', 'Unhandled error in handleBatchInsights', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  if (url?.startsWith('/v1/insights/')) {
    const sessionId = url.replace('/v1/insights/', '')
    handleInsights(req, res, sessionId).catch(err => {
      logError('insights', 'Unhandled error in handleInsights', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  if (url?.startsWith('/v1/training/')) {
    const action = url.replace('/v1/training/', '')
    handleTraining(req, res, action).catch(err => {
      logError('training', 'Unhandled error in handleTraining', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  // ─── Web Search (SearXNG) ───
  if (method === 'GET' && url === '/v1/web-search') {
    const urlObj = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`)
    const query = urlObj.searchParams.get('q')
    if (!query) {
      sendJson(res, 400, { error: 'Missing required parameter: q' })
      return
    }
    const language = urlObj.searchParams.get('language') || undefined
    const limit = urlObj.searchParams.get('limit') ? Number(urlObj.searchParams.get('limit')) : undefined
    const categories = urlObj.searchParams.get('categories') || undefined
    webSearch(query, { language, limit, categories }).then(result => {
      sendJson(res, 200, result)
    }).catch(err => {
      sendJson(res, 502, { error: `SearXNG unavailable: ${String(err)}` })
    })
    return
  }

  if (method === 'GET' && url === '/v1/web-search/status') {
    checkSearXNG().then(status => {
      sendJson(res, status.available ? 200 : 503, status)
    })
    return
  }

  if (method === 'POST' && url === '/v1/search') {
    handleSearch(req, res, config).catch(err => {
      logError('search', 'Unhandled error in handleSearch', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  if (method === 'POST' && url === '/v1/messages/count_tokens') {
    handleCountTokens(req, res, config).catch(err => {
      logError('http', 'Unhandled error in handleCountTokens', { error: String(err) })
      if (!res.headersSent) {
        sendError(res, 500, 'api_error', 'Internal server error')
      }
    })
    return
  }

  // === Local stub endpoints ===

  if (method === 'GET' && url === '/api/oauth/usage') {
    handleUsage(req, res, config)
    return
  }

  if (method === 'GET' && url === '/api/oauth/profile') {
    handleProfile(req, res, config)
    return
  }

  if (method === 'GET' && url === '/api/oauth/account/settings') {
    handleAccountSettings(req, res, config)
    return
  }

  if (method === 'GET' && url.startsWith('/api/oauth/organizations/') && url.includes('/referral/eligibility')) {
    sendJson(res, 200, { eligible: false })
    return
  }

  if (method === 'GET' && url.startsWith('/api/oauth/organizations/') && url.includes('/admin_requests')) {
    sendJson(res, 200, { data: [] })
    return
  }

  if (method === 'GET' && url.startsWith('/api/oauth/organizations/') && url.includes('/overage_credit_grant')) {
    sendJson(res, 200, { eligible: false, amount: 0 })
    return
  }

  if (method === 'POST' && url === '/v1/oauth/token') {
    sendJson(res, 200, {
      access_token: 'owlcoda-local-token',
      token_type: 'bearer',
      expires_in: 86400,
    })
    return
  }

  if (url.startsWith('/v1/files')) {
    sendJson(res, 200, { data: [], has_more: false })
    return
  }

  if (url.startsWith('/v1/session_ingress/')) {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.startsWith('/admin/api/')) {
    handleAdminApiRequest(req, res, adminApiDeps).catch(err => {
      logError('admin-api', 'Unhandled error in admin API', { error: String(err) })
      if (!res.headersSent) sendError(res, 500, 'api_error', 'Internal server error')
    })
    return
  }

  // Serve the compiled admin client (dist/admin/) before the bearer gate —
  // static UI is public; session-gated data lives in /admin/api/*.
  if (handleAdminStatic(req, res)) {
    return
  }

  // === Admin API ===

  // Gate every /admin/* data route behind AdminAuthManager, regardless of
  // whether config.adminToken is explicitly set. Previously this branch
  // ran the Bearer check only when an explicit adminToken was configured,
  // leaving all admin endpoints wide open when the user hadn't bothered
  // to set one — because the fallback bearer is deterministic
  // (`owlcoda-local-key-${port}`), any local process could reach the
  // admin API for free. AdminAuthManager.authenticate already accepts:
  //   - `Authorization: Bearer <bearerToken>` (explicit OR fallback)
  //   - a valid admin session cookie minted via one-shot token exchange
  // Static assets (handleAdminStatic above) were already handled and are
  // not sensitive; this gate only covers data/mutation routes.
  if (url.startsWith('/admin/')) {
    const authResult = adminApiDeps.auth.authenticate(req)
    if (!authResult.ok) {
      sendError(
        res,
        authResult.status ?? 401,
        authResult.code ?? 'authentication_error',
        authResult.message ?? 'Unauthorized',
      )
      return
    }
  }

  if (method === 'POST' && url === '/admin/reset-circuit-breakers') {
    adminHandlers.handleResetCircuitBreakers(req, res, config, runtimeAdminDeps)
    return
  }

  if (method === 'POST' && url === '/admin/reset-budgets') {
    adminHandlers.handleResetBudgets(req, res, config, runtimeAdminDeps)
    return
  }

  if (method === 'POST' && url === '/admin/reload-config') {
    adminHandlers.handleReloadConfig(req, res, config)
    return
  }

  if (method === 'GET' && url === '/admin/config') {
    adminHandlers.handleGetConfig(req, res, config)
    return
  }

  if (method === 'GET' && (url === '/admin/model-truth' || url.startsWith('/admin/model-truth?'))) {
    adminHandlers.handleGetModelTruth(req, res, config, runtimeAdminDeps, rawUrl)
    return
  }

  if (method === 'GET' && (url === '/admin/requests' || url.startsWith('/admin/requests?'))) {
    adminHandlers.handleGetRequests(req, res, config, runtimeAdminDeps, rawUrl)
    return
  }

  if (method === 'GET' && (url === '/admin/audit' || url.startsWith('/admin/audit?'))) {
    adminHandlers.handleGetAudit(req, res, config, runtimeAdminDeps, rawUrl)
    return
  }

  // Catch-all: return 200 empty instead of 404 (CC treats 404 as fatal)
  logWarn('http', `Unhandled endpoint: ${method} ${rawUrl} — returning empty OK`)
  sendJson(res, 200, {})
}

async function checkRouter(config: OwlCodaConfig, _log: ReturnType<typeof createLogger>): Promise<void> {
  const runtimeProbe = await probeRuntimeSurface(config.routerUrl, 5000)
  if (!runtimeProbe.ok) {
    console.error('Local runtime: unreachable (will retry on first request)')
    return
  }
  if (runtimeProbe.localRuntimeProtocol) {
    config.localRuntimeProtocol = runtimeProbe.localRuntimeProtocol
  }
  console.error(`Local runtime: connected ✓ (${runtimeProbe.source})`)
  if (runtimeProbe.platformVisibility?.deprecatedFallback) {
    console.error('Visibility truth: deprecated router fallback active')
  }
  if (runtimeProbe.modelIds.length > 0) {
    console.error(`Visibility models: ${runtimeProbe.modelIds.length} live`)
  } else if (runtimeProbe.loadedModelIds.length > 0) {
    console.error(`Loaded inventory: ${runtimeProbe.loadedModelIds.length} model(s)`)
  }
}

export function startServer(config: OwlCodaConfig): http.Server {
  const log = createLogger(config.logLevel)
  initShutdownController()
  // L3 training collection — opt-in. Wire config flag into the collector
  // so that the master gate (collector.isTrainingCollectionEnabled) reflects
  // user intent. Env OWLCODA_TRAINING_COLLECTION still wins per call.
  void import('./data/collector.js').then(({ configureCollector }) => {
    configureCollector({ enabled: config.trainingCollection === true })
  })
  const modelTruth = new ModelTruthAggregator(() => config, { ttlMs: 5_000 })
  const mutator = new ModelConfigMutator({
    onInvalidate: () => modelTruth.invalidate(),
    onWrite: (models, rawConfig) => {
      config.models = models
      if (typeof rawConfig.routerUrl === 'string') {
        config.routerUrl = rawConfig.routerUrl
      }
      if (
        rawConfig.localRuntimeProtocol === 'auto'
        || rawConfig.localRuntimeProtocol === 'openai_chat'
        || rawConfig.localRuntimeProtocol === 'anthropic_messages'
      ) {
        config.localRuntimeProtocol = rawConfig.localRuntimeProtocol
      }
      config.modelMap = (rawConfig.modelMap as Record<string, string>) ?? {}
      const defaultModel = models.find(model => model.default)?.backendModel ?? models[0]?.backendModel ?? ''
      config.defaultModel = defaultModel
      appendBuiltinEndpointModels(config)
    },
  })
  const providerProbe = new ProviderProbe()
  const adminAuth = createAdminAuthManager(config)
  const runtimeAdminDeps: AdminDeps = {
    ...adminDeps,
    getModelTruthSnapshot: options => modelTruth.getSnapshot(options),
  }
  const adminApiDeps = {
    getConfig: () => config,
    getSnapshot: (options?: { skipCache?: boolean }) => modelTruth.getSnapshot(options),
    getCatalog: () => loadCatalog(),
    mutator,
    providerProbe,
    auth: adminAuth,
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, modelTruth, runtimeAdminDeps, adminApiDeps)
  })
  Object.assign(server, { __adminAuth: adminAuth })

  server.on('close', () => {
    stopConfigWatcher()
    stopHealthMonitor()
    closeLogFile()
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌  Port ${config.port} is already in use on ${config.host}.`)
      console.error(`    Another OwlCoda process or an unrelated service is holding it.`)
      console.error(`    Try one of:`)
      console.error(`      owlcoda status                      # check if a daemon is already running`)
      console.error(`      owlcoda stop                        # stop an existing OwlCoda daemon`)
      console.error(`      owlcoda --port 8020                 # launch on a different port`)
      console.error(`      lsof -i :${config.port}                    # identify the process holding the port\n`)
      process.exit(1)
    }
    if (err.code === 'EACCES') {
      console.error(`\n❌  Permission denied binding to ${config.host}:${config.port}.`)
      console.error(`    Ports below 1024 require elevated privileges — use an unprivileged port (1024+).\n`)
      process.exit(1)
    }
    console.error(`\n❌  Server startup failed: ${err.message}\n`)
    process.exit(1)
  })

  server.listen(config.port, config.host, () => {
    console.error(`OwlCoda v${VERSION}`)
    console.error(`Proxy listening on http://${config.host}:${config.port}`)
    console.error(`Local runtime target: ${config.routerUrl}`)

    // Async health check — don't block startup
    checkRouter(config, log).catch(e => logWarn('startup', `Router check failed: ${e}`))

    // Start config watcher and health monitor
    startConfigWatcher(config, { onReload: () => modelTruth.invalidate() })
    startHealthMonitor(config)

    // Periodic cleanup of stale rate-limit buckets (every 5 minutes)
    const rateLimitPruner = setInterval(() => pruneRateLimitBuckets(), 300_000)
    rateLimitPruner.unref()

    // Initialize log file output if configured
    if (config.logFilePath) {
      initLogFile(config.logFilePath, config.logFileMaxBytes, config.logFileKeep)
    }

    // Apply circuit breaker config from config.json on startup
    const mw = config.middleware ?? {}
    if (mw.circuitBreakerThreshold != null || mw.circuitBreakerCooldownMs != null) {
      configureCircuitBreaker({
        ...(mw.circuitBreakerThreshold != null ? { threshold: mw.circuitBreakerThreshold } : {}),
        ...(mw.circuitBreakerCooldownMs != null ? { cooldownMs: mw.circuitBreakerCooldownMs } : {}),
      })
    }
    if (mw.sloTargetPercent != null) {
      setSloTarget(mw.sloTargetPercent / 100)
    }
  })

  const shutdown = (): void => {
    console.error('[shutdown] Draining — stop accepting new connections...')

    // Abort all in-flight upstream requests
    triggerShutdownSignal()

    // Stop background services
    stopConfigWatcher()
    stopHealthMonitor()
    closeLogFile()

    // Stop accepting new connections immediately
    server.close(() => {
      console.error('[shutdown] All connections closed, exiting.')
      process.exit(0)
    })

    // Notify all active SSE streams
    for (const stream of activeStreams) {
      try {
        stream.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Server shutting down' },
        })}\n\n`)
        stream.end()
      } catch { /* ignore */ }
    }

    // Wait for in-flight requests (check every 500ms, up to 30s)
    const drainStart = Date.now()
    const drainInterval = setInterval(() => {
      const active = getActiveRequests()
      const elapsed = Math.round((Date.now() - drainStart) / 1000)
      if (active === 0) {
        console.error(`[shutdown] Drain complete (${elapsed}s), exiting.`)
        clearInterval(drainInterval)
        process.exit(0)
      }
      if (elapsed >= 30) {
        console.error(`[shutdown] Drain timeout (${active} still active), forcing exit.`)
        clearInterval(drainInterval)
        process.exit(1)
      }
      console.error(`[shutdown] Draining... ${active} active requests (${elapsed}s)`)
    }, 500)
    drainInterval.unref()

    // Hard exit after 35s as final safety net
    setTimeout(() => process.exit(1), 35000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Prevent silent crashes from unhandled async errors
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[owlcoda] Unhandled promise rejection:', reason)
    console.error('[owlcoda] Promise:', promise)
  })
  process.on('uncaughtException', (err) => {
    console.error('[owlcoda] Uncaught exception:', err)
    // Attempt graceful shutdown on uncaught exception
    shutdown()
  })

  return server
}
