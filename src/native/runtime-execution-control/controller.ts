import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  AgentRuntimeDriver,
  AgentRuntimeDriverSession,
  RuntimeExecutionIdentityFactory,
  RuntimeExecutionInterruptResult,
  RuntimeExecutionReservation,
  RuntimeExecutionReserveInput,
  RuntimeExecutionResult,
  RuntimeExecutionTask,
  RuntimeExecutionTaskKind,
} from './types.js'
import { RuntimeExecutionControlError } from './types.js'
import { isTrustedBuiltInVendorDriver } from './driver-trust.js'
import {
  assertRuntimeExecutionGrantTask,
  consumeRuntimeExecutionGrant,
  createRuntimeExecutionRequestAdmission,
  getRuntimeExecutionContractSnapshot,
  getRuntimeExecutionResumeSnapshot,
  getRuntimeExecutionResumePlanSnapshot,
  revalidateRuntimeExecutionGrantResources,
  verifyRuntimeExecutionGrantReservation,
  type RuntimeExecutionAuthorizationGrant,
} from './grants.js'

export interface RuntimeExecutionControllerOptions {
  readonly drivers: readonly AgentRuntimeDriver[]
  readonly routingPolicy: Readonly<Record<RuntimeExecutionTaskKind, string>>
  readonly identityFactory?: RuntimeExecutionIdentityFactory
}

interface RuntimeExecutionRecord {
  readonly reservation: RuntimeExecutionReservation
  readonly driver: AgentRuntimeDriver
  readonly abortController: AbortController
  readonly authorizationGrant?: RuntimeExecutionAuthorizationGrant
  started: boolean
  terminal: boolean
  session?: AgentRuntimeDriverSession
}

export class RuntimeExecutionController {
  private readonly drivers: Map<string, AgentRuntimeDriver>
  private readonly routingPolicy: Readonly<Record<RuntimeExecutionTaskKind, string>>
  private readonly identityFactory: RuntimeExecutionIdentityFactory
  private readonly executions = new Map<string, RuntimeExecutionRecord>()

  constructor(options: RuntimeExecutionControllerOptions) {
    this.drivers = new Map()
    for (const driver of options.drivers) {
      if (!driver.id.trim()) {
        throw new RuntimeExecutionControlError('RUNTIME_DRIVER_REGISTRATION_INVALID', 'Runtime driver id must be non-empty')
      }
      if (this.drivers.has(driver.id)) {
        throw new RuntimeExecutionControlError(
          'RUNTIME_DRIVER_REGISTRATION_INVALID',
          `Runtime driver id is registered more than once: ${driver.id}`,
        )
      }
      this.drivers.set(driver.id, driver)
    }
    this.routingPolicy = Object.freeze({ ...options.routingPolicy })
    this.identityFactory = options.identityFactory ?? defaultIdentityFactory
  }

  reserve(input: RuntimeExecutionReserveInput): RuntimeExecutionReservation {
    const correlationId = requiredIdentifier(input.correlationId, 'correlationId')
    const requestedWorkspaceRoot = resolve(requiredString(input.workspaceRoot, 'workspaceRoot'))
    if (input.permissionMode !== 'local_read_only' && input.permissionMode !== 'approved_external_effect') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_PERMISSION_MODE_UNSUPPORTED',
        `Runtime permission mode is unsupported in this slice: ${String(input.permissionMode)}`,
      )
    }
    const authorizationGrant = input.permissionMode === 'approved_external_effect'
      ? input.taskKind === 'workflow-run-v1'
        ? verifyRuntimeExecutionGrantReservation(
            input.authorizationGrant,
            requestedWorkspaceRoot,
            requiredTask(input.task),
          )
        : (() => {
            throw new RuntimeExecutionControlError(
              'RUNTIME_PERMISSION_MODE_UNSUPPORTED',
              `Vendor structured-output task ${input.taskKind} does not accept external-effect authority`,
            )
          })()
      : undefined
    const workspaceRoot = authorizationGrant?.workspaceRoot ?? requestedWorkspaceRoot
    const driverId = this.routingPolicy[input.taskKind]
    if (!driverId) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_ROUTE_MISSING',
        `No runtime driver route is registered for ${String(input.taskKind)}`,
      )
    }
    const driver = this.drivers.get(driverId)
    if (!driver) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_NOT_REGISTERED',
        `Runtime routing policy selected an unregistered driver: ${driverId}`,
      )
    }
    if (
      driver.family !== 'owlcoda-native'
      && !isTrustedBuiltInVendorDriver(driver, input.taskKind)
    ) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_UNSUPPORTED',
        `Runtime driver is not a built-in trusted route for ${input.taskKind}: ${driver.id}`,
      )
    }
    const allocated = this.identityFactory()
    const executionId = requiredIdentifier(allocated.executionId, 'executionId')
    const attemptId = requiredIdentifier(allocated.attemptId, 'attemptId')
    if (executionId === attemptId) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_IDENTITY_INVALID',
        'Runtime executionId and attemptId must be distinct',
      )
    }
    if (this.executions.has(executionId)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_IDENTITY_COLLISION',
        `Runtime execution identity is already reserved: ${executionId}`,
      )
    }
    const reservation: RuntimeExecutionReservation = Object.freeze({
      schemaVersion: 1,
      taskKind: input.taskKind,
      correlationId,
      workspaceRoot,
      permissionMode: input.permissionMode,
      ...(authorizationGrant ? { grantId: authorizationGrant.grantId } : {}),
      driverId,
      executionId,
      attemptId,
    })
    this.executions.set(executionId, {
      reservation,
      driver,
      abortController: new AbortController(),
      ...(authorizationGrant ? { authorizationGrant } : {}),
      started: false,
      terminal: false,
    })
    if (authorizationGrant) consumeRuntimeExecutionGrant(authorizationGrant)
    return reservation
  }

  async execute(
    reservation: RuntimeExecutionReservation,
    task: RuntimeExecutionTask,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RuntimeExecutionResult> {
    const record = this.requireRecord(reservation)
    if (record.started) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_ALREADY_STARTED',
        `Runtime execution has already started: ${reservation.executionId}`,
      )
    }
    if (record.authorizationGrant) {
      assertRuntimeExecutionGrantTask(record.authorizationGrant, reservation.workspaceRoot, task)
    }
    const admittedTask = admitTask(reservation, task)
    record.started = true

    if (record.authorizationGrant) {
      await revalidateRuntimeExecutionGrantResources(record.authorizationGrant)
    }

    const probe = await record.driver.probe({
      taskKind: reservation.taskKind,
      workspaceRoot: reservation.workspaceRoot,
      permissionMode: reservation.permissionMode,
    })
    validateProbe(record.driver, reservation, probe)
    if (probe.status !== 'available') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_DRIVER_UNSUPPORTED',
        probe.reason ?? `Runtime driver ${record.driver.id} does not support ${reservation.taskKind}`,
      )
    }

    const unbindSignal = bindAbortSignal(options.signal, reason => {
      void this.interrupt(reservation, reason).catch(() => undefined)
    })
    try {
      if (options.signal?.aborted) {
        await this.interrupt(reservation, abortReason(options.signal))
      }
      const session = await record.driver.start({
        identity: identityFromReservation(reservation),
        correlationId: reservation.correlationId,
        workspaceRoot: reservation.workspaceRoot,
        permissionMode: reservation.permissionMode,
        task: admittedTask,
        ...(reservation.grantId ? { grantId: reservation.grantId } : {}),
        ...(record.authorizationGrant
          ? {
              requestAdmission: createRuntimeExecutionRequestAdmission(record.authorizationGrant),
              ...(getRuntimeExecutionContractSnapshot(record.authorizationGrant)
                ? { contractSnapshot: getRuntimeExecutionContractSnapshot(record.authorizationGrant) }
                : {}),
              ...(getRuntimeExecutionResumeSnapshot(record.authorizationGrant)
                ? { resumeSnapshot: getRuntimeExecutionResumeSnapshot(record.authorizationGrant) }
                : {}),
              ...(getRuntimeExecutionResumePlanSnapshot(record.authorizationGrant)
                ? { resumePlanSnapshot: getRuntimeExecutionResumePlanSnapshot(record.authorizationGrant) }
                : {}),
            }
          : {}),
        signal: record.abortController.signal,
      })
      validateSession(reservation, session)
      record.session = session
      await record.driver.observe(session)
      const collected = await record.driver.collect(session)
      if (
        collected.driverSessionId !== session.driverSessionId
        || collected.correlationRefs.correlationId !== reservation.correlationId
      ) {
        throw new RuntimeExecutionControlError(
          'RUNTIME_DRIVER_CORRELATION_MISMATCH',
          `Runtime driver ${record.driver.id} collected a different driver session`,
        )
      }
      record.terminal = true
      return Object.freeze({
        schemaVersion: 1,
        status: collected.status,
        driverId: reservation.driverId,
        driverFamily: record.driver.family,
        executionId: reservation.executionId,
        attemptId: reservation.attemptId,
        driverSessionId: collected.driverSessionId,
        ...(collected.resumeHandle ? { resumeHandle: collected.resumeHandle } : {}),
        correlationRefs: collected.correlationRefs,
        artifactFacts: Object.freeze([...collected.artifactFacts]),
        ...(collected.workflowResult ? { workflowResult: collected.workflowResult } : {}),
        ...(collected.vendorResult ? { vendorResult: collected.vendorResult } : {}),
        ...(collected.failure ? { failure: collected.failure } : {}),
        ...(reservation.grantId ? { grantId: reservation.grantId } : {}),
      })
    } finally {
      unbindSignal()
    }
  }

  async interrupt(
    reservation: RuntimeExecutionReservation,
    reason = 'runtime_execution_cancelled',
  ): Promise<RuntimeExecutionInterruptResult> {
    const record = this.requireRecord(reservation)
    const accepted = !record.terminal && !record.abortController.signal.aborted
    if (accepted) {
      record.abortController.abort(new RuntimeExecutionControlError('RUNTIME_EXECUTION_CANCELLED', requiredString(reason, 'reason')))
      if (record.session) await record.driver.interrupt(record.session, reason)
    }
    return Object.freeze({
      accepted,
      driverId: reservation.driverId,
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      ...(record.session ? { driverSessionId: record.session.driverSessionId } : {}),
    })
  }

  private requireRecord(reservation: RuntimeExecutionReservation): RuntimeExecutionRecord {
    const record = this.executions.get(reservation.executionId)
    if (!record || !sameReservation(record.reservation, reservation)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_RESERVATION_INVALID',
        `Runtime execution reservation is not owned by this controller: ${String(reservation.executionId)}`,
      )
    }
    return record
  }
}

function defaultIdentityFactory(): Pick<RuntimeExecutionReservation, 'executionId' | 'attemptId'> {
  return {
    executionId: `runtime-execution:${randomUUID()}`,
    attemptId: `runtime-attempt:${randomUUID()}`,
  }
}

function identityFromReservation(reservation: RuntimeExecutionReservation) {
  return {
    driverId: reservation.driverId,
    executionId: reservation.executionId,
    attemptId: reservation.attemptId,
  }
}

function validateProbe(
  driver: AgentRuntimeDriver,
  reservation: RuntimeExecutionReservation,
  probe: Awaited<ReturnType<AgentRuntimeDriver['probe']>>,
): void {
  if (probe.driverId !== driver.id || probe.driverFamily !== driver.family) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_PROBE_MISMATCH',
      `Runtime driver probe identity does not match registration ${driver.id}`,
    )
  }
  if (
    probe.status === 'available'
    && (!probe.capabilities.taskKinds.includes(reservation.taskKind)
      || !probe.capabilities.permissionModes.includes(reservation.permissionMode)
      || !probe.capabilities.artifactCollection)
  ) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_PROBE_MISMATCH',
      `Runtime driver ${driver.id} reported availability without the required capabilities`,
    )
  }
}

function admitTask(
  reservation: RuntimeExecutionReservation,
  task: RuntimeExecutionTask,
): RuntimeExecutionTask {
  if (task.kind !== reservation.taskKind) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_TASK_MISMATCH',
      `Reserved task kind ${reservation.taskKind} cannot execute ${task.kind}`,
    )
  }
  if (task.kind !== 'workflow-run-v1') {
    if (reservation.permissionMode !== 'local_read_only') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_PERMISSION_MODE_UNSUPPORTED',
        `Vendor structured-output task ${task.kind} only supports local_read_only`,
      )
    }
    const prompt = requiredString(task.prompt, 'vendor prompt')
    if (Buffer.byteLength(prompt, 'utf8') > 2 * 1024 * 1024) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_REQUEST_INVALID',
        'Runtime vendor prompt exceeds the 2 MiB contract limit',
      )
    }
    if (
      task.outputSchema !== undefined
      && (task.outputSchema === null || typeof task.outputSchema !== 'object' || Array.isArray(task.outputSchema))
    ) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_REQUEST_INVALID',
        'Runtime vendor outputSchema must be a JSON object',
      )
    }
    return Object.freeze({
      ...task,
      prompt,
      ...(task.model?.trim() ? { model: task.model.trim() } : {}),
      ...(task.outputSchema ? { outputSchema: Object.freeze({ ...task.outputSchema }) } : {}),
    })
  }
  const taskCwd = resolve(task.workflow.cwd ?? reservation.workspaceRoot)
  if (taskCwd !== reservation.workspaceRoot) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_WORKSPACE_MISMATCH',
      `Runtime task cwd ${taskCwd} does not match reserved workspace ${reservation.workspaceRoot}`,
    )
  }
  if (reservation.permissionMode === 'approved_external_effect') {
    if (task.options?.redirect !== 'follow') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_AUTHORIZATION_REDIRECT_MISMATCH',
        'Approved external-effect runtime execution requires redirect=follow',
      )
    }
    return Object.freeze({
      ...task,
      workflow: Object.freeze({ ...task.workflow, cwd: reservation.workspaceRoot }),
      options: Object.freeze({ ...task.options, redirect: 'follow' as const }),
    })
  }
  if (task.workflow.contractRef?.trim() || task.workflow.resumeRunId?.trim()) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_NOT_READ_ONLY',
      'A local-read-only runtime execution cannot enter a contract or resume path',
    )
  }
  const plan = task.workflow.plan
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_PLAN_INVALID',
      'A local-read-only runtime execution requires a non-empty workflow plan',
    )
  }
  const baseUrl = task.workflow.baseUrl?.trim() || plan.base_url
  for (const step of plan.steps) {
    const method = typeof step?.method === 'string' ? step.method.trim().toUpperCase() : ''
    if (method !== 'GET' && method !== 'HEAD') {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_NOT_READ_ONLY',
        `Local-read-only runtime execution rejects method ${method || '(missing)'}`,
      )
    }
    const endpoint = resolveRuntimeEndpoint(step.url, baseUrl)
    const hostname = endpoint.hostname.toLowerCase()
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_NON_LOCAL_ENDPOINT',
        `Local-read-only runtime execution rejects non-local endpoint ${endpoint.href}`,
      )
    }
  }
  return Object.freeze({
    ...task,
    workflow: Object.freeze({ ...task.workflow, cwd: reservation.workspaceRoot }),
    options: Object.freeze({ ...task.options, redirect: 'manual' as const }),
  })
}

function resolveRuntimeEndpoint(stepUrl: string, baseUrl: string | undefined): URL {
  try {
    if (typeof stepUrl !== 'string' || !stepUrl.trim()) throw new Error('step url is missing')
    const endpoint = isAbsoluteHttpUrl(stepUrl) ? new URL(stepUrl) : new URL(stepUrl, baseUrl)
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${endpoint.protocol}`)
    }
    return endpoint
  } catch (error) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_PLAN_INVALID',
      `Runtime workflow endpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function validateSession(reservation: RuntimeExecutionReservation, session: AgentRuntimeDriverSession): void {
  if (
    session.driverId !== reservation.driverId
    || session.executionId !== reservation.executionId
    || session.attemptId !== reservation.attemptId
    || !session.driverSessionId.trim()
  ) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_CORRELATION_MISMATCH',
      `Runtime driver ${reservation.driverId} returned an uncorrelated session`,
    )
  }
  if ([session.executionId, session.attemptId].includes(session.driverSessionId)) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_DRIVER_CORRELATION_MISMATCH',
      'Runtime execution, attempt, and driver session identities must remain distinct',
    )
  }
}

function sameReservation(left: RuntimeExecutionReservation, right: RuntimeExecutionReservation): boolean {
  return left.driverId === right.driverId
    && left.executionId === right.executionId
    && left.attemptId === right.attemptId
    && left.taskKind === right.taskKind
    && left.correlationId === right.correlationId
    && left.workspaceRoot === right.workspaceRoot
    && left.permissionMode === right.permissionMode
    && left.grantId === right.grantId
}

function requiredTask(task: RuntimeExecutionTask | undefined): RuntimeExecutionTask {
  if (!task) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_TASK_REQUIRED',
      'Approved external-effect runtime reservation requires the exact authorized task',
    )
  }
  return task
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: (reason: string) => void): () => void {
  if (!signal) return () => undefined
  const listener = () => abort(abortReason(signal))
  if (signal.aborted) listener()
  else signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'runtime_execution_cancelled')
}

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = requiredString(value, field)
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_EXECUTION_IDENTITY_INVALID',
      `Runtime ${field} may contain only letters, numbers, dots, underscores, colons, and hyphens`,
    )
  }
  return normalized
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeExecutionControlError('RUNTIME_EXECUTION_REQUEST_INVALID', `Runtime ${field} must be non-empty`)
  }
  return value.trim()
}
