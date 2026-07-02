import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMethodRegistry,
  handleRequest,
} from '../../../src/native/app-server/methods.js'
import { createAppServerEventBus, type AppServerEvent } from '../../../src/native/app-server/event-stream.js'
import { listProjects } from '../../../src/native/app-server/project-service.js'
import { APP_SERVER_METHOD_CONTRACTS } from '../../../src/native/app-server/protocol-contract.js'
import { createConversation } from '../../../src/native/conversation.js'
import { appendRuntimeRecoveryCheckpoint } from '../../../src/native/runtime-recovery-ledger.js'
import { appendRuntimeEvent } from '../../../src/native/runtime-events.js'
import { deleteSession, getSessionsDir, loadSession, saveSession } from '../../../src/native/session.js'
import { createJob, resetJobSupervisor, startJob } from '../../../src/native/job-supervisor.js'
import { createRunWorkspace, readArtifactLedger, recordArtifact } from '../../../src/native/run-workspace.js'
import type { OwlCodaConfig } from '../../../src/config.js'
import type { BenchmarkProviderEvalStoreRecord } from '../../../src/benchmark/index.js'

const createdSessions: string[] = []
const temporaryProjectRoots: string[] = []
const temporarySessionFiles: string[] = []
const originalOwlCodaHome = process.env['OWLCODA_HOME']
let isolatedOwlCodaHome: string | undefined

beforeAll(() => {
  isolatedOwlCodaHome = mkdtempSync(join(tmpdir(), 'owlcoda-app-server-methods-home-'))
  process.env['OWLCODA_HOME'] = isolatedOwlCodaHome
})

afterEach(() => {
  for (const id of createdSessions.splice(0)) deleteSession(id)
  for (const file of temporarySessionFiles.splice(0)) rmSync(file, { force: true })
  for (const root of temporaryProjectRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  resetJobSupervisor()
})

afterAll(() => {
  if (originalOwlCodaHome === undefined) {
    delete process.env['OWLCODA_HOME']
  } else {
    process.env['OWLCODA_HOME'] = originalOwlCodaHome
  }
  if (isolatedOwlCodaHome) rmSync(isolatedOwlCodaHome, { recursive: true, force: true })
})

describe('method registry', () => {
  const registry = createMethodRegistry()

  it('exposes diagnostic/health', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 1,
      method: 'diagnostic/health',
      params: {},
    })
    expect(res).toHaveProperty('result')
    expect(res.result).toHaveProperty('status')
    expect(res.result).toHaveProperty('schemaVersion')
    expect(res.result).toHaveProperty('cwd')
    expect(res.result).toHaveProperty('projectRoot')
    expect(res.result).toHaveProperty('methods')
    expect(res.result).toHaveProperty('subsystems')
    expect(res.result.subsystems).toMatchObject({
      jobSupervisor: {
        status: 'ok',
        jobCount: expect.any(Number),
      },
      browserRuntime: {
        status: expect.any(String),
        providers: expect.arrayContaining(['fetch_html']),
      },
      artifactRegistry: {
        status: expect.any(String),
      },
      toolRisk: {
        status: 'ok',
        safeReadonlyLocal: true,
      },
    })
    expect(Array.isArray(res.result.methods)).toBe(true)
    expect(res.result.methods).toContain('diagnostic/health')
    expect(res.result.methods).toContain('protocol/describe')
    expect(res.result.methods).toContain('project/list')
    expect(res.result.methods).toContain('project/get')
    expect(res.result.methods).toContain('runtimeRail/read')
    expect(res.result.methods).toContain('event/subscribe')
    expect(res.result.methods).toContain('thread/start')
    expect(res.result.methods).toContain('thread/list')
    expect(res.result.methods).toContain('thread/resume')
    expect(res.result.methods).toContain('turn/start')
    expect(res.result.methods).toContain('turn/status')
    expect(res.result.methods).toContain('turn/recover')
    expect(res.result.methods).toContain('turn/interrupt')
    expect(res.result.methods).toContain('approval/list')
    expect(res.result.methods).toContain('approval/resolve')
    expect(res.result.methods).toContain('interaction/list')
    expect(res.result.methods).toContain('interaction/respond')
    expect(res.result.methods).toContain('proof/append')
    expect(res.result.methods).toContain('gate/confirm')
    expect(res.result.methods).toContain('review/list')
    expect(res.result.methods).toContain('review/preflight')
    expect(res.result.methods).toContain('review/apply')
    expect(res.result.methods).toContain('review/revert')
    expect(res.result.methods).toContain('review/hunkApply')
    expect(res.result.methods).toContain('review/hunkRevert')
    expect(res.result.methods).toContain('review/statusList')
    expect(res.result.methods).toContain('review/statusUpdate')
    expect(res.result.methods).toContain('review/batchPreflight')
    expect(res.result.methods).toContain('review/batchApply')
    expect(res.result.methods).toContain('review/batchRevert')
    expect(res.result.methods).toContain('runtimeTranscript/read')
    expect(res.result.methods).toContain('runtimeFacts/read')
    expect(res.result.methods).toContain('benchmark/providerEvalReport/read')
    expect(res.result.methods).toContain('structuredOutputArtifacts/read')
    expect(res.result.methods).toContain('workflowRun/list')
    expect(res.result.methods).toContain('workflowRun/read')
    expect(res.result.methods).toContain('job/list')
    expect(res.result.methods).toContain('job/get')
    expect(res.result.methods).toContain('job/cancel')
  })

  it('diagnostic/health schemaVersion is v1', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 2,
      method: 'diagnostic/health',
      params: {},
    })
    expect(res.result.schemaVersion).toBe('v1')
  })

  it('describes App Server protocol contracts and stability classes', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 21,
      method: 'protocol/describe',
      params: {},
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      schemaVersion: 'v1',
      protocolVersion: 'v1',
    })
    const methodNames = res.result.methods.map((method: { method: string }) => method.method)
    expect(methodNames).toEqual([...registry.methods.keys()].sort())
    expect(methodNames).toEqual(Object.keys(APP_SERVER_METHOD_CONTRACTS).sort())
    expect(res.result.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'diagnostic/health',
        stability: 'debug-only',
        requestType: 'Record<string, never>',
      }),
      expect.objectContaining({
        method: 'runtimeScorecard/read',
        stability: 'experimental',
        requires: ['threadId', 'runId'],
        queryKeys: ['threadId', 'projectId', 'runId'],
      }),
      expect.objectContaining({
        method: 'runtimeFacts/read',
        stability: 'experimental',
        requires: ['threadId', 'runId'],
        queryKeys: ['threadId', 'projectId', 'runId'],
      }),
      expect.objectContaining({
        method: 'benchmark/providerEvalReport/read',
        stability: 'experimental',
        requestType: 'AppServerProviderEvalReportReadInput',
        responseType: 'AppServerProviderEvalReportReadResult',
        queryKeys: ['recordPath'],
      }),
      expect.objectContaining({
        method: 'structuredOutputArtifacts/read',
        stability: 'experimental',
        requestType: 'AppServerStructuredOutputArtifactsReadInput',
        responseType: 'AppServerStructuredOutputArtifactsReadResult',
        requires: ['threadId', 'runId'],
        queryKeys: ['threadId', 'projectId', 'runId', 'artifactId'],
      }),
      expect.objectContaining({
        method: 'workflowRun/list',
        stability: 'experimental',
        requestType: 'AppServerWorkflowRunListInput',
        responseType: 'AppServerWorkflowRunListResult',
        requires: [],
        queryKeys: ['projectId', 'workflowRoot', 'limit'],
      }),
      expect.objectContaining({
        method: 'workflowRun/read',
        stability: 'experimental',
        requestType: 'AppServerWorkflowRunReadInput',
        responseType: 'WorkflowConsumerManifest',
        requires: ['runId'],
        queryKeys: ['projectId', 'workflowRoot', 'runId'],
      }),
      expect.objectContaining({
        method: 'thread/start',
        stability: 'stable',
      }),
      expect.objectContaining({
        method: 'runtimeRail/read',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'review/hunkApply',
        stability: 'experimental',
        requires: ['threadId', 'diffId', 'hunkId'],
        queryKeys: ['threadId', 'projectId', 'diffId', 'hunkId'],
      }),
      expect.objectContaining({
        method: 'review/hunkRevert',
        stability: 'experimental',
        requires: ['threadId', 'diffId', 'hunkId'],
        queryKeys: ['threadId', 'projectId', 'diffId', 'hunkId'],
      }),
    ]))
    expect(res.result.methods.filter((method: { stability: string }) => method.stability === 'debug-only'))
      .toEqual([expect.objectContaining({ method: 'diagnostic/health' })])
  })

  it('exposes project/list', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 3,
      method: 'project/list',
      params: {},
    })
    expect(res).toHaveProperty('result')
    expect(Array.isArray(res.result.projects)).toBe(true)
    const project = res.result.projects[0]
    expect(project).toHaveProperty('id')
    expect(project).toHaveProperty('name')
    expect(project).toHaveProperty('root')
    expect(project).toHaveProperty('source')
  })

  it('project/list includes the current cwd project', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 4,
      method: 'project/list',
      params: {},
    })
    const roots = res.result.projects.map((p: { root: string }) => p.root)
    expect(roots.length).toBeGreaterThan(0)
  })

  it('exposes project/get aggregate with project summary and rail', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 6,
      method: 'project/get',
      params: {},
    })
    expect(res).toHaveProperty('result')
    expect(res.result.project).toHaveProperty('id')
    expect(res.result.project).toHaveProperty('root')
    expect(res.result.rail).toHaveProperty('projectId')
    expect(res.result.rail).toHaveProperty('freshness')
  })

  it('exposes event/subscribe as SSE discovery metadata', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 7,
      method: 'event/subscribe',
      params: {},
    })
    expect(res).toHaveProperty('result')
    expect(res.result).toEqual({
      transport: 'sse',
      endpoint: '/events',
      events: [
        'runtimeRail.updated',
        'project.updated',
        'thread.updated',
        'turn.started',
        'assistant.delta',
        'command.started',
        'command.outputDelta',
        'command.completed',
        'diff.started',
        'diff.completed',
        'tool.started',
        'tool.delta',
        'tool.completed',
        'turn.completed',
        'turn.failed',
        'turn.interrupted',
        'approval.requested',
        'approval.resolved',
        'interaction.requested',
        'interaction.resolved',
        'proof.appended',
        'gate.confirmed',
        'review.batchCompleted',
        'review.statusUpdated',
      ],
    })
  })

  it('reads provider eval batch report from the local JSONL store', async () => {
    if (!isolatedOwlCodaHome) throw new Error('isolated OWLCODA_HOME missing')
    const recordPath = join(isolatedOwlCodaHome, 'benchmark', 'provider-eval.jsonl')
    mkdirSync(join(isolatedOwlCodaHome, 'benchmark'), { recursive: true })
    writeFileSync(recordPath, [
      providerEvalRecord({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'deck-12p', passed: true, score: 94 }),
      providerEvalRecord({ providerId: 'moonshot', modelId: 'kimi-lite', caseId: 'deck-12p', passed: false, score: 55, error: 'missing verification' }),
    ].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')

    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 8,
      method: 'benchmark/providerEvalReport/read',
      params: {},
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      schemaVersion: 1,
      source: 'local_provider_eval_store',
      recordPath,
      recordCount: 2,
      report: {
        schemaVersion: 1,
        localOnly: true,
        trainingUse: 'not_collected',
        recordCount: 2,
        passedCount: 1,
        failedCount: 1,
      },
    })
    expect(res.result.markdown).toContain('Benchmark Provider Eval Batch Report')
    expect(res.result.report.leaderboard).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'openai', modelId: 'gpt-strong', passRate: 1 }),
      expect.objectContaining({ providerId: 'moonshot', modelId: 'kimi-lite', passRate: 0 }),
    ]))
  })

  it('exposes platform job list/get/cancel through App Server methods', async () => {
    createJob({
      jobId: 'job:api:app-server',
      type: 'api',
      stage: 'queued',
      tool: 'JudgeBackendProbe',
      provider: 'models',
      command: 'GET /v1/models',
      recoveryHint: 'JobGet jobId=job:api:app-server',
    })
    startJob('job:api:app-server', { stage: 'probing', externalHandle: 'http://127.0.0.1:9999/v1/models' })

    const listed = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 70,
      method: 'job/list',
      params: { type: 'api' },
    })
    expect(listed).toHaveProperty('result')
    expect(listed.result).toMatchObject({
      count: 1,
      filters: { type: 'api' },
      jobs: [
        {
          jobId: 'job:api:app-server',
          type: 'api',
          status: 'running',
          stage: 'probing',
        },
      ],
    })
    expect(listed.result.output).toContain('job:api:app-server')

    const got = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 71,
      method: 'job/get',
      params: { jobId: 'job:api:app-server' },
    })
    expect(got).toHaveProperty('result')
    expect(got.result).toMatchObject({
      job: {
        jobId: 'job:api:app-server',
        status: 'running',
        recoveryHint: 'JobGet jobId=job:api:app-server',
      },
      actions: expect.arrayContaining([
        expect.objectContaining({
          kind: 'cancel',
          command: 'JobCancel jobId=job:api:app-server',
        }),
      ]),
    })

    const cancelled = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 72,
      method: 'job/cancel',
      params: { jobId: 'job:api:app-server' },
    })
    expect(cancelled).toHaveProperty('result')
    expect(cancelled.result).toMatchObject({
      cancelledVia: 'supervisor_record',
      liveCancelAdapter: false,
      job: {
        jobId: 'job:api:app-server',
        status: 'cancelled',
        terminationReason: 'user_cancel',
        cleanupAttempted: false,
        cleanupSucceeded: false,
      },
    })
  })

  it('starts a durable thread session bound to the project root', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 8,
      method: 'thread/start',
      params: { title: 'Desktop thread', model: 'test-model' },
    })
    expect(res).toHaveProperty('result')
    createdSessions.push(res.result.thread.id)
    expect(res.result.thread).toMatchObject({
      id: expect.stringMatching(/^conv-/),
      projectId: expect.any(String),
      model: 'test-model',
      title: 'Desktop thread',
      status: 'ready',
    })
    expect(res.result.thread.createdAt).toEqual(expect.any(Number))

    const saved = loadSession(res.result.thread.id)
    expect(saved).not.toBeNull()
    expect(saved!.title).toBe('Desktop thread')
    expect(saved!.model).toBe('test-model')
    expect(saved!.cwd).toBe(process.cwd())
    expect(saved!.turns).toEqual([])
  })

  it('uses the configured OwlCoda loop model when desktop clients omit model', async () => {
    const configuredRegistry = createMethodRegistry({
      config: testConfig({
        models: [{
          id: 'desktop-model',
          label: 'Desktop Model',
          backendModel: 'backend-model',
          aliases: ['desktop'],
          provider: 'test',
          tier: 'local',
          default: true,
          supportsImages: true,
        } as any],
      }),
    } as any)

    const res = await handleRequest(configuredRegistry, {
      jsonrpc: '2.0',
      id: 802,
      method: 'thread/start',
      params: { title: 'Configured desktop thread' },
    })

    expect(res).toHaveProperty('result')
    createdSessions.push(res.result.thread.id)
    expect(res.result.thread.model).toBe('desktop-model')
    expect(loadSession(res.result.thread.id)!.model).toBe('desktop-model')
    expect(loadSession(res.result.thread.id)!.modelIdentity).toMatchObject({
      id: 'desktop-model',
      backendModel: 'backend-model',
      supportsImages: true,
    })
  })

  it('starts desktop threads with native OwlCoda tool definitions', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 803,
      method: 'thread/start',
      params: { title: 'Tool-enabled desktop thread', model: 'test-model' },
    })

    expect(res).toHaveProperty('result')
    createdSessions.push(res.result.thread.id)
    const toolNames = (loadSession(res.result.thread.id)!.tools ?? []).map(tool => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['bash', 'read', 'grep']))
  })

  it('publishes thread.updated when starting a durable thread', async () => {
    const events: AppServerEvent[] = []
    const eventBus = createAppServerEventBus()
    eventBus.subscribe(event => events.push(event))
    const eventRegistry = createMethodRegistry({ eventBus })

    const res = await handleRequest(eventRegistry, {
      jsonrpc: '2.0',
      id: 801,
      method: 'thread/start',
      params: { title: 'Evented desktop thread', model: 'event-model' },
    })

    expect(res).toHaveProperty('result')
    createdSessions.push(res.result.thread.id)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'thread.updated',
        projectId: res.result.thread.projectId,
        threadId: res.result.thread.id,
        turnCount: 0,
      }),
    ])
  })

  it('lists only durable thread sessions bound to the project root', async () => {
    const own = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 9,
      method: 'thread/start',
      params: { title: 'Own desktop thread', model: 'test-model' },
    })
    createdSessions.push(own.result.thread.id)

    const foreign = createConversation({ system: 'foreign', model: 'test-model' })
    saveSession(foreign, 'Foreign desktop thread', { cwd: `${process.cwd()}-other` })
    createdSessions.push(foreign.id)
    const duplicateOwn = {
      ...loadSession(own.result.thread.id)!,
      title: 'Stale duplicate desktop thread',
      updatedAt: 1,
    }
    const duplicatePath = join(getSessionsDir(), `duplicate-${own.result.thread.id}.json`)
    writeFileSync(duplicatePath, JSON.stringify(duplicateOwn, null, 2), 'utf8')
    temporarySessionFiles.push(duplicatePath)

    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 10,
      method: 'thread/list',
      params: {},
    })

    expect(res).toHaveProperty('result')
    const ids = res.result.threads.map((thread: { id: string }) => thread.id)
    expect(ids).toContain(own.result.thread.id)
    expect(ids).not.toContain(foreign.id)
    const ownThreads = res.result.threads.filter((thread: { id: string }) => thread.id === own.result.thread.id)
    expect(ownThreads).toHaveLength(1)
    expect(ownThreads[0]).toMatchObject({
      id: own.result.thread.id,
      projectId: expect.any(String),
      title: 'Own desktop thread',
      model: 'test-model',
      status: 'ready',
      cwd: process.cwd(),
      turnCount: 0,
    })
  })

  it('lists durable threads with recency pagination and query filtering', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const pagedRegistry = createMethodRegistry({ projectRoot })
    const alpha = createConversation({ system: 'alpha', model: 'desktop-model' })
    const beta = createConversation({ system: 'beta', model: 'desktop-model' })
    const gamma = createConversation({ system: 'gamma', model: 'desktop-model' })
    saveSession(alpha, 'Alpha design thread', { cwd: projectRoot })
    saveSession(beta, 'Beta runtime thread', { cwd: projectRoot })
    saveSession(gamma, 'Gamma rail thread', { cwd: projectRoot })
    createdSessions.push(alpha.id, beta.id, gamma.id)

    const firstPage = await handleRequest(pagedRegistry, {
      jsonrpc: '2.0',
      id: 1010,
      method: 'thread/list',
      params: { limit: 2 },
    })

    expect(firstPage).toHaveProperty('result')
    expect(firstPage.result).toMatchObject({
      limit: 2,
      offset: 0,
      totalCount: 3,
      hasMore: true,
    })
    expect(firstPage.result.threads).toHaveLength(2)

    const secondPage = await handleRequest(pagedRegistry, {
      jsonrpc: '2.0',
      id: 1011,
      method: 'thread/list',
      params: { limit: 2, offset: 2 },
    })

    expect(secondPage.result).toMatchObject({
      limit: 2,
      offset: 2,
      totalCount: 3,
      hasMore: false,
    })
    expect(secondPage.result.threads).toHaveLength(1)

    const searched = await handleRequest(pagedRegistry, {
      jsonrpc: '2.0',
      id: 1012,
      method: 'thread/list',
      params: { query: 'runtime', limit: 10 },
    })

    expect(searched.result).toMatchObject({
      query: 'runtime',
      totalCount: 1,
      hasMore: false,
    })
    expect(searched.result.threads).toHaveLength(1)
    expect(searched.result.threads[0]).toMatchObject({
      id: beta.id,
      title: 'Beta runtime thread',
    })
  }, 15000)

  it('resumes a durable thread session bound to the project root', async () => {
    const started = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 11,
      method: 'thread/start',
      params: { title: 'Resume desktop thread', model: 'resume-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 12,
      method: 'thread/resume',
      params: { threadId: started.result.thread.id },
    })

    expect(res).toHaveProperty('result')
    expect(res.result.thread).toMatchObject({
      id: started.result.thread.id,
      projectId: started.result.thread.projectId,
      title: 'Resume desktop thread',
      model: 'resume-model',
      status: 'ready',
      cwd: process.cwd(),
      turnCount: 0,
    })
  })

  it('rejects resume for missing or foreign project sessions', async () => {
    const missing = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 13,
      method: 'thread/resume',
      params: { threadId: 'missing-thread-id' },
    })
    expect(missing).toHaveProperty('error')
    expect(missing.error.code).toBe(-32602)

    const foreign = createConversation({ system: 'foreign', model: 'foreign-model' })
    saveSession(foreign, 'Foreign thread', { cwd: `${process.cwd()}-other` })
    createdSessions.push(foreign.id)

    const foreignRes = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 14,
      method: 'thread/resume',
      params: { threadId: foreign.id },
    })
    expect(foreignRes).toHaveProperty('error')
    expect(foreignRes.error.code).toBe(-32602)
  })

  it('reads a replayable runtime transcript from a durable project session', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'target.txt')
    writeFileSync(targetPath, 'alpha\n', 'utf8')
    const conversation = createConversation({ system: 'runtime transcript system', model: 'transcript-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'Please change alpha.' }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 2,
      content: [
        { type: 'text', text: 'I will edit.' },
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'edit',
          input: {
            path: targetPath,
            oldStr: 'alpha\n',
            newStr: 'beta\n',
          },
        },
      ],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 3,
      content: [{
        type: 'tool_result',
        tool_use_id: 'edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
        metadata: { path: targetPath, durationMs: 42 },
      }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 4,
      content: [{ type: 'text', text: 'Done.' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-23T01:00:00.000Z',
      turnId: 'runtime-turn-1',
      runId: 'runtime-run-1',
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_started',
      at: '2026-06-23T01:00:01.000Z',
      turnId: 'runtime-turn-1',
      runId: 'runtime-run-1',
      itemId: 'edit-1',
      payload: { tool_name: 'edit' },
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-23T01:00:02.000Z',
      turnId: 'runtime-turn-1',
      runId: 'runtime-run-1',
      itemId: 'edit-1',
      payload: { tool_name: 'edit', is_error: false, duration_ms: 42 },
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_completed',
      at: '2026-06-23T01:00:03.000Z',
      turnId: 'runtime-turn-1',
      runId: 'runtime-run-1',
      payload: {
        stop_reason: 'end_turn',
        iterations: 1,
        request_count: 1,
        input_tokens: 10,
        output_tokens: 5,
        assistant_response_count: 1,
        assistant_text_chars: 12,
        final_text_chars: 5,
        tool_use_count: 1,
        executed_tool_count: 1,
        empty_response_count: 0,
      },
    })
    saveSession(conversation, 'Transcript session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const transcriptRegistry = createMethodRegistry({ projectRoot })

    const res = await handleRequest(transcriptRegistry, {
      jsonrpc: '2.0',
      id: 15,
      method: 'runtimeTranscript/read',
      params: { threadId: conversation.id },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      threadId: conversation.id,
      title: 'Transcript session',
      model: 'transcript-model',
      status: 'ready',
      itemCount: 4,
      runtimeEventCount: 4,
      items: [
        {
          id: 'turn:0:text:0',
          kind: 'message',
          role: 'user',
          text: 'Please change alpha.',
          turnIndex: 0,
        },
        {
          id: 'turn:1:text:0',
          kind: 'message',
          role: 'assistant',
          text: 'I will edit.',
          turnIndex: 1,
        },
        {
          id: 'tool:edit-1',
          kind: 'tool_call',
          toolUseId: 'edit-1',
          toolName: 'edit',
          input: {
            path: targetPath,
            oldStr: 'alpha\n',
            newStr: 'beta\n',
          },
          status: 'completed',
          result: {
            content: `Edited ${targetPath}`,
            isError: false,
            metadata: { path: targetPath, durationMs: 42 },
          },
          runtime: {
            turnId: 'runtime-turn-1',
            runId: 'runtime-run-1',
            itemId: 'edit-1',
            startedAt: '2026-06-23T01:00:01.000Z',
            completedAt: '2026-06-23T01:00:02.000Z',
            eventIds: ['runtime_event-2', 'runtime_event-3'],
          },
        },
        {
          id: 'turn:3:text:0',
          kind: 'message',
          role: 'assistant',
          text: 'Done.',
          turnIndex: 3,
        },
      ],
    })

    const foreign = createConversation({ system: 'foreign transcript', model: 'foreign-model' })
    saveSession(foreign, 'Foreign transcript', { cwd: `${projectRoot}-other` })
    createdSessions.push(foreign.id)
    const foreignRes = await handleRequest(transcriptRegistry, {
      jsonrpc: '2.0',
      id: 16,
      method: 'runtimeTranscript/read',
      params: { threadId: foreign.id },
    })
    expect(foreignRes).toHaveProperty('error')
    expect(foreignRes.error.code).toBe(-32602)
  })

  it('reads structured runtime facts by threadId and runId', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const runId = 'run-app-server-facts'
    const turnId = 'turn-app-server-facts'
    const taskId = 'task-app-server-facts'
    const stepId = 'step-app-server-facts'
    const jobId = 'job-app-server-facts'
    const proofId = 'proof-app-server-facts'
    const conversation = createConversation({ system: 'runtime facts system', model: 'facts-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'verify runtime facts' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T01:00:00.000Z',
      threadId: conversation.id,
      turnId,
      runId,
      itemId: 'verify-1',
      factRefs: {
        taskId,
        stepId,
        jobId,
        proofId,
      },
      payload: {
        tool_name: 'TaskVerify',
        is_error: false,
        task_id: taskId,
        step_id: stepId,
        job_id: jobId,
        proof_id: proofId,
      },
    })
    appendRuntimeRecoveryCheckpoint(conversation, {
      kind: 'blocked_task_checkpoint',
      generatedAt: '2026-06-26T01:00:01.000Z',
      threadId: conversation.id,
      turnId,
      runId,
      payload: {
        schema_version: 1,
        kind: 'blocked_task_checkpoint',
        generated_at: '2026-06-26T01:00:01.000Z',
        blocked_task: {
          task_id: taskId,
          step_id: stepId,
          status: 'blocked',
          inspect_command: `TaskGet taskId=${taskId}`,
        },
      },
    })
    createJob({
      jobId,
      type: 'command',
      stage: 'verify',
      threadId: conversation.id,
      turnId,
      runId,
      taskId,
      recoveryHint: `JobGet jobId=${jobId}`,
    })
    saveSession(conversation, 'Runtime facts session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const factsRegistry = createMethodRegistry({ projectRoot })

    const res = await handleRequest(factsRegistry, {
      jsonrpc: '2.0',
      id: 151,
      method: 'runtimeFacts/read',
      params: { threadId: conversation.id, runId },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      schemaVersion: 1,
      runId,
      threadId: conversation.id,
      checkpointCount: 1,
      jobCount: 1,
      artifactCount: 0,
      threadIds: [conversation.id],
      turnIds: [turnId],
      taskIds: [taskId],
      stepIds: [stepId],
      jobIds: [jobId],
      proofIds: [proofId],
      checkpointIds: ['blocked_task_checkpoint-1'],
      checkpointRecordIds: ['blocked_task_checkpoint-1'],
    })
    expect(res.result.runtimeEventCount).toBeGreaterThanOrEqual(1)
    expect(res.result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'item_completed',
        runId,
        factRefs: expect.objectContaining({ taskId, stepId, jobId, proofId }),
      }),
    ]))
    expect(res.result.checkpoints).toEqual([
      expect.objectContaining({
        id: 'blocked_task_checkpoint-1',
        kind: 'blocked_task_checkpoint',
        runId,
      }),
    ])
    expect(res.result.jobs).toEqual([
      expect.objectContaining({
        jobId,
        runId,
        taskId,
      }),
    ])
  })

  it('reads a scorecard and local trajectory summary for a runtime run', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const runId = 'run-app-server-scorecard'
    const turnId = 'turn-app-server-scorecard'
    const taskId = 'task-app-server-scorecard'
    const proofId = 'proof-app-server-scorecard'
    const conversation = createConversation({ system: 'runtime scorecard system', model: 'scorecard-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'text', text: `完成，TaskVerify passed，证据 ${proofId} 已记录。` }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-26T05:00:00.000Z',
      threadId: conversation.id,
      turnId,
      runId,
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T05:00:01.000Z',
      threadId: conversation.id,
      turnId,
      runId,
      itemId: 'verify-scorecard-1',
      factRefs: {
        taskId,
        proofId,
      },
      payload: {
        tool_name: 'TaskVerify',
        is_error: false,
        task_id: taskId,
        proof_id: proofId,
      },
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_completed',
      at: '2026-06-26T05:00:03.000Z',
      threadId: conversation.id,
      turnId,
      runId,
      payload: {
        stop_reason: 'end_turn',
        iterations: 1,
        request_count: 1,
        input_tokens: 100,
        output_tokens: 25,
        assistant_response_count: 1,
        assistant_text_chars: 24,
        final_text_chars: 24,
        tool_use_count: 1,
        executed_tool_count: 1,
        empty_response_count: 0,
      },
    })
    saveSession(conversation, 'Runtime scorecard session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const scorecardRegistry = createMethodRegistry({ projectRoot })

    const res = await handleRequest(scorecardRegistry, {
      jsonrpc: '2.0',
      id: 152,
      method: 'runtimeScorecard/read',
      params: { threadId: conversation.id, runId },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      schemaVersion: 1,
      threadId: conversation.id,
      projectId: expect.any(String),
      runId,
      scorecard: {
        scorecardVersion: 1,
        runId,
        verdict: 'pass',
        antiCheat: {
          verdict: 'pass',
        },
      },
      trajectory: {
        recordCount: 3,
        localOnly: true,
        redactionMode: 'local_redacted_v0',
      },
      facts: {
        runtimeEventCount: 3,
        checkpointCount: 0,
        jobCount: 0,
        artifactCount: 0,
      },
    })
    expect(res.result.summary).toContain(`Scorecard run=${runId}`)
    expect(res.result.trajectory.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trajectory_version: 1,
        run_id: runId,
        reward: expect.objectContaining({
          verdict: 'pass',
          anti_cheat: 'pass',
        }),
      }),
    ]))
  })

  it('reads structured output artifacts for a desktop artifact panel without treating failed fallback as success', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const outputRoot = join(projectRoot, 'out', 'structured-output-run')
    const runId = 'run-structured-output-panel'
    const turnId = 'turn-structured-output-panel'
    const artifactId = 'structured-output-panel-artifact'
    const attemptLedgerId = `${artifactId}-attempts`
    const workspace = await createRunWorkspace({ outputRoot, cwd: projectRoot, runId })
    const structuredDir = join(outputRoot, 'evidence', 'structured-output')
    mkdirSync(structuredDir, { recursive: true })
    const artifactPath = join(structuredDir, `${artifactId}.json`)
    const attemptsPath = join(structuredDir, `${attemptLedgerId}.json`)
    writeFileSync(artifactPath, JSON.stringify({
      version: 1,
      artifactKind: 'structured_output_artifact',
      role: 'judge',
      model: 'model-output-panel',
      preset: 'canonical-judge.v1',
      requestFingerprint: 'sha256:request-panel',
      schemaHash: 'sha256:schema-panel',
      policyHash: 'sha256:policy-panel',
      ok: false,
      artifact: {
        artifact: 'failed_fallback.v1',
        ok: false,
        failureReason: 'forbidden_phrase',
        retryHint: 'rerun_role_artifact',
      },
      rawText: '{"summary":"EV looks great"}',
      rawThinkingText: 'hidden model thinking',
      parsed: true,
      schemaValid: true,
      validationErrors: ['forbidden_phrase: EV'],
      repairCount: 0,
      salvageUsed: false,
      fallbackUsed: true,
      stopReason: 'end_turn',
      inputTokens: 90,
      outputTokens: 21,
      durationMs: 450,
    }, null, 2), 'utf8')
    writeFileSync(attemptsPath, JSON.stringify({
      version: 1,
      artifactKind: 'structured_output_attempts',
      artifactId,
      attemptLedgerId,
      attempts: [
        {
          label: 'primary',
          model: 'model-output-panel',
          durationMs: 450,
          inputTokens: 90,
          outputTokens: 21,
          stopReason: 'end_turn',
          parsed: true,
          schemaValid: true,
        },
        {
          label: 'fallback',
          model: 'model-output-panel',
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'end_turn',
          parsed: true,
          schemaValid: false,
          error: 'forbidden_phrase: EV',
        },
      ],
    }, null, 2), 'utf8')
    await recordArtifact(outputRoot, {
      id: artifactId,
      path: artifactPath,
      origin: 'model_output_harness',
      artifactType: 'structured_output_artifact',
      threadId: 'thread-placeholder',
      turnId,
      runId,
      stepId: 'judge',
      participatesInFinal: false,
    })
    await recordArtifact(outputRoot, {
      id: attemptLedgerId,
      path: attemptsPath,
      origin: 'model_output_harness',
      artifactType: 'structured_output_attempts',
      threadId: 'thread-placeholder',
      turnId,
      runId,
      stepId: 'judge',
      participatesInFinal: false,
    })
    expect((await readArtifactLedger(outputRoot)).artifacts).toHaveLength(2)

    const conversation = createConversation({ system: 'structured output panel system', model: 'panel-model' })
    conversation.options = {
      ...(conversation.options ?? {}),
      taskState: {
        run: {
          runWorkspace: {
            runId,
            outputRoot: workspace.paths.outputRoot,
            runDir: workspace.paths.runDir,
            manifestPath: workspace.paths.manifestPath,
            artifactsPath: workspace.paths.artifactsPath,
            eventsPath: workspace.paths.eventsPath,
            createdAt: workspace.manifest.createdAt,
            artifactCount: 2,
          },
        },
      } as any,
    }
    saveSession(conversation, 'Structured output panel session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const panelRegistry = createMethodRegistry({ projectRoot })

    const res = await handleRequest(panelRegistry, {
      jsonrpc: '2.0',
      id: 153,
      method: 'structuredOutputArtifacts/read',
      params: { threadId: conversation.id, runId },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      schemaVersion: 1,
      surface: 'structured-output-artifacts',
      threadId: conversation.id,
      runId,
      artifactCount: 1,
      failedCount: 1,
      successCount: 0,
      items: [{
        artifactId,
        attemptLedgerId,
        status: 'failed',
        ok: false,
        schemaValid: true,
        fallbackUsed: true,
        role: 'judge',
        model: 'model-output-panel',
        preset: 'canonical-judge.v1',
        validationErrors: ['forbidden_phrase: EV'],
        rawText: '{"summary":"EV looks great"}',
        rawThinkingText: 'hidden model thinking',
        attempts: [
          expect.objectContaining({ label: 'primary', parsed: true, schemaValid: true }),
          expect.objectContaining({ label: 'fallback', schemaValid: false, error: 'forbidden_phrase: EV' }),
        ],
        rerunAction: {
          available: true,
          httpEndpoint: '/v1/structured-output/rerun',
          request: expect.objectContaining({
            runRef: workspace.paths.outputRoot,
            previousArtifactId: artifactId,
            role: 'judge',
            model: 'model-output-panel',
            preset: 'canonical-judge.v1',
            artifactRef: artifactId,
          }),
        },
      }],
    })
    expect(res.result.items[0].artifactPreview).toMatchObject({
      artifact: 'failed_fallback.v1',
      ok: false,
      failureReason: 'forbidden_phrase',
    })
  })

  it('lists and reads WorkflowConsumerManifest records through App Server without a thread session', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const runId = 'run-app-server-workflow'
    const runDir = join(projectRoot, '.owlcoda-workflows', runId)
    const artifactDir = join(runDir, `${runId}-artifacts`)
    mkdirSync(artifactDir, { recursive: true })
    const planPath = join(runDir, 'plan.json')
    const receiptPath = join(runDir, 'receipt.json')
    writeFileSync(planPath, JSON.stringify({
      run_id: runId,
      plan_version: 'app-server-workflow.test',
      steps: [{ id: 'ping', method: 'GET', url: 'https://example.test/ping' }],
    }), 'utf8')
    writeFileSync(receiptPath, JSON.stringify({
      schema_version: 1,
      kind: 'workflow_invocation_receipt',
      run_id: runId,
      started_at: '2026-07-02T03:00:00.000Z',
      finished_at: '2026-07-02T03:00:01.000Z',
      plan_version: 'app-server-workflow.test',
      plan_digest: 'digest',
      plan_path: planPath,
      receipt_path: receiptPath,
      artifact_dir: artifactDir,
      required_steps_total: 1,
      required_steps_completed: 1,
      failed_steps: [],
      skipped_steps: [],
      endpoint_calls: [],
      acceptance: 'pass',
      required_endpoint_calls: '1/1',
    }), 'utf8')
    const registry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 154,
      method: 'workflowRun/list',
      params: {},
    })

    expect(listed).toHaveProperty('result')
    expect(listed.result).toMatchObject({
      schemaVersion: 1,
      workflowRoot: join(projectRoot, '.owlcoda-workflows'),
      count: 1,
      runs: [{
        runId,
        normalizedState: 'completed',
        acceptance: { status: 'pass' },
      }],
    })

    const read = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 155,
      method: 'workflowRun/read',
      params: { runId },
    })

    expect(read).toHaveProperty('result')
    expect(read.result).toMatchObject({
      schemaVersion: 1,
      kind: 'workflow_consumer_manifest',
      runId,
      plan: { path: planPath, version: 'app-server-workflow.test' },
      receipt: { path: receiptPath, acceptance: 'pass' },
      finalReportEligibility: { allowed: true },
    })
  })

  it('starts a user turn by appending to the persisted thread session', async () => {
    const started = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 15,
      method: 'thread/start',
      params: { title: 'Turn desktop thread', model: 'turn-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 16,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'hello from desktop' },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      threadId: started.result.thread.id,
      projectId: started.result.thread.projectId,
      status: 'accepted',
      runtimeStarted: false,
      runtimeStatus: 'saved',
      runtimeReason: 'runtime_not_started',
      turn: {
        index: 0,
        role: 'user',
      },
    })

    const saved = loadSession(started.result.thread.id)
    expect(saved!.turns).toHaveLength(1)
    expect(saved!.turns[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hello from desktop' }],
    })
  })

  it('reports saved-only turn status for durable desktop recovery', async () => {
    const started = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 1601,
      method: 'thread/start',
      params: { title: 'Saved-only status thread', model: 'turn-model' },
    })
    createdSessions.push(started.result.thread.id)

    await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 1602,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'persist but do not run' },
    })

    const status = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 1603,
      method: 'turn/status',
      params: { threadId: started.result.thread.id },
    })

    expect(status).toHaveProperty('result')
    expect(status.result).toMatchObject({
      threadId: started.result.thread.id,
      projectId: started.result.thread.projectId,
      status: 'saved_only',
      reason: 'runtime_not_started',
      runtimeActive: false,
      turnCount: 1,
      runtimeEventCount: 0,
      itemCount: 1,
      pendingInteractionCount: 0,
      lastTurn: {
        index: 0,
        role: 'user',
      },
    })

    const resumed = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 1604,
      method: 'thread/resume',
      params: { threadId: started.result.thread.id },
    })
    expect(resumed.result.thread.runtime).toMatchObject({
      status: 'saved_only',
      reason: 'runtime_not_started',
      turnCount: 1,
    })
  })

  it('reports stale status for an unclosed runtime turn after process restore', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'stale status system', model: 'stale-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'start long turn' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-23T02:00:00.000Z',
      turnId: 'runtime-turn-stale-1',
    })
    saveSession(conversation, 'Stale runtime session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const restoredRegistry = createMethodRegistry({ projectRoot })

    const status = await handleRequest(restoredRegistry, {
      jsonrpc: '2.0',
      id: 1605,
      method: 'turn/status',
      params: { threadId: conversation.id },
    })

    expect(status).toHaveProperty('result')
    expect(status.result).toMatchObject({
      threadId: conversation.id,
      status: 'stale',
      reason: 'runtime_event_unclosed',
      runtimeActive: false,
      turnCount: 1,
      runtimeEventCount: 1,
      lastRuntimeEvent: {
        kind: 'turn_started',
        turnId: 'runtime-turn-stale-1',
      },
      resumeHint: {
        action: 'inspect_transcript_before_retry',
      },
    })

    const resumed = await handleRequest(restoredRegistry, {
      jsonrpc: '2.0',
      id: 1606,
      method: 'thread/resume',
      params: { threadId: conversation.id },
    })
    expect(resumed.result.thread.runtime).toMatchObject({
      status: 'stale',
      reason: 'runtime_event_unclosed',
    })
  })

  it('reports waiting_for_interaction from restored pending interactions', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const interactionStoragePath = join(projectRoot, '.owlcoda', 'app-server', 'approvals.json')
    mkdirSync(join(projectRoot, '.owlcoda', 'app-server'), { recursive: true })
    const conversation = createConversation({ system: 'waiting status system', model: 'waiting-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'needs approval' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-23T03:00:00.000Z',
      turnId: 'runtime-turn-waiting-1',
    })
    saveSession(conversation, 'Waiting interaction session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const projectId = listProjects(projectRoot).projects[0]!.id
    writeFileSync(interactionStoragePath, JSON.stringify({
      schemaVersion: '1.0',
      interactions: [{
        id: 'approval-1',
        kind: 'tool_approval',
        source: 'live',
        projectId,
        threadId: conversation.id,
        toolName: 'bash',
        input: { command: 'npm test' },
        status: 'pending',
        createdAt: 1782225000000,
      }],
    }, null, 2), 'utf8')

    const restoredRegistry = createMethodRegistry({ projectRoot, interactionStoragePath })
    const status = await handleRequest(restoredRegistry, {
      jsonrpc: '2.0',
      id: 1607,
      method: 'turn/status',
      params: { threadId: conversation.id },
    })

    expect(status).toHaveProperty('result')
    expect(status.result).toMatchObject({
      threadId: conversation.id,
      status: 'waiting_for_interaction',
      reason: 'pending_interaction',
      pendingInteractionCount: 1,
      lastInteraction: {
        id: 'approval-1',
        kind: 'tool_approval',
        source: 'restored',
        toolName: 'bash',
      },
      resumeHint: {
        action: 'resolve_pending_interaction',
      },
    })
  })

  it('marks stale runtime turns as recovered without claiming they completed', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'recover stale system', model: 'recover-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'start then lose process' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-23T04:00:00.000Z',
      turnId: 'runtime-turn-recover-1',
    })
    saveSession(conversation, 'Recover stale session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const recoveryRegistry = createMethodRegistry({ projectRoot })

    const recovered = await handleRequest(recoveryRegistry, {
      jsonrpc: '2.0',
      id: 1608,
      method: 'turn/recover',
      params: {
        threadId: conversation.id,
        action: 'mark_recovered',
        note: 'operator inspected transcript and will start a fresh turn',
      },
    })

    expect(recovered).toHaveProperty('result')
    expect(recovered.result).toMatchObject({
      threadId: conversation.id,
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
        kind: 'runtime_intervention',
        payload: {
          intervention_kind: 'app_server_turn_recovery',
          action: 'mark_recovered',
          previous_status: 'stale',
          previous_reason: 'runtime_event_unclosed',
          note: 'operator inspected transcript and will start a fresh turn',
        },
      },
    })

    const saved = loadSession(conversation.id)!
    expect(saved.runtimeEventLog?.events.at(-1)).toMatchObject({
      kind: 'runtime_intervention',
      payload: {
        intervention_kind: 'app_server_turn_recovery',
        action: 'mark_recovered',
      },
    })

    const status = await handleRequest(recoveryRegistry, {
      jsonrpc: '2.0',
      id: 1609,
      method: 'turn/status',
      params: { threadId: conversation.id },
    })
    expect(status.result).toMatchObject({
      status: 'recovered',
      reason: 'app_server_mark_recovered',
      resumeHint: {
        action: 'start_turn',
      },
    })
  })

  it('rejects turn/recover while a restored interaction is still pending', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const interactionStoragePath = join(projectRoot, '.owlcoda', 'app-server', 'approvals.json')
    mkdirSync(join(projectRoot, '.owlcoda', 'app-server'), { recursive: true })
    const conversation = createConversation({ system: 'recover waiting system', model: 'recover-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'needs approval' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-23T04:10:00.000Z',
      turnId: 'runtime-turn-wait-recover-1',
    })
    saveSession(conversation, 'Recover waiting session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const projectId = listProjects(projectRoot).projects[0]!.id
    writeFileSync(interactionStoragePath, JSON.stringify({
      schemaVersion: '1.0',
      interactions: [{
        id: 'approval-2',
        kind: 'tool_approval',
        source: 'live',
        projectId,
        threadId: conversation.id,
        toolName: 'bash',
        input: { command: 'npm test' },
        status: 'pending',
        createdAt: 1782225100000,
      }],
    }, null, 2), 'utf8')
    const recoveryRegistry = createMethodRegistry({ projectRoot, interactionStoragePath })

    const recovered = await handleRequest(recoveryRegistry, {
      jsonrpc: '2.0',
      id: 1610,
      method: 'turn/recover',
      params: { threadId: conversation.id, action: 'mark_recovered' },
    })

    expect(recovered).toHaveProperty('error')
    expect(recovered.error.code).toBe(-32011)
    expect(recovered.error.data).toMatchObject({
      reason: 'pending_interaction',
      status: 'waiting_for_interaction',
      suggestedAction: 'interaction/respond',
    })
  })

  it('publishes an honest completed event when a turn is saved without starting runtime', async () => {
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const noRuntimeRegistry = createMethodRegistry({ eventBus })
    const started = await handleRequest(noRuntimeRegistry, {
      jsonrpc: '2.0',
      id: 161,
      method: 'thread/start',
      params: { title: 'Saved-only desktop thread', model: 'desktop-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(noRuntimeRegistry, {
      jsonrpc: '2.0',
      id: 162,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'persist without runtime' },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      threadId: started.result.thread.id,
      status: 'accepted',
      runtimeStarted: false,
      runtimeStatus: 'saved',
      runtimeReason: 'runtime_not_started',
    })
    expect(events).toEqual([
      expect.objectContaining({ type: 'thread.updated', threadId: started.result.thread.id, turnCount: 0 }),
      expect.objectContaining({ type: 'turn.started', threadId: started.result.thread.id, turnIndex: 0 }),
      expect.objectContaining({ type: 'thread.updated', threadId: started.result.thread.id, turnCount: 1 }),
      expect.objectContaining({
        type: 'turn.completed',
        threadId: started.result.thread.id,
        finalText: '',
        iterations: 0,
        stopReason: 'runtime_not_started',
        runtimeStarted: false,
      }),
    ])
    expect(loadSession(started.result.thread.id)!.turns).toHaveLength(1)
  })

  it('rejects invalid turn/start inputs', async () => {
    const noThreadId = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 17,
      method: 'turn/start',
      params: { input: 'hello' },
    })
    expect(noThreadId).toHaveProperty('error')
    expect(noThreadId.error.code).toBe(-32602)

    const noInput = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 18,
      method: 'turn/start',
      params: { threadId: 'missing-thread-id', input: '   ' },
    })
    expect(noInput).toHaveProperty('error')
    expect(noInput.error.code).toBe(-32602)
  })

  it('interrupts a valid thread honestly when no turn is running', async () => {
    const started = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 19,
      method: 'thread/start',
      params: { title: 'Interrupt desktop thread', model: 'interrupt-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 20,
      method: 'turn/interrupt',
      params: { threadId: started.result.thread.id },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      threadId: started.result.thread.id,
      projectId: started.result.thread.projectId,
      status: 'not_running',
      reason: 'no_active_turn',
    })
  })

  it('rejects interrupt for missing thread sessions', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 21,
      method: 'turn/interrupt',
      params: { threadId: 'missing-thread-id' },
    })

    expect(res).toHaveProperty('error')
    expect(res.error.code).toBe(-32602)
  })

  it('bridges turn/start through an injected conversation loop and emits runtime events', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const runtimeTargetPath = join(projectRoot, 'runtime.log')
    const canonicalRuntimeTargetPath = join(realpathSync(projectRoot), 'runtime.log')
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    let runnerInput = ''
    const loopRunner = async (conversation: any, _dispatcher: unknown, opts: any) => {
      runnerInput = conversation.turns.at(-1)?.content?.[0]?.text ?? ''
      const bashInput = { command: 'printf "runtime\\n" > runtime.log', cwd: projectRoot }
      opts.callbacks.onText('assistant chunk')
      opts.callbacks.onToolStart('bash', bashInput, {
        toolUseId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      })
      opts.callbacks.onToolProgress('bash', {
        lines: ['first line'],
        totalLines: 1,
        totalBytes: 11,
        elapsedMs: 5,
      }, {
        toolUseId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      })
      opts.callbacks.onToolProgress('bash', {
        lines: ['first line', 'second line', 'third line'],
        totalLines: 3,
        totalBytes: 34,
        elapsedMs: 9,
      }, {
        toolUseId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      })
      opts.callbacks.onToolEnd('bash', '[exit code: 0]', false, 12, {
        exitCode: 0,
        writeCaptures: [{
          path: runtimeTargetPath,
          kind: 'redirect_stdout',
          oldContent: null,
          newContent: 'runtime\n',
        }],
      }, {
        toolUseId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      })
      opts.callbacks.onToolStart('edit', { path: 'src/app.ts', old_str: 'old', new_str: 'new' }, {
        toolUseId: 'tool-runtime-2',
        runtimeTurnId: 'runtime-turn-1',
      })
      opts.callbacks.onToolEnd('edit', 'Edited src/app.ts', false, 8, {}, {
        toolUseId: 'tool-runtime-2',
        runtimeTurnId: 'runtime-turn-1',
      })
      return {
        conversation,
        finalText: 'assistant final',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 5, requestCount: 1 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      projectRoot,
      eventBus,
      loopRunner,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 22,
      method: 'thread/start',
      params: { title: 'Loop bridge thread', model: 'loop-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 23,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'run loop now' },
    })

    expect(res).toHaveProperty('result')
    expect(res.result).toMatchObject({
      runtimeStarted: true,
      runtimeStatus: 'running',
    })
    await waitFor(() => events.some(event => event.type === 'turn.completed'))
    expect(runnerInput).toBe('run loop now')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn.started', threadId: started.result.thread.id }),
      expect.objectContaining({ type: 'assistant.delta', threadId: started.result.thread.id, text: 'assistant chunk' }),
      expect.objectContaining({
        type: 'tool.started',
        threadId: started.result.thread.id,
        toolName: 'bash',
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      }),
      expect.objectContaining({
        type: 'command.started',
        threadId: started.result.thread.id,
        commandId: 'tool-runtime-1',
        command: 'printf "runtime\\n" > runtime.log',
        commandRef: `command:${started.result.thread.id}:tool-runtime-1`,
        statusRef: `command-status:${started.result.thread.id}:tool-runtime-1`,
        outputRef: `command-output:${started.result.thread.id}:tool-runtime-1`,
        sourceRefs: [
          expect.objectContaining({
            sourceRef: `bash-source:${started.result.thread.id}:tool-runtime-1:0`,
            path: canonicalRuntimeTargetPath,
            kind: 'redirect_stdout',
            captureStatus: 'pending',
          }),
        ],
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
      }),
      expect.objectContaining({
        type: 'tool.delta',
        threadId: started.result.thread.id,
        toolName: 'bash',
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
        lines: ['first line'],
        delta: 'first line',
        totalLines: 1,
        totalBytes: 11,
        elapsedMs: 5,
      }),
      expect.objectContaining({
        type: 'command.outputDelta',
        threadId: started.result.thread.id,
        commandId: 'tool-runtime-1',
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
        lines: ['first line'],
        delta: 'first line',
        totalLines: 1,
        totalBytes: 11,
        elapsedMs: 5,
        outputRef: `command-output:${started.result.thread.id}:tool-runtime-1`,
        statusRef: `command-status:${started.result.thread.id}:tool-runtime-1`,
      }),
      expect.objectContaining({
        type: 'tool.delta',
        threadId: started.result.thread.id,
        toolName: 'bash',
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
        lines: ['first line', 'second line', 'third line'],
        delta: 'second line\nthird line',
        totalLines: 3,
        totalBytes: 34,
        elapsedMs: 9,
      }),
      expect.objectContaining({
        type: 'tool.completed',
        threadId: started.result.thread.id,
        toolName: 'bash',
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
        durationMs: 12,
      }),
      expect.objectContaining({
        type: 'command.completed',
        threadId: started.result.thread.id,
        commandId: 'tool-runtime-1',
        result: '[exit code: 0]',
        isError: false,
        exitCode: 0,
        commandRef: `command:${started.result.thread.id}:tool-runtime-1`,
        statusRef: `command-status:${started.result.thread.id}:tool-runtime-1`,
        outputRef: `command-output:${started.result.thread.id}:tool-runtime-1`,
        sourceRefs: [
          expect.objectContaining({
            sourceRef: `bash-source:${started.result.thread.id}:tool-runtime-1:0`,
            path: canonicalRuntimeTargetPath,
            kind: 'redirect_stdout',
            captureStatus: 'captured',
          }),
        ],
        toolUseId: 'tool-runtime-1',
        itemId: 'tool-runtime-1',
        runtimeTurnId: 'runtime-turn-1',
        durationMs: 12,
      }),
      expect.objectContaining({
        type: 'diff.started',
        threadId: started.result.thread.id,
        diffId: 'tool-runtime-2',
        toolName: 'edit',
        path: 'src/app.ts',
        operation: 'update',
        toolUseId: 'tool-runtime-2',
        itemId: 'tool-runtime-2',
        runtimeTurnId: 'runtime-turn-1',
      }),
      expect.objectContaining({
        type: 'diff.completed',
        threadId: started.result.thread.id,
        diffId: 'tool-runtime-2',
        toolName: 'edit',
        path: 'src/app.ts',
        operation: 'update',
        result: 'Edited src/app.ts',
        isError: false,
        toolUseId: 'tool-runtime-2',
        itemId: 'tool-runtime-2',
        runtimeTurnId: 'runtime-turn-1',
        durationMs: 8,
      }),
      expect.objectContaining({ type: 'turn.completed', threadId: started.result.thread.id, finalText: 'assistant final' }),
    ]))
  })

  it('bridges tool approval requests through App Server approval methods', async () => {
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    let approvalResult: boolean | null = null
    let runnerFinished = false
    const loopRunner = async (conversation: any, _dispatcher: unknown, opts: any) => {
      approvalResult = await opts.callbacks.onToolApproval('bash', { command: 'npm test' })
      runnerFinished = true
      return {
        conversation,
        finalText: approvalResult ? 'approved' : 'denied',
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      eventBus,
      loopRunner,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 24,
      method: 'thread/start',
      params: { title: 'Approval bridge thread', model: 'loop-model' },
    })
    createdSessions.push(started.result.thread.id)

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 25,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'run a tool that needs approval' },
    })

    let pendingApproval: any = null
    await waitFor(async () => {
      const listed = await handleRequest(loopRegistry, {
        jsonrpc: '2.0',
        id: 26,
        method: 'approval/list',
        params: { threadId: started.result.thread.id },
      })
      pendingApproval = listed.result.approvals[0]
      return Boolean(pendingApproval)
    })

    expect(pendingApproval).toMatchObject({
      projectId: started.result.thread.projectId,
      threadId: started.result.thread.id,
      toolName: 'bash',
      input: { command: 'npm test' },
      status: 'pending',
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.requested',
        threadId: started.result.thread.id,
        approvalId: pendingApproval.id,
        toolName: 'bash',
      }),
    ]))

    const resolved = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 27,
      method: 'approval/resolve',
      params: { approvalId: pendingApproval.id, decision: 'approve' },
    })

    expect(resolved).toHaveProperty('result')
    expect(resolved.result).toMatchObject({
      approvalId: pendingApproval.id,
      status: 'approved',
      threadId: started.result.thread.id,
    })
    await waitFor(() => runnerFinished && approvalResult === true)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.resolved',
        threadId: started.result.thread.id,
        approvalId: pendingApproval.id,
        status: 'approved',
        approved: true,
      }),
      expect.objectContaining({
        type: 'turn.completed',
        threadId: started.result.thread.id,
        finalText: 'approved',
      }),
    ]))

    const listedAfterResolve = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 28,
      method: 'approval/list',
      params: { threadId: started.result.thread.id },
    })
    expect(listedAfterResolve.result.approvals).toEqual([])
  })

  it('bridges task-scope approval and user questions through App Server interactions', async () => {
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    let taskScopeApproved: boolean | null = null
    let userAnswer: string | null = null
    let runnerFinished = false
    const loopRunner = async (conversation: any, _dispatcher: unknown, opts: any) => {
      taskScopeApproved = await opts.callbacks.onTaskScopeApproval({
        toolName: 'write',
        input: { path: 'src/new-file.ts' },
        attemptedPath: 'src/new-file.ts',
        attemptedPaths: ['src/new-file.ts'],
        allowedPaths: ['src/existing.ts'],
        message: 'write outside task scope',
      })
      userAnswer = await opts.callbacks.onUserQuestion('AskUserQuestion', 'Continue?', {
        options: [{ label: 'yes', description: 'Continue' }],
      })
      runnerFinished = true
      return {
        conversation,
        finalText: `${taskScopeApproved}:${userAnswer}`,
        iterations: 1,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      eventBus,
      loopRunner,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 29,
      method: 'thread/start',
      params: { title: 'Interaction bridge thread', model: 'loop-model' },
    })
    createdSessions.push(started.result.thread.id)

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 30,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'needs interaction' },
    })

    let taskScopeInteraction: any = null
    await waitFor(async () => {
      const listed = await handleRequest(loopRegistry, {
        jsonrpc: '2.0',
        id: 31,
        method: 'interaction/list',
        params: { threadId: started.result.thread.id },
      })
      taskScopeInteraction = listed.result.interactions.find((item: any) => item.kind === 'task_scope_approval')
      return Boolean(taskScopeInteraction)
    })
    expect(taskScopeInteraction).toMatchObject({
      projectId: started.result.thread.projectId,
      threadId: started.result.thread.id,
      kind: 'task_scope_approval',
      toolName: 'write',
      taskScope: {
        attemptedPath: 'src/new-file.ts',
        allowedPaths: ['src/existing.ts'],
      },
      status: 'pending',
    })

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 32,
      method: 'interaction/respond',
      params: { interactionId: taskScopeInteraction.id, decision: 'approve' },
    })
    await waitFor(() => taskScopeApproved === true)

    let userQuestion: any = null
    await waitFor(async () => {
      const listed = await handleRequest(loopRegistry, {
        jsonrpc: '2.0',
        id: 33,
        method: 'interaction/list',
        params: { threadId: started.result.thread.id },
      })
      userQuestion = listed.result.interactions.find((item: any) => item.kind === 'user_question')
      return Boolean(userQuestion)
    })
    expect(userQuestion).toMatchObject({
      projectId: started.result.thread.projectId,
      threadId: started.result.thread.id,
      kind: 'user_question',
      toolName: 'AskUserQuestion',
      question: 'Continue?',
      status: 'pending',
    })

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 34,
      method: 'interaction/respond',
      params: { interactionId: userQuestion.id, answer: 'yes' },
    })

    await waitFor(() => runnerFinished && userAnswer === 'yes')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'interaction.requested',
        interactionId: taskScopeInteraction.id,
        kind: 'task_scope_approval',
      }),
      expect.objectContaining({
        type: 'interaction.requested',
        interactionId: userQuestion.id,
        kind: 'user_question',
      }),
      expect.objectContaining({
        type: 'interaction.resolved',
        interactionId: taskScopeInteraction.id,
        status: 'approved',
        approved: true,
      }),
      expect.objectContaining({
        type: 'interaction.resolved',
        interactionId: userQuestion.id,
        status: 'answered',
        answer: 'yes',
      }),
      expect.objectContaining({
        type: 'turn.completed',
        threadId: started.result.thread.id,
        finalText: 'true:yes',
      }),
    ]))
  })

  it('interrupts an active injected conversation loop by aborting its signal', async () => {
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    let activeSignal: AbortSignal | null = null
    let releaseRunner!: () => void
    const loopRunner = async (conversation: any, _dispatcher: unknown, opts: any) => {
      activeSignal = opts.signal
      await new Promise<void>(resolve => {
        releaseRunner = resolve
      })
      return {
        conversation,
        finalText: '',
        iterations: 0,
        stopReason: activeSignal?.aborted ? 'abort' : 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
        runtimeFailure: activeSignal?.aborted
          ? { kind: 'abort', phase: 'request', message: 'aborted', retryable: false }
          : null,
      }
    }
    const loopRegistry = createMethodRegistry({
      eventBus,
      loopRunner,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 29,
      method: 'thread/start',
      params: { title: 'Interrupt active loop', model: 'loop-model' },
    })
    createdSessions.push(started.result.thread.id)

    const turnPromise = handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 30,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'keep running' },
    })
    await waitFor(() => activeSignal !== null)

    const interrupted = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 31,
      method: 'turn/interrupt',
      params: { threadId: started.result.thread.id },
    })

    expect(interrupted).toHaveProperty('result')
    expect(interrupted.result).toMatchObject({
      threadId: started.result.thread.id,
      status: 'interrupted',
      reason: 'abort_signal_sent',
    })
    expect(activeSignal!.aborted).toBe(true)
    releaseRunner()
    await turnPromise
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn.interrupted', threadId: started.result.thread.id, status: 'interrupted' }),
    ]))
  })

  it('rejects concurrent turn/start on the same active thread without appending another user turn', async () => {
    let releaseRunner!: () => void
    const loopRunner = async (conversation: any) => {
      await new Promise<void>(resolve => {
        releaseRunner = resolve
      })
      return {
        conversation,
        finalText: '',
        iterations: 0,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      loopRunner,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 27,
      method: 'thread/start',
      params: { title: 'Concurrent loop thread', model: 'loop-model' },
    })
    createdSessions.push(started.result.thread.id)

    const firstTurn = handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 28,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'first turn' },
    })
    await waitFor(() => loadSession(started.result.thread.id)!.turns.length === 1)

    const secondTurn = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 29,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'second turn' },
    })

    expect(secondTurn).toHaveProperty('error')
    expect(secondTurn.error.code).toBe(-32000)
    expect(loadSession(started.result.thread.id)!.turns).toHaveLength(1)
    releaseRunner()
    await firstTurn
  })

  it('resolves loop options from OwlCoda config when starting a turn', async () => {
    let seenApiBaseUrl = ''
    let seenApiKey = ''
    const loopRunner = async (conversation: any, _dispatcher: unknown, opts: any) => {
      seenApiBaseUrl = opts.apiBaseUrl
      seenApiKey = opts.apiKey
      return {
        conversation,
        finalText: '',
        iterations: 0,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      config: testConfig({
        port: 8124,
        models: [{
          id: 'desktop-model',
          label: 'Desktop Model',
          backendModel: 'backend-model',
          aliases: [],
          provider: 'test',
          tier: 'local',
          default: true,
        } as any],
      }),
      loopRunner,
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 30,
      method: 'thread/start',
      params: { title: 'Config loop thread', model: 'desktop-model' },
    })
    createdSessions.push(started.result.thread.id)

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 31,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'use config' },
    })
    await waitFor(() => seenApiBaseUrl !== '')

    expect(seenApiBaseUrl).toBe('http://127.0.0.1:8124')
    expect(seenApiKey).toBe('owlcoda-local-key-8124')
  })

  it('restores native OwlCoda tool definitions into the runtime loop', async () => {
    let seenToolNames: string[] = []
    const loopRunner = async (conversation: any) => {
      seenToolNames = conversation.tools.map((tool: { name: string }) => tool.name)
      return {
        conversation,
        finalText: '',
        iterations: 0,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
        runtimeFailure: null,
      }
    }
    const loopRegistry = createMethodRegistry({
      config: testConfig({
        models: [{
          id: 'desktop-model',
          label: 'Desktop Model',
          backendModel: 'backend-model',
          aliases: [],
          provider: 'test',
          tier: 'local',
          default: true,
        } as any],
      }),
      loopRunner,
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 3001,
      method: 'thread/start',
      params: { title: 'Tool loop thread', model: 'desktop-model' },
    })
    createdSessions.push(started.result.thread.id)

    await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 3002,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'use a tool' },
    })
    await waitFor(() => seenToolNames.length > 0)

    expect(seenToolNames).toEqual(expect.arrayContaining(['bash', 'read', 'grep']))
  })

  it('rejects turn/start without appending when App Server config has no runnable model', async () => {
    const loopRegistry = createMethodRegistry({
      config: testConfig({ models: [] }),
    } as any)
    const started = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 32,
      method: 'thread/start',
      params: { title: 'Missing config thread', model: 'missing-config-model' },
    })
    createdSessions.push(started.result.thread.id)

    const res = await handleRequest(loopRegistry, {
      jsonrpc: '2.0',
      id: 33,
      method: 'turn/start',
      params: { threadId: started.result.thread.id, input: 'do not append' },
    })

    expect(res).toHaveProperty('error')
    expect(res.error.code).toBe(-32001)
    expect(loadSession(started.result.thread.id)!.turns).toHaveLength(0)
  })

  it('lists, preflights, applies, and reverts an edit review action from a durable session', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'target.txt')
    writeFileSync(targetPath, 'alpha\nbeta\nomega\n', 'utf8')
    const conversation = createConversation({ system: 'review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'edit-1',
        name: 'edit',
        input: {
          path: targetPath,
          oldStr: 'beta',
          newStr: 'BETA',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 34,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed).toHaveProperty('result')
    expect(listed.result.changes).toHaveLength(1)
    expect(listed.result.changes[0]).toMatchObject({
      id: 'edit:edit-1',
      threadId: conversation.id,
      toolUseId: 'edit-1',
      toolName: 'edit',
      path: targetPath,
      operation: 'update',
      reviewStatus: {
        status: 'pending',
        source: 'derived',
      },
    })

    const preflight = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 35,
      method: 'review/preflight',
      params: { threadId: conversation.id, diffId: 'edit:edit-1' },
    })
    expect(preflight.result).toMatchObject({
      status: 'ready',
      reason: 'source_match',
      change: {
        id: 'edit:edit-1',
        path: targetPath,
      },
    })

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 36,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId: 'edit:edit-1' },
    })
    expect(applied.result).toMatchObject({
      status: 'applied',
      change: {
        id: 'edit:edit-1',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('alpha\nBETA\nomega\n')

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 37,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId: 'edit:edit-1' },
    })
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      change: {
        id: 'edit:edit-1',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('alpha\nbeta\nomega\n')
  })

  it('applies and reverts a single review hunk with proof and hunk-scoped status', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'hunk-target.txt')
    writeFileSync(targetPath, 'alpha\nbeta\ngamma\nomega\n', 'utf8')
    const conversation = createConversation({ system: 'review hunk system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'hunk-edit-1',
        name: 'edit',
        input: {
          path: targetPath,
          oldStr: 'beta\ngamma',
          newStr: 'BETA\nGAMMA',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'hunk-edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Review hunk session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const reviewRegistry = createMethodRegistry({ projectRoot, eventBus })
    const diffId = 'edit:hunk-edit-1'
    const hunkId = 'hunk:0'
    const hunkStatusId = `${diffId}#${hunkId}`

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 390,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes[0].hunks).toEqual([
      expect.objectContaining({
        hunkId: 'hunk:0',
        index: 0,
        oldText: 'beta',
        newText: 'BETA',
      }),
      expect.objectContaining({
        hunkId: 'hunk:1',
        index: 1,
        oldText: 'gamma',
        newText: 'GAMMA',
      }),
    ])

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 391,
      method: 'review/hunkApply',
      params: { threadId: conversation.id, diffId, hunkId },
    })
    expect(applied).toHaveProperty('result')
    expect(applied.result).toMatchObject({
      status: 'applied',
      reason: 'source_match',
      diffId,
      hunkId,
      hunk: {
        hunkId,
        index: 0,
        oldText: 'beta',
        newText: 'BETA',
      },
      proof: {
        kind: 'review_hunk_action',
        status: 'applied',
        action: 'apply',
        threadId: conversation.id,
        diffId,
        hunkId,
        path: targetPath,
      },
      reviewStatus: {
        diffId: hunkStatusId,
        status: 'applied',
        source: 'stored',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('alpha\nBETA\ngamma\nomega\n')

    const afterApply = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 392,
      method: 'review/statusList',
      params: { threadId: conversation.id },
    })
    expect(afterApply.result.statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        diffId: hunkStatusId,
        status: 'applied',
        updatedBy: 'app-server',
        source: 'stored',
      }),
    ]))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'review.statusUpdated',
        threadId: conversation.id,
        diffId: hunkStatusId,
        status: 'applied',
      }),
    ]))

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 393,
      method: 'review/hunkRevert',
      params: { threadId: conversation.id, diffId, hunkId },
    })
    expect(reverted).toHaveProperty('result')
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      reason: 'source_match',
      diffId,
      hunkId,
      proof: {
        kind: 'review_hunk_action',
        status: 'reverted',
        action: 'revert',
      },
      reviewStatus: {
        diffId: hunkStatusId,
        status: 'reverted',
        source: 'stored',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('alpha\nbeta\ngamma\nomega\n')
  })

  it('blocks hunk actions for full-file review changes with proof data and without writes', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'hunk-full-file-target.txt')
    writeFileSync(targetPath, 'after write\n', 'utf8')
    const conversation = createConversation({ system: 'review hunk full file system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'hunk-write-1',
        name: 'write',
        input: {
          path: targetPath,
          content: 'after write\n',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'hunk-write-1',
        content: `Wrote ${targetPath}`,
        is_error: false,
        metadata: {
          path: targetPath,
          oldContent: 'before write\n',
          newContent: 'after write\n',
          changeKind: 'overwrite',
        },
      }],
    })
    saveSession(conversation, 'Review hunk full file session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const blocked = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 394,
      method: 'review/hunkApply',
      params: { threadId: conversation.id, diffId: 'write:hunk-write-1', hunkId: 'hunk:0' },
    })

    expect(blocked).toHaveProperty('error')
    expect(blocked.error).toMatchObject({
      code: -32010,
      data: {
        reason: 'unsupported_source',
        proof: {
          kind: 'review_hunk_action',
          status: 'blocked',
          action: 'apply',
          diffId: 'write:hunk-write-1',
          hunkId: 'hunk:0',
          path: targetPath,
        },
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('after write\n')
  })

  it('persists review status updates and annotates review/list results', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'status-target.txt')
    writeFileSync(targetPath, 'keep\nold\n', 'utf8')
    const conversation = createConversation({ system: 'review status system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'status-edit-1',
        name: 'edit',
        input: {
          path: targetPath,
          oldStr: 'old',
          newStr: 'new',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'status-edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Review status session', { cwd: projectRoot })
    createdSessions.push(conversation.id)

    const diffId = 'edit:status-edit-1'
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const reviewRegistry = createMethodRegistry({ projectRoot, eventBus })

    const initial = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 381,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(initial.result.changes[0].reviewStatus).toMatchObject({
      threadId: conversation.id,
      diffId,
      status: 'pending',
      source: 'derived',
    })

    const updated = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 382,
      method: 'review/statusUpdate',
      params: {
        threadId: conversation.id,
        diffId,
        status: 'accepted',
        note: 'Palot accepted this change',
        updatedBy: 'palot',
      },
    })
    expect(updated).toHaveProperty('result')
    expect(updated.result).toMatchObject({
      threadId: conversation.id,
      diffId,
      status: {
        threadId: conversation.id,
        diffId,
        status: 'accepted',
        note: 'Palot accepted this change',
        updatedBy: 'palot',
        source: 'stored',
      },
    })
    expect(updated.result.status.updatedAt).toEqual(expect.any(Number))

    const statusEvent = events.find((event: any) => event.type === 'review.statusUpdated') as any
    expect(statusEvent).toMatchObject({
      type: 'review.statusUpdated',
      threadId: conversation.id,
      diffId,
      status: 'accepted',
      updatedBy: 'palot',
    })

    const restartedRegistry = createMethodRegistry({ projectRoot })
    const listed = await handleRequest(restartedRegistry, {
      jsonrpc: '2.0',
      id: 383,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes[0].reviewStatus).toMatchObject({
      threadId: conversation.id,
      diffId,
      status: 'accepted',
      note: 'Palot accepted this change',
      updatedBy: 'palot',
      source: 'stored',
    })

    const statuses = await handleRequest(restartedRegistry, {
      jsonrpc: '2.0',
      id: 384,
      method: 'review/statusList',
      params: { threadId: conversation.id },
    })
    expect(statuses.result).toMatchObject({
      threadId: conversation.id,
      statuses: [
        expect.objectContaining({
          diffId,
          status: 'accepted',
          source: 'stored',
        }),
      ],
    })
  })

  it('rejects review status updates for unknown changes', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'empty review status system', model: 'review-model' })
    saveSession(conversation, 'Empty review status session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const result = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 385,
      method: 'review/statusUpdate',
      params: {
        threadId: conversation.id,
        diffId: 'edit:missing',
        status: 'accepted',
      },
    })

    expect(result).toHaveProperty('error')
    expect(result.error).toMatchObject({
      code: -32602,
      message: 'Review change not found for project',
    })
  })

  it('persists successful review apply and revert status updates', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'action-status-target.txt')
    writeFileSync(targetPath, 'one\ntwo\n', 'utf8')
    const conversation = createConversation({ system: 'review action status system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'action-status-edit-1',
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
        tool_use_id: 'action-status-edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Review action status session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })
    const diffId = 'edit:action-status-edit-1'

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 386,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId },
    })
    expect(applied).toHaveProperty('result')

    const afterApply = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 387,
      method: 'review/statusList',
      params: { threadId: conversation.id },
    })
    expect(afterApply.result.statuses[0]).toMatchObject({
      diffId,
      status: 'applied',
      updatedBy: 'app-server',
      source: 'stored',
    })

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 388,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId },
    })
    expect(reverted).toHaveProperty('result')

    const afterRevert = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 389,
      method: 'review/statusList',
      params: { threadId: conversation.id },
    })
    expect(afterRevert.result.statuses[0]).toMatchObject({
      diffId,
      status: 'reverted',
      updatedBy: 'app-server',
      source: 'stored',
    })
  })

  it('lists, reverts, and reapplies a write review action from durable tool metadata', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'write-target.txt')
    writeFileSync(targetPath, 'after write\n', 'utf8')
    const conversation = createConversation({ system: 'write review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'write-1',
        name: 'write',
        input: {
          path: targetPath,
          content: 'after write\n',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'write-1',
        content: `Wrote ${targetPath}`,
        is_error: false,
        metadata: {
          path: targetPath,
          oldContent: 'before write\n',
          newContent: 'after write\n',
          changeKind: 'overwrite',
        },
      }],
    })
    saveSession(conversation, 'Write review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 38,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes).toHaveLength(1)
    expect(listed.result.changes[0]).toMatchObject({
      id: 'write:write-1',
      threadId: conversation.id,
      toolUseId: 'write-1',
      toolName: 'write',
      path: targetPath,
      operation: 'overwrite',
    })

    const preflight = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 39,
      method: 'review/preflight',
      params: { threadId: conversation.id, diffId: 'write:write-1' },
    })
    expect(preflight.result).toMatchObject({
      status: 'already_applied',
      reason: 'already_applied',
    })

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 40,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId: 'write:write-1' },
    })
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      change: {
        id: 'write:write-1',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('before write\n')

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 41,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId: 'write:write-1' },
    })
    expect(applied.result).toMatchObject({
      status: 'applied',
      change: {
        id: 'write:write-1',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('after write\n')
  })

  it('lists, reverts, and reapplies a NotebookEdit review action from durable full-file metadata', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const notebookPath = join(projectRoot, 'notebook.ipynb')
    const oldNotebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'code', id: 'cell-a', source: 'x = 1', metadata: {}, execution_count: 3, outputs: [{ text: 'old' }] },
      ],
    }
    const newNotebook = {
      ...oldNotebook,
      cells: [
        { cell_type: 'code', id: 'cell-a', source: 'x = 2', metadata: {}, execution_count: null, outputs: [] },
      ],
    }
    const oldContent = JSON.stringify(oldNotebook, null, 1)
    const newContent = JSON.stringify(newNotebook, null, 1)
    writeFileSync(notebookPath, newContent, 'utf8')
    const conversation = createConversation({ system: 'notebook review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'notebook-1',
        name: 'NotebookEdit',
        input: {
          notebook_path: notebookPath,
          cell_id: 'cell-a',
          new_source: 'x = 2',
          edit_mode: 'replace',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'notebook-1',
        content: `Updated cell cell-a in ${notebookPath}`,
        is_error: false,
        metadata: {
          notebook_path: notebookPath,
          oldContent,
          newContent,
          changeKind: 'notebook_replace',
        },
      }],
    })
    saveSession(conversation, 'Notebook review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 42,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes).toHaveLength(1)
    expect(listed.result.changes[0]).toMatchObject({
      id: 'NotebookEdit:notebook-1',
      threadId: conversation.id,
      toolUseId: 'notebook-1',
      toolName: 'NotebookEdit',
      path: notebookPath,
      operation: 'notebook_replace',
    })

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 43,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId: 'NotebookEdit:notebook-1' },
    })
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      change: {
        id: 'NotebookEdit:notebook-1',
      },
    })
    expect(readFileSync(notebookPath, 'utf8')).toBe(oldContent)

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 44,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId: 'NotebookEdit:notebook-1' },
    })
    expect(applied.result).toMatchObject({
      status: 'applied',
      change: {
        id: 'NotebookEdit:notebook-1',
      },
    })
    expect(readFileSync(notebookPath, 'utf8')).toBe(newContent)
  })

  it('preflights, applies, and reverts review batches without partial writes', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const firstPath = join(projectRoot, 'batch-first.txt')
    const secondPath = join(projectRoot, 'batch-second.txt')
    writeFileSync(firstPath, 'first old\n', 'utf8')
    writeFileSync(secondPath, 'second old\n', 'utf8')
    const conversation = createConversation({ system: 'batch review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [
        {
          type: 'tool_use',
          id: 'batch-edit-1',
          name: 'edit',
          input: {
            path: firstPath,
            oldStr: 'first old',
            newStr: 'first new',
          },
        },
        {
          type: 'tool_use',
          id: 'batch-edit-2',
          name: 'edit',
          input: {
            path: secondPath,
            oldStr: 'second old',
            newStr: 'second new',
          },
        },
      ],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'batch-edit-1',
          content: `Edited ${firstPath}`,
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'batch-edit-2',
          content: `Edited ${secondPath}`,
          is_error: false,
        },
      ],
    })
    saveSession(conversation, 'Batch review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })
    const diffIds = ['edit:batch-edit-1', 'edit:batch-edit-2']

    const preflight = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 45,
      method: 'review/batchPreflight',
      params: { threadId: conversation.id, diffIds },
    })
    expect(preflight).toHaveProperty('result')
    expect(preflight.result).toMatchObject({
      status: 'ready',
      threadId: conversation.id,
      diffIds,
      blocked: [],
    })
    expect(preflight.result.preflights).toHaveLength(2)

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 46,
      method: 'review/batchApply',
      params: { threadId: conversation.id, diffIds },
    })
    expect(applied).toHaveProperty('result')
    expect(applied.result).toMatchObject({
      status: 'applied',
      threadId: conversation.id,
      diffIds,
      transaction: {
        transactionId: `review-batch:${conversation.id}:apply:edit:batch-edit-1,edit:batch-edit-2`,
        action: 'apply',
        applied: ['edit:batch-edit-1', 'edit:batch-edit-2'],
        rolledBack: [],
        failed: [],
        rollbackFailed: [],
      },
      proof: {
        kind: 'review_batch_transaction',
        transactionId: `review-batch:${conversation.id}:apply:edit:batch-edit-1,edit:batch-edit-2`,
        status: 'applied',
      },
    })
    expect(applied.result.results).toHaveLength(2)
    expect(readFileSync(firstPath, 'utf8')).toBe('first new\n')
    expect(readFileSync(secondPath, 'utf8')).toBe('second new\n')

    const appliedStatuses = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 461,
      method: 'review/statusList',
      params: { threadId: conversation.id, diffIds },
    })
    expect(appliedStatuses.result.statuses).toEqual([
      expect.objectContaining({
        diffId: 'edit:batch-edit-1',
        status: 'applied',
        note: `transaction:${applied.result.transaction.transactionId}`,
      }),
      expect.objectContaining({
        diffId: 'edit:batch-edit-2',
        status: 'applied',
        note: `transaction:${applied.result.transaction.transactionId}`,
      }),
    ])

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 47,
      method: 'review/batchRevert',
      params: { threadId: conversation.id, diffIds },
    })
    expect(reverted).toHaveProperty('result')
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      threadId: conversation.id,
      diffIds,
      transaction: {
        transactionId: `review-batch:${conversation.id}:revert:edit:batch-edit-1,edit:batch-edit-2`,
        action: 'revert',
        applied: ['edit:batch-edit-1', 'edit:batch-edit-2'],
        rolledBack: [],
        failed: [],
        rollbackFailed: [],
      },
      proof: {
        kind: 'review_batch_transaction',
        transactionId: `review-batch:${conversation.id}:revert:edit:batch-edit-1,edit:batch-edit-2`,
        status: 'reverted',
      },
    })
    expect(reverted.result.results).toHaveLength(2)
    expect(readFileSync(firstPath, 'utf8')).toBe('first old\n')
    expect(readFileSync(secondPath, 'utf8')).toBe('second old\n')

    writeFileSync(secondPath, 'second drift\n', 'utf8')
    const blocked = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 48,
      method: 'review/batchApply',
      params: { threadId: conversation.id, diffIds },
    })
    expect(blocked).toHaveProperty('error')
    expect(blocked.error).toMatchObject({
      code: -32010,
      data: {
        reason: 'batch_preflight_blocked',
        preflight: {
          status: 'blocked',
          blocked: [
            expect.objectContaining({
              status: 'blocked',
              reason: 'source_mismatch',
              change: expect.objectContaining({
                id: 'edit:batch-edit-2',
              }),
            }),
          ],
        },
      },
    })
    expect(readFileSync(firstPath, 'utf8')).toBe('first old\n')
    expect(readFileSync(secondPath, 'utf8')).toBe('second drift\n')
  })

  it('rolls back already-written review batch items when a later write fails', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const firstPath = join(projectRoot, 'rollback-first.txt')
    const secondPath = join(projectRoot, 'rollback-second.txt')
    writeFileSync(firstPath, 'first old\n', 'utf8')
    writeFileSync(secondPath, 'second old\n', 'utf8')
    chmodSync(secondPath, 0o444)
    const conversation = createConversation({ system: 'batch rollback system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [
        {
          type: 'tool_use',
          id: 'rollback-edit-1',
          name: 'edit',
          input: {
            path: firstPath,
            oldStr: 'first old',
            newStr: 'first new',
          },
        },
        {
          type: 'tool_use',
          id: 'rollback-edit-2',
          name: 'edit',
          input: {
            path: secondPath,
            oldStr: 'second old',
            newStr: 'second new',
          },
        },
      ],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'rollback-edit-1',
          content: `Edited ${firstPath}`,
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'rollback-edit-2',
          content: `Edited ${secondPath}`,
          is_error: false,
        },
      ],
    })
    saveSession(conversation, 'Batch rollback session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const reviewRegistry = createMethodRegistry({ projectRoot, eventBus })
    const diffIds = ['edit:rollback-edit-1', 'edit:rollback-edit-2']

    const failed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 481,
      method: 'review/batchApply',
      params: { threadId: conversation.id, diffIds },
    })

    expect(failed).toHaveProperty('error')
    expect(failed.error).toMatchObject({
      code: -32010,
      data: {
        reason: 'batch_transaction_failed',
        transaction: {
          transactionId: `review-batch:${conversation.id}:apply:edit:rollback-edit-1,edit:rollback-edit-2`,
          action: 'apply',
          applied: ['edit:rollback-edit-1'],
          rolledBack: ['edit:rollback-edit-1'],
          failed: [
            expect.objectContaining({
              diffId: 'edit:rollback-edit-2',
            }),
          ],
          rollbackFailed: [],
        },
        proof: {
          kind: 'review_batch_transaction',
          transactionId: `review-batch:${conversation.id}:apply:edit:rollback-edit-1,edit:rollback-edit-2`,
          status: 'rolled_back',
        },
      },
    })
    expect(readFileSync(firstPath, 'utf8')).toBe('first old\n')
    expect(readFileSync(secondPath, 'utf8')).toBe('second old\n')

    const reviewEvent = events.find((event: any) => event.type === 'review.batchCompleted') as any
    expect(reviewEvent).toMatchObject({
      type: 'review.batchCompleted',
      action: 'apply',
      status: 'failed',
      transactionId: `review-batch:${conversation.id}:apply:edit:rollback-edit-1,edit:rollback-edit-2`,
      items: [
        expect.objectContaining({
          diffId: 'edit:rollback-edit-1',
          status: 'rolled_back',
        }),
        expect.objectContaining({
          diffId: 'edit:rollback-edit-2',
          status: 'failed',
        }),
      ],
    })
  })

  it('emits item-level review batch events for renderer surfaces', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'event-review.txt')
    writeFileSync(targetPath, 'event old\n', 'utf8')
    const conversation = createConversation({ system: 'review event system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'event-edit-1',
        name: 'edit',
        input: {
          path: targetPath,
          oldStr: 'event old',
          newStr: 'event new',
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'event-edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
      }],
    })
    saveSession(conversation, 'Review event session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const reviewRegistry = createMethodRegistry({ projectRoot, eventBus })

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 57,
      method: 'review/batchApply',
      params: { threadId: conversation.id, diffIds: ['edit:event-edit-1'] },
    })

    expect(applied).toHaveProperty('result')
    const reviewEvent = events.find((event: any) => event.type === 'review.batchCompleted') as any
    expect(reviewEvent).toMatchObject({
      type: 'review.batchCompleted',
      projectId: expect.any(String),
      threadId: conversation.id,
      action: 'apply',
      status: 'applied',
      diffIds: ['edit:event-edit-1'],
      items: [{
        diffId: 'edit:event-edit-1',
        status: 'applied',
        reason: 'source_match',
        path: targetPath,
        toolName: 'edit',
        operation: 'update',
        mode: 'string-replace',
      }],
    })
  })

  it('lists, reverts, and reapplies a captured bash source-map review action', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'bash-captured.txt')
    writeFileSync(targetPath, 'after bash\n', 'utf8')
    const canonicalTargetPath = realpathSync(targetPath)
    const conversation = createConversation({ system: 'bash captured review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'bash-captured-1',
        name: 'bash',
        input: {
          command: 'printf "after bash\\n" > bash-captured.txt',
          cwd: projectRoot,
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'bash-captured-1',
        content: '[exit code: 0]',
        is_error: false,
        metadata: {
          writeCaptures: [{
            path: canonicalTargetPath,
            kind: 'redirect_stdout',
            oldContent: 'before bash\n',
            newContent: 'after bash\n',
          }],
        },
      }],
    })
    saveSession(conversation, 'Bash captured review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 49,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes).toHaveLength(1)
    expect(listed.result.changes[0]).toMatchObject({
      id: 'bash:bash-captured-1:0',
      threadId: conversation.id,
      toolUseId: 'bash-captured-1',
      toolName: 'bash',
      path: canonicalTargetPath,
      operation: 'redirect_stdout',
      mode: 'full-file',
      oldText: 'before bash\n',
      newText: 'after bash\n',
      bashProvenance: {
        commandRef: `command:${conversation.id}:bash-captured-1`,
        statusRef: `command-status:${conversation.id}:bash-captured-1`,
        outputRef: `command-output:${conversation.id}:bash-captured-1`,
        sourceCaptureStatus: 'captured',
        sourceRefs: [
          expect.objectContaining({
            sourceRef: `bash-source:${conversation.id}:bash-captured-1:0`,
            path: canonicalTargetPath,
            kind: 'redirect_stdout',
            captureStatus: 'captured',
          }),
        ],
      },
    })

    const preflight = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 50,
      method: 'review/preflight',
      params: { threadId: conversation.id, diffId: 'bash:bash-captured-1:0' },
    })
    expect(preflight.result).toMatchObject({
      status: 'already_applied',
      reason: 'already_applied',
    })

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 51,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId: 'bash:bash-captured-1:0' },
    })
    expect(reverted.result).toMatchObject({
      status: 'reverted',
      change: {
        id: 'bash:bash-captured-1:0',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('before bash\n')

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 52,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId: 'bash:bash-captured-1:0' },
    })
    expect(applied.result).toMatchObject({
      status: 'applied',
      change: {
        id: 'bash:bash-captured-1:0',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('after bash\n')
  })

  it('surfaces bash write provenance as a blocked review item without writing files', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'bash-target.txt')
    writeFileSync(targetPath, 'bash should stay\n', 'utf8')
    const canonicalTargetPath = realpathSync(targetPath)
    const conversation = createConversation({ system: 'bash review system', model: 'review-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'tool_use',
        id: 'bash-1',
        name: 'bash',
        input: {
          command: 'rm bash-target.txt',
          cwd: projectRoot,
        },
      }],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 2,
      content: [{
        type: 'tool_result',
        tool_use_id: 'bash-1',
        content: '[exit code: 0]',
        is_error: false,
      }],
    })
    saveSession(conversation, 'Bash review session', { cwd: projectRoot })
    createdSessions.push(conversation.id)
    const reviewRegistry = createMethodRegistry({ projectRoot })

    const listed = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 53,
      method: 'review/list',
      params: { threadId: conversation.id },
    })
    expect(listed.result.changes).toHaveLength(1)
    expect(listed.result.changes[0]).toMatchObject({
      id: 'bash:bash-1:0',
      threadId: conversation.id,
      toolUseId: 'bash-1',
      toolName: 'bash',
      path: canonicalTargetPath,
      operation: 'rm',
      mode: 'provenance-only',
      bashProvenance: {
        commandRef: `command:${conversation.id}:bash-1`,
        statusRef: `command-status:${conversation.id}:bash-1`,
        outputRef: `command-output:${conversation.id}:bash-1`,
        sourceCaptureStatus: 'unavailable',
        sourceRefs: [
          expect.objectContaining({
            sourceRef: `bash-source:${conversation.id}:bash-1:0`,
            path: canonicalTargetPath,
            kind: 'rm',
            captureStatus: 'unavailable',
          }),
        ],
      },
    })

    const preflight = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 54,
      method: 'review/preflight',
      params: { threadId: conversation.id, diffId: 'bash:bash-1:0' },
    })
    expect(preflight.result).toMatchObject({
      status: 'blocked',
      reason: 'provenance_incomplete',
      change: {
        id: 'bash:bash-1:0',
      },
    })

    const applied = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 55,
      method: 'review/apply',
      params: { threadId: conversation.id, diffId: 'bash:bash-1:0' },
    })
    expect(applied).toHaveProperty('error')
    expect(applied.error).toMatchObject({
      code: -32010,
      data: {
        reason: 'provenance_incomplete',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('bash should stay\n')

    const reverted = await handleRequest(reviewRegistry, {
      jsonrpc: '2.0',
      id: 56,
      method: 'review/revert',
      params: { threadId: conversation.id, diffId: 'bash:bash-1:0' },
    })
    expect(reverted).toHaveProperty('error')
    expect(reverted.error).toMatchObject({
      code: -32010,
      data: {
        reason: 'provenance_incomplete',
      },
    })
    expect(readFileSync(targetPath, 'utf8')).toBe('bash should stay\n')
  })

  it('appends proof through proof/append and exposes readback on runtime rail', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    createRunKitTruthFixture(projectRoot)
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const truthRegistry = createMethodRegistry({ projectRoot, eventBus })

    const appended = await handleRequest(truthRegistry, {
      jsonrpc: '2.0',
      id: 57,
      method: 'proof/append',
      params: {
        kind: 'test_result',
        title: 'App Server tests passed',
        status: 'passed',
        detail: 'npm test -- tests/native/app-server',
      },
    })

    expect(appended).toHaveProperty('result')
    expect(appended.result).toMatchObject({
      status: 'appended',
      proof: {
        kind: 'test_result',
        title: 'App Server tests passed',
        status: 'passed',
        sourceRef: expect.stringMatching(/^\.owlrunkit\/proofs\/proof-/),
      },
      readback: {
        freshness: 'fresh',
      },
    })
    const rail = await handleRequest(truthRegistry, {
      jsonrpc: '2.0',
      id: 58,
      method: 'runtimeRail/read',
      params: {},
    })
    expect(rail.result.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Existing proof',
        sourceRef: '.owlrunkit/proofs/existing-proof.json',
      }),
      expect.objectContaining({
        title: 'App Server tests passed',
        status: 'passed',
      }),
    ]))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'proof.appended',
        projectId: expect.any(String),
        proof: expect.objectContaining({ title: 'App Server tests passed' }),
      }),
      expect.objectContaining({
        type: 'runtimeRail.updated',
        freshness: 'fresh',
        source: 'project_truth_packet',
      }),
    ]))
  })

  it('confirms a RunKit gate through gate/confirm and verifies readback', async () => {
    const projectRoot = makeTemporaryProjectRoot()
    createRunKitTruthFixture(projectRoot)
    const eventBus = createAppServerEventBus()
    const events: AppServerEvent[] = []
    eventBus.subscribe(event => events.push(event))
    const truthRegistry = createMethodRegistry({ projectRoot, eventBus })

    const confirmed = await handleRequest(truthRegistry, {
      jsonrpc: '2.0',
      id: 59,
      method: 'gate/confirm',
      params: {
        gateId: 'confirm-flow',
        note: '流程真源已确认',
        confirmedBy: 'Codex Desktop',
      },
    })

    expect(confirmed).toHaveProperty('result')
    expect(confirmed.result).toMatchObject({
      status: 'confirmed',
      gateId: 'confirm-flow',
      readback: {
        freshness: 'fresh',
        gate: {
          currentGate: null,
          passedGates: ['confirm-architecture', 'confirm-flow'],
          awaitingHuman: false,
        },
      },
    })
    const gateFile = JSON.parse(readFileSync(join(projectRoot, '.owlrunkit', 'state', 'governance-gate.json'), 'utf8')) as {
      passed_gates: string[]
      awaiting_human: boolean
      confirmations: Array<{ gate_id: string; confirmed_by: string; note: string }>
    }
    expect(gateFile.passed_gates).toEqual(['confirm-architecture', 'confirm-flow'])
    expect(gateFile.awaiting_human).toBe(false)
    expect(gateFile.confirmations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gate_id: 'confirm-flow',
        confirmed_by: 'Codex Desktop',
        note: '流程真源已确认',
      }),
    ]))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate.confirmed',
        gateId: 'confirm-flow',
      }),
      expect.objectContaining({
        type: 'runtimeRail.updated',
        freshness: 'fresh',
        source: 'project_truth_packet',
      }),
    ]))
  })

  it('returns error for unknown method', async () => {
    const res = await handleRequest(registry, {
      jsonrpc: '2.0',
      id: 5,
      method: 'unknown/method',
      params: {},
    })
    expect(res).toHaveProperty('error')
    expect(res.error.code).toBe(-32601)
  })
})

function makeTemporaryProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-review-'))
  temporaryProjectRoots.push(root)
  return root
}

function createRunKitTruthFixture(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.owlrunkit', 'agent-inbox'), { recursive: true })
  mkdirSync(join(projectRoot, '.owlrunkit', 'state'), { recursive: true })
  mkdirSync(join(projectRoot, '.owlrunkit', 'proofs'), { recursive: true })

  writeFileSync(join(projectRoot, '.owlrunkit', 'agent-inbox', 'thread-a.packet.json'), JSON.stringify({
    schema_version: '1.0',
    generated_at: '2026-06-23T00:00:00Z',
    generated_by: 'runkit-agent-hook',
    project: 'OwlCoda',
    subject_id: 'owlcoda',
    truth_fingerprint: 'truth-before-write',
    claim: {
      agent: 'Codex',
      goal_id: 'desktop-shell',
      status: 'active',
      handling: ['desktop'],
      handling_source: 'test',
      cwd: projectRoot,
      source_ref: '.owlrunkit/session-claims/thread-a.json',
    },
    gate: {
      sequence_id: 'coding-init',
      current_gate: 'confirm-flow',
      passed_gates: ['confirm-architecture'],
      awaiting_human: true,
      source_ref: '.owlrunkit/state/governance-gate.json',
    },
    proofs: [{
      kind: 'manual_note',
      title: 'Existing proof',
      status: 'passed',
      source_ref: '.owlrunkit/proofs/existing-proof.json',
      at: '2026-06-23T00:01:00Z',
    }],
    provenance: {
      truth_refs: ['.owlrunkit/state/governance-gate.json'],
      proof_refs: ['.owlrunkit/proofs/existing-proof.json'],
    },
    volatile: {
      thread_id: 'thread-a',
      packet_ref: '.owlrunkit/agent-inbox/thread-a.packet.json',
    },
  }), 'utf8')

  writeFileSync(join(projectRoot, '.owlrunkit', 'proofs', 'existing-proof.json'), JSON.stringify({
    schema_version: '1.0',
    kind: 'manual_note',
    title: 'Existing proof',
    status: 'passed',
  }), 'utf8')

  writeFileSync(join(projectRoot, '.owlrunkit', 'state', 'governance-gate.json'), JSON.stringify({
    schema_version: '1.1',
    sequence_id: 'coding-init',
    gates: [
      { id: 'confirm-architecture', prompt: '确认架构真源已讲清' },
      { id: 'confirm-flow', prompt: '确认流程真源已讲清' },
    ],
    current_gate: 'confirm-flow',
    passed_gates: ['confirm-architecture'],
    awaiting_human: true,
    confirmations: [{
      gate_id: 'confirm-architecture',
      confirmed_by: 'Codex',
      note: '架构真源已确认',
      confirmed_at: '2026-06-23T00:00:00Z',
      source_ref: '.owlrunkit/state/governance-gate.json',
    }],
  }), 'utf8')
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

function testConfig(overrides: Partial<OwlCodaConfig> = {}): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    localRuntimeProtocol: 'auto',
    routerTimeoutMs: 600_000,
    models: [],
    responseModelStyle: 'platform',
    logLevel: 'info',
    catalogLoaded: false,
    middleware: {},
    skillInjection: true,
    trainingCollection: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}

function providerEvalRecord(input: {
  providerId: string
  modelId: string
  caseId: string
  passed: boolean
  score: number
  error?: string
}): BenchmarkProviderEvalStoreRecord {
  return {
    schemaVersion: 1,
    recordedAt: '2026-06-26T08:00:00.000Z',
    providerId: input.providerId,
    modelId: input.modelId,
    caseId: input.caseId,
    runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
    livePassed: input.passed,
    hasActualResult: input.passed,
    error: input.error,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      durationMs: 1000,
    },
    diffSummary: {
      artifactMismatchCount: input.passed ? 0 : 1,
      verificationMismatchCount: input.passed ? 0 : 1,
      hasFinalStatusMismatch: !input.passed,
      hasTaskNoProgressMismatch: false,
      hasTimeToFirstWriteMismatch: false,
      hasTraceMismatch: false,
    },
    scorecard: {
      runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
      overallScore: input.score,
      verdict: input.passed ? 'pass' : 'fail',
      antiCheat: input.passed ? 'pass' : 'warn',
    },
    trajectory: {
      recordCount: 1,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
    },
    evidenceRefs: [`artifact:${input.caseId}`],
  }
}
