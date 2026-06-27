import type { AppServerMethod } from './methods.js'
import type { JsonRpcErrorObject, JsonRpcResponse } from './json-rpc.js'
import type {
  AppServerApprovalListResult,
  AppServerApprovalResolveResult,
  AppServerApprovalResolveInput,
  AppServerApprovalListInput,
  AppServerInteractionListResult,
  AppServerInteractionRespondInput,
} from './approval-service.js'
import type {
  ReviewActionResult,
  ReviewBatchActionResult,
  ReviewBatchPreflightResult,
  ReviewHunkActionResult,
  ReviewListResult,
  ReviewPreflightResult,
} from './review-action-service.js'
import type {
  ReviewStatusListResult,
  ReviewStatusUpdateResult,
  ReviewStatusValue,
} from './review-status-service.js'
import type { RuntimeTranscriptResult } from './runtime-transcript-service.js'
import type { ProjectListResult, ProjectSummary } from './project-service.js'
import type { RunKitRailState } from './runtime-rail-service.js'
import type { ThreadListResult, ThreadResumeResult, ThreadStartResult, TurnStartResult } from './thread-service.js'
import type { AppServerEvent } from './event-stream.js'
import type {
  AppServerProtocolDescription,
  AppServerProviderEvalReportReadInput,
  AppServerProviderEvalReportReadResult,
  AppServerRuntimeFactsReadInput,
  AppServerRuntimeFactsReadResult,
  AppServerRuntimeScorecardReadInput,
  AppServerRuntimeScorecardReadResult,
  AppServerStructuredOutputArtifactsReadInput,
  AppServerStructuredOutputArtifactsReadResult,
} from './protocol-contract.js'
import type {
  AppServerTurnRecoverResult,
  AppServerTurnRecoveryAction,
  AppServerTurnStatusResult,
} from './turn-status-service.js'
import type { RunKitGateConfirmResult, RunKitProofAppendResult } from './truth-gateway.js'
import type { JobRecord, JobStatus, JobType } from '../job-supervisor.js'
import type { JobSuggestedAction } from '../tools/job.js'

export interface AppServerClientOptions {
  baseUrl: string
  fetch?: typeof fetch
}

export interface AppServerProofAppendInput {
  projectId?: string
  kind: string
  title: string
  status?: string
  detail?: string
}

export interface AppServerGateConfirmInput {
  projectId?: string
  gateId?: string
  note?: string
  confirmedBy?: string
}

export interface AppServerProjectGetInput {
  projectId?: string
}

export interface AppServerProjectAggregateResult {
  project: ProjectSummary
  rail: RunKitRailState
}

export interface AppServerThreadListInput {
  projectId?: string
  limit?: number
  offset?: number
  query?: string
}

export interface AppServerThreadStartInput {
  projectId?: string
  title?: string
  model?: string
  systemPrompt?: string
}

export interface AppServerTurnStartInput {
  threadId: string
  input: string
  projectId?: string
}

export interface AppServerThreadResumeInput {
  threadId: string
  projectId?: string
}

export interface AppServerRuntimeRailReadInput {
  projectId?: string
}

export interface AppServerEventSubscription {
  transport: 'sse'
  endpoint: string
  events: Array<AppServerEvent['type']>
}

export interface AppServerJobListInput {
  limit?: number
  status?: JobStatus | string
  type?: JobType | string
}

export interface AppServerJobListResult {
  output: string
  jobs: JobRecord[]
  count: number
  filters?: { status?: string; type?: string }
}

export interface AppServerJobGetInput {
  jobId: string
}

export interface AppServerJobGetResult {
  output: string
  job: JobRecord
  actions: JobSuggestedAction[]
}

export interface AppServerJobCancelInput {
  jobId: string
  reason?: string
}

export interface AppServerTurnRecoverInput {
  threadId: string
  projectId?: string
  action: AppServerTurnRecoveryAction
  note?: string
}

export interface AppServerReviewStatusListInput {
  threadId: string
  projectId?: string
}

export interface AppServerReviewStatusUpdateInput extends AppServerReviewStatusListInput {
  diffId: string
  status: ReviewStatusValue | string
  note?: string
  updatedBy?: string
}

export interface AppServerReviewHunkActionInput {
  threadId: string
  diffId: string
  hunkId: string
  projectId?: string
}

export interface AppServerJobCancelResult {
  output: string
  job?: JobRecord
  cancelledVia?: string
  liveCancelAdapter?: boolean
  alreadyTerminal?: boolean
  sourceTaskMissing?: boolean
}

export interface AppServerClient {
  call<T = any>(method: AppServerMethod | string, params?: unknown[] | Record<string, unknown>): Promise<T>
  protocolDescribe(): Promise<AppServerProtocolDescription>
  projectList(): Promise<ProjectListResult>
  projectGet(params?: AppServerProjectGetInput): Promise<AppServerProjectAggregateResult>
  threadList(params?: AppServerThreadListInput): Promise<ThreadListResult>
  threadStart(params?: AppServerThreadStartInput): Promise<ThreadStartResult>
  turnStart(params: AppServerTurnStartInput): Promise<TurnStartResult>
  threadResume(params: AppServerThreadResumeInput): Promise<ThreadResumeResult>
  runtimeRailRead(params?: AppServerRuntimeRailReadInput): Promise<RunKitRailState>
  eventSubscribe(): Promise<AppServerEventSubscription>
  reviewList(params: { threadId: string; projectId?: string }): Promise<ReviewListResult>
  reviewPreflight(params: { threadId: string; diffId: string; projectId?: string }): Promise<ReviewPreflightResult>
  reviewApply(params: { threadId: string; diffId: string; projectId?: string }): Promise<ReviewActionResult>
  reviewRevert(params: { threadId: string; diffId: string; projectId?: string }): Promise<ReviewActionResult>
  reviewHunkApply(params: AppServerReviewHunkActionInput): Promise<ReviewHunkActionResult>
  reviewHunkRevert(params: AppServerReviewHunkActionInput): Promise<ReviewHunkActionResult>
  reviewStatusList(params: AppServerReviewStatusListInput): Promise<ReviewStatusListResult>
  reviewStatusUpdate(params: AppServerReviewStatusUpdateInput): Promise<ReviewStatusUpdateResult>
  reviewBatchPreflight(params: { threadId: string; diffIds: string[]; projectId?: string }): Promise<ReviewBatchPreflightResult>
  reviewBatchApply(params: { threadId: string; diffIds: string[]; projectId?: string }): Promise<ReviewBatchActionResult>
  reviewBatchRevert(params: { threadId: string; diffIds: string[]; projectId?: string }): Promise<ReviewBatchActionResult>
  runtimeTranscriptRead(params: { threadId: string; projectId?: string }): Promise<RuntimeTranscriptResult>
  runtimeFactsRead(params: AppServerRuntimeFactsReadInput): Promise<AppServerRuntimeFactsReadResult>
  runtimeScorecardRead(params: AppServerRuntimeScorecardReadInput): Promise<AppServerRuntimeScorecardReadResult>
  structuredOutputArtifactsRead(params: AppServerStructuredOutputArtifactsReadInput): Promise<AppServerStructuredOutputArtifactsReadResult>
  providerEvalReportRead(params?: AppServerProviderEvalReportReadInput): Promise<AppServerProviderEvalReportReadResult>
  turnStatus(params: { threadId: string; projectId?: string }): Promise<AppServerTurnStatusResult>
  turnRecover(params: AppServerTurnRecoverInput): Promise<AppServerTurnRecoverResult>
  approvalList(params?: AppServerApprovalListInput): Promise<AppServerApprovalListResult>
  approvalResolve(params: AppServerApprovalResolveInput): Promise<AppServerApprovalResolveResult>
  interactionList(params?: AppServerApprovalListInput): Promise<AppServerInteractionListResult>
  interactionRespond(params: AppServerInteractionRespondInput): Promise<AppServerApprovalResolveResult>
  proofAppend(params: AppServerProofAppendInput): Promise<RunKitProofAppendResult>
  gateConfirm(params: AppServerGateConfirmInput): Promise<RunKitGateConfirmResult>
  jobList(params?: AppServerJobListInput): Promise<AppServerJobListResult>
  jobGet(params: AppServerJobGetInput): Promise<AppServerJobGetResult>
  jobCancel(params: AppServerJobCancelInput): Promise<AppServerJobCancelResult>
}

export class AppServerClientError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: JsonRpcErrorObject) {
    super(error.message)
    this.name = 'AppServerClientError'
    this.code = error.code
    this.data = error.data
  }
}

export function createAppServerClient(options: AppServerClientOptions): AppServerClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  let nextId = 1

  const call = async <T = any>(method: AppServerMethod | string, params?: unknown[] | Record<string, unknown>): Promise<T> => {
    const id = nextId++
    const response = await fetchImpl(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }),
    })

    const body = await response.json() as JsonRpcResponse<T>
    if ('error' in body) {
      throw new AppServerClientError(body.error)
    }
    return body.result
  }

  return {
    call,
    protocolDescribe: () => call('protocol/describe', {}),
    projectList: () => call('project/list', {}),
    projectGet: params => call('project/get', params ? { ...params } : {}),
    threadList: params => call('thread/list', params ? { ...params } : {}),
    threadStart: params => call('thread/start', params ? { ...params } : {}),
    turnStart: params => call('turn/start', { ...params }),
    threadResume: params => call('thread/resume', { ...params }),
    runtimeRailRead: params => call('runtimeRail/read', params ? { ...params } : {}),
    eventSubscribe: () => call('event/subscribe', {}),
    reviewList: params => call('review/list', params),
    reviewPreflight: params => call('review/preflight', params),
    reviewApply: params => call('review/apply', params),
    reviewRevert: params => call('review/revert', params),
    reviewHunkApply: params => call('review/hunkApply', { ...params }),
    reviewHunkRevert: params => call('review/hunkRevert', { ...params }),
    reviewStatusList: params => call('review/statusList', { ...params }),
    reviewStatusUpdate: params => call('review/statusUpdate', { ...params }),
    reviewBatchPreflight: params => call('review/batchPreflight', params),
    reviewBatchApply: params => call('review/batchApply', params),
    reviewBatchRevert: params => call('review/batchRevert', params),
    runtimeTranscriptRead: params => call('runtimeTranscript/read', params),
    runtimeFactsRead: params => call('runtimeFacts/read', { ...params }),
    runtimeScorecardRead: params => call('runtimeScorecard/read', { ...params }),
    structuredOutputArtifactsRead: params => call('structuredOutputArtifacts/read', { ...params }),
    providerEvalReportRead: params => call('benchmark/providerEvalReport/read', params ? { ...params } : {}),
    turnStatus: params => call('turn/status', params),
    turnRecover: params => call('turn/recover', { ...params }),
    approvalList: params => call('approval/list', params ? { ...params } : {}),
    approvalResolve: params => call('approval/resolve', { ...params }),
    interactionList: params => call('interaction/list', params ? { ...params } : {}),
    interactionRespond: params => call('interaction/respond', { ...params }),
    proofAppend: params => call('proof/append', { ...params }),
    gateConfirm: params => call('gate/confirm', { ...params }),
    jobList: params => call('job/list', params ? { ...params } : {}),
    jobGet: params => call('job/get', { ...params }),
    jobCancel: params => call('job/cancel', { ...params }),
  }
}

export type { AppServerProtocolDescription }
