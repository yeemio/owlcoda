import {
  AppServerClientError,
  createAppServerClient,
  type AppServerClient,
  type AppServerClientOptions,
} from './client.js'
import type { OwlCodaAppServerPreloadAPI } from './electron-preload.js'
import type {
  ReviewActionResult,
  ReviewBatchActionResult,
  ReviewBatchPreflightResult,
  ReviewChange,
  ReviewPreflightReason,
  ReviewPreflightResult,
  ReviewPreflightStatus,
} from './review-action-service.js'
import type { ReviewStatusRecord } from './review-status-service.js'

export interface ReviewCenterLoadParams {
  threadId: string
  projectId?: string
}

export interface ReviewCenterMutationParams extends ReviewCenterLoadParams {
  diffIds: string[]
}

export interface ReviewCenterState {
  threadId: string
  status: 'empty' | 'ready' | 'blocked'
  diffIds: string[]
  items: ReviewCenterItem[]
  readyCount: number
  appliedCount: number
  blockedCount: number
  preflight?: ReviewBatchPreflightResult
}

export interface ReviewCenterItem {
  id: string
  title: string
  path: string
  toolName: ReviewChange['toolName']
  operation: ReviewChange['operation']
  mode: ReviewChange['mode']
  status: ReviewPreflightStatus
  reason: ReviewPreflightReason
  message: string
  canApply: boolean
  canRevert: boolean
  diffPreview: string
  reviewStatus?: ReviewStatusRecord
}

export interface ReviewCenterMutationResult {
  status: ReviewBatchActionResult['status'] | 'empty'
  reason?: ReviewBatchActionResult['reason'] | 'empty_selection'
  message: string
  threadId: string
  diffIds: string[]
  preflight?: ReviewBatchPreflightResult
  results: ReviewActionResult[]
  transaction?: ReviewBatchActionResult['transaction']
  proof?: ReviewBatchActionResult['proof']
}

export interface ReviewCenterAdapter {
  load(params: ReviewCenterLoadParams): Promise<ReviewCenterState>
  applySelected(params: ReviewCenterMutationParams): Promise<ReviewCenterMutationResult>
  revertSelected(params: ReviewCenterMutationParams): Promise<ReviewCenterMutationResult>
}

export function createReviewCenterAdapter(client: AppServerClient): ReviewCenterAdapter {
  return {
    async load(params) {
      const listed = await client.reviewList(params)
      const diffIds = listed.changes.map(change => change.id)
      if (diffIds.length === 0) {
        return emptyReviewCenterState(listed.threadId)
      }
      const preflight = await client.reviewBatchPreflight({ ...params, diffIds })
      return buildReviewCenterState(listed.threadId, listed.changes, preflight)
    },
    applySelected: params => mutateReviewSelection(client, 'apply', params),
    revertSelected: params => mutateReviewSelection(client, 'revert', params),
  }
}

export async function createReviewCenterAdapterFromPreload(
  preload: OwlCodaAppServerPreloadAPI,
  options: Pick<AppServerClientOptions, 'fetch'> = {},
): Promise<ReviewCenterAdapter> {
  const baseUrl = await preload.getUrl()
  return createReviewCenterAdapter(createAppServerClient({ baseUrl, fetch: options.fetch }))
}

export function buildReviewCenterState(
  threadId: string,
  changes: ReviewChange[],
  preflight: ReviewBatchPreflightResult,
): ReviewCenterState {
  const preflightsById = new Map(preflight.preflights.map(item => [item.change.id, item]))
  const items = changes.map(change => toReviewCenterItem(change, preflightsById.get(change.id)))
  return {
    threadId,
    status: items.length === 0 ? 'empty' : preflight.status,
    diffIds: changes.map(change => change.id),
    items,
    readyCount: items.filter(item => item.status === 'ready').length,
    appliedCount: items.filter(item => item.status === 'already_applied').length,
    blockedCount: items.filter(item => item.status === 'blocked').length,
    preflight,
  }
}

async function mutateReviewSelection(
  client: AppServerClient,
  action: 'apply' | 'revert',
  params: ReviewCenterMutationParams,
): Promise<ReviewCenterMutationResult> {
  if (params.diffIds.length === 0) {
    return {
      status: 'empty',
      reason: 'empty_selection',
      message: 'No review changes selected',
      threadId: params.threadId,
      diffIds: [],
      results: [],
    }
  }
  try {
    const result = action === 'apply'
      ? await client.reviewBatchApply(params)
      : await client.reviewBatchRevert(params)
    return {
      status: result.status,
      reason: result.reason,
      message: result.message,
      threadId: result.threadId,
      diffIds: result.diffIds,
      preflight: result.preflight,
      results: result.results,
      transaction: result.transaction,
      proof: result.proof,
    }
  } catch (error) {
    const blocked = blockedMutationResultFromError(error, params)
    if (blocked) return blocked
    throw error
  }
}

function toReviewCenterItem(
  change: ReviewChange,
  preflight: ReviewPreflightResult | undefined,
): ReviewCenterItem {
  const status = preflight?.status ?? 'blocked'
  const reason = preflight?.reason ?? 'unsupported_source'
  return {
    id: change.id,
    title: basenamePath(change.path) || change.path,
    path: change.path,
    toolName: change.toolName,
    operation: change.operation,
    mode: change.mode,
    status,
    reason,
    message: preflight?.message ?? `Review change ${change.id} has no preflight result`,
    canApply: status === 'ready' || status === 'already_reverted',
    canRevert: status === 'already_applied',
    diffPreview: change.diffPreview,
    reviewStatus: change.reviewStatus,
  }
}

function basenamePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) ?? ''
}

function emptyReviewCenterState(threadId: string): ReviewCenterState {
  return {
    threadId,
    status: 'empty',
    diffIds: [],
    items: [],
    readyCount: 0,
    appliedCount: 0,
    blockedCount: 0,
  }
}

function blockedMutationResultFromError(
  error: unknown,
  params: ReviewCenterMutationParams,
): ReviewCenterMutationResult | null {
  if (!(error instanceof AppServerClientError) || error.code !== -32010) return null
  const data = isRecord(error.data) ? error.data : {}
  const reason = data['reason']
  const preflight = isReviewBatchPreflightResult(data['preflight'])
    ? data['preflight']
    : undefined
  if ((reason !== 'batch_preflight_blocked' && reason !== 'batch_transaction_failed') || !preflight) return null
  const transaction = isRecord(data['transaction']) ? data['transaction'] as unknown as ReviewBatchActionResult['transaction'] : undefined
  const proof = isRecord(data['proof']) ? data['proof'] as unknown as ReviewBatchActionResult['proof'] : undefined
  return {
    status: reason === 'batch_transaction_failed' ? 'failed' : 'blocked',
    reason,
    message: error.message,
    threadId: preflight.threadId ?? params.threadId,
    diffIds: preflight.diffIds ?? params.diffIds,
    preflight,
    results: Array.isArray(data['results']) ? data['results'] as ReviewActionResult[] : [],
    transaction,
    proof,
  }
}

function isReviewBatchPreflightResult(value: unknown): value is ReviewBatchPreflightResult {
  return isRecord(value)
    && (value['status'] === 'ready' || value['status'] === 'blocked')
    && typeof value['threadId'] === 'string'
    && Array.isArray(value['diffIds'])
    && Array.isArray(value['preflights'])
    && Array.isArray(value['blocked'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
