import type { RuntimeFactsForRun } from '../runtime-facts.js'
import type { RunScorecard, TrajectoryRecord } from '../scorecard.js'
import type { WorkflowConsumerManifest, WorkflowRunListResult } from '../workflow-consumer.js'
import type { BenchmarkProviderEvalBatchReport } from '../../benchmark/provider-eval-report.js'
import type { AppServerMethod } from './methods.js'

export const APP_SERVER_PROTOCOL_VERSION = 'v1'

export type AppServerMethodStability = 'stable' | 'experimental' | 'debug-only'

export type AppServerMethodGroup =
  | 'benchmark'
  | 'client'
  | 'protocol'
  | 'diagnostic'
  | 'project'
  | 'model'
  | 'workspace'
  | 'attachment'
  | 'event'
  | 'thread'
  | 'turn'
  | 'interaction'
  | 'evidence'
  | 'review'
  | 'runtime'
  | 'job'

export interface AppServerMethodContract {
  method: AppServerMethod
  group: AppServerMethodGroup
  stability: AppServerMethodStability
  requestType: string
  responseType: string
  requires: string[]
  queryKeys: string[]
  notes?: string
}

export interface AppServerProtocolDescription {
  schemaVersion: typeof APP_SERVER_PROTOCOL_VERSION
  protocolVersion: typeof APP_SERVER_PROTOCOL_VERSION
  methods: AppServerMethodContract[]
}

export type {
  AppServerClientIdentity,
  AppServerClientInitializeInput,
  AppServerClientInitializeResult,
  AppServerCompatibility,
} from './runtime-identity.js'

export interface AppServerRuntimeFactsReadInput {
  threadId: string
  runId: string
  projectId?: string
}

export interface AppServerRuntimeFactsReadResult extends RuntimeFactsForRun {
  threadId: string
  projectId?: string
  runtimeEventCount: number
  checkpointCount: number
  jobCount: number
  artifactCount: number
}

export interface AppServerRuntimeScorecardReadInput extends AppServerRuntimeFactsReadInput {
  finalText?: string
}

export interface AppServerRuntimeScorecardReadResult {
  schemaVersion: 1
  threadId: string
  projectId?: string
  runId: string
  scorecard: RunScorecard
  summary: string
  trajectory: {
    recordCount: number
    localOnly: true
    redactionMode: 'local_redacted_v0'
    records: TrajectoryRecord[]
  }
  facts: {
    runtimeEventCount: number
    checkpointCount: number
    jobCount: number
    artifactCount: number
  }
}

export interface AppServerStructuredOutputArtifactsReadInput extends AppServerRuntimeFactsReadInput {
  artifactId?: string
}

export interface AppServerWorkflowRunListInput {
  projectId?: string
  workflowRoot?: string
  limit?: number
}

export interface AppServerWorkflowRunReadInput extends AppServerWorkflowRunListInput {
  runId: string
}

export type AppServerWorkflowRunListResult = WorkflowRunListResult

export type { WorkflowConsumerManifest }

export type AppServerStructuredOutputArtifactStatus = 'success' | 'warning' | 'failed'

export interface AppServerStructuredOutputAttemptItem {
  label: string
  model?: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  stopReason?: string
  parsed?: boolean
  schemaValid?: boolean
  error?: string
}

export interface AppServerStructuredOutputRerunAction {
  available: boolean
  httpEndpoint: '/v1/structured-output/rerun'
  request?: {
    runRef: string
    previousArtifactId: string
    role?: string
    model: string
    preset: string
    artifactRef: string
  }
  unavailableReason?: string
}

export interface AppServerStructuredOutputArtifactItem {
  artifactId: string
  attemptLedgerId?: string
  status: AppServerStructuredOutputArtifactStatus
  ok: boolean | null
  parsed: boolean | null
  schemaValid: boolean | null
  repairCount: number
  salvageUsed: boolean
  fallbackUsed: boolean
  role?: string | null
  model?: string
  preset?: string
  requestFingerprint?: string | null
  schemaHash?: string | null
  policyHash?: string | null
  validationErrors: string[]
  stopReason?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  durationMs?: number | null
  artifactPreview: unknown
  rawText?: string
  rawThinkingText?: string | null
  attempts: AppServerStructuredOutputAttemptItem[]
  rerunAction: AppServerStructuredOutputRerunAction
}

export interface AppServerStructuredOutputArtifactsReadResult {
  schemaVersion: 1
  surface: 'structured-output-artifacts'
  threadId: string
  projectId?: string
  runId: string
  artifactCount: number
  successCount: number
  failedCount: number
  warningCount: number
  items: AppServerStructuredOutputArtifactItem[]
  warnings: string[]
}

export interface AppServerProviderEvalReportReadInput {
  recordPath?: string
}

export interface AppServerProviderEvalReportReadResult {
  schemaVersion: 1
  source: 'local_provider_eval_store'
  recordPath: string
  recordCount: number
  report: BenchmarkProviderEvalBatchReport
  markdown: string
}

export const APP_SERVER_METHOD_CONTRACTS: Record<AppServerMethod, AppServerMethodContract> = {
  'benchmark/providerEvalReport/read': {
    method: 'benchmark/providerEvalReport/read',
    group: 'benchmark',
    stability: 'experimental',
    requestType: 'AppServerProviderEvalReportReadInput',
    responseType: 'AppServerProviderEvalReportReadResult',
    requires: [],
    queryKeys: ['recordPath'],
    notes: 'Reads local provider eval JSONL records and returns a local-only leaderboard/case matrix. It does not upload or train.',
  },
  'client/initialize': {
    method: 'client/initialize',
    group: 'client',
    stability: 'stable',
    requestType: 'AppServerClientInitializeInput',
    responseType: 'AppServerClientInitializeResult',
    requires: ['client', 'supportedProtocolVersions', 'expectedWorkspaceRealpath'],
    queryKeys: [
      'client',
      'supportedProtocolVersions',
      'expectedRuntimeVersion',
      'expectedWorkspaceRealpath',
      'requestedCapabilities',
    ],
    notes: 'Authenticates runtime, protocol, and canonical workspace identity before a client attaches.',
  },
  'protocol/describe': {
    method: 'protocol/describe',
    group: 'protocol',
    stability: 'stable',
    requestType: 'Record<string, never>',
    responseType: 'AppServerProtocolDescription',
    requires: [],
    queryKeys: [],
    notes: 'Authoritative method contract and stability discovery endpoint.',
  },
  'diagnostic/health': {
    method: 'diagnostic/health',
    group: 'diagnostic',
    stability: 'debug-only',
    requestType: 'Record<string, never>',
    responseType: 'RuntimeHealthSnapshot',
    requires: [],
    queryKeys: [],
    notes: 'Operator diagnostics. Do not treat as a long-term product UI contract.',
  },
  'project/list': {
    method: 'project/list',
    group: 'project',
    stability: 'stable',
    requestType: 'Record<string, never>',
    responseType: 'ProjectListResult',
    requires: [],
    queryKeys: [],
  },
  'project/get': {
    method: 'project/get',
    group: 'project',
    stability: 'stable',
    requestType: '{ projectId?: string }',
    responseType: 'ProjectAggregateResult',
    requires: [],
    queryKeys: ['projectId'],
  },
  'model/list': {
    method: 'model/list',
    group: 'model',
    stability: 'stable',
    requestType: 'Record<string, never>',
    responseType: 'AppServerModelListResult',
    requires: [],
    queryKeys: [],
  },
  'workspace/list': {
    method: 'workspace/list',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'Record<string, never>',
    responseType: 'ManagedWorkspaceListResult',
    requires: [],
    queryKeys: [],
    notes: 'Lists only OwlCoda-managed, ledger-backed worktrees for the current Git repository.',
  },
  'workspace/create': {
    method: 'workspace/create',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceCreateInput',
    responseType: 'ManagedWorkspaceCreateResult',
    requires: ['slug'],
    queryKeys: ['slug', 'startingRef', 'allowUntracked'],
    notes: 'Requires an injected trusted host authorizer before creating a managed worktree; does not change the long-lived App Server process cwd.',
  },
  'workspace/read': {
    method: 'workspace/read',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceLookupInput',
    responseType: 'ManagedWorkspaceReadResult',
    requires: ['workspaceId'],
    queryKeys: ['workspaceId'],
  },
  'workspace/resume': {
    method: 'workspace/resume',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceLookupInput',
    responseType: 'ManagedWorkspaceResumeResult',
    requires: ['workspaceId'],
    queryKeys: ['workspaceId'],
    notes: 'Requires an injected trusted host authorizer and fails closed unless ledger, path, branch, and base commit still match Git truth.',
  },
  'workspace/status': {
    method: 'workspace/status',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceLookupInput',
    responseType: 'ManagedWorkspaceStatusResult',
    requires: ['workspaceId'],
    queryKeys: ['workspaceId'],
    notes: 'Returns the current HEAD and status fingerprint used for stale-request detection; this is not strong fencing against unbrokered host writes.',
  },
  'workspace/commit': {
    method: 'workspace/commit',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceCommitInput',
    responseType: 'ManagedWorkspaceOperationResult',
    requires: ['workspaceId', 'requestId', 'message', 'expectedHead', 'expectedStatusFingerprint', 'authorized'],
    queryKeys: [],
    notes: 'Requires explicit trusted-host authorization and revalidates current workspace state; direct Git mutation is experimental and is not strong fencing against unbrokered host writes. Exact request replay is idempotent.',
  },
  'workspace/keep': {
    method: 'workspace/keep',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceAuthorizedInput',
    responseType: 'ManagedWorkspaceOperationResult',
    requires: ['workspaceId', 'requestId', 'expectedHead', 'expectedStatusFingerprint', 'authorized'],
    queryKeys: [],
    notes: 'Keeps the managed worktree and records an explicit durable lifecycle receipt.',
  },
  'workspace/cleanup': {
    method: 'workspace/cleanup',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceCleanupInput',
    responseType: 'ManagedWorkspaceOperationResult',
    requires: ['workspaceId', 'requestId', 'expectedHead', 'expectedStatusFingerprint', 'authorized'],
    queryKeys: [],
    notes: 'Removes the worktree only after explicit trusted-host authorization and stale-request checks; direct removal is not strong fencing against unbrokered host writes. The branch is retained by default.',
  },
  'workspace/handoff': {
    method: 'workspace/handoff',
    group: 'workspace',
    stability: 'experimental',
    requestType: 'ManagedWorkspaceHandoffInput',
    responseType: 'ManagedWorkspaceOperationResult',
    requires: [
      'workspaceId',
      'threadId',
      'direction',
      'requestId',
      'expectedHead',
      'expectedStatusFingerprint',
      'expectedProjectHead',
      'expectedProjectStatusFingerprint',
      'authorized',
    ],
    queryKeys: [],
    notes: 'Moves one persisted thread and its managed branch only after trusted-host authorization and two-checkout stale-request checks; direct branch switching is not strong fencing against unbrokered host writes.',
  },
  'attachment/store': {
    method: 'attachment/store',
    group: 'attachment',
    stability: 'experimental',
    requestType: 'AppServerAttachmentStoreInput',
    responseType: 'PublicStoredAttachment',
    requires: ['name', 'mediaType', 'dataBase64'],
    queryKeys: ['projectId'],
  },
  'event/subscribe': {
    method: 'event/subscribe',
    group: 'event',
    stability: 'experimental',
    requestType: 'Record<string, never>',
    responseType: 'AppServerEventSubscription',
    requires: [],
    queryKeys: [],
  },
  'event/snapshot': {
    method: 'event/snapshot',
    group: 'event',
    stability: 'experimental',
    requestType: '{ projectId?: string }',
    responseType: 'AppServerEventSnapshotResult',
    requires: [],
    queryKeys: ['projectId'],
  },
  'thread/start': {
    method: 'thread/start',
    group: 'thread',
    stability: 'stable',
    requestType: 'ThreadStartInput',
    responseType: 'ThreadStartResult',
    requires: [],
    queryKeys: ['projectId', 'model', 'reasoningEffort', 'permissionMode', 'workspaceMode'],
  },
  'thread/list': {
    method: 'thread/list',
    group: 'thread',
    stability: 'stable',
    requestType: '{ projectId?: string }',
    responseType: 'ThreadListResult',
    requires: [],
    queryKeys: ['projectId'],
  },
  'thread/read': {
    method: 'thread/read',
    group: 'thread',
    stability: 'stable',
    requestType: 'AppServerThreadReadInput',
    responseType: 'ThreadReadResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId', 'limit', 'cursor'],
  },
  'thread/resume': {
    method: 'thread/resume',
    group: 'thread',
    stability: 'stable',
    requestType: '{ threadId: string; projectId?: string; model?: string; reasoningEffort?: ReasoningEffort }',
    responseType: 'ThreadResumeResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId', 'model', 'reasoningEffort'],
  },
  'turn/start': {
    method: 'turn/start',
    group: 'turn',
    stability: 'experimental',
    requestType: 'AppServerTurnStartInput',
    responseType: 'TurnStartResult',
    requires: ['threadId'],
		queryKeys: ['threadId', 'projectId', 'retry', 'title'],
  },
  'turn/status': {
    method: 'turn/status',
    group: 'turn',
    stability: 'experimental',
    requestType: '{ threadId: string; projectId?: string }',
    responseType: 'AppServerTurnStatusResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId'],
  },
  'turn/recover': {
    method: 'turn/recover',
    group: 'turn',
    stability: 'experimental',
    requestType: 'AppServerTurnRecoverInput',
    responseType: 'AppServerTurnRecoverResult',
    requires: ['threadId', 'action'],
    queryKeys: ['threadId', 'projectId'],
  },
  'turn/interrupt': {
    method: 'turn/interrupt',
    group: 'turn',
    stability: 'experimental',
    requestType: '{ threadId: string; projectId?: string }',
    responseType: 'TurnInterruptResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId'],
  },
  'approval/list': {
    method: 'approval/list',
    group: 'interaction',
    stability: 'stable',
    requestType: 'AppServerApprovalListInput',
    responseType: 'AppServerApprovalListResult',
    requires: [],
    queryKeys: ['threadId', 'projectId'],
  },
  'approval/resolve': {
    method: 'approval/resolve',
    group: 'interaction',
    stability: 'stable',
    requestType: 'AppServerApprovalResolveInput',
    responseType: 'AppServerApprovalResolveResult',
    requires: ['approvalId', 'decision'],
    queryKeys: ['threadId', 'projectId'],
  },
  'interaction/list': {
    method: 'interaction/list',
    group: 'interaction',
    stability: 'stable',
    requestType: 'AppServerApprovalListInput',
    responseType: 'AppServerInteractionListResult',
    requires: [],
    queryKeys: ['threadId', 'projectId'],
  },
  'interaction/respond': {
    method: 'interaction/respond',
    group: 'interaction',
    stability: 'stable',
    requestType: 'AppServerInteractionRespondInput',
    responseType: 'AppServerApprovalResolveResult',
    requires: ['interactionId'],
    queryKeys: ['threadId', 'projectId'],
  },
  'review/list': {
    method: 'review/list',
    group: 'review',
    stability: 'stable',
    requestType: '{ threadId: string; projectId?: string }',
    responseType: 'ReviewListResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId'],
    notes: 'Returns independent repository-wide Unstaged Git worktree truth and receipt-backed Last Turn changes. Unstaged is read-only and fails closed when Git truth is unavailable.',
  },
  'review/preflight': {
    method: 'review/preflight',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffId: string; projectId?: string }',
    responseType: 'ReviewPreflightResult',
    requires: ['threadId', 'diffId'],
    queryKeys: ['threadId', 'projectId', 'diffId'],
  },
  'review/apply': {
    method: 'review/apply',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffId: string; projectId?: string }',
    responseType: 'ReviewActionResult',
    requires: ['threadId', 'diffId'],
    queryKeys: ['threadId', 'projectId', 'diffId'],
  },
  'review/revert': {
    method: 'review/revert',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffId: string; projectId?: string }',
    responseType: 'ReviewActionResult',
    requires: ['threadId', 'diffId'],
    queryKeys: ['threadId', 'projectId', 'diffId'],
  },
  'review/hunkApply': {
    method: 'review/hunkApply',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffId: string; hunkId: string; projectId?: string }',
    responseType: 'ReviewHunkActionResult',
    requires: ['threadId', 'diffId', 'hunkId'],
    queryKeys: ['threadId', 'projectId', 'diffId', 'hunkId'],
  },
  'review/hunkRevert': {
    method: 'review/hunkRevert',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffId: string; hunkId: string; projectId?: string }',
    responseType: 'ReviewHunkActionResult',
    requires: ['threadId', 'diffId', 'hunkId'],
    queryKeys: ['threadId', 'projectId', 'diffId', 'hunkId'],
  },
  'review/statusList': {
    method: 'review/statusList',
    group: 'review',
    stability: 'stable',
    requestType: '{ threadId: string; projectId?: string }',
    responseType: 'ReviewStatusListResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId'],
  },
  'review/statusUpdate': {
    method: 'review/statusUpdate',
    group: 'review',
    stability: 'stable',
    requestType: 'AppServerReviewStatusUpdateInput',
    responseType: 'ReviewStatusUpdateResult',
    requires: ['threadId', 'diffId', 'status'],
    queryKeys: ['threadId', 'projectId', 'diffId'],
  },
  'review/batchPreflight': {
    method: 'review/batchPreflight',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffIds: string[]; projectId?: string }',
    responseType: 'ReviewBatchPreflightResult',
    requires: ['threadId', 'diffIds'],
    queryKeys: ['threadId', 'projectId', 'diffIds'],
  },
  'review/batchApply': {
    method: 'review/batchApply',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffIds: string[]; projectId?: string }',
    responseType: 'ReviewBatchActionResult',
    requires: ['threadId', 'diffIds'],
    queryKeys: ['threadId', 'projectId', 'diffIds'],
  },
  'review/batchRevert': {
    method: 'review/batchRevert',
    group: 'review',
    stability: 'experimental',
    requestType: '{ threadId: string; diffIds: string[]; projectId?: string }',
    responseType: 'ReviewBatchActionResult',
    requires: ['threadId', 'diffIds'],
    queryKeys: ['threadId', 'projectId', 'diffIds'],
  },
  'runtimeRail/read': {
    method: 'runtimeRail/read',
    group: 'runtime',
    stability: 'experimental',
    requestType: '{ projectId?: string }',
    responseType: 'RunKitRailState',
    requires: [],
    queryKeys: ['projectId'],
    notes: 'Read-only OwlCodaRunKitInspectSummaryV1 projection from project-owned .owlcoda/runkit truth; it grants no Git or release authority.',
  },
  'runtimeTranscript/read': {
    method: 'runtimeTranscript/read',
    group: 'runtime',
    stability: 'stable',
    requestType: '{ threadId: string; projectId?: string }',
    responseType: 'RuntimeTranscriptResult',
    requires: ['threadId'],
    queryKeys: ['threadId', 'projectId'],
    notes: 'Desktop-facing transcript items omit provider hidden thinking; reasoning effort metadata does not expose chain-of-thought.',
  },
  'runtimeFacts/read': {
    method: 'runtimeFacts/read',
    group: 'runtime',
    stability: 'experimental',
    requestType: 'AppServerRuntimeFactsReadInput',
    responseType: 'AppServerRuntimeFactsReadResult',
    requires: ['threadId', 'runId'],
    queryKeys: ['threadId', 'projectId', 'runId'],
  },
  'runtimeScorecard/read': {
    method: 'runtimeScorecard/read',
    group: 'runtime',
    stability: 'experimental',
    requestType: 'AppServerRuntimeScorecardReadInput',
    responseType: 'AppServerRuntimeScorecardReadResult',
    requires: ['threadId', 'runId'],
    queryKeys: ['threadId', 'projectId', 'runId'],
    notes: 'Generates a local scorecard and redacted trajectory from runtime facts. It does not upload or train.',
  },
  'structuredOutputArtifacts/read': {
    method: 'structuredOutputArtifacts/read',
    group: 'runtime',
    stability: 'experimental',
    requestType: 'AppServerStructuredOutputArtifactsReadInput',
    responseType: 'AppServerStructuredOutputArtifactsReadResult',
    requires: ['threadId', 'runId'],
    queryKeys: ['threadId', 'projectId', 'runId', 'artifactId'],
    notes: 'Reads local structured output artifacts, attempts, raw text, and rerun action metadata from RunWorkspace. It does not call models.',
  },
  'workflowRun/list': {
    method: 'workflowRun/list',
    group: 'runtime',
    stability: 'experimental',
    requestType: 'AppServerWorkflowRunListInput',
    responseType: 'AppServerWorkflowRunListResult',
    requires: [],
    queryKeys: ['projectId', 'workflowRoot', 'limit'],
    notes: 'Lists local WorkflowRun receipts as WorkflowConsumerManifest summaries. It does not execute or resume workflows.',
  },
  'workflowRun/read': {
    method: 'workflowRun/read',
    group: 'runtime',
    stability: 'experimental',
    requestType: 'AppServerWorkflowRunReadInput',
    responseType: 'WorkflowConsumerManifest',
    requires: ['runId'],
    queryKeys: ['projectId', 'workflowRoot', 'runId'],
    notes: 'Reads one local WorkflowConsumerManifest by run id. It is read-only and does not call models.',
  },
  'job/list': {
    method: 'job/list',
    group: 'job',
    stability: 'stable',
    requestType: 'AppServerJobListInput',
    responseType: 'AppServerJobListResult',
    requires: [],
    queryKeys: ['status', 'type', 'limit'],
  },
  'job/get': {
    method: 'job/get',
    group: 'job',
    stability: 'stable',
    requestType: 'AppServerJobGetInput',
    responseType: 'AppServerJobGetResult',
    requires: ['jobId'],
    queryKeys: ['jobId'],
  },
  'job/cancel': {
    method: 'job/cancel',
    group: 'job',
    stability: 'stable',
    requestType: 'AppServerJobCancelInput',
    responseType: 'AppServerJobCancelResult',
    requires: ['jobId'],
    queryKeys: ['jobId', 'reason'],
  },
}

export function listAppServerMethodContracts(): AppServerMethodContract[] {
  return Object.values(APP_SERVER_METHOD_CONTRACTS).sort((a, b) => a.method.localeCompare(b.method))
}

export function describeAppServerProtocol(): AppServerProtocolDescription {
  return {
    schemaVersion: APP_SERVER_PROTOCOL_VERSION,
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    methods: listAppServerMethodContracts(),
  }
}

export function getAppServerMethodContract(method: AppServerMethod): AppServerMethodContract {
  return APP_SERVER_METHOD_CONTRACTS[method]
}
