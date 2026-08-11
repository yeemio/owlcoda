import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  addJobArtifacts,
  appendJobOutput,
  createJob,
  finishJob,
  getJob,
  mergeJobFactRefs,
  recordJobCleanup,
  registerJobAbortAdapter,
  startJob,
  unregisterJobAbortAdapter,
  type JobArtifactRef,
  type JobRecord,
} from '../job-supervisor.js'
import type { RuntimeFactRefs } from '../protocol/types.js'
import {
  getRunWorkspacePathsFromRef,
  readManifest,
  recordArtifact,
  recordEvent,
  type RunArtifactRecord,
} from '../run-workspace.js'
import {
  WorkflowPlanValidationError,
  type WorkflowPlan,
  type WorkflowRunResult,
} from '../workflow-runner.js'
import {
  RuntimeExecutionControlError,
  createDefaultRuntimeExecutionController,
  type RuntimeExecutionArtifactFact,
  type RuntimeExecutionReservation,
  type RuntimeExecutionResult,
} from '../runtime-execution-control/index.js'
import type { EvidenceContext } from './evidence.js'
import { InvariantSpineError, resolveEvidenceContext } from './evidence.js'

export interface WorkCase {
  readonly schemaVersion: 1
  readonly id: string
  readonly objective: string
  readonly evidenceContextRef: string
  readonly executionMode: 'local_read_only'
  readonly createdAt: string
  readonly state: 'created'
  readonly opaqueDomainPayloadRef?: string
}

export type WorkCaseExecutionStatus = 'completed' | 'failed' | 'cancelled'

export interface EvidenceContextSnapshotArtifact {
  readonly schemaVersion: 1
  readonly kind: 'evidence_context_snapshot'
  readonly status: 'validated' | 'attempted'
  readonly workCaseId: string
  readonly evidenceContextId: string
  readonly executionRunId: string
  readonly driverId: string
  readonly executionId: string
  readonly attemptId: string
  readonly driverSessionId?: string
  readonly workspaceRunId: string
  readonly jobId: string
  readonly capturedAt: string
  readonly evidenceContext: EvidenceContext
  readonly failure?: { readonly code: string; readonly message: string }
}

export interface WorkCaseExecutionReceipt {
  readonly schemaVersion: 1
  readonly kind: 'work_case_execution_correlation_receipt'
  readonly status: WorkCaseExecutionStatus
  readonly workCaseId: string
  readonly evidenceContextId: string
  readonly executionRunId: string
  readonly driverId: string
  readonly executionId: string
  readonly attemptId: string
  readonly driverSessionId?: string
  readonly runId: string
  readonly jobId: string
  readonly workspaceRunId: string
  readonly executionMode: 'local_read_only'
  readonly startedAt: string
  readonly finishedAt: string
  readonly evidenceContextSnapshotRef?: string
  readonly workflowReceiptRef?: string
  readonly workflowArtifactRefs: readonly string[]
  readonly registeredArtifactRefs: readonly {
    readonly id: string
    readonly path: string
    readonly artifactType?: string
  }[]
  readonly workflowMethods: readonly ('GET' | 'HEAD')[]
  readonly productionWriteCount: 0
  readonly failure?: { readonly code: string; readonly message: string }
}

export interface WorkCaseExecutionResult {
  readonly receipt: WorkCaseExecutionReceipt
  readonly receiptPath: string
  readonly job: JobRecord
  readonly workflowResult?: WorkflowRunResult
  readonly runtimeExecutionResult?: RuntimeExecutionResult
}

export interface ExecuteWorkCaseInput {
  workCase: WorkCase
  evidenceContext: EvidenceContext
  executionRunId?: string
  workflowPlan: WorkflowPlan
  runRef: string
  cwd?: string
  signal?: AbortSignal
}

export function createWorkCase(input: Omit<WorkCase, 'schemaVersion' | 'state'>): WorkCase {
  if (!isRecord(input)) throw new InvariantSpineError('WORK_CASE_INVALID', 'WorkCase input must be an object')
  const allowedKeys = new Set([
    'id',
    'objective',
    'evidenceContextRef',
    'executionMode',
    'createdAt',
    'opaqueDomainPayloadRef',
  ])
  const unknownKeys = Object.keys(input).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new InvariantSpineError('WORK_CASE_INVALID', `WorkCase has unsupported fields: ${unknownKeys.join(', ')}`)
  }
  const id = requiredString(input.id, 'id')
  const objective = requiredString(input.objective, 'objective')
  const evidenceContextRef = requiredString(input.evidenceContextRef, 'evidenceContextRef')
  if (!/^evidence-context:sha256:[a-f0-9]{64}$/.test(evidenceContextRef)) {
    throw new InvariantSpineError('WORK_CASE_INVALID', 'WorkCase evidenceContextRef must be an EvidenceContext id')
  }
  if (input.executionMode !== 'local_read_only') {
    throw new InvariantSpineError('WORK_CASE_INVALID', 'WorkCase executionMode must be local_read_only in F0')
  }
  const createdAt = normalizeTimestamp(input.createdAt, 'createdAt')
  const opaqueDomainPayloadRef = input.opaqueDomainPayloadRef === undefined
    ? undefined
    : requiredString(input.opaqueDomainPayloadRef, 'opaqueDomainPayloadRef')
  return Object.freeze({
    schemaVersion: 1,
    id,
    objective,
    evidenceContextRef,
    executionMode: 'local_read_only',
    createdAt,
    state: 'created',
    ...(opaqueDomainPayloadRef ? { opaqueDomainPayloadRef } : {}),
  })
}

export async function executeWorkCase(input: ExecuteWorkCaseInput): Promise<WorkCaseExecutionResult> {
  const workCase = normalizeWorkCase(input.workCase)
  const cwd = resolve(input.cwd ?? process.cwd())
  const workspacePaths = getRunWorkspacePathsFromRef(requiredString(input.runRef, 'runRef'), cwd)
  const workspaceManifest = await readManifest(workspacePaths.runDir, cwd)
  const executionRunId = normalizeExecutionRunId(
    input.executionRunId
      ?? input.workflowPlan?.run_id
      ?? `workcase-${safeSegment(workCase.id)}-${randomUUID().slice(0, 8)}`,
  )
  const runtimeController = createDefaultRuntimeExecutionController()
  const runtimeExecution = runtimeController.reserve({
    taskKind: 'workflow-run-v1',
    correlationId: executionRunId,
    workspaceRoot: cwd,
    permissionMode: 'local_read_only',
  })
  const startedAt = new Date().toISOString()
  const correlationDir = join(workspacePaths.evidenceDir, 'invariant-spine', safeSegment(workCase.id), executionRunId)
  const workflowDir = join(correlationDir, 'workflow')
  const receiptPath = join(correlationDir, 'correlation-receipt.json')
  const evidenceContextSnapshotPath = join(correlationDir, 'evidence-context-snapshot.json')
  const workflowReceiptPath = join(workflowDir, 'receipt.json')
  const workflowArtifactDir = join(workflowDir, 'artifacts')
  const baseFactRefs: RuntimeFactRefs = {
    runId: workspaceManifest.runId,
    workCaseId: workCase.id,
    evidenceContextId: workCase.evidenceContextRef,
    executionRunId,
    driverId: runtimeExecution.driverId,
    executionId: runtimeExecution.executionId,
    attemptId: runtimeExecution.attemptId,
    workspaceRunId: workspaceManifest.runId,
  }
  const createdJob = createJob({
    type: 'workflow',
    stage: 'queued',
    cwd,
    tool: 'WorkCaseExecution',
    provider: runtimeExecution.driverId,
    command: `RuntimeExecution execution_id=${runtimeExecution.executionId} attempt_id=${runtimeExecution.attemptId}`,
    recoveryHint: `JobGet jobId=<jobId>; inspect ${receiptPath}`,
    runId: workspaceManifest.runId,
    factRefs: baseFactRefs,
    source: { kind: 'work_case', id: workCase.id },
  })
  const jobId = createdJob.jobId
  const factRefs: RuntimeFactRefs = { ...baseFactRefs, jobId }
  startJob(jobId, { stage: 'validating_evidence', externalHandle: runtimeExecution.executionId })
  const liveCancelController = new AbortController()
  registerJobAbortAdapter(jobId, reason => {
    liveCancelController.abort(new InvariantSpineError('WORK_CASE_EXECUTION_CANCELLED', `WorkCase cancelled: ${reason}`))
    void runtimeController.interrupt(runtimeExecution, reason).catch(error => {
      appendJobOutput(jobId, `RUNTIME_EXECUTION_INTERRUPT_FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  })
  const composedSignal = composeAbortSignals(input.signal, liveCancelController.signal)

  let workflowResult: WorkflowRunResult | undefined
  let runtimeExecutionResult: RuntimeExecutionResult | undefined
  let evidenceContextSnapshotRef: string | undefined
  let workflowReceiptRef: string | undefined
  let workflowArtifactRefs: string[] = []
  const registeredArtifacts: RunArtifactRecord[] = []
  let status: WorkCaseExecutionStatus = 'failed'
  let failure: WorkCaseExecutionReceipt['failure']

  try {
    let evidenceContext: EvidenceContext
    try {
      evidenceContext = await resolveEvidenceContext(input.evidenceContext)
      if (evidenceContext.id !== workCase.evidenceContextRef) {
        throw new InvariantSpineError(
          'WORK_CASE_EVIDENCE_CONTEXT_MISMATCH',
          `WorkCase ${workCase.id} expects ${workCase.evidenceContextRef}, received ${evidenceContext.id}`,
        )
      }
    } catch (error) {
      const validationFailure = failureFromError(error)
      const attemptedSnapshot = await persistEvidenceContextSnapshot({
        status: 'attempted',
        evidenceContext: input.evidenceContext,
        failure: validationFailure,
        path: evidenceContextSnapshotPath,
        workCaseId: workCase.id,
        evidenceContextId: workCase.evidenceContextRef,
        executionRunId,
        runtimeExecution,
        workspaceRunId: workspaceManifest.runId,
        jobId,
        runRef: workspacePaths.runDir,
        cwd,
        factRefs,
      })
      evidenceContextSnapshotRef = attemptedSnapshot.path
      registeredArtifacts.push(attemptedSnapshot)
      throw error
    }
    const validatedSnapshot = await persistEvidenceContextSnapshot({
      status: 'validated',
      evidenceContext,
      path: evidenceContextSnapshotPath,
      workCaseId: workCase.id,
      evidenceContextId: evidenceContext.id,
      executionRunId,
      runtimeExecution,
      workspaceRunId: workspaceManifest.runId,
      jobId,
      runRef: workspacePaths.runDir,
      cwd,
      factRefs,
    })
    evidenceContextSnapshotRef = validatedSnapshot.path
    registeredArtifacts.push(validatedSnapshot)
    throwIfAborted(composedSignal.signal)
    const workflowMethods = readOnlyMethods(input.workflowPlan)
    startJob(jobId, { stage: 'executing_runtime', externalHandle: runtimeExecution.executionId })
    runtimeExecutionResult = await runtimeController.execute(runtimeExecution, {
      kind: 'workflow-run-v1',
      workflow: {
        plan: { ...input.workflowPlan, run_id: executionRunId },
        receiptPath: workflowReceiptPath,
        artifactDir: workflowArtifactDir,
        cwd,
      },
      options: { redirect: 'manual' },
    }, { signal: composedSignal.signal })
    workflowResult = runtimeExecutionResult.workflowResult
    workflowReceiptRef = runtimeExecutionResult.correlationRefs.receiptRef
    workflowArtifactRefs = [...runtimeExecutionResult.correlationRefs.artifactRefs]
    const workflowFactRefs: RuntimeFactRefs = {
      ...factRefs,
      driverSessionId: runtimeExecutionResult.driverSessionId,
      workflowReceiptRef,
      workflowArtifactRefs,
    }
    if (!mergeJobFactRefs(jobId, workflowFactRefs)) {
      throw new InvariantSpineError('WORK_CASE_JOB_MISSING', `WorkCase job disappeared: ${jobId}`)
    }
    if (evidenceContextSnapshotRef) {
      const correlatedSnapshot = await correlateEvidenceContextSnapshot({
        path: evidenceContextSnapshotRef,
        driverSessionId: runtimeExecutionResult.driverSessionId,
        workCaseId: workCase.id,
        executionId: runtimeExecution.executionId,
        attemptId: runtimeExecution.attemptId,
        jobId,
        runRef: workspacePaths.runDir,
        cwd,
        workspaceRunId: workspaceManifest.runId,
        factRefs: workflowFactRefs,
      })
      const snapshotIndex = registeredArtifacts.findIndex(artifact => artifact.path === correlatedSnapshot.path)
      if (snapshotIndex >= 0) registeredArtifacts[snapshotIndex] = correlatedSnapshot
      else registeredArtifacts.push(correlatedSnapshot)
    }
    registeredArtifacts.push(...await registerRuntimeExecutionArtifacts({
      runRef: workspacePaths.runDir,
      cwd,
      jobId,
      workspaceRunId: workspaceManifest.runId,
      artifactFacts: runtimeExecutionResult.artifactFacts,
      factRefs: workflowFactRefs,
    }))

    const currentJob = getJob(jobId)
    if (
      currentJob?.status === 'cancelled'
      || composedSignal.signal.aborted
      || runtimeExecutionResult.status === 'cancelled'
    ) {
      status = 'cancelled'
      failure = {
        code: 'WORK_CASE_EXECUTION_CANCELLED',
        message: currentJob?.terminationReason
          ?? runtimeExecutionResult.failure?.message
          ?? abortReason(composedSignal.signal),
      }
    } else if (runtimeExecutionResult.status === 'completed' && workflowResult?.receipt.acceptance === 'pass') {
      status = 'completed'
    } else if (runtimeExecutionResult.failure?.code === 'WORKFLOW_PLAN_INVALID') {
      status = 'failed'
      failure = {
        code: 'WORK_CASE_EXECUTION_PLAN_INVALID',
        message: runtimeExecutionResult.failure.message,
      }
    } else if (!workflowResult && runtimeExecutionResult.failure) {
      status = 'failed'
      failure = {
        code: 'WORK_CASE_EXECUTION_FAILED',
        message: runtimeExecutionResult.failure.message,
      }
    } else {
      status = 'failed'
      failure = {
        code: 'WORKFLOW_ACCEPTANCE_FAILED',
        message: `WorkflowRun ${executionRunId} did not pass acceptance`,
      }
    }

    const result = await finalizeWorkCaseExecution({
      workCase,
      executionRunId,
      runtimeExecution,
      workspaceRunId: workspaceManifest.runId,
      workflowMethods,
      jobId,
      runRef: workspacePaths.runDir,
      cwd,
      receiptPath,
      startedAt,
      status,
      failure,
      evidenceContextSnapshotRef,
      workflowReceiptRef,
      workflowArtifactRefs,
      registeredArtifacts,
      factRefs: workflowFactRefs,
      workflowResult,
      runtimeExecutionResult,
    })
    return result
  } catch (error) {
    const currentJob = getJob(jobId)
    status = currentJob?.status === 'cancelled' || composedSignal.signal.aborted ? 'cancelled' : 'failed'
    const caughtFailure = status === 'cancelled'
      ? { code: 'WORK_CASE_EXECUTION_CANCELLED', message: currentJob?.terminationReason ?? abortReason(composedSignal.signal) }
      : failureFromError(error)
    failure = caughtFailure
    appendJobOutput(jobId, `${caughtFailure.code}: ${caughtFailure.message}\n`)
    return await finalizeWorkCaseExecution({
      workCase,
      executionRunId,
      runtimeExecution,
      workspaceRunId: workspaceManifest.runId,
      workflowMethods: readOnlyMethods(input.workflowPlan),
      jobId,
      runRef: workspacePaths.runDir,
      cwd,
      receiptPath,
      startedAt,
      status,
      failure,
      evidenceContextSnapshotRef,
      workflowReceiptRef,
      workflowArtifactRefs,
      registeredArtifacts,
      factRefs: {
        ...factRefs,
        ...(runtimeExecutionResult ? { driverSessionId: runtimeExecutionResult.driverSessionId } : {}),
        ...(workflowReceiptRef ? { workflowReceiptRef } : {}),
        ...(workflowArtifactRefs.length > 0 ? { workflowArtifactRefs } : {}),
      },
      workflowResult,
      runtimeExecutionResult,
    })
  } finally {
    composedSignal.cleanup()
    unregisterJobAbortAdapter(jobId)
  }
}

async function finalizeWorkCaseExecution(args: {
  workCase: WorkCase
  executionRunId: string
  runtimeExecution: RuntimeExecutionReservation
  workspaceRunId: string
  workflowMethods: readonly ('GET' | 'HEAD')[]
  jobId: string
  runRef: string
  cwd: string
  receiptPath: string
  startedAt: string
  status: WorkCaseExecutionStatus
  failure?: WorkCaseExecutionReceipt['failure']
  evidenceContextSnapshotRef?: string
  workflowReceiptRef?: string
  workflowArtifactRefs: string[]
  registeredArtifacts: RunArtifactRecord[]
  factRefs: RuntimeFactRefs
  workflowResult?: WorkflowRunResult
  runtimeExecutionResult?: RuntimeExecutionResult
}): Promise<WorkCaseExecutionResult> {
  const receipt: WorkCaseExecutionReceipt = deepFreeze({
    schemaVersion: 1,
    kind: 'work_case_execution_correlation_receipt',
    status: args.status,
    workCaseId: args.workCase.id,
    evidenceContextId: args.workCase.evidenceContextRef,
    executionRunId: args.executionRunId,
    driverId: args.runtimeExecution.driverId,
    executionId: args.runtimeExecution.executionId,
    attemptId: args.runtimeExecution.attemptId,
    ...(args.runtimeExecutionResult
      ? { driverSessionId: args.runtimeExecutionResult.driverSessionId }
      : {}),
    runId: args.executionRunId,
    jobId: args.jobId,
    workspaceRunId: args.workspaceRunId,
    executionMode: args.workCase.executionMode,
    startedAt: args.startedAt,
    finishedAt: new Date().toISOString(),
    ...(args.evidenceContextSnapshotRef ? { evidenceContextSnapshotRef: args.evidenceContextSnapshotRef } : {}),
    ...(args.workflowReceiptRef ? { workflowReceiptRef: args.workflowReceiptRef } : {}),
    workflowArtifactRefs: [...args.workflowArtifactRefs],
    registeredArtifactRefs: args.registeredArtifacts.map(artifact => ({
      id: artifact.id,
      path: artifact.path,
      ...(artifact.artifactType ? { artifactType: artifact.artifactType } : {}),
    })),
    workflowMethods: [...args.workflowMethods],
    productionWriteCount: 0,
    ...(args.failure ? { failure: args.failure } : {}),
  })

  try {
    await mkdir(dirname(args.receiptPath), { recursive: true })
    await writeFile(args.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8')
    const receiptArtifact = await recordArtifact(args.runRef, {
      path: args.receiptPath,
      origin: 'work_case_execution',
      runId: args.workspaceRunId,
      jobId: args.jobId,
      factRefs: args.factRefs,
      artifactType: 'work_case_execution_receipt',
      participatesInFinal: false,
    }, args.cwd)
    const allArtifacts = [...args.registeredArtifacts, receiptArtifact]
    addJobArtifacts(args.jobId, allArtifacts.map(jobArtifactRef))
    await recordEvent(args.runRef, {
      type: `work_case_execution_${args.status}`,
      message: `WorkCase ${args.workCase.id} execution ${args.status}`,
      factRefs: args.factRefs,
      data: {
        workCaseId: args.workCase.id,
        evidenceContextId: args.workCase.evidenceContextRef,
        executionRunId: args.executionRunId,
        driverId: args.runtimeExecution.driverId,
        executionId: args.runtimeExecution.executionId,
        attemptId: args.runtimeExecution.attemptId,
        ...(args.runtimeExecutionResult
          ? { driverSessionId: args.runtimeExecutionResult.driverSessionId }
          : {}),
        jobId: args.jobId,
        workspaceRunId: args.workspaceRunId,
        correlationReceiptRef: args.receiptPath,
        ...(args.evidenceContextSnapshotRef ? { evidenceContextSnapshotRef: args.evidenceContextSnapshotRef } : {}),
        ...(args.workflowReceiptRef ? { workflowReceiptRef: args.workflowReceiptRef } : {}),
        workflowArtifactRefs: args.workflowArtifactRefs,
        productionWriteCount: 0,
      },
    }, args.cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendJobOutput(args.jobId, `WORK_CASE_RECEIPT_PERSISTENCE_FAILED: ${message}\n`)
    finishJob(args.jobId, 'failed', {
      stage: 'evidence_persistence_failed',
      error: message,
      terminationReason: 'work_case_receipt_persistence_failed',
    })
    recordJobCleanup(args.jobId, { attempted: false, succeeded: false, remainingPids: [] })
    throw new InvariantSpineError(
      'WORK_CASE_RECEIPT_PERSISTENCE_FAILED',
      `Could not retain WorkCase execution receipt: ${message}`,
    )
  }

  finishJobFromWorkCaseStatus(args.jobId, args.status, args.failure)
  const job = getJob(args.jobId)
  if (!job) throw new InvariantSpineError('WORK_CASE_JOB_MISSING', `WorkCase job disappeared: ${args.jobId}`)
  return {
    receipt,
    receiptPath: args.receiptPath,
    job,
    ...(args.workflowResult ? { workflowResult: args.workflowResult } : {}),
    ...(args.runtimeExecutionResult ? { runtimeExecutionResult: args.runtimeExecutionResult } : {}),
  }
}

async function persistEvidenceContextSnapshot(args: {
  status: EvidenceContextSnapshotArtifact['status']
  evidenceContext: EvidenceContext
  failure?: EvidenceContextSnapshotArtifact['failure']
  path: string
  workCaseId: string
  evidenceContextId: string
  executionRunId: string
  runtimeExecution: RuntimeExecutionReservation
  workspaceRunId: string
  jobId: string
  runRef: string
  cwd: string
  factRefs: RuntimeFactRefs
}): Promise<RunArtifactRecord> {
  const snapshot: EvidenceContextSnapshotArtifact = deepFreeze({
    schemaVersion: 1,
    kind: 'evidence_context_snapshot',
    status: args.status,
    workCaseId: args.workCaseId,
    evidenceContextId: args.evidenceContextId,
    executionRunId: args.executionRunId,
    driverId: args.runtimeExecution.driverId,
    executionId: args.runtimeExecution.executionId,
    attemptId: args.runtimeExecution.attemptId,
    workspaceRunId: args.workspaceRunId,
    jobId: args.jobId,
    capturedAt: new Date().toISOString(),
    evidenceContext: args.evidenceContext,
    ...(args.failure ? { failure: args.failure } : {}),
  })
  await mkdir(dirname(args.path), { recursive: true })
  await writeFile(args.path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  return await recordArtifact(args.runRef, {
    path: args.path,
    origin: 'work_case_execution',
    runId: args.workspaceRunId,
    jobId: args.jobId,
    factRefs: args.factRefs,
    artifactType: 'evidence_context_snapshot',
    participatesInFinal: false,
  }, args.cwd)
}

async function correlateEvidenceContextSnapshot(args: {
  path: string
  driverSessionId: string
  workCaseId: string
  executionId: string
  attemptId: string
  jobId: string
  runRef: string
  cwd: string
  workspaceRunId: string
  factRefs: RuntimeFactRefs
}): Promise<RunArtifactRecord> {
  const parsed = JSON.parse(await readFile(args.path, 'utf-8')) as unknown
  if (
    !isRecord(parsed)
    || parsed['kind'] !== 'evidence_context_snapshot'
    || parsed['workCaseId'] !== args.workCaseId
    || parsed['executionId'] !== args.executionId
    || parsed['attemptId'] !== args.attemptId
    || parsed['jobId'] !== args.jobId
  ) {
    throw new InvariantSpineError(
      'WORK_CASE_EVIDENCE_CORRELATION_MISMATCH',
      `EvidenceContext snapshot does not belong to execution ${args.executionId}`,
    )
  }
  const snapshot: EvidenceContextSnapshotArtifact = deepFreeze({
    ...parsed,
    driverSessionId: args.driverSessionId,
  } as unknown as EvidenceContextSnapshotArtifact)
  await writeFile(args.path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  return await recordArtifact(args.runRef, {
    path: args.path,
    origin: 'work_case_execution',
    runId: args.workspaceRunId,
    jobId: args.jobId,
    factRefs: args.factRefs,
    artifactType: 'evidence_context_snapshot',
    participatesInFinal: false,
  }, args.cwd)
}

async function registerRuntimeExecutionArtifacts(args: {
  runRef: string
  cwd: string
  jobId: string
  workspaceRunId: string
  artifactFacts: readonly RuntimeExecutionArtifactFact[]
  factRefs: RuntimeFactRefs
}): Promise<RunArtifactRecord[]> {
  const entries = args.artifactFacts.map(fact => ({ path: fact.ref, artifactType: fact.artifactType }))
  const deduped = [...new Map(entries.map(entry => [entry.path, entry])).values()]
  const records: RunArtifactRecord[] = []
  for (const entry of deduped) {
    records.push(await recordArtifact(args.runRef, {
      path: entry.path,
      origin: 'work_case_execution',
      runId: args.workspaceRunId,
      jobId: args.jobId,
      factRefs: args.factRefs,
      artifactType: entry.artifactType,
      participatesInFinal: false,
    }, args.cwd))
  }
  return records
}

function readOnlyMethods(plan: WorkflowPlan): ('GET' | 'HEAD')[] {
  if (!Array.isArray(plan?.steps)) return []
  return uniqueStrings(plan.steps
    .map(step => typeof step?.method === 'string' ? step.method.trim().toUpperCase() : '')
    .filter((method): method is 'GET' | 'HEAD' => method === 'GET' || method === 'HEAD')) as ('GET' | 'HEAD')[]
}

function finishJobFromWorkCaseStatus(
  jobId: string,
  status: WorkCaseExecutionStatus,
  failure: WorkCaseExecutionReceipt['failure'],
): void {
  if (status === 'cancelled') {
    if (getJob(jobId)?.status !== 'cancelled') {
      finishJob(jobId, 'cancelled', {
        stage: 'cancelled',
        terminationReason: failure?.message ?? 'work_case_cancelled',
      })
      recordJobCleanup(jobId, { attempted: true, succeeded: true, remainingPids: [] })
    }
    return
  }
  if (status === 'completed') {
    finishJob(jobId, 'completed', { stage: 'completed', terminationReason: 'workflow_acceptance_passed' })
    recordJobCleanup(jobId, { attempted: false, succeeded: true, remainingPids: [] })
    return
  }
  finishJob(jobId, 'failed', {
    stage: 'failed',
    error: failure?.message ?? 'WorkCase execution failed',
    terminationReason: failure?.code ?? 'work_case_execution_failed',
  })
  recordJobCleanup(jobId, { attempted: false, succeeded: true, remainingPids: [] })
}

function normalizeWorkCase(workCase: WorkCase): WorkCase {
  if (!isRecord(workCase)) throw new InvariantSpineError('WORK_CASE_INVALID', 'WorkCase must be an object')
  const allowedKeys = new Set([
    'schemaVersion',
    'id',
    'objective',
    'evidenceContextRef',
    'executionMode',
    'createdAt',
    'state',
    'opaqueDomainPayloadRef',
  ])
  const unknownKeys = Object.keys(workCase).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0 || workCase.schemaVersion !== 1 || workCase.state !== 'created') {
    throw new InvariantSpineError('WORK_CASE_INVALID', 'WorkCase envelope shape is invalid')
  }
  return createWorkCase({
    id: workCase.id,
    objective: workCase.objective,
    evidenceContextRef: workCase.evidenceContextRef,
    executionMode: workCase.executionMode,
    createdAt: workCase.createdAt,
    ...(workCase.opaqueDomainPayloadRef ? { opaqueDomainPayloadRef: workCase.opaqueDomainPayloadRef } : {}),
  })
}

function failureFromError(error: unknown): NonNullable<WorkCaseExecutionReceipt['failure']> {
  if (error instanceof InvariantSpineError) return { code: error.code, message: error.message }
  if (error instanceof RuntimeExecutionControlError) {
    const code = error.code === 'RUNTIME_EXECUTION_NOT_READ_ONLY'
      ? 'WORK_CASE_EXECUTION_NOT_READ_ONLY'
      : error.code === 'RUNTIME_EXECUTION_NON_LOCAL_ENDPOINT'
        ? 'WORK_CASE_EXECUTION_NON_LOCAL_ENDPOINT'
        : error.code === 'RUNTIME_EXECUTION_PLAN_INVALID'
          ? 'WORK_CASE_EXECUTION_PLAN_INVALID'
          : error.code
    return { code, message: error.message }
  }
  if (error instanceof WorkflowPlanValidationError) {
    return { code: 'WORK_CASE_EXECUTION_PLAN_INVALID', message: error.message }
  }
  return {
    code: 'WORK_CASE_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const signal of signals) {
    if (!signal) continue
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    if (signal.aborted) listener()
    else {
      signal.addEventListener('abort', listener, { once: true })
      listeners.push({ signal, listener })
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const entry of listeners) entry.signal.removeEventListener('abort', entry.listener)
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new InvariantSpineError('WORK_CASE_EXECUTION_CANCELLED', abortReason(signal))
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'work_case_cancelled')
}

function jobArtifactRef(artifact: RunArtifactRecord): JobArtifactRef {
  return {
    id: artifact.id,
    path: artifact.path,
    ...(artifact.artifactType ? { artifactType: artifact.artifactType } : {}),
  }
}

function normalizeExecutionRunId(value: string): string {
  const normalized = requiredString(value, 'executionRunId')
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new InvariantSpineError(
      'WORK_CASE_INVALID',
      'WorkCase executionRunId may contain only letters, numbers, dots, underscores, and hyphens',
    )
  }
  return normalized
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'work-case'
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvariantSpineError('WORK_CASE_INVALID', `WorkCase ${field} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new InvariantSpineError('WORK_CASE_INVALID', `WorkCase ${field} must be an ISO-compatible timestamp`)
  }
  return parsed.toISOString()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value) as T
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
