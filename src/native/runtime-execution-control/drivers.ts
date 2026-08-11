import { isAbsolute } from 'node:path'
import {
  runWorkflow,
  WorkflowPlanValidationError,
  type WorkflowRunResult,
} from '../workflow-runner.js'
import {
  OWLCODA_NATIVE_DRIVER_ID,
  RuntimeExecutionControlError,
  type AgentRuntimeDriver,
  type AgentRuntimeDriverCapabilities,
  type AgentRuntimeDriverCollectedOutcome,
  type AgentRuntimeDriverResumeRequest,
  type AgentRuntimeDriverSession,
  type AgentRuntimeDriverStartRequest,
  type RuntimeDriverObservation,
  type RuntimeDriverProbeRequest,
  type RuntimeDriverProbeResult,
  type RuntimeExecutionArtifactFact,
  type RuntimeExecutionFailure,
  type RuntimeExecutionStatus,
} from './types.js'

interface NativeSessionState {
  readonly session: AgentRuntimeDriverSession
  readonly abortController: AbortController
  completion: Promise<AgentRuntimeDriverCollectedOutcome>
  status: RuntimeDriverObservation['status']
  resumeHandle?: string
}

const NATIVE_CAPABILITIES: AgentRuntimeDriverCapabilities = Object.freeze({
  taskKinds: Object.freeze(['workflow-run-v1'] as const),
  permissionModes: Object.freeze(['local_read_only', 'approved_external_effect'] as const),
  lifecycle: Object.freeze({
    probe: true,
    start: true,
    observe: true,
    interrupt: true,
    resume: true,
    collect: true,
  }),
  artifactCollection: true,
})

export class OwlCodaNativeAgentRuntimeDriver implements AgentRuntimeDriver {
  readonly id = OWLCODA_NATIVE_DRIVER_ID
  readonly family = 'owlcoda-native' as const
  readonly capabilities = NATIVE_CAPABILITIES
  private readonly sessions = new Map<string, NativeSessionState>()

  async probe(request: RuntimeDriverProbeRequest): Promise<RuntimeDriverProbeResult> {
    const supported = this.capabilities.taskKinds.includes(request.taskKind)
      && this.capabilities.permissionModes.includes(request.permissionMode)
    return Object.freeze({
      driverId: this.id,
      driverFamily: this.family,
      status: supported ? 'available' : 'unsupported',
      capabilities: this.capabilities,
      ...(!supported ? { reason: `owlcoda-native does not support ${request.taskKind}/${request.permissionMode}` } : {}),
    })
  }

  async start(request: AgentRuntimeDriverStartRequest): Promise<AgentRuntimeDriverSession> {
    if (request.identity.driverId !== this.id || request.task.kind !== 'workflow-run-v1') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_START_REJECTED',
        `owlcoda-native cannot start driver=${request.identity.driverId} task=${request.task.kind}`,
      )
    }
    const driverSessionId = `owlcoda-native-session:${request.identity.attemptId}`
    if (this.sessions.has(driverSessionId)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_SESSION_COLLISION',
        `owlcoda-native driver session already exists: ${driverSessionId}`,
      )
    }
    const session: AgentRuntimeDriverSession = Object.freeze({
      ...request.identity,
      driverSessionId,
    })
    const abortController = new AbortController()
    const unbindSignal = bindAbortSignal(request.signal, reason => abortController.abort(reason))
    const state = {
      session,
      abortController,
      status: 'running' as const,
      completion: Promise.resolve(undefined as never),
    } as NativeSessionState
    state.completion = this.runNativeHarness(request, state).finally(unbindSignal)
    this.sessions.set(driverSessionId, state)
    return session
  }

  async observe(session: AgentRuntimeDriverSession): Promise<RuntimeDriverObservation> {
    const state = this.requireSession(session)
    return Object.freeze({
      ...state.session,
      status: state.status,
      ...(state.resumeHandle ? { resumeHandle: state.resumeHandle } : {}),
    })
  }

  async interrupt(session: AgentRuntimeDriverSession, reason: string): Promise<void> {
    const state = this.requireSession(session)
    if (['completed', 'failed', 'cancelled'].includes(state.status)) return
    state.status = 'interrupting'
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(new RuntimeExecutionControlError('RUNTIME_EXECUTION_CANCELLED', reason))
    }
  }

  async resume(request: AgentRuntimeDriverResumeRequest): Promise<AgentRuntimeDriverSession> {
    if (request.task.kind !== 'workflow-run-v1') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_START_REJECTED',
        `owlcoda-native cannot resume task=${request.task.kind}`,
      )
    }
    if (!request.resumeHandle.startsWith('workflow-run:')) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_RESUME_HANDLE_INVALID',
        `owlcoda-native resume handle is invalid: ${request.resumeHandle}`,
      )
    }
    const resumeRunId = request.resumeHandle.slice('workflow-run:'.length)
    return await this.start({
      ...request,
      task: {
        ...request.task,
        workflow: { ...request.task.workflow, resumeRunId },
      },
    })
  }

  async collect(session: AgentRuntimeDriverSession): Promise<AgentRuntimeDriverCollectedOutcome> {
    return await this.requireSession(session).completion
  }

  private async runNativeHarness(
    request: AgentRuntimeDriverStartRequest,
    state: NativeSessionState,
  ): Promise<AgentRuntimeDriverCollectedOutcome> {
    if (request.task.kind !== 'workflow-run-v1') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_START_REJECTED',
        `owlcoda-native cannot run task=${request.task.kind}`,
      )
    }
    try {
      const workflowResult = await runWorkflow(request.task.workflow, {
        ...request.task.options,
        requestAdmission: request.requestAdmission,
        contractSnapshot: request.contractSnapshot,
        resumeSnapshot: request.resumeSnapshot,
        resumePlanSnapshot: request.resumePlanSnapshot,
        runtimeExecution: {
          ...state.session,
          ...(request.grantId ? { grantId: request.grantId } : {}),
        },
        signal: state.abortController.signal,
      })
      const status: RuntimeExecutionStatus = state.abortController.signal.aborted
        ? 'cancelled'
        : workflowResult.receipt.acceptance === 'pass'
          ? 'completed'
          : 'failed'
      const failure = runtimeFailure(status, state.abortController.signal)
      const resumeHandle = `workflow-run:${workflowResult.receipt.run_id}`
      state.status = status
      state.resumeHandle = resumeHandle
      return Object.freeze({
        status,
        driverSessionId: state.session.driverSessionId,
        resumeHandle,
        correlationRefs: Object.freeze({
          correlationId: request.correlationId,
          nativeRunId: workflowResult.receipt.run_id,
          receiptRef: workflowResult.receiptPath,
          artifactRefs: Object.freeze(workflowArtifactRefs(workflowResult)),
        }),
        artifactFacts: Object.freeze(workflowArtifactFacts(workflowResult)),
        workflowResult,
        ...(failure ? { failure } : {}),
      })
    } catch (error) {
      const status: RuntimeExecutionStatus = state.abortController.signal.aborted ? 'cancelled' : 'failed'
      state.status = status
      return Object.freeze({
        status,
        driverSessionId: state.session.driverSessionId,
        correlationRefs: Object.freeze({
          correlationId: request.correlationId,
          artifactRefs: Object.freeze([] as string[]),
        }),
        artifactFacts: Object.freeze([] as RuntimeExecutionArtifactFact[]),
        failure: status === 'cancelled'
          ? runtimeFailure(status, state.abortController.signal)!
          : Object.freeze({
              code: error instanceof WorkflowPlanValidationError
                ? 'WORKFLOW_PLAN_INVALID'
                : 'OWLCODA_NATIVE_HARNESS_FAILED',
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof WorkflowPlanValidationError
                ? { errors: Object.freeze([...error.errors]) }
                : {}),
            }),
      })
    }
  }

  private requireSession(session: AgentRuntimeDriverSession): NativeSessionState {
    const state = this.sessions.get(session.driverSessionId)
    if (
      !state
      || state.session.driverId !== session.driverId
      || state.session.executionId !== session.executionId
      || state.session.attemptId !== session.attemptId
    ) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_SESSION_UNKNOWN',
        `owlcoda-native does not own driver session ${session.driverSessionId}`,
      )
    }
    return state
  }
}

export function createUnsupportedVendorNativeDriver(id = 'vendor-native'): AgentRuntimeDriver {
  const capabilities: AgentRuntimeDriverCapabilities = Object.freeze({
    taskKinds: Object.freeze([]),
    permissionModes: Object.freeze([]),
    lifecycle: Object.freeze({
      probe: true,
      start: true,
      observe: true,
      interrupt: true,
      resume: false,
      collect: true,
    }),
    artifactCollection: false,
  })
  const unsupported = (): never => {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_UNSUPPORTED',
      `Vendor-native driver ${id} is a typed boundary only in this Gate`,
    )
  }
  return Object.freeze({
    id,
    family: 'vendor-native' as const,
    capabilities,
    async probe() {
      return Object.freeze({
        driverId: id,
        driverFamily: 'vendor-native' as const,
        status: 'unsupported' as const,
        capabilities,
        reason: `Vendor-native driver ${id} is not implemented in this Gate`,
      })
    },
    async start() { return unsupported() },
    async observe() { return unsupported() },
    async interrupt() { unsupported() },
    async resume() { return unsupported() },
    async collect() { return unsupported() },
  })
}

function runtimeFailure(
  status: RuntimeExecutionStatus,
  signal: AbortSignal,
): RuntimeExecutionFailure | undefined {
  if (status === 'completed') return undefined
  if (status === 'cancelled') {
    return Object.freeze({
      code: 'RUNTIME_EXECUTION_CANCELLED',
      message: signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason ?? 'runtime_execution_cancelled'),
    })
  }
  return Object.freeze({
    code: 'OWLCODA_NATIVE_HARNESS_ACCEPTANCE_FAILED',
    message: 'owlcoda-native harness did not pass acceptance',
  })
}

function workflowArtifactFacts(result: WorkflowRunResult): RuntimeExecutionArtifactFact[] {
  const facts: RuntimeExecutionArtifactFact[] = [
    ...(result.receipt.plan_path
      ? [{ artifactType: 'workflow_plan' as const, ref: result.receipt.plan_path }]
      : []),
    { artifactType: 'workflow_receipt', ref: result.receiptPath },
    ...workflowResponsePaths(result).map(ref => ({ artifactType: 'workflow_response' as const, ref })),
  ]
  return [...new Map(facts.map(fact => [`${fact.artifactType}:${fact.ref}`, fact])).values()]
}

function workflowArtifactRefs(result: WorkflowRunResult): string[] {
  return uniqueStrings([
    ...(result.receipt.plan_path ? [result.receipt.plan_path] : []),
    ...workflowResponsePaths(result),
  ])
}

function workflowResponsePaths(result: WorkflowRunResult): string[] {
  return uniqueStrings(result.receipt.endpoint_calls.flatMap(call => [
    call.response_artifact,
    call.raw_ref,
    call.artifact_ref,
  ].filter((value): value is string => Boolean(value) && isAbsolute(value!))))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: (reason: unknown) => void): () => void {
  if (!signal) return () => undefined
  const listener = () => abort(signal.reason)
  if (signal.aborted) listener()
  else signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}
