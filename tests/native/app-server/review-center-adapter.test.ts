import { describe, expect, it } from 'vitest'
import {
  createReviewCenterAdapter,
  createReviewCenterAdapterFromPreload,
} from '../../../src/native/app-server/review-center-adapter.js'
import { AppServerClientError, type AppServerClient } from '../../../src/native/app-server/client.js'
import type {
  ReviewBatchActionResult,
  ReviewBatchPreflightResult,
  ReviewChange,
  ReviewPreflightResult,
} from '../../../src/native/app-server/review-action-service.js'

describe('renderer review center adapter', () => {
  it('loads a renderer-ready review center model through App Server batch preflight', async () => {
    const first = reviewChange({ id: 'edit:one', path: '/repo/src/one.ts', operation: 'update' })
    const second = reviewChange({ id: 'write:two', path: '/repo/src/two.ts', toolName: 'write', operation: 'overwrite', mode: 'full-file' })
    const third = reviewChange({ id: 'bash:three:0', path: '/repo/tmp.txt', toolName: 'bash', operation: 'rm', mode: 'provenance-only' })
    const calls: string[] = []
    const client = fakeClient({
      reviewList: async (params) => {
        calls.push(`list:${params.threadId}`)
        return { threadId: params.threadId, changes: [first, second, third] }
      },
      reviewBatchPreflight: async (params) => {
        calls.push(`batchPreflight:${params.diffIds.join(',')}`)
        return {
          status: 'blocked',
          threadId: params.threadId,
          diffIds: params.diffIds,
          preflights: [
            preflight(first, 'ready', 'source_match'),
            preflight(second, 'already_applied', 'already_applied'),
            preflight(third, 'blocked', 'provenance_incomplete'),
          ],
          blocked: [preflight(third, 'blocked', 'provenance_incomplete')],
        }
      },
    })

    const adapter = createReviewCenterAdapter(client)
    const state = await adapter.load({ threadId: 'thread-1' })

    expect(calls).toEqual([
      'list:thread-1',
      'batchPreflight:edit:one,write:two,bash:three:0',
    ])
    expect(state).toMatchObject({
      threadId: 'thread-1',
      status: 'blocked',
      diffIds: ['edit:one', 'write:two', 'bash:three:0'],
      blockedCount: 1,
      readyCount: 1,
      appliedCount: 1,
    })
    expect(state.items).toEqual([
      expect.objectContaining({
        id: 'edit:one',
        title: 'one.ts',
        status: 'ready',
        canApply: true,
        canRevert: false,
      }),
      expect.objectContaining({
        id: 'write:two',
        title: 'two.ts',
        status: 'already_applied',
        canApply: false,
        canRevert: true,
      }),
      expect.objectContaining({
        id: 'bash:three:0',
        title: 'tmp.txt',
        status: 'blocked',
        reason: 'provenance_incomplete',
        canApply: false,
        canRevert: false,
      }),
    ])
  })

  it('uses batch apply and returns blocked preflight details without throwing renderer errors', async () => {
    const change = reviewChange({ id: 'bash:blocked:0', toolName: 'bash', operation: 'rm', mode: 'provenance-only' })
    const blockedPreflight: ReviewBatchPreflightResult = {
      status: 'blocked',
      threadId: 'thread-1',
      diffIds: [change.id],
      preflights: [preflight(change, 'blocked', 'provenance_incomplete')],
      blocked: [preflight(change, 'blocked', 'provenance_incomplete')],
    }
    const client = fakeClient({
      reviewBatchApply: async () => {
        throw new AppServerClientError({
          code: -32010,
          message: 'Review batch apply blocked by preflight',
          data: {
            reason: 'batch_preflight_blocked',
            preflight: blockedPreflight,
          },
        })
      },
    })

    const adapter = createReviewCenterAdapter(client)
    const result = await adapter.applySelected({ threadId: 'thread-1', diffIds: [change.id] })

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'batch_preflight_blocked',
      message: 'Review batch apply blocked by preflight',
      diffIds: [change.id],
      preflight: blockedPreflight,
    })
  })

  it('creates a renderer adapter from the Electron preload App Server URL', async () => {
    const methods: string[] = []
    const adapter = await createReviewCenterAdapterFromPreload({
      getUrl: async () => 'http://app-server.test',
    }, {
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        const result = request.method === 'review/list'
          ? { threadId: request.params.threadId, changes: [] }
          : { status: 'ready', threadId: request.params.threadId, diffIds: [], preflights: [], blocked: [] }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const state = await adapter.load({ threadId: 'thread-1' })

    expect(state.status).toBe('empty')
    expect(methods).toEqual(['review/list'])
  })
})

function fakeClient(overrides: Partial<AppServerClient>): AppServerClient {
  return {
    call: async () => ({}) as never,
    reviewList: async (params) => ({ threadId: params.threadId, changes: [] }),
    reviewPreflight: async () => { throw new Error('not implemented') },
    reviewApply: async () => { throw new Error('not implemented') },
    reviewRevert: async () => { throw new Error('not implemented') },
    reviewStatusList: async (params) => ({ threadId: params.threadId, statuses: [] }),
    reviewStatusUpdate: async (params) => ({
      threadId: params.threadId,
      diffId: params.diffId,
      status: {
        threadId: params.threadId,
        diffId: params.diffId,
        status: params.status === 'accepted' ? 'accepted' : 'pending',
        updatedAt: 1,
        updatedBy: params.updatedBy ?? 'app-server',
        source: 'stored',
      },
    }),
    reviewBatchPreflight: async (params) => ({
      status: 'ready',
      threadId: params.threadId,
      diffIds: params.diffIds,
      preflights: [],
      blocked: [],
    }),
    reviewBatchApply: async (params) => batchAction('applied', params.threadId, params.diffIds),
    reviewBatchRevert: async (params) => batchAction('reverted', params.threadId, params.diffIds),
    runtimeTranscriptRead: async (params) => ({
      threadId: params.threadId,
      status: 'ready',
      model: 'test-model',
      createdAt: 1,
      updatedAt: 1,
      itemCount: 0,
      runtimeEventCount: 0,
      items: [],
    }),
    ...overrides,
  }
}

function reviewChange(overrides: Partial<ReviewChange>): ReviewChange {
  return {
    id: overrides.id ?? 'edit:one',
    threadId: 'thread-1',
    toolUseId: 'tool-1',
    toolName: overrides.toolName ?? 'edit',
    path: overrides.path ?? '/repo/file.ts',
    operation: overrides.operation ?? 'update',
    mode: overrides.mode ?? 'string-replace',
    oldText: 'old',
    newText: 'new',
    replaceAll: false,
    diffPreview: '--- old\n+++ new',
    ...overrides,
  }
}

function preflight(
  change: ReviewChange,
  status: ReviewPreflightResult['status'],
  reason: ReviewPreflightResult['reason'],
): ReviewPreflightResult {
  return {
    status,
    reason,
    message: `${status} ${change.id}`,
    change,
  }
}

function batchAction(
  status: ReviewBatchActionResult['status'],
  threadId: string,
  diffIds: string[],
): ReviewBatchActionResult {
  const action = status === 'reverted' ? 'revert' : 'apply'
  const transactionId = `review-batch:${threadId}:${action}:${diffIds.join(',')}`
  return {
    status,
    reason: 'source_match',
    message: `${status} ${diffIds.length} review changes`,
    threadId,
    diffIds,
    preflight: { status: 'ready', threadId, diffIds, preflights: [], blocked: [] },
    results: [],
    transaction: {
      transactionId,
      action,
      applied: [],
      rolledBack: [],
      failed: [],
      rollbackFailed: [],
    },
    proof: {
      proofId: `review-batch-proof:${transactionId}`,
      kind: 'review_batch_transaction',
      source: 'app-server-review-center',
      status: status === 'failed' ? 'rolled_back' : status,
      action,
      threadId,
      diffIds,
      transactionId,
      applied: [],
      rolledBack: [],
      failed: [],
      rollbackFailed: [],
    },
  }
}
