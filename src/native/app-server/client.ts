import type { AppServerMethod } from './methods.js'
import type { JsonRpcErrorObject, JsonRpcResponse } from './json-rpc.js'
import type {
  AppServerApprovalListResult,
  AppServerApprovalResolveResult,
  AppServerApprovalResolveInput,
  AppServerApprovalListInput,
  AppServerInteractionListResult,
  AppServerInteractionRespondInput,
  AppServerInteractionRequest,
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
import type { AppServerThread, ThreadListResult, ThreadReadResult, ThreadResumeResult, ThreadStartResult, TurnStartResult } from './thread-service.js'
import type { AppServerEvent, AppServerEventCursor } from './event-stream.js'
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
  AppServerWorkflowRunListInput,
  AppServerWorkflowRunListResult,
  AppServerWorkflowRunReadInput,
  WorkflowConsumerManifest,
} from './protocol-contract.js'
import type {
  AppServerClientInitializeInput,
  AppServerClientInitializeResult,
} from './runtime-identity.js'
import {
  classifyAppServerCompatibility,
  isAppServerClientInitializeResult,
} from './runtime-identity.js'
import type {
  AppServerTurnRecoverResult,
  AppServerTurnRecoveryAction,
  AppServerTurnStatusResult,
} from './turn-status-service.js'
import type { JobRecord, JobStatus, JobType } from '../job-supervisor.js'
import type { JobSuggestedAction } from '../tools/job.js'
import type {
  ManagedWorkspaceAuthorizedInput,
  ManagedWorkspaceCleanupInput,
  ManagedWorkspaceCommitInput,
  ManagedWorkspaceCreateInput,
  ManagedWorkspaceDescriptor,
  ManagedWorkspaceHandoffInput,
  ManagedWorkspaceLookupInput,
  ManagedWorkspaceOperationResult,
  ManagedWorkspaceStatusResult,
} from './managed-workspace-service.js'

export interface AppServerClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  token?: string
  headers?: HeadersInit
}

export type AppServerCompatibilityCheckResult =
  | AppServerClientInitializeResult
  | { compatibility: 'protocol_mismatch' | 'unreachable' }

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
  permissionMode?: 'plan' | 'normal' | 'auto' | 'yolo'
  workspaceMode?: 'project' | 'managed'
}

export interface AppServerThreadReadInput {
  threadId: string
  projectId?: string
  limit?: number
  cursor?: string
}

export interface AppServerTurnStartInput {
	threadId: string
	input?: string
	content?: AppServerTurnContentBlock[]
	projectId?: string
	retry?: boolean
	title?: string
}

export type AppServerTurnContentBlock =
  | { type: 'text'; text: string }
  | { type: 'localImage'; attachmentId: string }
  | { type: 'fileRef'; path: string }

export interface AppServerAttachmentStoreInput {
  projectId?: string
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  dataBase64: string
}

export interface AppServerAttachmentStoreResult {
  id: string
  name: string
  mediaType: string
  size: number
}

export interface AppServerModelListResult {
  defaultModelId: string | null
  defaultPermissionMode: 'plan' | 'normal' | 'auto' | 'yolo'
  permissionModes: Array<{ id: 'plan' | 'normal' | 'auto' | 'yolo'; label: string; detail: string }>
  workspaceModes: Array<{ id: 'project' | 'managed'; available: boolean }>
  models: Array<{
    id: string
    label: string
    provider: string
    tier: string
    origin: 'cloud' | 'local' | 'unknown'
    availability: 'available' | 'unavailable' | 'unknown'
    isDefault: boolean
    unavailableReason?: string
    vision: { status: 'supported' | 'unsupported' | 'unknown'; inputImages: boolean; source: string; labels: string[]; reason?: string }
  }>
}

export type AppServerManagedWorkspaceCreateInput = ManagedWorkspaceCreateInput
export type AppServerManagedWorkspaceLookupInput = ManagedWorkspaceLookupInput
export type AppServerManagedWorkspaceCommitInput = ManagedWorkspaceCommitInput
export type AppServerManagedWorkspaceKeepInput = ManagedWorkspaceAuthorizedInput
export type AppServerManagedWorkspaceCleanupInput = ManagedWorkspaceCleanupInput
export type AppServerManagedWorkspaceHandoffInput = ManagedWorkspaceHandoffInput
export interface AppServerManagedWorkspaceListResult { workspaces: ManagedWorkspaceDescriptor[] }
export interface AppServerManagedWorkspaceCreateResult { workspace: ManagedWorkspaceDescriptor }
export interface AppServerManagedWorkspaceReadResult { workspace: ManagedWorkspaceDescriptor }
export interface AppServerManagedWorkspaceResumeResult { workspace: ManagedWorkspaceDescriptor; resumed: true }
export type AppServerManagedWorkspaceStatusResult = ManagedWorkspaceStatusResult
export type AppServerManagedWorkspaceOperationResult = ManagedWorkspaceOperationResult

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
  cursor: AppServerEventCursor
}

export interface AppServerEventSnapshotResult {
  schemaVersion: 1
  projectId: string
  workspaceId: string
  threads: AppServerThread[]
  interactions: AppServerInteractionRequest[]
  cursor: AppServerEventCursor
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
  eventStreamRequest(options?: { afterSequence?: number }): { url: string; headers: Headers }
  protocolDescribe(): Promise<AppServerProtocolDescription>
  initialize(params: AppServerClientInitializeInput): Promise<AppServerClientInitializeResult>
  checkCompatibility(params: AppServerClientInitializeInput): Promise<AppServerCompatibilityCheckResult>
  projectList(): Promise<ProjectListResult>
  projectGet(params?: AppServerProjectGetInput): Promise<AppServerProjectAggregateResult>
  modelList(): Promise<AppServerModelListResult>
  workspaceList(): Promise<AppServerManagedWorkspaceListResult>
  workspaceCreate(params: AppServerManagedWorkspaceCreateInput): Promise<AppServerManagedWorkspaceCreateResult>
  workspaceRead(params: AppServerManagedWorkspaceLookupInput): Promise<AppServerManagedWorkspaceReadResult>
  workspaceResume(params: AppServerManagedWorkspaceLookupInput): Promise<AppServerManagedWorkspaceResumeResult>
  workspaceStatus(params: AppServerManagedWorkspaceLookupInput): Promise<AppServerManagedWorkspaceStatusResult>
  workspaceCommit(params: AppServerManagedWorkspaceCommitInput): Promise<AppServerManagedWorkspaceOperationResult>
  workspaceKeep(params: AppServerManagedWorkspaceKeepInput): Promise<AppServerManagedWorkspaceOperationResult>
  workspaceCleanup(params: AppServerManagedWorkspaceCleanupInput): Promise<AppServerManagedWorkspaceOperationResult>
  workspaceHandoff(params: AppServerManagedWorkspaceHandoffInput): Promise<AppServerManagedWorkspaceOperationResult>
  attachmentStore(params: AppServerAttachmentStoreInput): Promise<AppServerAttachmentStoreResult>
  threadList(params?: AppServerThreadListInput): Promise<ThreadListResult>
  threadRead(params: AppServerThreadReadInput): Promise<ThreadReadResult>
  threadStart(params?: AppServerThreadStartInput): Promise<ThreadStartResult>
  turnStart(params: AppServerTurnStartInput): Promise<TurnStartResult>
  threadResume(params: AppServerThreadResumeInput): Promise<ThreadResumeResult>
  runtimeRailRead(params?: AppServerRuntimeRailReadInput): Promise<RunKitRailState>
  eventSubscribe(): Promise<AppServerEventSubscription>
  eventSnapshot(params?: AppServerProjectGetInput): Promise<AppServerEventSnapshotResult>
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
  workflowRunList(params?: AppServerWorkflowRunListInput): Promise<AppServerWorkflowRunListResult>
  workflowRunRead(params: AppServerWorkflowRunReadInput): Promise<WorkflowConsumerManifest>
  providerEvalReportRead(params?: AppServerProviderEvalReportReadInput): Promise<AppServerProviderEvalReportReadResult>
  turnStatus(params: { threadId: string; projectId?: string }): Promise<AppServerTurnStatusResult>
  turnRecover(params: AppServerTurnRecoverInput): Promise<AppServerTurnRecoverResult>
  approvalList(params?: AppServerApprovalListInput): Promise<AppServerApprovalListResult>
  approvalResolve(params: AppServerApprovalResolveInput): Promise<AppServerApprovalResolveResult>
  interactionList(params?: AppServerApprovalListInput): Promise<AppServerInteractionListResult>
  interactionRespond(params: AppServerInteractionRespondInput): Promise<AppServerApprovalResolveResult>
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
  const requestHeaders = new Headers(options.headers)
  requestHeaders.set('content-type', 'application/json')
  if (options.token) requestHeaders.set('authorization', `Bearer ${options.token}`)
  let nextId = 1

  const call = async <T = any>(method: AppServerMethod | string, params?: unknown[] | Record<string, unknown>): Promise<T> => {
    const id = nextId++
    const response = await fetchImpl(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }),
    })

    if (response.status === 401) {
      throw new AppServerClientError({ code: -32001, message: 'Unauthorized' })
    }
    if (response.status === 403) {
      throw new AppServerClientError({ code: -32002, message: 'Origin or loopback policy rejected the request' })
    }

    const parsed = await response.json() as unknown
    if (!isJsonRpcResponse<T>(parsed)) {
      throw new Error('Invalid JSON-RPC response from App Server')
    }
    const body = parsed
    if (body.id !== id) {
      throw new Error(`Invalid JSON-RPC response id from App Server: expected ${id}, received ${String(body.id)}`)
    }
    if ('error' in body) {
      throw new AppServerClientError(body.error)
    }
    return body.result
  }

  const initialize = async (params: AppServerClientInitializeInput): Promise<AppServerClientInitializeResult> => {
    const result = await call<unknown>('client/initialize', { ...params })
    if (!isAppServerClientInitializeResult(result)) {
      throw new Error('Invalid client/initialize result from App Server')
    }
    return result
  }

  const checkCompatibility = async (params: AppServerClientInitializeInput): Promise<AppServerCompatibilityCheckResult> => {
    try {
      const result = await initialize(params)
      return {
        ...result,
        compatibility: classifyAppServerCompatibility(params, result),
      }
    } catch (error) {
      if (error instanceof AppServerClientError) {
        if (error.code === -32601) return { compatibility: 'protocol_mismatch' }
        throw error
      }
      return { compatibility: 'unreachable' }
    }
  }

  return {
    call,
    eventStreamRequest: (streamOptions = {}) => {
      const headers = new Headers(requestHeaders)
      const url = new URL(`${baseUrl}/events`)
      if (streamOptions.afterSequence !== undefined) {
        const value = String(streamOptions.afterSequence)
        url.searchParams.set('afterSequence', value)
        headers.set('last-event-id', value)
      }
      return { url: url.toString(), headers }
    },
    initialize,
    checkCompatibility,
    protocolDescribe: () => call('protocol/describe', {}),
    projectList: () => call('project/list', {}),
    projectGet: params => call('project/get', params ? { ...params } : {}),
    modelList: () => call('model/list', {}),
    workspaceList: () => call('workspace/list', {}),
    workspaceCreate: params => call('workspace/create', { ...params }),
    workspaceRead: params => call('workspace/read', { ...params }),
    workspaceResume: params => call('workspace/resume', { ...params }),
    workspaceStatus: params => call('workspace/status', { ...params }),
    workspaceCommit: params => call('workspace/commit', { ...params }),
    workspaceKeep: params => call('workspace/keep', { ...params }),
    workspaceCleanup: params => call('workspace/cleanup', { ...params }),
    workspaceHandoff: params => call('workspace/handoff', { ...params }),
    attachmentStore: params => call('attachment/store', { ...params }),
    threadList: params => call('thread/list', params ? { ...params } : {}),
    threadRead: params => call('thread/read', { ...params }),
    threadStart: params => call('thread/start', params ? { ...params } : {}),
    turnStart: params => call('turn/start', { ...params }),
    threadResume: params => call('thread/resume', { ...params }),
    runtimeRailRead: params => call('runtimeRail/read', params ? { ...params } : {}),
    eventSubscribe: () => call('event/subscribe', {}),
    eventSnapshot: params => call('event/snapshot', params ? { ...params } : {}),
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
    workflowRunList: params => call('workflowRun/list', params ? { ...params } : {}),
    workflowRunRead: params => call('workflowRun/read', { ...params }),
    providerEvalReportRead: params => call('benchmark/providerEvalReport/read', params ? { ...params } : {}),
    turnStatus: params => call('turn/status', params),
    turnRecover: params => call('turn/recover', { ...params }),
    approvalList: params => call('approval/list', params ? { ...params } : {}),
    approvalResolve: params => call('approval/resolve', { ...params }),
    interactionList: params => call('interaction/list', params ? { ...params } : {}),
    interactionRespond: params => call('interaction/respond', { ...params }),
    jobList: params => call('job/list', params ? { ...params } : {}),
    jobGet: params => call('job/get', { ...params }),
    jobCancel: params => call('job/cancel', { ...params }),
  }
}

function isJsonRpcResponse<T>(value: unknown): value is JsonRpcResponse<T> {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !('id' in value)) return false
  const hasResult = 'result' in value
  const hasError = 'error' in value
  if (hasResult === hasError) return false
  if (!hasError) return true
  return isRecord(value.error)
    && typeof value.error.code === 'number'
    && typeof value.error.message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { AppServerProtocolDescription }
