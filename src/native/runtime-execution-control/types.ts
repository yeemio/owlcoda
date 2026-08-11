import type {
  WorkflowRequestAdmissionHook,
  WorkflowContractSnapshot,
  WorkflowResumeSourceSnapshot,
  WorkflowResumePlanSnapshot,
  WorkflowRunInput,
  WorkflowRunOptions,
  WorkflowRunResult,
} from '../workflow-runner.js'
import type { RuntimeExecutionAuthorizationGrant } from './grants.js'

export const OWLCODA_NATIVE_DRIVER_ID = 'owlcoda-native'
export const KIMI_CLI_DRIVER_ID = 'vendor-native:kimi-cli'
export const CURSOR_AGENT_DRIVER_ID = 'vendor-native:cursor-agent'
export const CODEX_CLI_DRIVER_ID = 'vendor-native:codex-cli'

export const KIMI_CLI_TASK_KIND = 'kimi-cli-structured-output-v1'
export const CURSOR_AGENT_TASK_KIND = 'cursor-agent-structured-output-v1'
export const CODEX_CLI_TASK_KIND = 'codex-cli-structured-output-v1'

export type AgentRuntimeDriverFamily = 'owlcoda-native' | 'vendor-native'
export type VendorCliDriverName = 'kimi' | 'cursor' | 'codex'
export type VendorCliExecutorKind = 'kimi-cli' | 'cursor-agent' | 'codex-cli'
export type VendorCliRuntimeTaskKind =
  | typeof KIMI_CLI_TASK_KIND
  | typeof CURSOR_AGENT_TASK_KIND
  | typeof CODEX_CLI_TASK_KIND
export type RuntimeExecutionTaskKind = 'workflow-run-v1' | VendorCliRuntimeTaskKind
export type RuntimeExecutionPermissionMode = 'local_read_only' | 'approved_external_effect'
export type RuntimeExecutionStatus = 'completed' | 'failed' | 'cancelled'
export type RuntimeDriverSessionStatus = 'running' | 'interrupting' | RuntimeExecutionStatus

export interface RuntimeExecutionIdentity {
  readonly driverId: string
  readonly executionId: string
  readonly attemptId: string
}

export interface RuntimeExecutionReservation extends RuntimeExecutionIdentity {
  readonly schemaVersion: 1
  readonly taskKind: RuntimeExecutionTaskKind
  readonly correlationId: string
  readonly workspaceRoot: string
  readonly permissionMode: RuntimeExecutionPermissionMode
  readonly grantId?: string
}

export interface RuntimeExecutionReserveInput {
  readonly taskKind: RuntimeExecutionTaskKind
  readonly correlationId: string
  readonly workspaceRoot: string
  readonly permissionMode: RuntimeExecutionPermissionMode
  readonly authorizationGrant?: RuntimeExecutionAuthorizationGrant
  readonly task?: RuntimeExecutionTask
}

export interface RuntimeExecutionIdentityFactory {
  (): Pick<RuntimeExecutionIdentity, 'executionId' | 'attemptId'>
}

export interface WorkflowRuntimeExecutionTask {
  readonly kind: 'workflow-run-v1'
  readonly workflow: WorkflowRunInput
  readonly options?: Omit<WorkflowRunOptions, 'signal' | 'requestAdmission' | 'runtimeExecution' | 'contractSnapshot' | 'resumeSnapshot' | 'resumePlanSnapshot'>
}

export interface VendorCliRuntimeExecutionTask {
  readonly kind: VendorCliRuntimeTaskKind
  readonly prompt: string
  readonly model?: string
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

export type RuntimeExecutionTask = WorkflowRuntimeExecutionTask | VendorCliRuntimeExecutionTask

export interface AgentRuntimeDriverCapabilities {
  readonly taskKinds: readonly RuntimeExecutionTaskKind[]
  readonly permissionModes: readonly RuntimeExecutionPermissionMode[]
  readonly lifecycle: {
    readonly probe: true
    readonly start: true
    readonly observe: true
    readonly interrupt: true
    readonly resume: boolean
    readonly collect: true
  }
  readonly artifactCollection: boolean
}

export interface RuntimeDriverProbeRequest {
  readonly taskKind: RuntimeExecutionTaskKind
  readonly workspaceRoot: string
  readonly permissionMode: RuntimeExecutionPermissionMode
}

export interface RuntimeDriverProbeResult {
  readonly driverId: string
  readonly driverFamily: AgentRuntimeDriverFamily
  readonly status: 'available' | 'unsupported'
  readonly capabilities: AgentRuntimeDriverCapabilities
  readonly reason?: string
}

export interface AgentRuntimeDriverSession extends RuntimeExecutionIdentity {
  readonly driverSessionId: string
}

export interface RuntimeDriverObservation extends AgentRuntimeDriverSession {
  readonly status: RuntimeDriverSessionStatus
  readonly resumeHandle?: string
}

export interface RuntimeExecutionArtifactFact {
  readonly artifactType: 'workflow_plan' | 'workflow_receipt' | 'workflow_response' | (string & {})
  readonly ref: string
}

export interface RuntimeExecutionCorrelationRefs {
  readonly correlationId: string
  readonly nativeRunId?: string
  readonly receiptRef?: string
  readonly artifactRefs: readonly string[]
}

export interface RuntimeExecutionFailure {
  readonly code: string
  readonly message: string
  readonly errors?: readonly string[]
}

export interface VendorCliExecutionResult {
  readonly text: string
  readonly backendModel?: string
  readonly executable: string
  readonly cliVersion?: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly stdoutRef: string
  readonly stderrRef: string
  readonly resultRef: string
  readonly receiptRef: string
  readonly cleanup: {
    readonly childReaped: boolean
    readonly scratchRemoved: boolean
    readonly orphanCount: number
  }
}

export interface AgentRuntimeDriverCollectedOutcome {
  readonly status: RuntimeExecutionStatus
  readonly driverSessionId: string
  readonly resumeHandle?: string
  readonly correlationRefs: RuntimeExecutionCorrelationRefs
  readonly artifactFacts: readonly RuntimeExecutionArtifactFact[]
  readonly workflowResult?: WorkflowRunResult
  readonly vendorResult?: VendorCliExecutionResult
  readonly failure?: RuntimeExecutionFailure
}

export interface AgentRuntimeDriverStartRequest {
  readonly identity: RuntimeExecutionIdentity
  readonly correlationId: string
  readonly workspaceRoot: string
  readonly permissionMode: RuntimeExecutionPermissionMode
  readonly task: RuntimeExecutionTask
  readonly grantId?: string
  readonly requestAdmission?: WorkflowRequestAdmissionHook
  readonly contractSnapshot?: WorkflowContractSnapshot
  readonly resumeSnapshot?: WorkflowResumeSourceSnapshot
  readonly resumePlanSnapshot?: WorkflowResumePlanSnapshot
  readonly signal?: AbortSignal
}

export interface AgentRuntimeDriverResumeRequest extends AgentRuntimeDriverStartRequest {
  readonly resumeHandle: string
}

export interface AgentRuntimeDriver {
  readonly id: string
  readonly family: AgentRuntimeDriverFamily
  readonly capabilities: AgentRuntimeDriverCapabilities
  probe(request: RuntimeDriverProbeRequest): Promise<RuntimeDriverProbeResult>
  start(request: AgentRuntimeDriverStartRequest): Promise<AgentRuntimeDriverSession>
  observe(session: AgentRuntimeDriverSession): Promise<RuntimeDriverObservation>
  interrupt(session: AgentRuntimeDriverSession, reason: string): Promise<void>
  resume(request: AgentRuntimeDriverResumeRequest): Promise<AgentRuntimeDriverSession>
  collect(session: AgentRuntimeDriverSession): Promise<AgentRuntimeDriverCollectedOutcome>
}

export interface RuntimeExecutionResult extends RuntimeExecutionIdentity {
  readonly schemaVersion: 1
  readonly status: RuntimeExecutionStatus
  readonly driverFamily: AgentRuntimeDriverFamily
  readonly driverSessionId: string
  readonly resumeHandle?: string
  readonly correlationRefs: RuntimeExecutionCorrelationRefs
  readonly artifactFacts: readonly RuntimeExecutionArtifactFact[]
  readonly workflowResult?: WorkflowRunResult
  readonly vendorResult?: VendorCliExecutionResult
  readonly failure?: RuntimeExecutionFailure
  readonly grantId?: string
}

export interface RuntimeExecutionInterruptResult extends RuntimeExecutionIdentity {
  readonly accepted: boolean
  readonly driverSessionId?: string
}

export class RuntimeExecutionControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RuntimeExecutionControlError'
    this.code = code
  }
}
