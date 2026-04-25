/**
 * Minimal fetch wrapper for the admin API.
 * - Same-origin by default (served under /admin/)
 * - credentials: 'include' so session cookie is sent
 * - Validates schemaVersion
 * - Never writes. This module only exports read helpers for Phase β.
 */

import { getCsrfToken } from '../auth/session'
import {
  ADMIN_API_SCHEMA_VERSION,
  type ApiKeyPayload,
  type BatchResponse,
  type BulkBindItem,
  type BulkCreateItem,
  type BulkPatchItem,
  type CatalogResponse,
  type ConfigResponse,
  type CreateEndpointModelPatch,
  type DryRunProbePayload,
  type MutationResponse,
  type ProbeResponse,
  type ProvidersResponse,
  type SnapshotResponse,
  type UpdateModelFieldsPatch,
  type UpdateRuntimeSettingsPatch,
} from './types'

const BASE = '/admin/api'

export class SchemaVersionMismatchError extends Error {
  readonly received: number
  constructor(received: number) {
    super(`Admin API schemaVersion mismatch: client expects ${ADMIN_API_SCHEMA_VERSION}, server returned ${received}`)
    this.received = received
    this.name = 'SchemaVersionMismatchError'
  }
}

export class AdminApiRequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'AdminApiRequestError'
  }
}

async function getJson<T extends { schemaVersion: number }>(path: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  const bodyText = await res.text()
  let body: unknown = null
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    throw new AdminApiRequestError(res.status, 'invalid_json', 'Response body was not JSON')
  }

  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } } | null
    throw new AdminApiRequestError(
      res.status,
      err?.error?.code ?? 'http_error',
      err?.error?.message ?? `HTTP ${res.status}`,
    )
  }

  assertSchemaVersion(body)
  return body as T
}

export function assertSchemaVersion(body: unknown): asserts body is { schemaVersion: number } {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof version !== 'number') {
    throw new AdminApiRequestError(0, 'schema_missing', 'Response missing schemaVersion')
  }
  if (version !== ADMIN_API_SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError(version)
  }
}

export function fetchSnapshot(): Promise<SnapshotResponse> {
  return getJson<SnapshotResponse>('/snapshot')
}

export function fetchConfig(): Promise<ConfigResponse> {
  return getJson<ConfigResponse>('/config')
}

export function fetchProviders(): Promise<ProvidersResponse> {
  return getJson<ProvidersResponse>('/providers')
}

export function fetchCatalog(): Promise<CatalogResponse> {
  return getJson<CatalogResponse>('/catalog')
}

// ─── Write helpers ───────────────────────────────────────────────────

async function requestJson<T extends { schemaVersion: number }>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const csrf = getCsrfToken()
  if (csrf) headers['x-owlcoda-token'] = csrf

  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    throw new AdminApiRequestError(res.status, 'invalid_json', 'Response body was not JSON')
  }

  if (!res.ok) {
    const err = parsed as { error?: { code?: string; message?: string } } | null
    throw new AdminApiRequestError(
      res.status,
      err?.error?.code ?? 'http_error',
      err?.error?.message ?? `HTTP ${res.status}`,
    )
  }

  assertSchemaVersion(parsed)
  return parsed as T
}

export function setDefaultModel(modelId: string): Promise<MutationResponse> {
  return requestJson<MutationResponse>('POST', '/default', { modelId })
}

export function updateModelFields(modelId: string, patch: UpdateModelFieldsPatch): Promise<MutationResponse> {
  return requestJson<MutationResponse>('PATCH', `/models/${encodeURIComponent(modelId)}`, { patch })
}

export function updateRuntimeSettings(patch: UpdateRuntimeSettingsPatch): Promise<MutationResponse> {
  return requestJson<MutationResponse>('PATCH', '/config/runtime', { patch })
}

export function createEndpointModel(patch: CreateEndpointModelPatch): Promise<MutationResponse> {
  return requestJson<MutationResponse>('POST', '/models', { model: patch })
}

export function deleteModel(modelId: string): Promise<MutationResponse> {
  return requestJson<MutationResponse>('DELETE', `/models/${encodeURIComponent(modelId)}`, undefined)
}

export function setModelKey(modelId: string, payload: ApiKeyPayload): Promise<MutationResponse> {
  return requestJson<MutationResponse>('POST', `/models/${encodeURIComponent(modelId)}/key`, payload)
}

export function testSavedModel(modelId: string): Promise<ProbeResponse> {
  return requestJson<ProbeResponse>('POST', `/models/${encodeURIComponent(modelId)}/test`, {})
}

export function testConnectionDryRun(payload: DryRunProbePayload): Promise<ProbeResponse> {
  return requestJson<ProbeResponse>('POST', '/test-connection', { model: payload })
}

// ─── Bulk (Phase δ) ──────────────────────────────────────────────────
//
// The server returns 200 on all-success, 207 on partial, 422 when every item
// fails. `requestJson` throws AdminApiRequestError on 4xx/5xx, but we want
// to surface per-item results for 207/422 — so we use a bulk-aware wrapper.

async function requestBulk(path: string, body: unknown): Promise<BatchResponse> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  const csrf = getCsrfToken()
  if (csrf) headers['x-owlcoda-token'] = csrf

  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    throw new AdminApiRequestError(res.status, 'invalid_json', 'Response body was not JSON')
  }

  // 200 / 207 / 422 are all "data responses" carrying per-item results.
  // Other statuses are real errors (bad request, auth, etc).
  if (res.status !== 200 && res.status !== 207 && res.status !== 422) {
    const err = parsed as { error?: { code?: string; message?: string } } | null
    throw new AdminApiRequestError(
      res.status,
      err?.error?.code ?? 'http_error',
      err?.error?.message ?? `HTTP ${res.status}`,
    )
  }

  assertSchemaVersion(parsed)
  return parsed as BatchResponse
}

export function bulkPatchModels(items: BulkPatchItem[]): Promise<BatchResponse> {
  return requestBulk('/bulk/patch', { items })
}

export function bulkBindDiscovered(items: BulkBindItem[]): Promise<BatchResponse> {
  return requestBulk('/bulk/bind-discovered', { items })
}

export function bulkCreateModels(items: BulkCreateItem[]): Promise<BatchResponse> {
  return requestBulk('/bulk/create', { items })
}
