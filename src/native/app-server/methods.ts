import { isAbsolute, join, resolve } from 'node:path'
import {
  createJsonRpcFailure,
  createJsonRpcSuccess,
  JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc.js'
import { listProjects } from './project-service.js'
import { readRuntimeRail } from './runtime-rail-service.js'
import { interruptTurn, listThreads, resumeThread, startThread, startTurn } from './thread-service.js'
import {
  applyReviewChange,
  applyReviewHunk,
  batchApplyReviewChanges,
  batchPreflightReviewChanges,
  batchRevertReviewChanges,
  listReviewChanges,
  preflightReviewChange,
  revertReviewChange,
  revertReviewHunk,
  type ReviewActionResult,
  type ReviewBatchActionResult,
  type ReviewChange,
  type ReviewHunkActionResult,
  type ReviewPreflightResult,
} from './review-action-service.js'
import {
  annotateReviewChanges,
  isReviewStatusValue,
  listReviewStatuses,
  updateReviewStatus,
  type ReviewStatusUpdateResult,
  type ReviewStatusValue,
} from './review-status-service.js'
import {
  createAppServerApprovalBroker,
  type AppServerApprovalBroker,
  type AppServerApprovalDecision,
} from './approval-service.js'
import { readRuntimeTranscript } from './runtime-transcript-service.js'
import { recoverTurn, readTurnStatus, type AppServerTurnStatusResult } from './turn-status-service.js'
import { appendRunKitProof, confirmRunKitGate } from './truth-gateway.js'
import {
  APP_SERVER_PROTOCOL_VERSION,
  describeAppServerProtocol,
} from './protocol-contract.js'
import {
  buildBenchmarkProviderEvalBatchReport,
  formatBenchmarkProviderEvalBatchReport,
} from '../../benchmark/provider-eval-report.js'
import {
  getBenchmarkProviderEvalPath,
  readBenchmarkProviderEvalRecords,
} from '../../benchmark/provider-eval-store.js'
import type { AppServerEventBus } from './event-stream.js'
import { runConversationLoop, type ConversationLoopOptions, type ToolRuntimeItemMetadata } from '../conversation.js'
import { ToolDispatcher } from '../dispatch.js'
import { buildNativeToolDefs } from '../tool-defs.js'
import { loadSession, restoreConversation, saveSession, type SessionFile } from '../session.js'
import type { Conversation, ConversationModelIdentity } from '../protocol/types.js'
import type { ToolProgressEvent } from '../tools/types.js'
import type { OwlCodaConfig } from '../../config.js'
import { resolveAppServerLoopConfig } from './loop-config.js'
import { buildRuntimeHealthSnapshot } from '../runtime-health.js'
import { listJobs } from '../job-supervisor.js'
import { readArtifactLedger, type RunArtifactRecord } from '../run-workspace.js'
import { collectRuntimeFactsForRun } from '../runtime-facts.js'
import {
  buildRunScorecard,
  buildRunTrajectory,
  summarizeRunScorecard,
} from '../scorecard.js'
import { buildStructuredOutputArtifactsPanel } from './structured-output-artifacts.js'
import {
  buildWorkflowConsumerManifest,
  listWorkflowRuns,
  WorkflowRunNotFoundError,
} from '../workflow-consumer.js'
import {
  createJobCancelTool,
  createJobGetTool,
  createJobListTool,
} from '../tools/job.js'
import type { ToolResult } from '../tools/types.js'
import { canonicalizeProvenancePath, extractWriteTargets } from '../write-provenance.js'
import type { BashSourceCaptureStatus, BashSourceRef } from './review-action-service.js'

export const APP_SERVER_SCHEMA_VERSION = APP_SERVER_PROTOCOL_VERSION

export type AppServerMethod =
  | 'benchmark/providerEvalReport/read'
  | 'protocol/describe'
  | 'diagnostic/health'
  | 'project/list'
  | 'project/get'
  | 'event/subscribe'
  | 'thread/start'
  | 'thread/list'
  | 'thread/resume'
  | 'turn/start'
  | 'turn/status'
  | 'turn/recover'
  | 'turn/interrupt'
  | 'approval/list'
  | 'approval/resolve'
  | 'interaction/list'
  | 'interaction/respond'
  | 'proof/append'
  | 'gate/confirm'
  | 'review/list'
  | 'review/preflight'
  | 'review/apply'
  | 'review/revert'
  | 'review/hunkApply'
  | 'review/hunkRevert'
  | 'review/statusList'
  | 'review/statusUpdate'
  | 'review/batchPreflight'
  | 'review/batchApply'
  | 'review/batchRevert'
  | 'runtimeRail/read'
  | 'runtimeTranscript/read'
  | 'runtimeFacts/read'
  | 'runtimeScorecard/read'
  | 'structuredOutputArtifacts/read'
  | 'workflowRun/list'
  | 'workflowRun/read'
  | 'job/list'
  | 'job/get'
  | 'job/cancel'

export interface MethodRegistryOptions {
  cwd?: string
  projectRoot?: string
  eventBus?: AppServerEventBus
  loopRunner?: AppServerLoopRunner
  loopOptions?: Pick<ConversationLoopOptions, 'apiBaseUrl' | 'apiKey'> & Partial<ConversationLoopOptions>
  loopModelId?: string
  dispatcherFactory?: () => ToolDispatcher
  config?: OwlCodaConfig
  approvalBroker?: AppServerApprovalBroker
  interactionStoragePath?: string
}

export type AppServerMethodHandler = (params: unknown, request: JsonRpcRequest) => Promise<unknown> | unknown

export interface AppServerMethodRegistry {
  readonly cwd: string
  readonly projectRoot: string
  readonly methods: ReadonlyMap<AppServerMethod, AppServerMethodHandler>
}

export type AppServerLoopRunner = (
  conversation: Conversation,
  dispatcher: ToolDispatcher,
  opts: ConversationLoopOptions,
) => ReturnType<typeof runConversationLoop>

interface ActiveTurn {
  abortController: AbortController
}

type RuntimeStartResult =
  | {
      runtimeStarted: true
      runtimeStatus: 'running'
    }
  | {
      runtimeStarted: false
      runtimeStatus: 'saved'
      runtimeReason: 'runtime_not_started' | 'thread_session_unavailable' | 'turn_already_running'
    }

export function createMethodRegistry(options: MethodRegistryOptions = {}): AppServerMethodRegistry {
  const cwd = resolve(options.cwd ?? process.cwd())
  const projectRoot = resolve(options.projectRoot ?? cwd)
  const handlers = new Map<AppServerMethod, AppServerMethodHandler>()
  const activeTurns = new Map<string, ActiveTurn>()
  const loopRunner = options.loopRunner ?? runConversationLoop
  const dispatcherFactory = options.dispatcherFactory ?? (() => new ToolDispatcher())
  const toolDefs = buildNativeToolDefs(dispatcherFactory())
  const resolvedLoopConfig = options.loopOptions
    ? null
    : options.config ? resolveAppServerLoopConfig(options.config, options.loopModelId) : null
  const loopOptions = options.loopOptions ?? (resolvedLoopConfig?.ok ? resolvedLoopConfig.loopOptions : undefined)
  const loopConfigError = resolvedLoopConfig && !resolvedLoopConfig.ok ? resolvedLoopConfig : null
  const jobListTool = createJobListTool()
  const jobGetTool = createJobGetTool()
  const jobCancelTool = createJobCancelTool()
  const readFactsForRequest = async (params: unknown) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const runId = extractStringParam(params, 'runId')
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!runId) {
      throw new JsonRpcError(-32602, 'runId is required')
    }
    const transcript = readRuntimeTranscript({
      projectId: project.id,
      projectRoot: project.root,
      threadId,
    })
    if (!transcript) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    const session = loadSession(threadId)
    if (!session) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    const artifacts = await readRuntimeFactArtifacts(session, runId)
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: session.runtimeEventLog,
      runtimeRecoveryLedger: session.runtimeRecoveryLedger,
      jobs: listJobs(),
      artifacts,
    })
    return { project, threadId, runId, session, facts }
  }
  const approvalBroker = options.approvalBroker ?? createAppServerApprovalBroker({
    storagePath: options.interactionStoragePath ?? defaultInteractionStoragePath(projectRoot),
    onRequested: approval => {
      options.eventBus?.publish({
        type: 'interaction.requested',
        projectId: approval.projectId,
        threadId: approval.threadId,
        interactionId: approval.id,
        kind: approval.kind,
        interaction: approval,
      })
      if (approval.kind !== 'tool_approval') return
      options.eventBus?.publish({
        type: 'approval.requested',
        projectId: approval.projectId,
        threadId: approval.threadId,
        approvalId: approval.id,
        toolName: approval.toolName,
        approval,
      })
    },
    onResolved: result => {
      const approved = result.status === 'approved'
      options.eventBus?.publish({
        type: 'interaction.resolved',
        projectId: result.projectId,
        threadId: result.threadId,
        interactionId: result.interactionId,
        kind: result.kind,
        toolName: result.toolName,
        status: result.status,
        ...(result.status === 'approved' || result.status === 'denied' ? { approved } : {}),
        ...(result.answer !== undefined ? { answer: result.answer } : {}),
        resolvedAt: result.resolvedAt,
      })
      if (result.kind !== 'tool_approval') return
      options.eventBus?.publish({
        type: 'approval.resolved',
        projectId: result.projectId,
        threadId: result.threadId,
        approvalId: result.approvalId,
        toolName: result.toolName,
        approved,
        status: result.status,
        resolvedAt: result.resolvedAt,
      })
    },
  })

  handlers.set('protocol/describe', () => describeAppServerProtocol())

  handlers.set('diagnostic/health', () => ({
    schemaVersion: APP_SERVER_SCHEMA_VERSION,
    status: 'ok',
    cwd,
    projectRoot,
    methods: [...handlers.keys()],
    subsystems: {
      ...buildRuntimeHealthSnapshot({ projectRoot }).subsystems,
      appServerLoop: describeAppServerLoop({
        loopOptions,
        resolvedLoopConfig,
        loopConfigError,
      }),
    },
  }))

  handlers.set('project/list', () => listProjects(projectRoot))

  handlers.set('project/get', async (params) => {
    const projects = listProjects(projectRoot).projects
    const requestedProjectId = extractProjectId(params)
    const project = projects.find(item => item.id === requestedProjectId) ?? projects[0]
    if (!project) {
      throw new JsonRpcError(-32602, 'Project not found')
    }
    return {
      project,
      rail: await readRuntimeRail({ projectId: project.id, projectRoot: project.root }),
    }
  })

  handlers.set('runtimeRail/read', async (params) => {
    const projectId = extractProjectId(params) ?? listProjects(projectRoot).projects[0]?.id ?? 'workspace'
    return readRuntimeRail({ projectId, projectRoot })
  })

  handlers.set('runtimeTranscript/read', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const result = readRuntimeTranscript({
      projectId: project.id,
      projectRoot: project.root,
      threadId,
    })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    return result
  })

  handlers.set('runtimeFacts/read', async (params) => {
    const { project, threadId, facts } = await readFactsForRequest(params)
    return {
      ...facts,
      threadId,
      projectId: project.id,
      runtimeEventCount: facts.events.length,
      checkpointCount: facts.checkpoints.length,
      jobCount: facts.jobs.length,
      artifactCount: facts.artifacts.length,
    }
  })

  handlers.set('runtimeScorecard/read', async (params) => {
    const { project, threadId, runId, session, facts } = await readFactsForRequest(params)
    const finalText = extractStringParam(params, 'finalText') ?? latestAssistantText(session)
    const scorecard = buildRunScorecard({ facts, finalText })
    const records = buildRunTrajectory(facts, scorecard)
    return {
      schemaVersion: 1,
      threadId,
      projectId: project.id,
      runId,
      scorecard,
      summary: summarizeRunScorecard(scorecard),
      trajectory: {
        recordCount: records.length,
        localOnly: true,
        redactionMode: 'local_redacted_v0',
        records,
      },
      facts: {
        runtimeEventCount: facts.events.length,
        checkpointCount: facts.checkpoints.length,
        jobCount: facts.jobs.length,
        artifactCount: facts.artifacts.length,
      },
    }
  })

  handlers.set('structuredOutputArtifacts/read', async (params) => {
    const { project, threadId, runId, session, facts } = await readFactsForRequest(params)
    return buildStructuredOutputArtifactsPanel({
      facts: {
        ...facts,
        threadId,
        projectId: project.id,
        runtimeEventCount: facts.events.length,
        checkpointCount: facts.checkpoints.length,
        jobCount: facts.jobs.length,
        artifactCount: facts.artifacts.length,
      },
      threadId,
      projectId: project.id,
      runRef: session.taskState?.run.runWorkspace?.outputRoot ?? session.taskState?.run.runWorkspace?.runDir,
      artifactId: extractStringParam(params, 'artifactId'),
    })
  })

  handlers.set('workflowRun/list', async (params) => {
    const project = resolveProject(projectRoot, params)
    const limit = numberField(params, 'limit')
    return listWorkflowRuns({
      cwd: project.root,
      ...(extractStringParam(params, 'workflowRoot') ? { workflowRoot: extractStringParam(params, 'workflowRoot') } : {}),
      ...(typeof limit === 'number' && limit > 0 ? { limit } : {}),
    })
  })

  handlers.set('workflowRun/read', async (params) => {
    const project = resolveProject(projectRoot, params)
    const runId = extractStringParam(params, 'runId')
    if (!runId) {
      throw new JsonRpcError(-32602, 'runId is required')
    }
    try {
      return await buildWorkflowConsumerManifest({
        cwd: project.root,
        runId,
        ...(extractStringParam(params, 'workflowRoot') ? { workflowRoot: extractStringParam(params, 'workflowRoot') } : {}),
      })
    } catch (err) {
      if (err instanceof WorkflowRunNotFoundError) {
        throw new JsonRpcError(-32602, err.message, {
          runId: err.runId,
          workflowRoot: err.workflowRoot,
        })
      }
      throw err
    }
  })

  handlers.set('benchmark/providerEvalReport/read', async (params) => {
    const recordPath = extractStringParam(params, 'recordPath') ?? getBenchmarkProviderEvalPath()
    const records = await readBenchmarkProviderEvalRecords({ recordPath })
    const report = buildBenchmarkProviderEvalBatchReport(records)
    return {
      schemaVersion: 1,
      source: 'local_provider_eval_store' as const,
      recordPath,
      recordCount: records.length,
      report,
      markdown: formatBenchmarkProviderEvalBatchReport(report),
    }
  })

  handlers.set('job/list', async (params) => {
    const result = await jobListTool.execute(isRecord(params) ? params : {})
    return appServerToolResult(result)
  })

  handlers.set('job/get', async (params) => {
    const result = await jobGetTool.execute({ jobId: extractStringParam(params, 'jobId') ?? '' })
    if (result.isError) {
      throw new JsonRpcError(-32602, result.output, result.metadata)
    }
    return appServerToolResult(result)
  })

  handlers.set('job/cancel', async (params) => {
    const result = await jobCancelTool.execute({
      jobId: extractStringParam(params, 'jobId') ?? '',
      reason: extractStringParam(params, 'reason'),
    })
    if (result.isError) {
      throw new JsonRpcError(-32602, result.output, result.metadata)
    }
    return appServerToolResult(result)
  })

  handlers.set('event/subscribe', () => ({
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
  }))

  handlers.set('thread/start', (params) => {
    const project = resolveProject(projectRoot, params)
    const model = extractStringParam(params, 'model') ?? (resolvedLoopConfig?.ok ? resolvedLoopConfig.model : undefined)
    const result = startThread({
      project,
      title: extractStringParam(params, 'title'),
      model,
      modelIdentity: resolveConfiguredModelIdentity(options.config, model),
      systemPrompt: extractStringParam(params, 'systemPrompt'),
      tools: toolDefs,
    })
    options.eventBus?.publish({
      type: 'thread.updated',
      projectId: result.thread.projectId,
      threadId: result.thread.id,
      turnCount: result.thread.turnCount,
    })
    return result
  })

  handlers.set('thread/list', (params) => {
    const project = resolveProject(projectRoot, params)
    const result = listThreads({
      project,
      limit: extractNumberParam(params, 'limit'),
      offset: extractNumberParam(params, 'offset'),
      query: extractStringParam(params, 'query')?.trim(),
    })
    const interactions = approvalBroker.listInteractions({ projectId: project.id }).interactions
    return {
      ...result,
      threads: result.threads.map(thread => ({
        ...thread,
        runtime: runtimeStatusForThread({
          activeTurns,
          interactions,
          project,
          threadId: thread.id,
        }),
      })),
    }
  })

  handlers.set('thread/resume', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const result = resumeThread({ project, threadId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    const interactions = approvalBroker.listInteractions({ projectId: project.id, threadId }).interactions
    return {
      ...result,
      thread: {
        ...result.thread,
        runtime: runtimeStatusForThread({
          activeTurns,
          interactions,
          project,
          threadId,
        }),
      },
    }
  })

  handlers.set('turn/status', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const result = runtimeStatusForThread({
      activeTurns,
      interactions: approvalBroker.listInteractions({ projectId: project.id, threadId }).interactions,
      project,
      threadId,
    })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    return result
  })

  handlers.set('turn/recover', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const action = extractStringParam(params, 'action')
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (action !== 'mark_recovered') {
      throw new JsonRpcError(-32602, 'action must be mark_recovered')
    }
    const result = recoverTurn({
      projectId: project.id,
      projectRoot: project.root,
      threadId,
      runtimeActive: activeTurns.has(threadId),
      interactions: approvalBroker.listInteractions({ projectId: project.id, threadId }).interactions,
      action,
      note: extractStringParam(params, 'note') ?? undefined,
    })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    if (!result.ok) {
      throw new JsonRpcError(-32011, result.message, {
        reason: result.reason,
        status: result.status.status,
        suggestedAction: result.suggestedAction,
      })
    }
    return result.result
  })

  handlers.set('turn/start', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const input = extractStringParam(params, 'input')?.trim()
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!input) {
      throw new JsonRpcError(-32602, 'input is required')
    }
    if (loopConfigError) {
      throw new JsonRpcError(-32001, loopConfigError.message, { reason: loopConfigError.reason })
    }
    if (loopOptions && activeTurns.has(threadId)) {
      throw new JsonRpcError(-32000, 'Turn already running')
    }
    const result = startTurn({ project, threadId, input, tools: toolDefs })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    options.eventBus?.publish({
      type: 'turn.started',
      projectId: result.projectId,
      threadId: result.threadId,
      turnIndex: result.turn.index,
    })
    options.eventBus?.publish({
      type: 'thread.updated',
      projectId: result.projectId,
      threadId: result.threadId,
      turnCount: result.thread.turnCount,
    })
    const runtimeStart = maybeStartConversationLoop({
      activeTurns,
      dispatcherFactory,
      eventBus: options.eventBus,
      loopOptions,
      loopRunner,
      approvalBroker,
      project,
      threadId: result.threadId,
      toolDefs,
    })
    if (!runtimeStart.runtimeStarted) {
      options.eventBus?.publish({
        type: 'turn.completed',
        projectId: result.projectId,
        threadId: result.threadId,
        finalText: '',
        iterations: 0,
        stopReason: runtimeStart.runtimeReason,
        runtimeStarted: false,
      })
    }
    return { ...result, ...runtimeStart }
  })

  handlers.set('turn/interrupt', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const active = activeTurns.get(threadId)
    if (active) {
      active.abortController.abort()
      const result = {
        projectId: project.id,
        threadId,
        status: 'interrupted' as const,
        reason: 'abort_signal_sent' as const,
      }
      options.eventBus?.publish({
        type: 'turn.interrupted',
        projectId: result.projectId,
        threadId: result.threadId,
        status: result.status,
        reason: result.reason,
      })
      return result
    }

    const result = interruptTurn({ project, threadId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    options.eventBus?.publish({
      type: 'turn.interrupted',
      projectId: result.projectId,
      threadId: result.threadId,
      status: result.status,
      reason: result.reason,
    })
    return result
  })

  handlers.set('approval/list', (params) => {
    return approvalBroker.listApprovals({
      projectId: extractProjectId(params) ?? undefined,
      threadId: extractThreadId(params) ?? undefined,
    })
  })

  handlers.set('approval/resolve', (params) => {
    const approvalId = extractApprovalId(params)
    const decision = extractApprovalDecision(params)
    if (!approvalId) {
      throw new JsonRpcError(-32602, 'approvalId is required')
    }
    if (!decision) {
      throw new JsonRpcError(-32602, 'decision must be approve or deny')
    }
    const result = approvalBroker.resolveApproval({ approvalId, decision })
    if (!result) {
      throw new JsonRpcError(-32602, 'Approval request not found')
    }
    return result
  })

  handlers.set('interaction/list', (params) => {
    return approvalBroker.listInteractions({
      projectId: extractProjectId(params) ?? undefined,
      threadId: extractThreadId(params) ?? undefined,
    })
  })

  handlers.set('interaction/respond', (params) => {
    const interactionId = extractInteractionId(params)
    if (!interactionId) {
      throw new JsonRpcError(-32602, 'interactionId is required')
    }
    const result = approvalBroker.respondInteraction({
      interactionId,
      decision: extractApprovalDecision(params) ?? undefined,
      answer: extractStringParam(params, 'answer') ?? undefined,
    })
    if (!result) {
      throw new JsonRpcError(-32602, 'Interaction request not found')
    }
    return result
  })

  handlers.set('proof/append', async (params) => {
    const project = resolveProject(projectRoot, params)
    const kind = extractStringParam(params, 'kind')?.trim()
    const title = extractStringParam(params, 'title')?.trim()
    if (!kind) {
      throw new JsonRpcError(-32602, 'kind is required')
    }
    if (!title) {
      throw new JsonRpcError(-32602, 'title is required')
    }
    const result = appendRunKitProof({
      projectRoot: project.root,
      kind,
      title,
      status: extractStringParam(params, 'status')?.trim(),
      detail: extractStringParam(params, 'detail'),
    })
    const readback = await readRuntimeRail({ projectId: project.id, projectRoot: project.root })
    options.eventBus?.publish({
      type: 'proof.appended',
      projectId: project.id,
      proof: result.proof,
    })
    publishRuntimeRailUpdated(options.eventBus, project.id, readback)
    return {
      status: result.status,
      proof: result.proof,
      proofPath: result.proofPath,
      packetPath: result.packetPath,
      readback,
    }
  })

  handlers.set('gate/confirm', async (params) => {
    const project = resolveProject(projectRoot, params)
    const result = confirmRunKitGate({
      projectRoot: project.root,
      gateId: extractStringParam(params, 'gateId')?.trim(),
      note: extractStringParam(params, 'note'),
      confirmedBy: extractStringParam(params, 'confirmedBy')?.trim(),
    })
    const readback = await readRuntimeRail({ projectId: project.id, projectRoot: project.root })
    options.eventBus?.publish({
      type: 'gate.confirmed',
      projectId: project.id,
      gateId: result.gateId,
      gate: readback.gate,
    })
    publishRuntimeRailUpdated(options.eventBus, project.id, readback)
    return {
      status: result.status,
      gateId: result.gateId,
      gatePath: result.gatePath,
      readback,
    }
  })

  handlers.set('review/list', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const result = listReviewChanges({ projectRoot: project.root, threadId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    return {
      ...result,
      changes: annotateReviewChanges({
        projectRoot: project.root,
        threadId: result.threadId,
        changes: result.changes,
      }),
    }
  })

  handlers.set('review/statusList', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    const result = listReviewChanges({ projectRoot: project.root, threadId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Thread not found for project')
    }
    return listReviewStatusesWithStoredHunks(project.root, result.threadId, result.changes.map(change => change.id))
  })

  handlers.set('review/statusUpdate', (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    const status = extractStringParam(params, 'status')
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    if (!isReviewStatusValue(status)) {
      throw new JsonRpcError(-32602, 'status is required')
    }
    const listed = listReviewChanges({ projectRoot: project.root, threadId })
    if (!listed || !listed.changes.some(change => change.id === diffId)) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    const result = updateReviewStatus({
      projectRoot: project.root,
      threadId: listed.threadId,
      diffId,
      status,
      note: extractStringParam(params, 'note'),
      updatedBy: extractStringParam(params, 'updatedBy'),
    })
    publishReviewStatusEvent(options.eventBus, project.id, result)
    return result
  })

  handlers.set('review/preflight', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    const result = await preflightReviewChange({ projectRoot: project.root, threadId, diffId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    return result
  })

  handlers.set('review/apply', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    const result = await applyReviewChange({ projectRoot: project.root, threadId, diffId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    if (result.status !== 'applied' && result.status !== 'already_applied') {
      throw new JsonRpcError(-32010, result.message, {
        reason: result.reason,
        preflight: result.preflight,
      })
    }
    persistReviewActionStatus(options.eventBus, {
      projectId: project.id,
      projectRoot: project.root,
      threadId: result.change.threadId,
      diffId: result.change.id,
      status: 'applied',
    })
    return result
  })

  handlers.set('review/revert', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    const result = await revertReviewChange({ projectRoot: project.root, threadId, diffId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    if (result.status !== 'reverted' && result.status !== 'already_reverted') {
      throw new JsonRpcError(-32010, result.message, {
        reason: result.reason,
        preflight: result.preflight,
      })
    }
    persistReviewActionStatus(options.eventBus, {
      projectId: project.id,
      projectRoot: project.root,
      threadId: result.change.threadId,
      diffId: result.change.id,
      status: 'reverted',
    })
    return result
  })

  handlers.set('review/hunkApply', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    const hunkId = extractHunkId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    if (!hunkId) {
      throw new JsonRpcError(-32602, 'hunkId is required')
    }
    const result = await applyReviewHunk({ projectRoot: project.root, threadId, diffId, hunkId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    if (result.status !== 'applied' && result.status !== 'already_applied') {
      throw reviewHunkActionError(result)
    }
    const reviewStatus = persistReviewActionStatus(options.eventBus, {
      projectId: project.id,
      projectRoot: project.root,
      threadId: result.threadId,
      diffId: reviewHunkStatusId(result.diffId, result.hunkId),
      status: 'applied',
    })
    return { ...result, reviewStatus: reviewStatus.status }
  })

  handlers.set('review/hunkRevert', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffId = extractDiffId(params)
    const hunkId = extractHunkId(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (!diffId) {
      throw new JsonRpcError(-32602, 'diffId is required')
    }
    if (!hunkId) {
      throw new JsonRpcError(-32602, 'hunkId is required')
    }
    const result = await revertReviewHunk({ projectRoot: project.root, threadId, diffId, hunkId })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    if (result.status !== 'reverted' && result.status !== 'already_reverted') {
      throw reviewHunkActionError(result)
    }
    const reviewStatus = persistReviewActionStatus(options.eventBus, {
      projectId: project.id,
      projectRoot: project.root,
      threadId: result.threadId,
      diffId: reviewHunkStatusId(result.diffId, result.hunkId),
      status: 'reverted',
    })
    return { ...result, reviewStatus: reviewStatus.status }
  })

  handlers.set('review/batchPreflight', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffIds = extractDiffIds(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (diffIds.length === 0) {
      throw new JsonRpcError(-32602, 'diffIds is required')
    }
    const result = await batchPreflightReviewChanges({ projectRoot: project.root, threadId, diffIds })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    return result
  })

  handlers.set('review/batchApply', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffIds = extractDiffIds(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (diffIds.length === 0) {
      throw new JsonRpcError(-32602, 'diffIds is required')
    }
    const result = await batchApplyReviewChanges({ projectRoot: project.root, threadId, diffIds })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    publishReviewBatchEvent(options.eventBus, project.id, 'apply', result)
    if (result.status !== 'applied') {
      throw new JsonRpcError(-32010, result.message, {
        reason: result.reason,
        preflight: result.preflight,
        transaction: result.transaction,
        proof: result.proof,
        results: result.results,
      })
    }
    for (const actionResult of result.results) {
      persistReviewActionStatus(options.eventBus, {
        projectId: project.id,
        projectRoot: project.root,
        threadId: actionResult.change.threadId,
        diffId: actionResult.change.id,
        status: 'applied',
        note: `transaction:${result.transaction.transactionId}`,
      })
    }
    return result
  })

  handlers.set('review/batchRevert', async (params) => {
    const project = resolveProject(projectRoot, params)
    const threadId = extractThreadId(params)
    const diffIds = extractDiffIds(params)
    if (!threadId) {
      throw new JsonRpcError(-32602, 'threadId is required')
    }
    if (diffIds.length === 0) {
      throw new JsonRpcError(-32602, 'diffIds is required')
    }
    const result = await batchRevertReviewChanges({ projectRoot: project.root, threadId, diffIds })
    if (!result) {
      throw new JsonRpcError(-32602, 'Review change not found for project')
    }
    publishReviewBatchEvent(options.eventBus, project.id, 'revert', result)
    if (result.status !== 'reverted') {
      throw new JsonRpcError(-32010, result.message, {
        reason: result.reason,
        preflight: result.preflight,
        transaction: result.transaction,
        proof: result.proof,
        results: result.results,
      })
    }
    for (const actionResult of result.results) {
      persistReviewActionStatus(options.eventBus, {
        projectId: project.id,
        projectRoot: project.root,
        threadId: actionResult.change.threadId,
        diffId: actionResult.change.id,
        status: 'reverted',
        note: `transaction:${result.transaction.transactionId}`,
      })
    }
    return result
  })

  return {
    cwd,
    projectRoot,
    methods: handlers,
  }
}

function describeAppServerLoop(input: {
  loopOptions?: MethodRegistryOptions['loopOptions']
  resolvedLoopConfig: ReturnType<typeof resolveAppServerLoopConfig> | null
  loopConfigError: Extract<ReturnType<typeof resolveAppServerLoopConfig>, { ok: false }> | null
}): Record<string, unknown> {
  if (input.resolvedLoopConfig?.ok) {
    return {
      status: 'ok',
      runtimeConfigured: true,
      model: input.resolvedLoopConfig.model,
      apiBaseUrl: input.loopOptions?.apiBaseUrl,
    }
  }

  if (input.loopConfigError) {
    return {
      status: 'error',
      runtimeConfigured: false,
      reason: input.loopConfigError.reason,
      message: input.loopConfigError.message,
    }
  }

  if (input.loopOptions) {
    return {
      status: 'ok',
      runtimeConfigured: true,
      model: 'injected-loop-options',
      apiBaseUrl: input.loopOptions.apiBaseUrl,
    }
  }

  return {
    status: 'disabled',
    runtimeConfigured: false,
    reason: 'no_loop_config',
    message: 'No OwlCoda config or injected loop options were provided for App Server loop execution.',
  }
}

function resolveConfiguredModelIdentity(config: OwlCodaConfig | undefined, model: string | undefined): ConversationModelIdentity | undefined {
  if (!model) return undefined
  const configured = config?.models.find(candidate =>
    candidate.id === model
    || candidate.backendModel === model
    || candidate.aliases.includes(model),
  )
  if (!configured) return { id: model, backendModel: model }
  return {
    id: configured.id,
    label: configured.label,
    backendModel: configured.backendModel,
    aliases: configured.aliases,
    provider: configured.provider,
    endpoint: configured.endpoint,
    contextWindow: configured.contextWindow,
    supportsImages: configured.supportsImages,
  }
}

function maybeStartConversationLoop(input: {
  activeTurns: Map<string, ActiveTurn>
  dispatcherFactory: () => ToolDispatcher
  eventBus?: AppServerEventBus
  loopOptions?: MethodRegistryOptions['loopOptions']
  loopRunner: AppServerLoopRunner
  approvalBroker: AppServerApprovalBroker
  project: ReturnType<typeof resolveProject>
  threadId: string
  toolDefs: ReturnType<typeof buildNativeToolDefs>
}): RuntimeStartResult {
  if (!input.loopOptions) {
    return { runtimeStarted: false, runtimeStatus: 'saved', runtimeReason: 'runtime_not_started' }
  }
  if (input.activeTurns.has(input.threadId)) {
    return { runtimeStarted: false, runtimeStatus: 'saved', runtimeReason: 'turn_already_running' }
  }

  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) {
    return { runtimeStarted: false, runtimeStatus: 'saved', runtimeReason: 'thread_session_unavailable' }
  }

  const abortController = new AbortController()
  input.activeTurns.set(input.threadId, { abortController })
  const conversation = restoreConversation(session, input.toolDefs)
  const dispatcher = input.dispatcherFactory()
  const toolProgressTotals = new Map<string, number>()
  const toolInputsByRuntimeIdentity = new Map<string, {
    toolName: string
    toolInput: Record<string, unknown>
  }>()

  void input.loopRunner(conversation, dispatcher, {
    ...input.loopOptions,
    signal: abortController.signal,
    cwd: input.project.root,
    callbacks: {
      ...input.loopOptions.callbacks,
      onText: text => {
        input.loopOptions?.callbacks?.onText?.(text)
        input.eventBus?.publish({
          type: 'assistant.delta',
          projectId: input.project.id,
          threadId: input.threadId,
          text,
        })
      },
      onToolStart: (toolName, toolInput, runtime) => {
        input.loopOptions?.callbacks?.onToolStart?.(toolName, toolInput, runtime)
        const metadata = runtimeEventMetadata(runtime)
        toolInputsByRuntimeIdentity.set(runtimeItemIdentity(runtime, toolName), { toolName, toolInput })
        input.eventBus?.publish({
          type: 'tool.started',
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          input: toolInput,
          ...metadata,
        })
        publishCommandStarted(input.eventBus, {
          projectId: input.project.id,
          projectRoot: input.project.root,
          threadId: input.threadId,
          toolName,
          toolInput,
          runtime,
          metadata,
        })
        publishDiffStarted(input.eventBus, {
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          toolInput,
          runtime,
          metadata,
        })
      },
      onToolEnd: (toolName, result, isError, durationMs, metadata, runtime) => {
        input.loopOptions?.callbacks?.onToolEnd?.(toolName, result, isError, durationMs, metadata, runtime)
        const runtimeMetadata = runtimeEventMetadata(runtime)
        input.eventBus?.publish({
          type: 'tool.completed',
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          result,
          isError,
          durationMs,
          ...runtimeMetadata,
        })
        publishCommandCompleted(input.eventBus, {
          projectId: input.project.id,
          projectRoot: input.project.root,
          threadId: input.threadId,
          toolName,
          toolInput: toolInputsByRuntimeIdentity.get(runtimeItemIdentity(runtime, toolName))?.toolInput ?? {},
          result,
          isError,
          durationMs,
          resultMetadata: metadata,
          runtime,
          metadata: runtimeMetadata,
        })
        publishDiffCompleted(input.eventBus, {
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          toolInput: toolInputsByRuntimeIdentity.get(runtimeItemIdentity(runtime, toolName))?.toolInput ?? {},
          result,
          isError,
          durationMs,
          runtime,
          metadata: runtimeMetadata,
        })
      },
      onToolProgress: (toolName, event, runtime) => {
        input.loopOptions?.callbacks?.onToolProgress?.(toolName, event, runtime)
        const metadata = runtimeEventMetadata(runtime)
        const delta = toolProgressDelta(toolProgressTotals, toolName, event, runtime)
        input.eventBus?.publish({
          type: 'tool.delta',
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          lines: event.lines,
          delta,
          totalLines: event.totalLines,
          totalBytes: event.totalBytes,
          elapsedMs: event.elapsedMs,
          ...metadata,
        })
        publishCommandOutputDelta(input.eventBus, {
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          event,
          delta,
          runtime,
          metadata,
        })
      },
      onError: message => {
        input.loopOptions?.callbacks?.onError?.(message)
        input.eventBus?.publish({
          type: 'turn.failed',
          projectId: input.project.id,
          threadId: input.threadId,
          message,
        })
      },
      onToolApproval: async (toolName, toolInput) => {
        if (input.loopOptions?.callbacks?.onToolApproval) {
          return input.loopOptions.callbacks.onToolApproval(toolName, toolInput)
        }
        return input.approvalBroker.requestApproval({
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          toolInput,
          signal: abortController.signal,
        })
      },
      onTaskScopeApproval: async request => {
        if (input.loopOptions?.callbacks?.onTaskScopeApproval) {
          return input.loopOptions.callbacks.onTaskScopeApproval(request)
        }
        return input.approvalBroker.requestTaskScopeApproval({
          projectId: input.project.id,
          threadId: input.threadId,
          toolName: request.toolName,
          toolInput: request.input,
          taskScope: {
            attemptedPath: request.attemptedPath,
            attemptedPaths: request.attemptedPaths,
            allowedPaths: request.allowedPaths,
            message: request.message,
          },
          signal: abortController.signal,
        })
      },
      onUserQuestion: async (toolName, question, opts) => {
        if (input.loopOptions?.callbacks?.onUserQuestion) {
          return input.loopOptions.callbacks.onUserQuestion(toolName, question, opts)
        }
        return input.approvalBroker.requestUserQuestion({
          projectId: input.project.id,
          threadId: input.threadId,
          toolName,
          question,
          opts,
          signal: abortController.signal,
        })
      },
    },
  }).then(result => {
    saveSession(result.conversation, session.title, { cwd: input.project.root })
    if (result.runtimeFailure) {
      input.eventBus?.publish({
        type: 'turn.failed',
        projectId: input.project.id,
        threadId: input.threadId,
        message: result.runtimeFailure.message,
      })
      return
    }
    input.eventBus?.publish({
      type: 'turn.completed',
      projectId: input.project.id,
      threadId: input.threadId,
      finalText: result.finalText,
      iterations: result.iterations,
      stopReason: result.stopReason,
      runtimeStarted: true,
    })
  }).catch(error => {
    input.eventBus?.publish({
      type: 'turn.failed',
      projectId: input.project.id,
      threadId: input.threadId,
      message: error instanceof Error ? error.message : 'Conversation loop failed',
    })
  }).finally(() => {
    input.activeTurns.delete(input.threadId)
  })

  return { runtimeStarted: true, runtimeStatus: 'running' }
}

function runtimeStatusForThread(input: {
  activeTurns: Map<string, ActiveTurn>
  interactions: ReturnType<AppServerApprovalBroker['listInteractions']>['interactions']
  project: ReturnType<typeof resolveProject>
  threadId: string
}): AppServerTurnStatusResult | null {
  return readTurnStatus({
    projectId: input.project.id,
    projectRoot: input.project.root,
    threadId: input.threadId,
    runtimeActive: input.activeTurns.has(input.threadId),
    interactions: input.interactions,
  })
}

function publishReviewBatchEvent(
  eventBus: AppServerEventBus | undefined,
  projectId: string,
  action: 'apply' | 'revert',
  result: ReviewBatchActionResult,
): void {
  eventBus?.publish({
    type: 'review.batchCompleted',
    projectId,
    threadId: result.threadId,
    action,
    status: result.status,
    diffIds: result.diffIds,
    transactionId: result.transaction.transactionId,
    items: reviewBatchEventItems(result),
  })
}

function listReviewStatusesWithStoredHunks(projectRoot: string, threadId: string, diffIds: string[]) {
  const listed = listReviewStatuses({ projectRoot, threadId, diffIds })
  const baseDiffIds = new Set(listed.statuses.map(status => status.diffId))
  const storedHunkStatuses = listReviewStatuses({ projectRoot, threadId }).statuses
    .filter(status => !baseDiffIds.has(status.diffId))
  return {
    threadId,
    statuses: listed.statuses.concat(storedHunkStatuses)
      .sort((left, right) => left.updatedAt - right.updatedAt),
  }
}

function persistReviewActionStatus(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    projectRoot: string
    threadId: string
    diffId: string
    status: Extract<ReviewStatusValue, 'applied' | 'reverted'>
    note?: string
  },
): ReviewStatusUpdateResult {
  const result = updateReviewStatus({
    projectRoot: input.projectRoot,
    threadId: input.threadId,
    diffId: input.diffId,
    status: input.status,
    updatedBy: 'app-server',
    note: input.note,
  })
  publishReviewStatusEvent(eventBus, input.projectId, result)
  return result
}

function reviewHunkStatusId(diffId: string, hunkId: string): string {
  return `${diffId}#${hunkId}`
}

function reviewHunkActionError(result: ReviewHunkActionResult): JsonRpcError {
  return new JsonRpcError(-32010, result.message, {
    reason: result.reason,
    preflight: result.preflight,
    proof: result.proof,
  })
}

function publishReviewStatusEvent(
  eventBus: AppServerEventBus | undefined,
  projectId: string,
  result: ReviewStatusUpdateResult,
): void {
  eventBus?.publish({
    type: 'review.statusUpdated',
    projectId,
    threadId: result.threadId,
    diffId: result.diffId,
    status: result.status.status,
    updatedBy: result.status.updatedBy,
    reviewStatus: result.status,
  })
}

function publishRuntimeRailUpdated(
  eventBus: AppServerEventBus | undefined,
  projectId: string,
  rail: Awaited<ReturnType<typeof readRuntimeRail>>,
): void {
  eventBus?.publish({
    type: 'runtimeRail.updated',
    projectId,
    freshness: rail.freshness,
    source: rail.source,
  })
}

function runtimeEventMetadata(runtime: ToolRuntimeItemMetadata | undefined) {
  return runtime
    ? {
        toolUseId: runtime.toolUseId,
        itemId: runtime.itemId ?? runtime.toolUseId,
        runtimeTurnId: runtime.runtimeTurnId,
      }
    : {}
}

function publishCommandStarted(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    projectRoot: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    runtime: ToolRuntimeItemMetadata | undefined
    metadata: ReturnType<typeof runtimeEventMetadata>
  },
): void {
  if (input.toolName !== 'bash') return
  const command = stringField(input.toolInput, 'command')
  if (!command) return
  const commandId = runtimeItemIdentity(input.runtime, input.toolName)
  const refs = commandRefs(input.threadId, commandId)
  const cwd = commandCwd(input.projectRoot, input.toolInput)
  eventBus?.publish({
    type: 'command.started',
    projectId: input.projectId,
    threadId: input.threadId,
    commandId,
    ...refs,
    sourceRefs: bashCommandSourceRefs({
      threadId: input.threadId,
      commandId,
      toolInput: input.toolInput,
      projectRoot: input.projectRoot,
      captureStatus: 'pending',
    }),
    command,
    cwd,
    ...input.metadata,
  })
}

function publishCommandOutputDelta(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    threadId: string
    toolName: string
    event: ToolProgressEvent
    delta: string
    runtime: ToolRuntimeItemMetadata | undefined
    metadata: ReturnType<typeof runtimeEventMetadata>
  },
): void {
  if (input.toolName !== 'bash') return
  const commandId = runtimeItemIdentity(input.runtime, input.toolName)
  const refs = commandRefs(input.threadId, commandId)
  eventBus?.publish({
    type: 'command.outputDelta',
    projectId: input.projectId,
    threadId: input.threadId,
    commandId,
    lines: input.event.lines,
    delta: input.delta,
    totalLines: input.event.totalLines,
    totalBytes: input.event.totalBytes,
    elapsedMs: input.event.elapsedMs,
    statusRef: refs.statusRef,
    outputRef: refs.outputRef,
    ...input.metadata,
  })
}

function publishCommandCompleted(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    projectRoot: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    result: string
    isError: boolean
    durationMs: number
    resultMetadata: Record<string, unknown> | undefined
    runtime: ToolRuntimeItemMetadata | undefined
    metadata: ReturnType<typeof runtimeEventMetadata>
  },
): void {
  if (input.toolName !== 'bash') return
  const commandId = runtimeItemIdentity(input.runtime, input.toolName)
  const exitCode = numberField(input.resultMetadata, 'exitCode')
  const refs = commandRefs(input.threadId, commandId)
  eventBus?.publish({
    type: 'command.completed',
    projectId: input.projectId,
    threadId: input.threadId,
    commandId,
    result: input.result,
    isError: input.isError,
    durationMs: input.durationMs,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...refs,
    sourceRefs: bashCommandSourceRefs({
      threadId: input.threadId,
      commandId,
      toolInput: input.toolInput,
      projectRoot: input.projectRoot,
      resultMetadata: input.resultMetadata,
    }),
    ...input.metadata,
  })
}

function commandRefs(threadId: string, commandId: string): {
  commandRef: string
  statusRef: string
  outputRef: string
} {
  return {
    commandRef: `command:${threadId}:${commandId}`,
    statusRef: `command-status:${threadId}:${commandId}`,
    outputRef: `command-output:${threadId}:${commandId}`,
  }
}

function bashCommandSourceRefs(input: {
  threadId: string
  commandId: string
  toolInput: Record<string, unknown>
  projectRoot: string
  captureStatus?: BashSourceCaptureStatus
  resultMetadata?: Record<string, unknown> | undefined
}): BashSourceRef[] {
  const command = stringField(input.toolInput, 'command')
  if (!command) return []
  const cwd = commandCwd(input.projectRoot, input.toolInput)
  const capturedPaths = bashCapturedPaths(input.resultMetadata, cwd)
  return extractWriteTargets('bash', { command }, cwd).map((target, index) => {
    const captureStatus = input.captureStatus
      ?? (capturedPaths.has(target.path) ? 'captured' : 'unavailable')
    return {
      sourceRef: `bash-source:${input.threadId}:${input.commandId}:${index}`,
      path: target.path,
      kind: target.kind,
      captureStatus,
      ...(target.destructive ? { destructive: true } : {}),
    }
  })
}

function bashCapturedPaths(metadata: Record<string, unknown> | undefined, cwd: string): Set<string> {
  const paths = new Set<string>()
  const rawCaptures = metadata?.['writeCaptures']
  if (!Array.isArray(rawCaptures)) return paths
  for (const rawCapture of rawCaptures) {
    if (!isRecord(rawCapture)) continue
    const path = stringField(rawCapture, 'path')
    const newContent = stringField(rawCapture, 'newContent')
    if (!path || newContent === undefined) continue
    paths.add(canonicalizeProvenancePath(path, cwd))
  }
  return paths
}

function commandCwd(projectRoot: string, toolInput: Record<string, unknown>): string {
  const cwd = stringField(toolInput, 'cwd')
  if (!cwd) return projectRoot
  return isAbsolute(cwd) ? resolve(cwd) : resolve(projectRoot, cwd)
}

function publishDiffStarted(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    runtime: ToolRuntimeItemMetadata | undefined
    metadata: ReturnType<typeof runtimeEventMetadata>
  },
): void {
  const toolName = diffToolName(input.toolName)
  if (!toolName) return
  const diffId = runtimeItemIdentity(input.runtime, input.toolName)
  const operation = diffOperation(toolName, input.toolInput)
  eventBus?.publish({
    type: 'diff.started',
    projectId: input.projectId,
    threadId: input.threadId,
    diffId,
    toolName,
    input: input.toolInput,
    ...(diffPath(toolName, input.toolInput) ? { path: diffPath(toolName, input.toolInput) } : {}),
    operation,
    ...input.metadata,
  })
}

function publishDiffCompleted(
  eventBus: AppServerEventBus | undefined,
  input: {
    projectId: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    result: string
    isError: boolean
    durationMs: number
    runtime: ToolRuntimeItemMetadata | undefined
    metadata: ReturnType<typeof runtimeEventMetadata>
  },
): void {
  const toolName = diffToolName(input.toolName)
  if (!toolName) return
  const diffId = runtimeItemIdentity(input.runtime, input.toolName)
  eventBus?.publish({
    type: 'diff.completed',
    projectId: input.projectId,
    threadId: input.threadId,
    diffId,
    toolName,
    result: input.result,
    isError: input.isError,
    durationMs: input.durationMs,
    ...(diffPath(toolName, input.toolInput) ? { path: diffPath(toolName, input.toolInput) } : {}),
    operation: diffOperation(toolName, input.toolInput),
    ...input.metadata,
  })
}

function runtimeItemIdentity(runtime: ToolRuntimeItemMetadata | undefined, fallback: string): string {
  return runtime?.itemId ?? runtime?.toolUseId ?? fallback
}

function diffToolName(toolName: string): ReviewChange['toolName'] | null {
  if (toolName === 'edit' || toolName === 'write' || toolName === 'NotebookEdit') return toolName
  return null
}

function diffPath(toolName: ReviewChange['toolName'], toolInput: Record<string, unknown>): string | undefined {
  if (toolName === 'NotebookEdit') return stringField(toolInput, 'notebook_path')
  return stringField(toolInput, 'path')
}

function diffOperation(
  toolName: ReviewChange['toolName'],
  toolInput: Record<string, unknown>,
): ReviewChange['operation'] {
  if (toolName === 'write') return 'overwrite'
  if (toolName === 'NotebookEdit') {
    const editType = stringField(toolInput, 'edit_type')
    if (editType === 'insert') return 'notebook_insert'
    if (editType === 'delete') return 'notebook_delete'
    return 'notebook_replace'
  }
  return 'update'
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'number' ? field : undefined
}

function appServerToolResult(result: ToolResult): Record<string, unknown> {
  return {
    ...(result.metadata ?? {}),
    output: result.output,
  }
}

async function readRuntimeFactArtifacts(session: SessionFile, runId: string): Promise<RunArtifactRecord[]> {
  const workspace = session.taskState?.run.runWorkspace
  if (!workspace || workspace.runId !== runId) return []
  try {
    return (await readArtifactLedger(workspace.runDir)).artifacts
  } catch {
    return []
  }
}

function latestAssistantText(session: SessionFile): string {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index]
    if (turn?.role !== 'assistant') continue
    const text = turn.content
      .map(block => block.type === 'text' ? block.text : '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function defaultInteractionStoragePath(projectRoot: string): string {
  return join(projectRoot, '.owlcoda', 'app-server', 'approvals.json')
}

function toolProgressDelta(
  totals: Map<string, number>,
  toolName: string,
  event: ToolProgressEvent,
  runtime: ToolRuntimeItemMetadata | undefined,
): string {
  const key = runtime?.itemId ?? runtime?.toolUseId ?? toolName
  const previousTotal = totals.get(key) ?? 0
  totals.set(key, event.totalLines)
  const addedLineCount = Math.max(0, event.totalLines - previousTotal)
  if (addedLineCount === 0) return ''
  return event.lines.slice(Math.max(0, event.lines.length - addedLineCount)).join('\n')
}

function reviewBatchEventItems(result: ReviewBatchActionResult) {
  if (result.transaction.failed.length > 0 || result.transaction.rolledBack.length > 0 || result.transaction.rollbackFailed.length > 0) {
    return result.preflight.preflights.map(preflight => reviewBatchEventItemFromTransaction(result, preflight))
  }
  if (result.results.length > 0) {
    return result.results.map(reviewBatchEventItemFromAction)
  }
  return result.preflight.preflights.map(reviewBatchEventItemFromPreflight)
}

function reviewBatchEventItemFromTransaction(result: ReviewBatchActionResult, preflight: ReviewPreflightResult) {
  const failed = new Set(result.transaction.failed.map(item => item.diffId))
  const rolledBack = new Set(result.transaction.rolledBack)
  const rollbackFailed = new Set(result.transaction.rollbackFailed.map(item => item.diffId))
  let status: string = preflight.status
  if (rollbackFailed.has(preflight.change.id)) status = 'rollback_failed'
  else if (rolledBack.has(preflight.change.id)) status = 'rolled_back'
  else if (failed.has(preflight.change.id)) status = 'failed'
  return {
    diffId: preflight.change.id,
    status,
    reason: preflight.reason,
    path: preflight.change.path,
    toolName: preflight.change.toolName,
    operation: preflight.change.operation,
    mode: preflight.change.mode,
  }
}

function reviewBatchEventItemFromAction(result: ReviewActionResult) {
  return {
    diffId: result.change.id,
    status: result.status,
    reason: result.reason,
    path: result.change.path,
    toolName: result.change.toolName,
    operation: result.change.operation,
    mode: result.change.mode,
  }
}

function reviewBatchEventItemFromPreflight(result: ReviewPreflightResult) {
  return {
    diffId: result.change.id,
    status: result.status,
    reason: result.reason,
    path: result.change.path,
    toolName: result.change.toolName,
    operation: result.change.operation,
    mode: result.change.mode,
  }
}

export async function handleRequest(
  registry: AppServerMethodRegistry,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const handler = registry.methods.get(request.method as AppServerMethod)
  if (!handler) {
    return createJsonRpcFailure(request.id, new JsonRpcError(-32601, `Method not found: ${request.method}`))
  }

  try {
    const result = await handler(request.params, request)
    return createJsonRpcSuccess(request.id, result)
  } catch (error) {
    if (error instanceof JsonRpcError) {
      return createJsonRpcFailure(request.id, error)
    }
    return createJsonRpcFailure(
      request.id,
      new JsonRpcError(-32603, error instanceof Error ? error.message : 'Internal error'),
    )
  }
}

function extractProjectId(params: unknown): string | null {
  if (isRecord(params) && typeof params['projectId'] === 'string' && params['projectId'].trim()) {
    return params['projectId']
  }
  if (Array.isArray(params) && typeof params[0] === 'string' && params[0].trim()) {
    return params[0]
  }
  return null
}

function extractThreadId(params: unknown): string | null {
  if (isRecord(params) && typeof params['threadId'] === 'string' && params['threadId'].trim()) {
    return params['threadId']
  }
  if (Array.isArray(params) && typeof params[0] === 'string' && params[0].trim()) {
    return params[0]
  }
  return null
}

function extractDiffId(params: unknown): string | null {
  if (isRecord(params) && typeof params['diffId'] === 'string' && params['diffId'].trim()) {
    return params['diffId']
  }
  if (isRecord(params) && typeof params['changeId'] === 'string' && params['changeId'].trim()) {
    return params['changeId']
  }
  if (Array.isArray(params) && typeof params[1] === 'string' && params[1].trim()) {
    return params[1]
  }
  return null
}

function extractDiffIds(params: unknown): string[] {
  if (isRecord(params)) {
    const value = params['diffIds'] ?? params['changeIds']
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim())
    }
  }
  if (Array.isArray(params) && Array.isArray(params[1])) {
    return params[1]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim())
  }
  const single = extractDiffId(params)
  return single ? [single] : []
}

function extractHunkId(params: unknown): string | null {
  if (isRecord(params) && typeof params['hunkId'] === 'string' && params['hunkId'].trim()) {
    return params['hunkId']
  }
  if (Array.isArray(params) && typeof params[2] === 'string' && params[2].trim()) {
    return params[2]
  }
  return null
}

function extractApprovalId(params: unknown): string | null {
  if (isRecord(params) && typeof params['approvalId'] === 'string' && params['approvalId'].trim()) {
    return params['approvalId']
  }
  if (isRecord(params) && typeof params['id'] === 'string' && params['id'].trim()) {
    return params['id']
  }
  if (Array.isArray(params) && typeof params[0] === 'string' && params[0].trim()) {
    return params[0]
  }
  return null
}

function extractInteractionId(params: unknown): string | null {
  if (isRecord(params) && typeof params['interactionId'] === 'string' && params['interactionId'].trim()) {
    return params['interactionId']
  }
  return extractApprovalId(params)
}

function extractApprovalDecision(params: unknown): AppServerApprovalDecision | null {
  const value = isRecord(params)
    ? params['decision']
    : Array.isArray(params) ? params[1] : null
  return value === 'approve' || value === 'deny' ? value : null
}

function resolveProject(projectRoot: string, params: unknown) {
  const projects = listProjects(projectRoot).projects
  const requestedProjectId = extractProjectId(params)
  const project = projects.find(item => item.id === requestedProjectId) ?? projects[0]
  if (!project) {
    throw new JsonRpcError(-32602, 'Project not found')
  }
  return project
}

function extractStringParam(params: unknown, key: string): string | undefined {
  if (!isRecord(params)) return undefined
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function extractNumberParam(params: unknown, key: string): number | undefined {
  if (!isRecord(params)) return undefined
  const value = params[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
