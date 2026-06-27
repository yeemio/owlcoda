import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'
import { createAppServerClient, AppServerClientError } from '../../../src/native/app-server/client.js'
import { createConversation } from '../../../src/native/conversation.js'
import { deleteSession, loadSession, saveSession } from '../../../src/native/session.js'

const servers: Server[] = []
const createdSessions: string[] = []
const temporaryProjectRoots: string[] = []
const originalOwlCodaHome = process.env['OWLCODA_HOME']
let isolatedOwlCodaHome: string | undefined

beforeAll(() => {
  isolatedOwlCodaHome = mkdtempSync(join(tmpdir(), 'owlcoda-app-server-client-home-'))
  process.env['OWLCODA_HOME'] = isolatedOwlCodaHome
})

afterEach(async () => {
  for (const id of createdSessions.splice(0)) deleteSession(id)
  for (const root of temporaryProjectRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

afterAll(() => {
  if (originalOwlCodaHome === undefined) {
    delete process.env['OWLCODA_HOME']
  } else {
    process.env['OWLCODA_HOME'] = originalOwlCodaHome
  }
  if (isolatedOwlCodaHome) rmSync(isolatedOwlCodaHome, { recursive: true, force: true })
})

describe('app-server client adapter', () => {
  it('calls diagnostic/health through typed JSON-RPC client', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const health = await client.call('diagnostic/health', {})

    expect(health.status).toBe('ok')
    expect(health.methods).toContain('project/list')
  })

  it('describes the App Server protocol through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({})
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            schemaVersion: 'v1',
            protocolVersion: 'v1',
            methods: [
              {
                method: 'thread/start',
                group: 'thread',
                stability: 'stable',
                requestType: 'ThreadStartInput',
                responseType: 'ThreadStartResult',
                requires: [],
                queryKeys: ['projectId'],
              },
              {
                method: 'diagnostic/health',
                group: 'diagnostic',
                stability: 'debug-only',
                requestType: 'Record<string, never>',
                responseType: 'RuntimeHealthSnapshot',
                requires: [],
                queryKeys: [],
              },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const protocol = await client.protocolDescribe()

    expect(methods).toEqual(['protocol/describe'])
    expect(protocol).toMatchObject({
      schemaVersion: 'v1',
      protocolVersion: 'v1',
      methods: [
        expect.objectContaining({ method: 'thread/start', stability: 'stable' }),
        expect.objectContaining({ method: 'diagnostic/health', stability: 'debug-only' }),
      ],
    })
  })

  it('reads runtime scorecards through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({ threadId: 'thread-scorecard-1', runId: 'run-scorecard-1', projectId: 'project-1' })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            schemaVersion: 1,
            threadId: 'thread-scorecard-1',
            projectId: 'project-1',
            runId: 'run-scorecard-1',
            scorecard: {
              scorecardVersion: 1,
              runId: 'run-scorecard-1',
              threadIds: ['thread-scorecard-1'],
              turnIds: ['turn-scorecard-1'],
              generatedAt: '2026-06-26T05:00:00.000Z',
              overallScore: 90,
              verdict: 'pass',
              dimensions: [],
              antiCheat: { verdict: 'pass', gates: [] },
              evidenceRefs: ['runtime_event-1'],
            },
            summary: 'Scorecard run=run-scorecard-1 score=90 verdict=pass anti_cheat=pass',
            trajectory: {
              recordCount: 1,
              localOnly: true,
              redactionMode: 'local_redacted_v0',
              records: [],
            },
            facts: {
              runtimeEventCount: 1,
              checkpointCount: 0,
              jobCount: 0,
              artifactCount: 0,
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const result = await client.runtimeScorecardRead({
      threadId: 'thread-scorecard-1',
      runId: 'run-scorecard-1',
      projectId: 'project-1',
    })

    expect(methods).toEqual(['runtimeScorecard/read'])
    expect(result).toMatchObject({
      runId: 'run-scorecard-1',
      scorecard: {
        verdict: 'pass',
      },
      trajectory: {
        localOnly: true,
        redactionMode: 'local_redacted_v0',
      },
    })
  })

  it('reads structured output artifact panels through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({
          threadId: 'thread-structured-output-1',
          runId: 'run-structured-output-1',
          projectId: 'project-1',
          artifactId: 'structured-output-1',
        })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            schemaVersion: 1,
            surface: 'structured-output-artifacts',
            threadId: 'thread-structured-output-1',
            projectId: 'project-1',
            runId: 'run-structured-output-1',
            artifactCount: 1,
            successCount: 0,
            failedCount: 1,
            warningCount: 0,
            items: [{
              artifactId: 'structured-output-1',
              attemptLedgerId: 'structured-output-1-attempts',
              status: 'failed',
              ok: false,
              parsed: true,
              schemaValid: true,
              fallbackUsed: true,
              validationErrors: ['forbidden_phrase: EV'],
              artifactPreview: { artifact: 'failed_fallback.v1', ok: false },
              attempts: [],
              rawText: '{"artifact":"failed_fallback.v1"}',
              rerunAction: {
                available: true,
                httpEndpoint: '/v1/structured-output/rerun',
                request: {
                  runRef: '/tmp/run',
                  previousArtifactId: 'structured-output-1',
                  role: 'judge',
                  model: 'model-1',
                  preset: 'canonical-judge.v1',
                  artifactRef: 'structured-output-1',
                },
              },
            }],
            warnings: [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const result = await client.structuredOutputArtifactsRead({
      threadId: 'thread-structured-output-1',
      runId: 'run-structured-output-1',
      projectId: 'project-1',
      artifactId: 'structured-output-1',
    })

    expect(methods).toEqual(['structuredOutputArtifacts/read'])
    expect(result).toMatchObject({
      surface: 'structured-output-artifacts',
      failedCount: 1,
      items: [{
        artifactId: 'structured-output-1',
        status: 'failed',
        fallbackUsed: true,
        rerunAction: {
          available: true,
          httpEndpoint: '/v1/structured-output/rerun',
        },
      }],
    })
  })

  it('reads provider eval batch reports through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({ recordPath: '/tmp/provider-eval.jsonl' })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            schemaVersion: 1,
            source: 'local_provider_eval_store',
            recordPath: '/tmp/provider-eval.jsonl',
            recordCount: 1,
            report: {
              schemaVersion: 1,
              generatedAt: '2026-06-26T09:00:00.000Z',
              recordCount: 1,
              providerModelCount: 1,
              caseCount: 1,
              passedCount: 1,
              failedCount: 0,
              localOnly: true,
              redactionMode: 'local_redacted_v0',
              trainingUse: 'not_collected',
              leaderboard: [{
                providerId: 'openai',
                modelId: 'gpt-strong',
                runCount: 1,
                passedCount: 1,
                failedCount: 0,
                passRate: 1,
                averageScore: 94,
                totalTokens: 150,
                totalCostUsd: 0.01,
                averageDurationMs: 1000,
                costPerPassedRunUsd: 0.01,
                verdict: 'pass',
              }],
              caseMatrix: [],
              summary: 'Benchmark provider eval batch report: 1/1 passed',
            },
            markdown: 'Benchmark Provider Eval Batch Report',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const result = await client.providerEvalReportRead({ recordPath: '/tmp/provider-eval.jsonl' })

    expect(methods).toEqual(['benchmark/providerEvalReport/read'])
    expect(result).toMatchObject({
      source: 'local_provider_eval_store',
      recordPath: '/tmp/provider-eval.jsonl',
      report: {
        localOnly: true,
        trainingUse: 'not_collected',
        leaderboard: [expect.objectContaining({ providerId: 'openai', modelId: 'gpt-strong' })],
      },
      markdown: expect.stringContaining('Benchmark Provider Eval Batch Report'),
    })
  })

  it('calls runtimeRail/read and preserves missing truth status', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const rail = await client.call('runtimeRail/read', { projectId: 'owlcoda' })

    expect(rail.projectId).toBe('owlcoda')
    expect(rail.freshness).toBe('missing')
    expect(rail.source).toBe('not_connected')
  })

  it('calls project/get aggregate through typed JSON-RPC client', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const aggregate = await client.call('project/get', {})

    expect(aggregate.project.id).toBeTruthy()
    expect(aggregate.rail.projectId).toBe(aggregate.project.id)
    expect(aggregate.rail.freshness).toBe('missing')
  })

  it('uses typed client helpers for product shell project, thread, and rail reads', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        if (request.method === 'project/list') {
          expect(request.params).toEqual({})
          return jsonRpcResult(request.id, {
            projects: [{ id: 'project-1', name: 'OwlCoda', root: '/repo/owlcoda', source: 'cwd' }],
          })
        }
        if (request.method === 'project/get') {
          expect(request.params).toEqual({ projectId: 'project-1' })
          return jsonRpcResult(request.id, {
            project: { id: 'project-1', name: 'OwlCoda', root: '/repo/owlcoda', source: 'cwd' },
            rail: { projectId: 'project-1', freshness: 'missing', packet: null, gate: null, claim: null, proofs: [], rejectedPaths: [], nextAction: null, source: 'not_connected' },
          })
        }
        if (request.method === 'thread/list') {
          expect(request.params).toEqual({ projectId: 'project-1', limit: 20 })
          return jsonRpcResult(request.id, {
            threads: [{ id: 'thread-1', projectId: 'project-1', title: 'Thread', model: 'model', status: 'ready', createdAt: 1, updatedAt: 2, cwd: '/repo/owlcoda', sessionPath: '/sessions/thread-1.json', turnCount: 1 }],
            totalCount: 1,
            offset: 0,
            limit: 20,
            hasMore: false,
          })
        }
        if (request.method === 'runtimeRail/read') {
          expect(request.params).toEqual({ projectId: 'project-1' })
          return jsonRpcResult(request.id, {
            projectId: 'project-1',
            freshness: 'missing',
            packet: null,
            gate: null,
            claim: null,
            proofs: [],
            rejectedPaths: [],
            nextAction: null,
            source: 'not_connected',
          })
        }
        throw new Error(`unexpected method ${request.method}`)
      },
    })

    const projects = await client.projectList()
    const aggregate = await client.projectGet({ projectId: 'project-1' })
    const threads = await client.threadList({ projectId: 'project-1', limit: 20 })
    const rail = await client.runtimeRailRead({ projectId: 'project-1' })

    expect(methods).toEqual(['project/list', 'project/get', 'thread/list', 'runtimeRail/read'])
    expect(projects.projects[0].id).toBe('project-1')
    expect(aggregate.project.id).toBe('project-1')
    expect(threads.threads[0].id).toBe('thread-1')
    expect(rail.projectId).toBe('project-1')
  })

  it('discovers event stream endpoint through event/subscribe', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const subscription = await client.eventSubscribe()

    expect(subscription.transport).toBe('sse')
    expect(subscription.endpoint).toBe('/events')
    expect(subscription.events).toContain('runtimeRail.updated')
    expect(subscription.events).toContain('turn.started')
    expect(subscription.events).toContain('turn.interrupted')
  })

  it('starts a thread through typed JSON-RPC client', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const result = await client.call('thread/start', { title: 'Client thread', model: 'test-client-model' })

    createdSessions.push(result.thread.id)
    expect(result.thread.status).toBe('ready')
    expect(result.thread.title).toBe('Client thread')
    expect(result.thread.model).toBe('test-client-model')
    expect(loadSession(result.thread.id)?.cwd).toBe(process.cwd())
  })

  it('lists and resumes threads through typed JSON-RPC client', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const started = await client.call('thread/start', { title: 'Client resumable thread', model: 'test-client-model' })
    createdSessions.push(started.thread.id)

    const listed = await client.call('thread/list', {})
    expect(listed.threads.map((thread: { id: string }) => thread.id)).toContain(started.thread.id)

    const resumed = await client.call('thread/resume', { threadId: started.thread.id })
    expect(resumed.thread).toMatchObject({
      id: started.thread.id,
      title: 'Client resumable thread',
      model: 'test-client-model',
      status: 'ready',
      cwd: process.cwd(),
    })
  })

  it('starts a user turn through typed JSON-RPC client', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const started = await client.threadStart({ title: 'Client turn thread', model: 'test-client-model' })
    createdSessions.push(started.thread.id)

    const result = await client.turnStart({ threadId: started.thread.id, input: 'client turn input' })

    expect(result).toMatchObject({
      threadId: started.thread.id,
      status: 'accepted',
      turn: {
        index: 0,
        role: 'user',
      },
    })
    expect(loadSession(started.thread.id)?.turns[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'client turn input' }],
    })
  })

  it('reads turn status through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({ threadId: 'thread-status-1', projectId: 'project-1' })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            threadId: 'thread-status-1',
            projectId: 'project-1',
            status: 'stale',
            reason: 'runtime_event_unclosed',
            runtimeActive: false,
            turnCount: 1,
            itemCount: 1,
            runtimeEventCount: 1,
            pendingInteractionCount: 0,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const status = await client.turnStatus({ threadId: 'thread-status-1', projectId: 'project-1' })

    expect(methods).toEqual(['turn/status'])
    expect(status).toMatchObject({
      threadId: 'thread-status-1',
      status: 'stale',
      reason: 'runtime_event_unclosed',
    })
  })

  it('recovers turns through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({
          threadId: 'thread-recover-1',
          projectId: 'project-1',
          action: 'mark_recovered',
          note: 'inspected',
        })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            threadId: 'thread-recover-1',
            projectId: 'project-1',
            action: 'mark_recovered',
            previousStatus: {
              status: 'stale',
              reason: 'runtime_event_unclosed',
            },
            status: {
              status: 'recovered',
              reason: 'app_server_mark_recovered',
            },
            recoveryEvent: {
              id: 'runtime_event-2',
              kind: 'runtime_intervention',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const result = await client.turnRecover({
      threadId: 'thread-recover-1',
      projectId: 'project-1',
      action: 'mark_recovered',
      note: 'inspected',
    })

    expect(methods).toEqual(['turn/recover'])
    expect(result).toMatchObject({
      threadId: 'thread-recover-1',
      action: 'mark_recovered',
      status: {
        status: 'recovered',
      },
    })
  })

  it('interrupts through typed JSON-RPC client without claiming a running turn exists', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })
    const started = await client.call('thread/start', { title: 'Client interrupt thread', model: 'test-client-model' })
    createdSessions.push(started.thread.id)

    const result = await client.call('turn/interrupt', { threadId: started.thread.id })

    expect(result).toMatchObject({
      threadId: started.thread.id,
      status: 'not_running',
      reason: 'no_active_turn',
    })
  })

  it('reviews edit changes through typed client helpers', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'client-review.txt')
    writeFileSync(targetPath, 'one\ntwo\nthree\n', 'utf8')
    const conversation = createConversation({ system: 'client review system', model: 'client-review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'client-edit-1',
        name: 'edit',
        input: {
          path: targetPath,
          oldStr: 'two',
          newStr: 'TWO',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'client-edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Client review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer(projectRoot)) })

    const listed = await client.reviewList({ threadId: conversation.id })
    expect(listed.changes).toHaveLength(1)
    expect(listed.changes[0]).toMatchObject({
      id: 'edit:client-edit-1',
      path: targetPath,
    })

    await expect(client.reviewPreflight({ threadId: conversation.id, diffId: 'edit:client-edit-1' }))
      .resolves.toMatchObject({ status: 'ready' })
    await expect(client.reviewApply({ threadId: conversation.id, diffId: 'edit:client-edit-1' }))
      .resolves.toMatchObject({ status: 'applied' })
    expect(readFileSync(targetPath, 'utf8')).toBe('one\nTWO\nthree\n')

    await expect(client.reviewRevert({ threadId: conversation.id, diffId: 'edit:client-edit-1' }))
      .resolves.toMatchObject({ status: 'reverted' })
    expect(readFileSync(targetPath, 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('reviews edit batches through typed client helpers', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string }
        methods.push(request.method)
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            status: request.method === 'review/batchPreflight' ? 'ready' : 'applied',
            threadId: 'thread-1',
            diffIds: ['edit:one', 'edit:two'],
            preflights: [],
            blocked: [],
            results: [],
            preflight: {
              status: 'ready',
              threadId: 'thread-1',
              diffIds: ['edit:one', 'edit:two'],
              preflights: [],
              blocked: [],
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await client.reviewBatchPreflight({ threadId: 'thread-1', diffIds: ['edit:one', 'edit:two'] })
    await client.reviewBatchApply({ threadId: 'thread-1', diffIds: ['edit:one', 'edit:two'] })
    await client.reviewBatchRevert({ threadId: 'thread-1', diffIds: ['edit:one', 'edit:two'] })

    expect(methods).toEqual([
      'review/batchPreflight',
      'review/batchApply',
      'review/batchRevert',
    ])
  })

  it('reviews individual hunks through typed client helpers', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        expect(request.params).toEqual({
          threadId: 'thread-1',
          projectId: 'project-1',
          diffId: 'edit:one',
          hunkId: 'hunk:0',
        })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            status: request.method === 'review/hunkApply' ? 'applied' : 'reverted',
            reason: 'source_match',
            message: 'ok',
            threadId: 'thread-1',
            diffId: 'edit:one',
            hunkId: 'hunk:0',
            hunk: {
              hunkId: 'hunk:0',
              index: 0,
              oldText: 'old',
              newText: 'new',
            },
            proof: {
              kind: 'review_hunk_action',
              status: request.method === 'review/hunkApply' ? 'applied' : 'reverted',
              action: request.method === 'review/hunkApply' ? 'apply' : 'revert',
            },
            reviewStatus: {
              threadId: 'thread-1',
              diffId: 'edit:one#hunk:0',
              status: request.method === 'review/hunkApply' ? 'applied' : 'reverted',
              updatedAt: 1,
              updatedBy: 'app-server',
              source: 'stored',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.reviewHunkApply({
      threadId: 'thread-1',
      projectId: 'project-1',
      diffId: 'edit:one',
      hunkId: 'hunk:0',
    })).resolves.toMatchObject({ status: 'applied' })
    await expect(client.reviewHunkRevert({
      threadId: 'thread-1',
      projectId: 'project-1',
      diffId: 'edit:one',
      hunkId: 'hunk:0',
    })).resolves.toMatchObject({ status: 'reverted' })

    expect(methods).toEqual([
      'review/hunkApply',
      'review/hunkRevert',
    ])
  })

  it('updates and lists review status through typed client helpers', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: any }
        methods.push(request.method)
        if (request.method === 'review/statusUpdate') {
          expect(request.params).toEqual({
            threadId: 'thread-1',
            projectId: 'project-1',
            diffId: 'edit:one',
            status: 'accepted',
            note: 'ready for apply',
            updatedBy: 'palot',
          })
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              threadId: 'thread-1',
              diffId: 'edit:one',
              status: {
                threadId: 'thread-1',
                diffId: 'edit:one',
                status: 'accepted',
                note: 'ready for apply',
                updatedBy: 'palot',
                updatedAt: 1,
                source: 'stored',
              },
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        expect(request.params).toEqual({ threadId: 'thread-1', projectId: 'project-1' })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            threadId: 'thread-1',
            statuses: [{
              threadId: 'thread-1',
              diffId: 'edit:one',
              status: 'accepted',
              updatedBy: 'palot',
              updatedAt: 1,
              source: 'stored',
            }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.reviewStatusUpdate({
      threadId: 'thread-1',
      projectId: 'project-1',
      diffId: 'edit:one',
      status: 'accepted',
      note: 'ready for apply',
      updatedBy: 'palot',
    })).resolves.toMatchObject({
      diffId: 'edit:one',
      status: {
        status: 'accepted',
      },
    })
    await expect(client.reviewStatusList({
      threadId: 'thread-1',
      projectId: 'project-1',
    })).resolves.toMatchObject({
      threadId: 'thread-1',
      statuses: [
        expect.objectContaining({
          diffId: 'edit:one',
          status: 'accepted',
        }),
      ],
    })

    expect(methods).toEqual([
      'review/statusUpdate',
      'review/statusList',
    ])
  })

  it('reads runtime transcripts through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: { threadId: string; projectId?: string }
        }
        methods.push(request.method)
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            threadId: request.params.threadId,
            projectId: request.params.projectId,
            status: 'ready',
            model: 'test-model',
            createdAt: 1,
            updatedAt: 2,
            itemCount: 0,
            runtimeEventCount: 0,
            items: [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const transcript = await client.runtimeTranscriptRead({ threadId: 'thread-1', projectId: 'project-1' })

    expect(methods).toEqual(['runtimeTranscript/read'])
    expect(transcript).toMatchObject({
      threadId: 'thread-1',
      projectId: 'project-1',
      status: 'ready',
      items: [],
    })
  })

  it('reads runtime facts through a typed client helper', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: { threadId: string; projectId?: string; runId: string }
        }
        methods.push(request.method)
        expect(request.params).toEqual({
          threadId: 'thread-1',
          projectId: 'project-1',
          runId: 'run-1',
        })
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            schemaVersion: 1,
            runId: 'run-1',
            threadId: 'thread-1',
            projectId: 'project-1',
            threadIds: ['thread-1'],
            turnIds: ['turn-1'],
            taskIds: ['task-1'],
            stepIds: [],
            jobIds: ['job-1'],
            artifactIds: [],
            checkpointIds: ['checkpoint-1'],
            proofIds: [],
            eventIds: ['runtime_event-1'],
            checkpointRecordIds: ['checkpoint-1'],
            events: [],
            checkpoints: [],
            jobs: [{ jobId: 'job-1', runId: 'run-1' }],
            artifacts: [],
            runtimeEventCount: 1,
            checkpointCount: 1,
            jobCount: 1,
            artifactCount: 0,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const facts = await client.runtimeFactsRead({
      threadId: 'thread-1',
      projectId: 'project-1',
      runId: 'run-1',
    })

    expect(methods).toEqual(['runtimeFacts/read'])
    expect(facts).toMatchObject({
      runId: 'run-1',
      threadId: 'thread-1',
      projectId: 'project-1',
      jobCount: 1,
      checkpointCount: 1,
    })
  })

  it('uses typed client helpers for approval list and resolution', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: Record<string, unknown>
        }
        methods.push(request.method)
        const result = request.method === 'approval/list'
          ? {
              approvals: [{
                id: 'approval-1',
                projectId: request.params.projectId,
                threadId: request.params.threadId,
                toolName: 'bash',
                input: { command: 'npm test' },
                status: 'pending',
                createdAt: 1,
              }],
            }
          : {
              approvalId: request.params.approvalId,
              status: request.params.decision === 'approve' ? 'approved' : 'denied',
              projectId: 'project-1',
              threadId: 'thread-1',
              toolName: 'bash',
            }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.approvalList({ projectId: 'project-1', threadId: 'thread-1' }))
      .resolves.toMatchObject({
        approvals: [{
          id: 'approval-1',
          toolName: 'bash',
          status: 'pending',
        }],
      })
    await expect(client.approvalResolve({ approvalId: 'approval-1', decision: 'approve' }))
      .resolves.toMatchObject({
        approvalId: 'approval-1',
        status: 'approved',
      })

    expect(methods).toEqual(['approval/list', 'approval/resolve'])
  })

  it('uses typed client helpers for interaction list and response', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: Record<string, unknown>
        }
        methods.push(request.method)
        const result = request.method === 'interaction/list'
          ? {
              interactions: [{
                id: 'interaction-1',
                kind: 'user_question',
                projectId: request.params.projectId,
                threadId: request.params.threadId,
                toolName: 'AskUserQuestion',
                question: 'Continue?',
                input: { question: 'Continue?' },
                status: 'pending',
                createdAt: 1,
              }],
            }
          : {
              interactionId: request.params.interactionId,
              status: 'answered',
              answer: request.params.answer,
              projectId: 'project-1',
              threadId: 'thread-1',
              toolName: 'AskUserQuestion',
            }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.interactionList({ projectId: 'project-1', threadId: 'thread-1' }))
      .resolves.toMatchObject({
        interactions: [{
          id: 'interaction-1',
          kind: 'user_question',
          question: 'Continue?',
          status: 'pending',
        }],
      })
    await expect(client.interactionRespond({ interactionId: 'interaction-1', answer: 'yes' }))
      .resolves.toMatchObject({
        interactionId: 'interaction-1',
        status: 'answered',
        answer: 'yes',
      })

    expect(methods).toEqual(['interaction/list', 'interaction/respond'])
  })

  it('uses typed client helpers for platform job actions', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: Record<string, unknown>
        }
        methods.push(request.method)
        const job = {
          jobId: request.params.jobId || 'job:api:client',
          type: 'api',
          status: request.method === 'job/cancel' ? 'cancelled' : 'running',
          stage: request.method === 'job/cancel' ? 'cancelled' : 'probing',
          createdAt: '2026-06-23T00:00:00.000Z',
          updatedAt: '2026-06-23T00:00:01.000Z',
          artifacts: [],
        }
        const result = request.method === 'job/list'
          ? { output: 'job:api:client type=api status=running', count: 1, jobs: [job] }
          : request.method === 'job/get'
            ? { output: 'ID: job:api:client', job, actions: [{ kind: 'cancel', label: 'Cancel job', command: 'JobCancel jobId=job:api:client' }] }
            : { output: 'Cancelled platform job job:api:client', job, cancelledVia: 'supervisor_record', liveCancelAdapter: false }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.jobList({ type: 'api' })).resolves.toMatchObject({
      count: 1,
      jobs: [{ jobId: 'job:api:client', status: 'running' }],
    })
    await expect(client.jobGet({ jobId: 'job:api:client' })).resolves.toMatchObject({
      job: { jobId: 'job:api:client', status: 'running' },
      actions: [{ kind: 'cancel', command: 'JobCancel jobId=job:api:client' }],
    })
    await expect(client.jobCancel({ jobId: 'job:api:client' })).resolves.toMatchObject({
      job: { jobId: 'job:api:client', status: 'cancelled' },
      cancelledVia: 'supervisor_record',
      liveCancelAdapter: false,
    })

    expect(methods).toEqual(['job/list', 'job/get', 'job/cancel'])
  })

  it('uses typed client helpers for truth writer actions', async () => {
    const methods: string[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          id: unknown
          method: string
          params: Record<string, unknown>
        }
        methods.push(request.method)
        const result = request.method === 'proof/append'
          ? {
              status: 'appended',
              proof: {
                kind: request.params.kind,
                title: request.params.title,
                status: request.params.status,
                sourceRef: '.owlrunkit/proofs/proof-1.json',
              },
              readback: { freshness: 'fresh' },
            }
          : {
              status: 'confirmed',
              gateId: request.params.gateId,
              readback: {
                freshness: 'fresh',
                gate: { currentGate: null, passedGates: [request.params.gateId] },
              },
            }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await expect(client.proofAppend({
      projectId: 'project-1',
      kind: 'manual_note',
      title: 'Proof note',
      status: 'recorded',
    })).resolves.toMatchObject({
      status: 'appended',
      proof: { title: 'Proof note' },
    })
    await expect(client.gateConfirm({
      projectId: 'project-1',
      gateId: 'confirm-flow',
      note: 'ok',
    })).resolves.toMatchObject({
      status: 'confirmed',
      gateId: 'confirm-flow',
    })

    expect(methods).toEqual(['proof/append', 'gate/confirm'])
  })

  it('raises structured errors for unknown methods', async () => {
    const client = createAppServerClient({ baseUrl: baseUrl(await startServer()) })

    await expect(client.call('unknown/method', {})).rejects.toMatchObject({
      name: 'AppServerClientError',
      code: -32601,
    })
  })

  it('uses deterministic incrementing ids by default', async () => {
    const ids: unknown[] = []
    const client = createAppServerClient({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown }
        ids.push(request.id)
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { ok: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await client.call('diagnostic/health', {})
    await client.call('project/list', {})

    expect(ids).toEqual([1, 2])
  })
})

async function startServer(projectRoot = process.cwd()): Promise<Server> {
  const server = createAppServer({ projectRoot })
  await listenAppServer(server, { host: '127.0.0.1', port: 0 })
  servers.push(server)
  return server
}

function makeTemporaryProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-client-review-'))
  temporaryProjectRoots.push(root)
  return root
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

void AppServerClientError
