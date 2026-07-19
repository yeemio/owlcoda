import { describe, expect, it } from 'vitest'
import { describeAppServerProtocol } from '../../../src/native/app-server/protocol-contract.js'
import { runDesktopProductShellSmoke } from '../../../src/native/app-server/desktop-product-shell-smoke.js'

describe('desktop product shell smoke', () => {
  it('runs a product-shell smoke flow without binding the /desktop debug harness', async () => {
    const calls: string[] = []
    const result = await runDesktopProductShellSmoke({
      baseUrl: 'http://app-server.test/',
      projectId: 'project-1',
      threadId: 'thread-1',
      taskInput: 'smoke task',
      reviewAction: 'apply',
      reviewDiffIds: ['diff-1'],
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        calls.push(request.method)
        if (request.method === 'diagnostic/health') {
          throw new Error('product shell smoke must not call diagnostic/health')
        }
        return jsonRpcResponse(request.id, responseForMethod(request.method, request.params))
      },
    })

    expect(calls).toEqual([
      'protocol/describe',
      'project/list',
      'thread/list',
      'runtimeRail/read',
      'benchmark/providerEvalReport/read',
      'runtimeTranscript/read',
      'approval/list',
      'interaction/list',
      'review/list',
      'review/batchPreflight',
      'event/subscribe',
      'turn/start',
      'review/batchApply',
      'turn/status',
    ])
    expect(result).toMatchObject({
      surface: 'desktop-product-shell-smoke',
      ready: true,
      boundary: 'external-product-shell',
      projectId: 'project-1',
      threadId: 'thread-1',
      checks: {
        bootstrap: true,
        viewModel: true,
        liveEvents: true,
        submitTask: true,
        reviewTransaction: true,
        statusRecovery: true,
        readOnlyRunKitRail: true,
        debugBoundary: true,
      },
      debugBoundary: {
        productShellImport: 'owlcoda/desktop',
        productShellUsesDebugOnlyMethods: false,
        debugRendererPath: '/desktop',
        debugRendererBoundary: 'operator-debug-harness',
        debugRendererMayUseDebugOnlyMethods: true,
        forbiddenProductMethods: ['diagnostic/health'],
      },
      eventSubscription: {
        endpoint: '/events',
        events: expect.arrayContaining(['review.batchCompleted', 'turn.started']),
      },
      submittedTurn: {
        status: 'accepted',
      },
      reviewBatch: {
        status: 'applied',
        transaction: {
          transactionId: 'review-batch:thread-1:apply:diff-1',
          applied: ['diff-1'],
        },
        proof: {
          kind: 'review_batch_transaction',
          transactionId: 'review-batch:thread-1:apply:diff-1',
        },
      },
      turnStatus: {
        status: 'completed',
      },
    })
    expect(result.errors).toEqual([])
  })
})

function jsonRpcResponse(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseForMethod(method: string, params: any): unknown {
  if (method === 'protocol/describe') return describeAppServerProtocol()
  if (method === 'project/list') {
    return {
      projects: [{ id: 'project-1', name: 'OwlCoda', root: '/repo/owlcoda', source: 'cwd' }],
    }
  }
  if (method === 'thread/list') {
    expect(params).toMatchObject({ projectId: 'project-1' })
    return {
      threads: [{
        id: 'thread-1',
        projectId: 'project-1',
        title: 'Smoke Thread',
        model: 'smoke-model',
        status: 'ready',
        createdAt: 1,
        updatedAt: 2,
        cwd: '/repo/owlcoda',
        sessionPath: '/sessions/thread-1.json',
        turnCount: 1,
      }],
      totalCount: 1,
      offset: 0,
      limit: 100,
      hasMore: false,
    }
  }
  if (method === 'runtimeRail/read') {
    return {
      projectId: 'project-1',
      freshness: 'missing',
      summary: null,
      source: 'not_connected',
    }
  }
  if (method === 'benchmark/providerEvalReport/read') return { unavailable: true, message: 'not configured' }
  if (method === 'runtimeTranscript/read') {
    return {
      threadId: 'thread-1',
      projectId: 'project-1',
      title: 'Smoke Thread',
      model: 'smoke-model',
      status: 'ready',
      createdAt: 1,
      updatedAt: 2,
      itemCount: 1,
      runtimeEventCount: 0,
      items: [{ id: 'message-1', kind: 'message', role: 'assistant', text: 'ready', timestamp: 1, turnIndex: 0, contentIndex: 0 }],
    }
  }
  if (method === 'approval/list') return { approvals: [] }
  if (method === 'interaction/list') return { interactions: [] }
  if (method === 'review/list') {
    return {
      threadId: 'thread-1',
      changes: [{
        id: 'diff-1',
        threadId: 'thread-1',
        toolUseId: 'tool-1',
        toolName: 'edit',
        path: '/repo/owlcoda/src/app.ts',
        operation: 'update',
        mode: 'string-replace',
        oldText: 'old',
        newText: 'new',
        replaceAll: false,
        diffPreview: '-old\n+new',
      }],
    }
  }
  if (method === 'review/batchPreflight') {
    return {
      status: 'ready',
      threadId: 'thread-1',
      diffIds: ['diff-1'],
      preflights: [{
        status: 'ready',
        reason: 'source_match',
        message: 'ready',
        change: { id: 'diff-1' },
      }],
      blocked: [],
    }
  }
  if (method === 'event/subscribe') {
    return {
      transport: 'sse',
      endpoint: '/events',
      events: ['turn.started', 'review.batchCompleted', 'runtimeRail.updated'],
    }
  }
  if (method === 'turn/start') {
    expect(params).toMatchObject({ threadId: 'thread-1', input: 'smoke task', projectId: 'project-1' })
    return {
      projectId: 'project-1',
      threadId: 'thread-1',
      status: 'accepted',
      turn: { index: 1, role: 'user' },
      thread: { id: 'thread-1', projectId: 'project-1', title: 'Smoke Thread', model: 'smoke-model', status: 'ready', createdAt: 1, updatedAt: 3, cwd: '/repo/owlcoda', sessionPath: '/sessions/thread-1.json', turnCount: 2 },
    }
  }
  if (method === 'review/batchApply') {
    expect(params).toMatchObject({ threadId: 'thread-1', projectId: 'project-1', diffIds: ['diff-1'] })
    return {
      status: 'applied',
      reason: 'source_match',
      message: 'Applied 1 review changes',
      threadId: 'thread-1',
      diffIds: ['diff-1'],
      preflight: { status: 'ready', threadId: 'thread-1', diffIds: ['diff-1'], preflights: [], blocked: [] },
      results: [],
      transaction: {
        transactionId: 'review-batch:thread-1:apply:diff-1',
        action: 'apply',
        applied: ['diff-1'],
        rolledBack: [],
        failed: [],
        rollbackFailed: [],
      },
      proof: {
        proofId: 'review-batch-proof:review-batch:thread-1:apply:diff-1',
        kind: 'review_batch_transaction',
        source: 'app-server-review-center',
        status: 'applied',
        action: 'apply',
        threadId: 'thread-1',
        diffIds: ['diff-1'],
        transactionId: 'review-batch:thread-1:apply:diff-1',
        applied: ['diff-1'],
        rolledBack: [],
        failed: [],
        rollbackFailed: [],
      },
    }
  }
  if (method === 'turn/status') {
    return {
      threadId: 'thread-1',
      projectId: 'project-1',
      status: 'completed',
      reason: 'turn_completed',
      runtimeActive: false,
      turnCount: 2,
      itemCount: 1,
      runtimeEventCount: 1,
      pendingInteractionCount: 0,
      resumeHint: { action: 'none', message: 'No recovery needed.' },
    }
  }
  throw new Error(`unexpected method ${method}`)
}
