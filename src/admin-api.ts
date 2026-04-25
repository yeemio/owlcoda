import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig, ConfiguredModel } from './config.js'
import type { PlatformCatalog } from './models/catalog.js'
import { getProviderTemplates, ProviderProbe, type DryRunProviderPayload, type ProviderProbeResult } from './provider-probe.js'
import {
  ModelConfigMutator,
  type CreateEndpointModelPatch,
  type UpdateModelFieldsPatch,
  type BindDiscoveredModelPatch,
  type UpdateRuntimeSettingsPatch,
} from './model-config-mutator.js'
import type { ModelTruthSnapshot } from './model-truth.js'
import { createOneShotAdminToken, getAdminBearerToken, verifyOneShotAdminToken } from './admin-delivery.js'

export const ADMIN_API_SCHEMA_VERSION = 1
const ADMIN_SESSION_COOKIE = 'owlcoda_admin_session'

export interface AdminApiDeps {
  getConfig: () => OwlCodaConfig
  getSnapshot: (options?: { skipCache?: boolean }) => Promise<ModelTruthSnapshot>
  getCatalog: () => PlatformCatalog | null
  mutator: ModelConfigMutator
  providerProbe: ProviderProbe
  auth: AdminAuthManager
}

export interface AdminApiResultItem {
  id: string
  ok: boolean
  error?: {
    code: string
    message: string
  }
  data?: unknown
}

interface RouteMatch {
  action:
    | 'snapshot'
    | 'config'
    | 'catalog'
    | 'providers'
    | 'patch-runtime'
    | 'create-model'
    | 'patch-model'
    | 'delete-model'
    | 'set-key'
    | 'set-default'
    | 'bind-discovered'
    | 'test-model'
    | 'test-connection'
    | 'auth-exchange'
    | 'bulk-patch'
    | 'bulk-bind-discovered'
    | 'bulk-create'
  modelId?: string
}

export interface BulkPatchItem {
  id: string
  patch: UpdateModelFieldsPatch
}

export interface BulkBindItem {
  discoveredId: string
  patch?: BindDiscoveredModelPatch
}

export interface BulkCreateItem {
  model: CreateEndpointModelPatch
}

interface AdminSession {
  csrfToken: string
  expiresAt: number
}

export class AdminAuthManager {
  private readonly bearerToken: string
  private readonly sessionTtlMs: number
  private readonly oneShotTtlMs: number
  private readonly sessions = new Map<string, AdminSession>()
  private readonly oneShotTokens = new Map<string, number>()

  constructor(bearerToken: string, options: { sessionTtlMs?: number, oneShotTtlMs?: number } = {}) {
    this.bearerToken = bearerToken
    this.sessionTtlMs = options.sessionTtlMs ?? 86_400_000
    this.oneShotTtlMs = options.oneShotTtlMs ?? 300_000
  }

  issueOneShotToken(): string {
    const token = createOneShotAdminToken(this.bearerToken)
    this.oneShotTokens.set(token, Date.now() + this.oneShotTtlMs)
    return token
  }

  exchangeOneShotToken(token: string): { sessionId: string, csrfToken: string } | null {
    this.pruneExpired()
    const expiresAt = this.oneShotTokens.get(token)
    const validStatelessToken = verifyOneShotAdminToken(this.bearerToken, token, { maxAgeMs: this.oneShotTtlMs })
    if ((!expiresAt || expiresAt < Date.now()) && !validStatelessToken) {
      this.oneShotTokens.delete(token)
      return null
    }
    this.oneShotTokens.delete(token)
    const sessionId = randomToken('sess')
    const csrfToken = randomToken('csrf')
    this.sessions.set(sessionId, {
      csrfToken,
      expiresAt: Date.now() + this.sessionTtlMs,
    })
    return { sessionId, csrfToken }
  }

  buildSessionCookie(sessionId: string): string {
    return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/admin; HttpOnly; SameSite=Strict`
  }

  authenticate(req: IncomingMessage, options: { requireCsrf?: boolean } = {}): {
    ok: boolean
    status?: number
    code?: string
    message?: string
  } {
    this.pruneExpired()
    const auth = req.headers['authorization']
    if (auth === `Bearer ${this.bearerToken}`) {
      return { ok: true }
    }

    const cookies = parseCookies(req.headers['cookie'])
    const sessionId = cookies[ADMIN_SESSION_COOKIE]
    if (!sessionId) {
      return {
        ok: false,
        status: 401,
        code: 'authentication_error',
        message: 'Missing admin session',
      }
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId)
      return {
        ok: false,
        status: 401,
        code: 'authentication_error',
        message: 'Admin session expired',
      }
    }

    if (options.requireCsrf) {
      const csrf = req.headers['x-owlcoda-token']
      if (csrf !== session.csrfToken) {
        return {
          ok: false,
          status: 403,
          code: 'csrf_mismatch',
          message: 'Missing or invalid X-OwlCoda-Token',
        }
      }
    }

    return { ok: true }
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [token, expiresAt] of this.oneShotTokens.entries()) {
      if (expiresAt < now) this.oneShotTokens.delete(token)
    }
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt < now) this.sessions.delete(sessionId)
    }
  }
}

export async function handleAdminApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminApiDeps,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? 'GET'
  const rawUrl = req.url ?? '/'
  const url = rawUrl.split('?')[0] ?? rawUrl

  if (!url.startsWith('/admin/api/')) {
    return false
  }

  if (!isLoopbackRequest(req)) {
    sendAdminError(res, 403, 'forbidden', 'Admin API is only available from loopback clients')
    return true
  }

  const route = matchRoute(method, url)
  if (!route) {
    sendAdminError(res, 404, 'not_found', 'Admin API route not found')
    return true
  }

  if (route.action === 'auth-exchange') {
    const body = method === 'POST' ? await readJsonBody(req) : null
    const params = new URLSearchParams(rawUrl.split('?')[1] ?? '')
    const token = (body?.token as string | undefined) ?? params.get('token') ?? undefined
    if (!token) {
      sendAdminError(res, 400, 'invalid_request', 'Missing one-shot token')
      return true
    }
    const session = deps.auth.exchangeOneShotToken(token)
    if (!session) {
      sendAdminError(res, 401, 'authentication_error', 'Invalid or expired one-shot token')
      return true
    }
    res.setHeader('Set-Cookie', deps.auth.buildSessionCookie(session.sessionId))
    sendAdminJson(res, 200, {
      schemaVersion: ADMIN_API_SCHEMA_VERSION,
      ok: true,
      csrfToken: session.csrfToken,
    })
    return true
  }

  const auth = deps.auth.authenticate(req, { requireCsrf: isWriteMethod(method) })
  if (!auth.ok) {
    sendAdminError(res, auth.status ?? 401, auth.code ?? 'authentication_error', auth.message ?? 'Unauthorized')
    return true
  }

  try {
    switch (route.action) {
      case 'snapshot':
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          snapshot: sanitizeSnapshot(await deps.getSnapshot()),
        })
        return true
      case 'config':
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          config: sanitizeConfig(deps.getConfig()),
        })
        return true
      case 'catalog': {
        const catalog = deps.getCatalog()
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          items: catalog?.models ?? [],
          aliases: catalog?.aliases ?? {},
          defaultModel: catalog?.default_model ?? null,
          catalogVersion: catalog?.version ?? null,
        })
        return true
      }
      case 'providers':
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          providers: getProviderTemplates(),
        })
        return true
      case 'patch-runtime': {
        const body = await readJsonBody(req)
        const patch = unwrapPatchPayload<UpdateRuntimeSettingsPatch>(body)
        await deps.mutator.updateRuntimeSettings(patch)
        sendMutationResult(res, 200, {
          id: 'runtime-settings',
          ok: true,
        }, deps)
        return true
      }
      case 'create-model': {
        const body = await readJsonBody(req)
        const patch = unwrapModelPayload<CreateEndpointModelPatch>(body)
        await deps.mutator.createEndpointModel(patch)
        sendMutationResult(res, 201, {
          id: patch.id,
          ok: true,
        }, deps)
        return true
      }
      case 'patch-model': {
        const body = await readJsonBody(req)
        const patch = unwrapPatchPayload<UpdateModelFieldsPatch>(body)
        await deps.mutator.updateModelFields(route.modelId!, patch)
        sendMutationResult(res, 200, {
          id: route.modelId!,
          ok: true,
        }, deps)
        return true
      }
      case 'delete-model':
        await deps.mutator.removeModel(route.modelId!)
        sendMutationResult(res, 200, {
          id: route.modelId!,
          ok: true,
        }, deps)
        return true
      case 'set-key': {
        const body = await readJsonBody(req)
        if (typeof body?.apiKey === 'string' && body.apiKey) {
          await deps.mutator.setApiKey(route.modelId!, body.apiKey)
        } else if (typeof body?.apiKeyEnv === 'string' && body.apiKeyEnv) {
          await deps.mutator.setApiKeyEnv(route.modelId!, body.apiKeyEnv)
        } else {
          throw new AdminApiError(400, 'invalid_request', 'Either apiKey or apiKeyEnv is required')
        }
        sendMutationResult(res, 200, {
          id: route.modelId!,
          ok: true,
        }, deps)
        return true
      }
      case 'set-default': {
        const body = await readJsonBody(req)
        const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined
        if (!modelId) throw new AdminApiError(400, 'invalid_request', 'modelId is required')
        await deps.mutator.setDefaultModel(modelId)
        sendMutationResult(res, 200, {
          id: modelId,
          ok: true,
        }, deps)
        return true
      }
      case 'bind-discovered': {
        const body = await readJsonBody(req)
        const patch = unwrapPatchPayload<BindDiscoveredModelPatch>(body)
        await deps.mutator.bindDiscoveredModel(route.modelId!, patch)
        sendMutationResult(res, 200, {
          id: route.modelId!,
          ok: true,
        }, deps)
        return true
      }
      case 'test-model': {
        const model = deps.getConfig().models.find(candidate => candidate.id === route.modelId!)
        if (!model) throw new AdminApiError(404, 'not_found', `Model "${route.modelId}" not found`)
        const result = await deps.providerProbe.test(model)
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          result,
        })
        return true
      }
      case 'test-connection': {
        const body = await readJsonBody(req)
        const payload = unwrapProbePayload(body)
        const result = await deps.providerProbe.test(payload)
        sendAdminJson(res, 200, {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          result,
        })
        return true
      }
      case 'bulk-patch': {
        const body = await readJsonBody(req)
        const items = extractBulkArray<BulkPatchItem>(body, 'items')
        const results: AdminApiResultItem[] = []
        for (const item of items) {
          if (!item || typeof item.id !== 'string' || !item.id) {
            results.push({ id: String(item?.id ?? '?'), ok: false, error: { code: 'invalid_request', message: 'id is required' } })
            continue
          }
          const patch = (item.patch ?? {}) as UpdateModelFieldsPatch
          try {
            await deps.mutator.updateModelFields(item.id, patch)
            results.push({ id: item.id, ok: true })
          } catch (error) {
            results.push({
              id: item.id,
              ok: false,
              error: errorToItemError(error),
            })
          }
        }
        await sendBatchResult(res, results, deps)
        return true
      }
      case 'bulk-bind-discovered': {
        const body = await readJsonBody(req)
        const items = extractBulkArray<BulkBindItem>(body, 'items')
        const results: AdminApiResultItem[] = []
        for (const item of items) {
          if (!item || typeof item.discoveredId !== 'string' || !item.discoveredId) {
            results.push({ id: String(item?.discoveredId ?? '?'), ok: false, error: { code: 'invalid_request', message: 'discoveredId is required' } })
            continue
          }
          try {
            await deps.mutator.bindDiscoveredModel(item.discoveredId, item.patch ?? {})
            results.push({ id: item.discoveredId, ok: true })
          } catch (error) {
            results.push({
              id: item.discoveredId,
              ok: false,
              error: errorToItemError(error),
            })
          }
        }
        await sendBatchResult(res, results, deps)
        return true
      }
      case 'bulk-create': {
        const body = await readJsonBody(req)
        const items = extractBulkArray<BulkCreateItem>(body, 'items')
        const results: AdminApiResultItem[] = []
        for (const wrapper of items) {
          const patch = (wrapper?.model ?? wrapper) as CreateEndpointModelPatch | null
          if (!patch || typeof patch.id !== 'string' || !patch.id) {
            results.push({ id: String(patch?.id ?? '?'), ok: false, error: { code: 'invalid_request', message: 'model.id is required' } })
            continue
          }
          try {
            await deps.mutator.createEndpointModel(patch)
            results.push({ id: patch.id, ok: true })
          } catch (error) {
            results.push({
              id: patch.id,
              ok: false,
              error: errorToItemError(error),
            })
          }
        }
        await sendBatchResult(res, results, deps)
        return true
      }
      default:
        sendAdminError(res, 404, 'not_found', 'Admin API route not found')
        return true
    }
  } catch (error) {
    if (error instanceof AdminApiError) {
      sendAdminError(res, error.status, error.code, error.message, error.details)
      return true
    }
    const message = error instanceof Error ? error.message : String(error)
    sendAdminError(res, 500, 'internal_error', message)
    return true
  }
}

export function createAdminAuthManager(config: OwlCodaConfig): AdminAuthManager {
  return new AdminAuthManager(getAdminBearerToken(config))
}

function matchRoute(method: string, url: string): RouteMatch | null {
  if (method === 'GET' && url === '/admin/api/snapshot') return { action: 'snapshot' }
  if (method === 'GET' && url === '/admin/api/config') return { action: 'config' }
  if (method === 'GET' && url === '/admin/api/catalog') return { action: 'catalog' }
  if (method === 'GET' && url === '/admin/api/providers') return { action: 'providers' }
  if (method === 'PATCH' && url === '/admin/api/config/runtime') return { action: 'patch-runtime' }
  if (method === 'POST' && url === '/admin/api/models') return { action: 'create-model' }
  if (method === 'POST' && url === '/admin/api/default') return { action: 'set-default' }
  if (method === 'POST' && url === '/admin/api/test-connection') return { action: 'test-connection' }
  if ((method === 'POST' || method === 'GET') && url === '/admin/api/auth/exchange') return { action: 'auth-exchange' }
  if (method === 'POST' && url === '/admin/api/bulk/patch') return { action: 'bulk-patch' }
  if (method === 'POST' && url === '/admin/api/bulk/bind-discovered') return { action: 'bulk-bind-discovered' }
  if (method === 'POST' && url === '/admin/api/bulk/create') return { action: 'bulk-create' }

  const patchModel = url.match(/^\/admin\/api\/models\/([^/]+)$/)
  if (patchModel && method === 'PATCH') return { action: 'patch-model', modelId: decodeURIComponent(patchModel[1]!) }
  if (patchModel && method === 'DELETE') return { action: 'delete-model', modelId: decodeURIComponent(patchModel[1]!) }

  const keyRoute = url.match(/^\/admin\/api\/models\/([^/]+)\/key$/)
  if (keyRoute && method === 'POST') return { action: 'set-key', modelId: decodeURIComponent(keyRoute[1]!) }

  const bindRoute = url.match(/^\/admin\/api\/models\/([^/]+)\/bind-discovered$/)
  if (bindRoute && method === 'POST') return { action: 'bind-discovered', modelId: decodeURIComponent(bindRoute[1]!) }

  const testRoute = url.match(/^\/admin\/api\/models\/([^/]+)\/test$/)
  if (testRoute && method === 'POST') return { action: 'test-model', modelId: decodeURIComponent(testRoute[1]!) }

  return null
}

function isWriteMethod(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT'
}

function sanitizeSnapshot(snapshot: ModelTruthSnapshot): ModelTruthSnapshot {
  const sanitizeStatus = <T extends typeof snapshot.statuses[number]>(status: T): T => ({
    ...status,
    raw: status.raw.config
      ? {
          ...status.raw,
          config: sanitizeModel(status.raw.config),
        }
      : status.raw,
  })
  return {
    ...snapshot,
    statuses: snapshot.statuses.map(sanitizeStatus),
    byModelId: Object.fromEntries(
      Object.entries(snapshot.byModelId).map(([key, value]) => [key, sanitizeStatus(value)]),
    ),
  }
}

function sanitizeConfig(config: OwlCodaConfig): Omit<OwlCodaConfig, 'models'> & { models: Array<Record<string, unknown>> } {
  return {
    ...config,
    models: config.models.map(model => sanitizeModel(model)),
  }
}

function sanitizeModel(model: ConfiguredModel): Record<string, unknown> {
  return {
    ...model,
    apiKey: { set: Boolean(model.apiKey && model.apiKey.length > 0) },
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new AdminApiError(400, 'invalid_json', 'Request body must be valid JSON')
  }
}

function unwrapModelPayload<T>(body: Record<string, unknown>): T {
  const candidate = body.model
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as T
  }
  return body as T
}

function unwrapPatchPayload<T>(body: Record<string, unknown>): T {
  const candidate = body.patch
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as T
  }
  return body as T
}

function unwrapProbePayload(body: Record<string, unknown>): DryRunProviderPayload {
  const candidate = body.model
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as DryRunProviderPayload
  }
  return body as DryRunProviderPayload
}

function sendMutationResult(
  res: ServerResponse,
  statusCode: number,
  item: AdminApiResultItem,
  deps: AdminApiDeps,
): void {
  deps.getSnapshot({ skipCache: true }).then(snapshot => {
    sendAdminJson(res, statusCode, {
      schemaVersion: ADMIN_API_SCHEMA_VERSION,
      ok: item.ok,
      results: [item],
      snapshot: sanitizeSnapshot(snapshot),
    })
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    sendAdminError(res, 500, 'internal_error', message)
  })
}

async function sendBatchResult(
  res: ServerResponse,
  results: AdminApiResultItem[],
  deps: AdminApiDeps,
): Promise<void> {
  const snapshot = await deps.getSnapshot({ skipCache: true })
  const allOk = results.every(r => r.ok)
  const anyOk = results.some(r => r.ok)
  // 200 = fully ok, 207 = partial, 422 = all items failed (still a valid
  // response shape — client uses per-item result, not status code, but giving
  // a distinguishable code helps ops/logs.)
  const statusCode = allOk ? 200 : anyOk ? 207 : 422
  sendAdminJson(res, statusCode, {
    schemaVersion: ADMIN_API_SCHEMA_VERSION,
    ok: allOk,
    results,
    snapshot: sanitizeSnapshot(snapshot),
  })
}

function extractBulkArray<T>(body: Record<string, unknown>, key: string): T[] {
  const raw = body[key]
  if (!Array.isArray(raw)) {
    throw new AdminApiError(400, 'invalid_request', `Expected "${key}" to be an array`)
  }
  return raw as T[]
}

function errorToItemError(error: unknown): { code: string; message: string } {
  if (error instanceof AdminApiError) {
    return { code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'mutation_failed', message }
}

function sendAdminJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendAdminError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  sendAdminJson(res, statusCode, {
    schemaVersion: ADMIN_API_SCHEMA_VERSION,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  })
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
    || remote === undefined
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(';') : header ?? ''
  const cookies: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (!name) continue
    cookies[name] = decodeURIComponent(rest.join('=') || '')
  }
  return cookies
}

function randomToken(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

class AdminApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}
