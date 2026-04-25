/**
 * Admin route handlers — extracted from server.ts for modularity.
 * All handlers are pure functions: (req, res, config, deps) → void
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { OwlCodaConfig } from '../config.js'
import { getOwlcodaConfigPath } from '../paths.js'
import { validateConfig as validateConfigSchema } from '../config-validate.js'
import { applyReloadableFields } from '../config-watcher.js'
import type { ModelTruthSnapshot } from '../model-truth.js'

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, statusCode: number, type: string, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

export interface AdminDeps {
  resetCircuitBreaker: () => void
  resetBudgets: () => void
  getAllCircuitStates: () => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRecentTraces: (count: number) => any[]
  readAuditLog: (count: number) => Promise<unknown[]>
  getModelTruthSnapshot: (options?: { skipCache?: boolean }) => Promise<ModelTruthSnapshot>
}

export function handleResetCircuitBreakers(
  _req: IncomingMessage, res: ServerResponse, _config: OwlCodaConfig, deps: AdminDeps,
): void {
  deps.resetCircuitBreaker()
  sendJson(res, 200, { ok: true, message: 'All circuit breakers reset' })
}

export function handleResetBudgets(
  _req: IncomingMessage, res: ServerResponse, _config: OwlCodaConfig, deps: AdminDeps,
): void {
  deps.resetBudgets()
  sendJson(res, 200, { ok: true, message: 'All error budgets reset' })
}

export function handleReloadConfig(
  _req: IncomingMessage, res: ServerResponse, config: OwlCodaConfig,
): void {
  try {
    const content = readFileSync(getOwlcodaConfigPath(), 'utf-8')
    const parsed = JSON.parse(content)
    const validation = validateConfigSchema(parsed)
    const warnings = validation.errors
    const applied = applyReloadableFields(config, parsed)
    sendJson(res, 200, { ok: true, applied, warnings })
  } catch (err) {
    sendError(res, 500, 'api_error', `Config reload failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function handleGetConfig(
  _req: IncomingMessage, res: ServerResponse, config: OwlCodaConfig,
): void {
  const safeConfig = { ...(config as unknown as Record<string, unknown>) }
  if (Array.isArray(safeConfig.models)) {
    safeConfig.models = (safeConfig.models as Array<Record<string, unknown>>).map(m => ({
      ...m,
      apiKey: m.apiKey ? '***' : undefined,
    }))
  }
  sendJson(res, 200, safeConfig)
}

export function handleGetModelTruth(
  _req: IncomingMessage, res: ServerResponse, _config: OwlCodaConfig, deps: AdminDeps, rawUrl: string,
): void {
  const params = new URLSearchParams(rawUrl.split('?')[1] ?? '')
  const skipCache = params.get('skipCache') === 'true'
  deps.getModelTruthSnapshot({ skipCache }).then(snapshot => {
    const sanitizeStatus = <T extends typeof snapshot.statuses[number]>(status: T): T => ({
      ...status,
      raw: status.raw.config
        ? {
            ...status.raw,
            config: {
              ...status.raw.config,
              apiKey: status.raw.config.apiKey ? '***' : undefined,
            },
          }
        : status.raw,
    })
    const safeSnapshot = {
      ...snapshot,
      statuses: snapshot.statuses.map(sanitizeStatus),
      byModelId: Object.fromEntries(
        Object.entries(snapshot.byModelId).map(([modelId, status]) => [modelId, sanitizeStatus(status)]),
      ),
    }
    sendJson(res, 200, safeSnapshot)
  }).catch(err => {
    sendError(res, 500, 'api_error', `Model truth read failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

export function handleGetRequests(
  _req: IncomingMessage, res: ServerResponse, _config: OwlCodaConfig, deps: AdminDeps, rawUrl: string,
): void {
  const params = new URLSearchParams(rawUrl.split('?')[1] ?? '')
  const count = Math.min(Math.max(parseInt(params.get('count') ?? '10') || 10, 1), 500)
  const model = params.get('model')
  let traces = deps.getRecentTraces(count)
  if (model) {
    traces = traces.filter(t => typeof t.requestId === 'string' && t.requestId.includes(model))
  }
  sendJson(res, 200, { traces })
}

export function handleGetAudit(
  _req: IncomingMessage, res: ServerResponse, _config: OwlCodaConfig, deps: AdminDeps, rawUrl: string,
): void {
  const params = new URLSearchParams(rawUrl.split('?')[1] ?? '')
  const count = Math.min(Math.max(parseInt(params.get('count') ?? '20') || 20, 1), 500)
  deps.readAuditLog(count).then(entries => {
    sendJson(res, 200, { entries })
  }).catch(err => {
    sendError(res, 500, 'api_error', `Audit read failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}
