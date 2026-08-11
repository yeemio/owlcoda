import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type WorkflowHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
export type WorkflowAcceptance = 'pass' | 'fail'

export interface WorkflowCondition {
  from_step: string
  path: string
  exists?: boolean
  equals?: unknown
  not_equals?: unknown
}

export interface WorkflowStep {
  id: string
  method: WorkflowHttpMethod | string
  url: string
  required?: boolean
  headers?: Record<string, string>
  body?: unknown
  idempotency_key?: string
  timeout_ms?: number
  retry?: number
  expected_status?: number | number[]
  projection?: string[]
  max_response_bytes?: number
  if?: WorkflowCondition
}

export interface WorkflowPlan {
  run_id?: string
  plan_version?: string
  base_url?: string
  steps: WorkflowStep[]
  acceptance?: {
    required_endpoint_calls?: number
    must_all_ok?: boolean
    must_write_receipt?: boolean
  }
}

export interface WorkflowRunInput {
  plan?: WorkflowPlan
  contractRef?: string
  baseUrl?: string
  runRef?: string
  receiptEndpoint?: string
  taskRunId?: string
  structuredOutputModel?: string
  structuredOutputUser?: string
  resumeRunId?: string
  receiptPath?: string
  artifactDir?: string
  cwd?: string
}

export interface WorkflowRunOptions {
  signal?: AbortSignal
  redirect?: RequestRedirect
  /** Internal Runtime Execution Control request boundary. */
  requestAdmission?: WorkflowRequestAdmissionHook
  /** Internal correlation written into the durable workflow receipt. */
  runtimeExecution?: WorkflowRuntimeExecutionReceipt
  /** Internal immutable contract source captured when authority is issued. */
  contractSnapshot?: WorkflowContractSnapshot
  /** Internal immutable previous-run sources captured when authority is issued. */
  resumeSnapshot?: WorkflowResumeSourceSnapshot
  /** Internal immutable saved plan source for plan-less resume requests. */
  resumePlanSnapshot?: WorkflowResumePlanSnapshot
}

export interface WorkflowRequestAdmission {
  method: WorkflowHttpMethod
  url: string
  redirect: RequestRedirect
}

export type WorkflowRequestAdmissionHook = (request: WorkflowRequestAdmission) => void

export interface WorkflowRuntimeExecutionReceipt {
  driverId: string
  executionId: string
  attemptId: string
  driverSessionId: string
  grantId?: string
}

export interface WorkflowContractSnapshot {
  ref: string
  content?: string
  readError?: string
}

export interface WorkflowResumeSourceSnapshot {
  receiptRef: string
  receiptContent?: string
  receiptReadError?: string
  responseArtifacts: readonly {
    ref: string
    content?: string
    readError?: string
  }[]
}

export interface WorkflowResumePlanSnapshot {
  ref: string
  content?: string
  readError?: string
}

export interface WorkflowSkippedStepReceipt {
  step_id: string
  reason: 'condition_not_met'
  condition?: WorkflowCondition
}

export interface WorkflowFailedStepReceipt {
  step_id: string
  required: boolean
  reason: string
}

export interface WorkflowEndpointCallReceipt {
  step_id: string
  required: boolean
  method: WorkflowHttpMethod
  url: string
  started_at: string
  finished_at: string
  latency_ms: number
  attempts: number
  ok: boolean
  expected_status?: number | number[]
  status_code?: number
  content_type?: string
  response_size_bytes: number
  max_response_bytes: number
  response_truncated: boolean
  response_artifact?: string
  raw_ref?: string
  artifact_ref?: string
  resumed_from_receipt?: string
  raw_text?: string
  projected_response?: unknown
  response_preview?: string
  artifact_completeness?: WorkflowArtifactCompletenessReceipt
  error?: string
}

export interface WorkflowArtifactCompletenessReceipt {
  expected: string[]
  produced: string[]
  missing: string[]
  validationStatus: 'pass' | 'warn' | 'fail' | 'unknown'
  fallbackStatus: 'none' | 'repair' | 'salvage' | 'failed_fallback'
  artifactRefs: Array<{
    artifactId: string
    kind: string
    path?: string
    ref?: string
  }>
  attemptLedgerRef?: string
}

export interface WorkflowConsumerReadinessReceipt {
  consumerReady: boolean
  blockers: Array<{ code: string; message: string; ref?: string }>
  warnings: Array<{ code: string; message: string; ref?: string }>
  requiredArtifactsMissing: string[]
  fallbackUsed: boolean
  usable: boolean
}

export interface WorkflowResumeReceipt {
  previous_run_id: string
  previous_receipt_path: string
  previous_endpoint_calls: number
  resumed_step_ids: string[]
  mode: 'skip_successful_steps'
}

export interface WorkflowRunReceipt {
  schema_version: 1
  kind: 'workflow_invocation_receipt'
  run_id: string
  task_run_id?: string
  transcript_ref?: string
  started_at: string
  finished_at: string
  plan_version?: string
  plan_digest: string
  plan_path?: string
  receipt_path: string
  artifact_dir: string
  required_steps_total: number
  required_steps_completed: number
  skipped_steps: WorkflowSkippedStepReceipt[]
  failed_steps: WorkflowFailedStepReceipt[]
  endpoint_calls: WorkflowEndpointCallReceipt[]
  artifact_completeness: WorkflowArtifactCompletenessReceipt
  consumer_readiness: WorkflowConsumerReadinessReceipt
  acceptance: WorkflowAcceptance
  required_endpoint_calls: string
  runtime_execution?: WorkflowRuntimeExecutionReceipt
  resume?: WorkflowResumeReceipt
  contract?: {
    kind: 'owlfootball_harness_task_contract'
    matchId: string
    stamp: string
    runRef: string
    tasks_total: number
    tasks_completed: number
  }
}

export interface WorkflowRunResult {
  receipt: WorkflowRunReceipt
  receiptPath: string
  artifactDir: string
}

interface InternalStepResult {
  call: WorkflowEndpointCallReceipt
  parsedResponse?: unknown
}

interface WorkflowResumeState {
  previousRunId: string
  previousReceiptPath: string
  previousEndpointCalls: number
  successfulCalls: Map<string, WorkflowEndpointCallReceipt>
  stepResponses: Map<string, unknown>
}

interface OwlFootballHarnessContractTask {
  task_id: string
  task_name: string
  order: number
  status: string
  writes: string[]
  model_preset?: string | null
  execution: {
    method: WorkflowHttpMethod
    endpoint: string
    request: Record<string, unknown>
    runRef: string
    receipt_endpoint?: string
    structured_output?: Record<string, unknown> | null
  }
}

interface OwlFootballHarnessContract {
  artifact_version: 'match-harness-task-contract.v1' | string
  matchId: string
  stamp: string
  runRef: string
  task_queue: OwlFootballHarnessContractTask[]
}

const SUPPORTED_METHODS = new Set<WorkflowHttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 20_000
const MAX_RETRY = 5

export class WorkflowPlanValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`Invalid workflow plan:\n${errors.map(error => `- ${error}`).join('\n')}`)
    this.name = 'WorkflowPlanValidationError'
    this.errors = errors
  }
}

export async function runWorkflow(input: WorkflowRunInput, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  if (typeof input.contractRef === 'string' && input.contractRef.trim()) {
    return await runOwlFootballHarnessContract(input, options)
  }
  if (!input.plan && input.resumeRunId?.trim()) {
    const cwd = input.cwd && input.cwd.trim() ? resolve(input.cwd) : process.cwd()
    const runId = safeSegment(input.resumeRunId)
    const receiptPath = resolveReceiptPath(cwd, runId, input.receiptPath)
    const planPath = defaultPlanSnapshotPath(receiptPath)
    let plan: WorkflowPlan
    if (options.resumePlanSnapshot) {
      if (resolve(options.resumePlanSnapshot.ref) !== resolve(planPath)) {
        throw new WorkflowPlanValidationError(['resumeRunId plan does not match the approved plan snapshot'])
      }
      if (options.resumePlanSnapshot.content === undefined) {
        throw new WorkflowPlanValidationError([
          `resumeRunId ${runId} requires a saved plan snapshot at ${planPath}: ${options.resumePlanSnapshot.readError ?? 'approved plan snapshot is unavailable'}`,
        ])
      }
      try {
        plan = JSON.parse(options.resumePlanSnapshot.content) as WorkflowPlan
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new WorkflowPlanValidationError([`resumeRunId ${runId} requires a saved plan snapshot at ${planPath}: ${message}`])
      }
    } else {
      try {
        plan = JSON.parse(await readFile(planPath, 'utf-8')) as WorkflowPlan
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new WorkflowPlanValidationError([`resumeRunId ${runId} requires a saved plan snapshot at ${planPath}: ${message}`])
      }
    }
    return await runWorkflowPlan({ ...input, plan: { ...plan, run_id: plan.run_id ?? runId } }, options)
  }
  if (!input.plan) {
    throw new WorkflowPlanValidationError(['either plan or contractRef is required'])
  }
  return await runWorkflowPlan({ ...input, plan: input.plan }, options)
}

export async function runWorkflowPlan(input: WorkflowRunInput & { plan: WorkflowPlan }, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const effectivePlan = input.baseUrl?.trim()
    ? { ...input.plan, base_url: input.baseUrl.trim() }
    : input.plan
  const errors = validateWorkflowRunInput({ ...input, plan: effectivePlan })
  if (errors.length > 0) throw new WorkflowPlanValidationError(errors)

  const plan = effectivePlan
  const cwd = input.cwd && input.cwd.trim() ? resolve(input.cwd) : process.cwd()
  const runId = input.resumeRunId?.trim() ? safeSegment(input.resumeRunId) : normalizeRunId(plan.run_id)
  const receiptPath = resolveReceiptPath(cwd, runId, input.receiptPath)
  const planPath = defaultPlanSnapshotPath(receiptPath)
  const artifactDir = input.artifactDir && input.artifactDir.trim()
    ? resolveFromCwd(cwd, input.artifactDir)
    : join(dirname(receiptPath), `${runId}-artifacts`)
  const startedAt = new Date().toISOString()
  const endpointCalls: WorkflowEndpointCallReceipt[] = []
  const skippedSteps: WorkflowSkippedStepReceipt[] = []
  const failedSteps: WorkflowFailedStepReceipt[] = []
  const stepResponses = new Map<string, unknown>()
  const resumeState = input.resumeRunId?.trim()
    ? await loadWorkflowResumeState(receiptPath, plan.steps, options.resumeSnapshot)
    : undefined
  const resumedStepIds: string[] = []
  for (const [stepId, value] of resumeState?.stepResponses ?? []) {
    stepResponses.set(stepId, value)
  }

  for (const step of plan.steps) {
    const resumedCall = resumeState?.successfulCalls.get(step.id)
    if (resumedCall) {
      endpointCalls.push({
        ...resumedCall,
        resumed_from_receipt: resumeState!.previousReceiptPath,
      })
      resumedStepIds.push(step.id)
      continue
    }

    const condition = step.if
    if (condition && !conditionMatches(condition, stepResponses)) {
      skippedSteps.push({
        step_id: step.id,
        reason: 'condition_not_met',
        condition,
      })
      continue
    }

    const result = await executeHttpStep(step, {
      baseUrl: plan.base_url,
      artifactDir,
      signal: options.signal,
      redirect: options.redirect,
      requestAdmission: options.requestAdmission,
    })
    endpointCalls.push(result.call)
    if (result.parsedResponse !== undefined) {
      stepResponses.set(step.id, result.parsedResponse)
    }
    if (!result.call.ok) {
      failedSteps.push({
        step_id: step.id,
        required: step.required !== false,
        reason: result.call.error ?? 'endpoint_call_failed',
      })
    }
  }

  const requiredStepsTotal = plan.steps.filter(step => step.required !== false).length
  const requiredStepsCompleted = endpointCalls.filter(call => call.required && call.ok).length
  const requiredEndpointTarget = normalizeRequiredEndpointTarget(
    plan.acceptance?.required_endpoint_calls,
    requiredStepsTotal,
  )
  const requiredEndpointActual = endpointCalls.filter(call => call.required && call.ok).length
  const mustAllOk = plan.acceptance?.must_all_ok === true
  const hasRequiredFailure = failedSteps.some(step => step.required)
  const hasAnyFailure = failedSteps.length > 0
  const artifactCompleteness = summarizeWorkflowArtifactCompleteness(endpointCalls)
  const acceptance: WorkflowAcceptance =
    hasRequiredFailure ||
    requiredEndpointActual < requiredEndpointTarget ||
    artifactCompleteness.validationStatus === 'fail' ||
    (mustAllOk && hasAnyFailure)
      ? 'fail'
      : 'pass'
  const consumerReadiness = buildWorkflowConsumerReadiness(artifactCompleteness, failedSteps, acceptance)

  const receipt: WorkflowRunReceipt = {
    schema_version: 1,
    kind: 'workflow_invocation_receipt',
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ...(plan.plan_version ? { plan_version: plan.plan_version } : {}),
    plan_digest: digestJson(plan),
    plan_path: planPath,
    receipt_path: receiptPath,
    artifact_dir: artifactDir,
    required_steps_total: requiredStepsTotal,
    required_steps_completed: requiredStepsCompleted,
    skipped_steps: skippedSteps,
    failed_steps: failedSteps,
    endpoint_calls: endpointCalls,
    artifact_completeness: artifactCompleteness,
    consumer_readiness: consumerReadiness,
    acceptance,
    required_endpoint_calls: `${requiredEndpointActual}/${requiredEndpointTarget}`,
    ...(options.runtimeExecution ? { runtime_execution: options.runtimeExecution } : {}),
    ...(resumeState
      ? {
          resume: {
            previous_run_id: resumeState.previousRunId,
            previous_receipt_path: resumeState.previousReceiptPath,
            previous_endpoint_calls: resumeState.previousEndpointCalls,
            resumed_step_ids: resumedStepIds,
            mode: 'skip_successful_steps',
          },
        }
      : {}),
  }

  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8')
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8')

  return { receipt, receiptPath, artifactDir }
}

async function runOwlFootballHarnessContract(input: WorkflowRunInput, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const cwd = input.cwd && input.cwd.trim() ? resolve(input.cwd) : process.cwd()
  const contractRef = resolveFromCwd(cwd, input.contractRef!)
  const baseUrl = requiredNonEmpty(input.baseUrl, 'baseUrl')
  if (!baseUrl) throw new WorkflowPlanValidationError(['baseUrl is required when contractRef is provided'])

  let parsed: unknown
  if (options.contractSnapshot) {
    if (resolve(options.contractSnapshot.ref) !== contractRef) {
      throw new WorkflowPlanValidationError(['contractRef does not match the approved contract snapshot'])
    }
    if (options.contractSnapshot.content === undefined) {
      throw new WorkflowPlanValidationError([
        `contractRef could not be read as JSON: ${options.contractSnapshot.readError ?? 'approved contract snapshot is unavailable'}`,
      ])
    }
    try {
      parsed = JSON.parse(options.contractSnapshot.content)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new WorkflowPlanValidationError([`contractRef could not be read as JSON: ${message}`])
    }
  } else {
    try {
      parsed = JSON.parse(await readFile(contractRef, 'utf-8'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new WorkflowPlanValidationError([`contractRef could not be read as JSON: ${message}`])
    }
  }
  const contractErrors = validateOwlFootballHarnessContract(parsed)
  if (contractErrors.length > 0) throw new WorkflowPlanValidationError(contractErrors)
  const contract = parsed as OwlFootballHarnessContract

  const taskRunId = input.taskRunId?.trim() || stableOwlFootballTaskRunId(contract)
  const transcriptRef = `owlcoda://runs/${taskRunId}`
  const runId = taskRunId
  const receiptPath = input.receiptPath && input.receiptPath.trim()
    ? resolveFromCwd(cwd, input.receiptPath)
    : join(cwd, '.owlcoda-workflows', runId, 'receipt.json')
  const artifactDir = input.artifactDir && input.artifactDir.trim()
    ? resolveFromCwd(cwd, input.artifactDir)
    : join(dirname(receiptPath), `${runId}-artifacts`)
  const startedAt = new Date().toISOString()
  const endpointCalls: WorkflowEndpointCallReceipt[] = []
  const skippedSteps: WorkflowSkippedStepReceipt[] = []
  const failedSteps: WorkflowFailedStepReceipt[] = []
  let completedTasks = 0

  const tasks = [...contract.task_queue]
    .filter(task => task.status !== 'complete')
    .sort((a, b) => a.order - b.order)

  for (const task of tasks) {
    const taskStartedAt = new Date().toISOString()
    let status: 'completed' | 'failed' | 'skipped' = 'failed'
    let artifactsWritten: string[] = []
    let message: string | undefined

    const execute = await executeHttpStep({
      id: `${task.task_name}:execute`,
      method: task.execution.method,
      url: task.execution.endpoint,
      required: true,
      body: task.execution.request,
      expected_status: [200, 409],
      projection: ['ok', 'result', 'error', 'preset', 'runRef', 'request', 'structured_output', 'receipt'],
      max_response_bytes: 20_000,
    }, {
      baseUrl,
      artifactDir,
      signal: options.signal,
      redirect: options.redirect,
      requestAdmission: options.requestAdmission,
    })
    endpointCalls.push(execute.call)
    const executeBody = asRecord(execute.parsedResponse)

    if (execute.call.status_code === 409 && executeBody?.['error'] === 'requires_structured_output') {
      const structuredOutput = await runStructuredOutputForOwlFootballTask({
        input,
        task,
        executeBody,
        contract,
        baseUrl,
        artifactDir,
        signal: options.signal,
        redirect: options.redirect,
        requestAdmission: options.requestAdmission,
      })
      endpointCalls.push(structuredOutput.call)
      const structuredBody = asRecord(structuredOutput.parsedResponse)
      const bodyOk = structuredBody?.['ok'] !== false
      status = structuredOutput.call.ok && bodyOk ? 'completed' : 'failed'
      artifactsWritten = task.writes
      message = structuredOutputMessage(structuredBody)
      if (status === 'failed') {
        failedSteps.push({
          step_id: task.task_name,
          required: true,
          reason: message ?? structuredOutput.call.error ?? 'structured_output_failed',
        })
      }
    } else if (execute.call.ok && executeBody?.['ok'] !== false) {
      status = 'completed'
      artifactsWritten = artifactsFromExecuteResponse(executeBody) ?? task.writes
      completedTasks += 1
    } else {
      status = 'failed'
      message = stringField(executeBody?.['error']) ?? execute.call.error ?? 'task_execute_failed'
      failedSteps.push({
        step_id: task.task_name,
        required: true,
        reason: message,
      })
    }

    if (status === 'completed' && execute.call.status_code === 409) completedTasks += 1

    const taskFinishedAt = new Date().toISOString()
    const receiptEndpoint = stringField(input.receiptEndpoint)
      ?? stringField(executeBody?.['receipt'] && asRecord(executeBody['receipt'])?.['endpoint'])
      ?? stringField(task.execution.receipt_endpoint)
      ?? '/api/harness/tasks/receipt'
    const receiptPost = await executeHttpStep({
      id: `${task.task_name}:receipt`,
      method: 'POST',
      url: receiptEndpoint,
      required: true,
      body: {
        matchId: contract.matchId,
        stamp: contract.stamp,
        taskName: task.task_name,
        taskRunId,
        transcriptRef,
        status,
        artifactsWritten,
        startedAt: taskStartedAt,
        finishedAt: taskFinishedAt,
        ...(message ? { message } : {}),
      },
      expected_status: 200,
      projection: ['ok', 'error', 'receipt.summary'],
      max_response_bytes: 20_000,
    }, {
      baseUrl,
      artifactDir,
      signal: options.signal,
      redirect: options.redirect,
      requestAdmission: options.requestAdmission,
    })
    endpointCalls.push(receiptPost.call)
    if (!receiptPost.call.ok) {
      failedSteps.push({
        step_id: `${task.task_name}:receipt`,
        required: true,
        reason: receiptPost.call.error ?? 'receipt_post_failed',
      })
    }
  }

  const requiredStepsTotal = tasks.length
  const requiredStepsCompleted = completedTasks
  const acceptance: WorkflowAcceptance =
    failedSteps.some(step => step.required) || requiredStepsCompleted < requiredStepsTotal
      ? 'fail'
      : 'pass'
  const artifactCompleteness = summarizeWorkflowArtifactCompleteness(endpointCalls)
  const consumerReadiness = buildWorkflowConsumerReadiness(artifactCompleteness, failedSteps, acceptance)
  const receipt: WorkflowRunReceipt = {
    schema_version: 1,
    kind: 'workflow_invocation_receipt',
    run_id: runId,
    task_run_id: taskRunId,
    transcript_ref: transcriptRef,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    plan_version: contract.artifact_version,
    plan_digest: digestJson(contract),
    receipt_path: receiptPath,
    artifact_dir: artifactDir,
    required_steps_total: requiredStepsTotal,
    required_steps_completed: requiredStepsCompleted,
    skipped_steps: skippedSteps,
    failed_steps: failedSteps,
    endpoint_calls: endpointCalls,
    artifact_completeness: artifactCompleteness,
    consumer_readiness: consumerReadiness,
    acceptance,
    required_endpoint_calls: `${requiredStepsCompleted}/${requiredStepsTotal}`,
    ...(options.runtimeExecution ? { runtime_execution: options.runtimeExecution } : {}),
    contract: {
      kind: 'owlfootball_harness_task_contract',
      matchId: contract.matchId,
      stamp: contract.stamp,
      runRef: contract.runRef,
      tasks_total: tasks.length,
      tasks_completed: completedTasks,
    },
  }

  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8')

  return { receipt, receiptPath, artifactDir }
}

export function formatWorkflowRunSummary(result: WorkflowRunResult): string {
  const { receipt } = result
  const verb = receipt.acceptance === 'pass' ? 'completed' : 'failed'
  return [
    `WorkflowRun ${verb}: ${receipt.run_id}`,
    `acceptance=${receipt.acceptance}`,
    `required_endpoint_calls=${receipt.required_endpoint_calls}`,
    `failed_steps=${receipt.failed_steps.length}`,
    `skipped_steps=${receipt.skipped_steps.length}`,
    `receipt=${receipt.receipt_path}`,
  ].join(' ')
}

function validateWorkflowRunInput(input: WorkflowRunInput & { plan: WorkflowPlan }): string[] {
  if (!isRecord(input)) return ['input must be an object']
  if (!isRecord(input.plan)) return ['plan must be an object']
  return validateWorkflowPlan(input.plan)
}

export function validateWorkflowPlan(plan: WorkflowPlan): string[] {
  const errors: string[] = []
  if (!isRecord(plan)) return ['plan must be an object']
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push('steps must be a non-empty array')
    return errors
  }

  if (plan.base_url !== undefined) {
    if (typeof plan.base_url !== 'string' || !plan.base_url.trim()) {
      errors.push('base_url must be a non-empty string when provided')
    } else {
      try {
        const parsed = new URL(plan.base_url)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push('base_url must use http or https')
        }
      } catch {
        errors.push(`base_url is not a valid URL: ${plan.base_url}`)
      }
    }
  }

  const ids = new Set<string>()
  for (let index = 0; index < plan.steps.length; index += 1) {
    const rawStep = plan.steps[index]
    if (!isRecord(rawStep)) {
      errors.push(`step ${index + 1}: must be an object`)
      continue
    }
    const id = typeof rawStep.id === 'string' && rawStep.id.trim()
      ? rawStep.id.trim()
      : `step-${index + 1}`
    if (ids.has(id)) errors.push(`${id}: duplicate step id`)
    ids.add(id)

    const method = typeof rawStep.method === 'string' ? rawStep.method.trim().toUpperCase() : ''
    if (!method) {
      errors.push(`${id}: method is required`)
    } else if (!SUPPORTED_METHODS.has(method as WorkflowHttpMethod)) {
      errors.push(`${id}: unsupported method ${rawStep.method}`)
    }

    if (typeof rawStep.url !== 'string' || !rawStep.url.trim()) {
      errors.push(`${id}: url is required`)
    } else {
      const url = rawStep.url.trim()
      if (!isAbsoluteHttpUrl(url) && !plan.base_url) {
        errors.push(`${id}: relative url requires plan.base_url`)
      }
      if (isAbsoluteHttpUrl(url)) {
        try {
          const parsed = new URL(url)
          if (!['http:', 'https:'].includes(parsed.protocol)) errors.push(`${id}: url must use http or https`)
        } catch {
          errors.push(`${id}: url is not a valid URL`)
        }
      }
    }

    if (rawStep.headers !== undefined && !isStringRecord(rawStep.headers)) {
      errors.push(`${id}: headers must be an object of string values`)
    }
    if (rawStep.idempotency_key !== undefined && (typeof rawStep.idempotency_key !== 'string' || !rawStep.idempotency_key.trim())) {
      errors.push(`${id}: idempotency_key must be a non-empty string when provided`)
    }
    if (rawStep.body !== undefined && (method === 'GET' || method === 'HEAD')) {
      errors.push(`${id}: body is not allowed for ${method}`)
    }
    if (rawStep.body !== undefined) {
      try {
        JSON.stringify(rawStep.body)
      } catch {
        errors.push(`${id}: body must be JSON serializable`)
      }
    }
    if (rawStep.timeout_ms !== undefined && !isPositiveInteger(rawStep.timeout_ms)) {
      errors.push(`${id}: timeout_ms must be a positive integer`)
    }
    if (rawStep.retry !== undefined && (!Number.isInteger(rawStep.retry) || rawStep.retry < 0)) {
      errors.push(`${id}: retry must be a non-negative integer`)
    }
    if (rawStep.max_response_bytes !== undefined && !isPositiveInteger(rawStep.max_response_bytes)) {
      errors.push(`${id}: max_response_bytes must be a positive integer`)
    }
    if (rawStep.projection !== undefined && (!Array.isArray(rawStep.projection) || !rawStep.projection.every(item => typeof item === 'string' && item.trim()))) {
      errors.push(`${id}: projection must be an array of non-empty strings`)
    }
    if (rawStep.expected_status !== undefined && !isValidExpectedStatus(rawStep.expected_status)) {
      errors.push(`${id}: expected_status must be an HTTP status code or array of status codes`)
    }
    if (rawStep.if !== undefined) {
      if (!isRecord(rawStep.if)) {
        errors.push(`${id}: if must be an object`)
      } else {
        const condition = rawStep.if as WorkflowCondition
        if (typeof condition.from_step !== 'string' || !condition.from_step.trim()) errors.push(`${id}: if.from_step is required`)
        if (typeof condition.path !== 'string' || !condition.path.trim()) errors.push(`${id}: if.path is required`)
      }
    }
  }

  if (isRecord(plan.acceptance)) {
    const required = plan.acceptance.required_endpoint_calls
    if (required !== undefined && (!Number.isInteger(required) || required < 0)) {
      errors.push('acceptance.required_endpoint_calls must be a non-negative integer')
    }
  }
  return errors
}

function validateOwlFootballHarnessContract(value: unknown): string[] {
  const errors: string[] = []
  const contract = asRecord(value)
  if (!contract) return ['contractRef JSON must be an object']
  if (stringField(contract['artifact_version']) !== 'match-harness-task-contract.v1') {
    errors.push('contract artifact_version must be match-harness-task-contract.v1')
  }
  if (!stringField(contract['matchId'])) errors.push('contract matchId is required')
  if (!stringField(contract['stamp'])) errors.push('contract stamp is required')
  if (!stringField(contract['runRef'])) errors.push('contract runRef is required')
  if (!Array.isArray(contract['task_queue']) || contract['task_queue'].length === 0) {
    errors.push('contract task_queue must be a non-empty array')
    return errors
  }
  for (let index = 0; index < contract['task_queue'].length; index += 1) {
    const task = asRecord(contract['task_queue'][index])
    const prefix = `task_queue[${index}]`
    if (!task) {
      errors.push(`${prefix} must be an object`)
      continue
    }
    const name = stringField(task['task_name'])
    if (!name) errors.push(`${prefix}.task_name is required`)
    if (!Number.isFinite(task['order'])) errors.push(`${prefix}.order is required`)
    if (!Array.isArray(task['writes']) || !task['writes'].every(item => typeof item === 'string')) {
      errors.push(`${prefix}.writes must be a string array`)
    }
    const execution = asRecord(task['execution'])
    if (!execution) {
      errors.push(`${prefix}.execution is required`)
      continue
    }
    const method = stringField(execution['method'])?.toUpperCase()
    if (!method || !SUPPORTED_METHODS.has(method as WorkflowHttpMethod)) {
      errors.push(`${prefix}.execution.method must be a supported HTTP method`)
    }
    if (!stringField(execution['endpoint'])) errors.push(`${prefix}.execution.endpoint is required`)
    if (!isRecord(execution['request'])) errors.push(`${prefix}.execution.request is required`)
  }
  return errors
}

async function runStructuredOutputForOwlFootballTask(args: {
  input: WorkflowRunInput
  task: OwlFootballHarnessContractTask
  executeBody: Record<string, unknown>
  contract: OwlFootballHarnessContract
  baseUrl: string
  artifactDir: string
  signal?: AbortSignal
  redirect?: RequestRedirect
  requestAdmission?: WorkflowRequestAdmissionHook
}): Promise<InternalStepResult> {
  const fromResponse = asRecord(args.executeBody['structured_output'])
    ?? asRecord(args.executeBody['request'])
    ?? asRecord(args.task.execution.structured_output)
    ?? {}
  const endpoint = stringField(fromResponse['endpoint'])
    ?? stringField(asRecord(args.task.execution.structured_output)?.['endpoint'])
    ?? '/v1/structured-output'
  const request = { ...fromResponse }
  delete request['endpoint']
  delete request['trigger_error']

  const preset = stringField(request['preset'])
    ?? stringField(args.executeBody['preset'])
    ?? stringField(args.task.model_preset)
    ?? 'evidence-digest.v1'
  const runRef = stringField(request['runRef']) ?? args.input.runRef ?? args.contract.runRef
  const stepId = stringField(request['stepId']) ?? args.task.task_name
  const taskId = stringField(request['taskId']) ?? `owlfootball.match.${args.contract.matchId}`
  const runId = stringField(request['runId']) ?? args.contract.stamp
  const body = {
    ...request,
    model: args.input.structuredOutputModel?.trim() || stringField(request['model']) || 'mimo',
    preset,
    persist: request['persist'] ?? true,
    runRef,
    runId,
    taskId,
    stepId,
    user: args.input.structuredOutputUser?.trim()
      || stringField(request['user'])
      || `Run OwlFootball harness task ${args.task.task_name}. Use persisted run artifacts from runRef=${runRef}.`,
  }

  return await executeHttpStep({
    id: `${args.task.task_name}:structured-output`,
    method: 'POST',
    url: endpoint,
    required: true,
    body,
    expected_status: 200,
    projection: ['ok', 'usable', 'consumerReady', 'fallbackUsed', 'artifactId', 'attemptLedgerId', 'rawText', 'stopReason', 'persisted', 'runRef', 'artifactCompleteness.validationStatus'],
    max_response_bytes: 20_000,
  }, {
    baseUrl: args.baseUrl,
    artifactDir: args.artifactDir,
    signal: args.signal,
    redirect: args.redirect,
    requestAdmission: args.requestAdmission,
  })
}

function structuredOutputMessage(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined
  const parts = [
    stringField(body['artifactId']) ? `artifactId=${stringField(body['artifactId'])}` : undefined,
    stringField(body['attemptLedgerId']) ? `attemptLedgerId=${stringField(body['attemptLedgerId'])}` : undefined,
    stringField(body['stopReason']) ? `stopReason=${stringField(body['stopReason'])}` : undefined,
  ].filter(Boolean)
  if (parts.length > 0) return `structured_output ${parts.join(' ')}`
  return body['ok'] === false ? 'structured_output returned ok=false' : undefined
}

function artifactsFromExecuteResponse(body: Record<string, unknown> | undefined): string[] | undefined {
  const result = asRecord(body?.['result'])
  const fromResult = result?.['artifacts_written']
  if (Array.isArray(fromResult) && fromResult.every(item => typeof item === 'string')) return fromResult
  const direct = body?.['artifacts_written']
  if (Array.isArray(direct) && direct.every(item => typeof item === 'string')) return direct
  return undefined
}

async function executeHttpStep(step: WorkflowStep, args: {
  baseUrl?: string
  artifactDir: string
  signal?: AbortSignal
  redirect?: RequestRedirect
  requestAdmission?: WorkflowRequestAdmissionHook
}): Promise<InternalStepResult> {
  const method = step.method.trim().toUpperCase() as WorkflowHttpMethod
  const url = resolveStepUrl(step.url, args.baseUrl)
  const timeoutMs = Math.min(step.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxResponseBytes = step.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const retry = Math.min(step.retry ?? 0, MAX_RETRY)
  const attemptsTotal = retry + 1
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  let lastError: unknown

  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    try {
      const body = step.body === undefined ? undefined : JSON.stringify(step.body)
      const headers: Record<string, string> = { ...(step.headers ?? {}) }
      if (step.idempotency_key?.trim() && !hasHeader(headers, 'idempotency-key')) {
        headers['idempotency-key'] = step.idempotency_key.trim()
      }
      if (body !== undefined && !hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
      if (!hasHeader(headers, 'accept')) headers.accept = 'application/json, text/plain, */*'

      const response = await fetchWithTimeout(url, {
        method,
        headers,
        body,
        redirect: args.redirect ?? 'follow',
      }, timeoutMs, args.signal, args.requestAdmission)
      const raw = method === 'HEAD' ? '' : await response.text()
      const finishedAt = new Date().toISOString()
      const contentType = response.headers.get('content-type') ?? undefined
      const responseBytes = Buffer.byteLength(raw, 'utf-8')
      const parsedResponse = parseResponseBody(raw, contentType)
      const statusOk = expectedStatusMatches(response.status, step.expected_status)
      const artifactPath = responseBytes > maxResponseBytes
        ? await writeResponseArtifact({
            artifactDir: args.artifactDir,
            stepId: step.id,
            contentType,
            raw,
          })
        : undefined
      const projectedResponse = parsedResponse !== undefined && step.projection
        ? projectResponse(parsedResponse, step.projection)
        : undefined
      const artifactCompleteness = buildEndpointArtifactCompleteness({
        ok: statusOk,
        responseArtifact: artifactPath,
        rawRef: artifactPath,
        artifactRef: artifactPath,
        projectedResponse,
      })
      const call: WorkflowEndpointCallReceipt = {
        step_id: step.id,
        required: step.required !== false,
        method,
        url,
        started_at: startedAt,
        finished_at: finishedAt,
        latency_ms: Math.max(0, Date.now() - startMs),
        attempts: attempt,
        ok: statusOk,
        expected_status: step.expected_status,
        status_code: response.status,
        ...(contentType ? { content_type: contentType } : {}),
        response_size_bytes: responseBytes,
        max_response_bytes: maxResponseBytes,
        response_truncated: responseBytes > maxResponseBytes,
        ...(artifactPath
          ? {
              response_artifact: artifactPath,
              raw_ref: artifactPath,
              artifact_ref: artifactPath,
            }
          : {}),
        ...(projectedResponse !== undefined ? { projected_response: projectedResponse } : {}),
        artifact_completeness: artifactCompleteness,
        ...(!statusOk && raw ? { raw_text: raw.slice(0, Math.min(raw.length, maxResponseBytes)) } : {}),
        ...(projectedResponse === undefined && raw
          ? { response_preview: raw.slice(0, Math.min(raw.length, maxResponseBytes)) }
          : {}),
        ...(!statusOk ? { error: `status ${response.status} did not match expected ${formatExpectedStatus(step.expected_status)}` } : {}),
      }
      if (!statusOk && attempt < attemptsTotal) continue
      return { call, parsedResponse }
    } catch (err) {
      lastError = err
      if (attempt < attemptsTotal) continue
      const message = err instanceof Error ? err.message : String(err)
      const finishedAt = new Date().toISOString()
      return {
        call: {
          step_id: step.id,
          required: step.required !== false,
          method,
          url,
          started_at: startedAt,
          finished_at: finishedAt,
          latency_ms: Math.max(0, Date.now() - startMs),
          attempts: attempt,
          ok: false,
          expected_status: step.expected_status,
          response_size_bytes: 0,
          max_response_bytes: maxResponseBytes,
          response_truncated: false,
          artifact_completeness: buildEndpointArtifactCompleteness({ ok: false }),
          error: isAbortLikeError(err)
            ? `request timed out after ${timeoutMs}ms`
            : message,
        },
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
  throw new Error(message)
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  requestAdmission?: WorkflowRequestAdmissionHook,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  try {
    if (!requestAdmission) return await fetch(url, { ...init, signal: controller.signal })

    const redirect = init.redirect ?? 'follow'
    if (redirect !== 'follow') {
      requestAdmission({
        method: normalizedRequestMethod(init.method),
        url,
        redirect,
      })
      return await fetch(url, { ...init, signal: controller.signal })
    }

    let currentUrl = url
    let currentInit: RequestInit = { ...init, redirect: 'manual' }
    for (let redirectCount = 0; redirectCount <= 20; redirectCount += 1) {
      const method = normalizedRequestMethod(currentInit.method)
      requestAdmission({ method, url: currentUrl, redirect })
      const response = await fetch(currentUrl, { ...currentInit, signal: controller.signal })
      if (!isRedirectResponse(response.status)) return response

      const location = response.headers.get('location')
      if (!location) return response
      if (redirectCount === 20) {
        await response.body?.cancel()
        throw new Error('redirect count exceeded 20')
      }

      const nextUrl = new URL(location, currentUrl).href
      const nextMethod = redirectMethod(response.status, method)
      let nextHeaders = new Headers(currentInit.headers)
      let nextBody = currentInit.body
      if (nextMethod !== method) {
        nextBody = undefined
        nextHeaders.delete('content-length')
        nextHeaders.delete('content-type')
      }
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) {
          nextHeaders.delete(name)
        }
      }
      await response.body?.cancel()
      currentUrl = nextUrl
      currentInit = {
        ...currentInit,
        method: nextMethod,
        headers: nextHeaders,
        body: nextBody,
        redirect: 'manual',
      }
    }
    throw new Error('redirect count exceeded 20')
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

function normalizedRequestMethod(method: string | undefined): WorkflowHttpMethod {
  return (method?.trim().toUpperCase() || 'GET') as WorkflowHttpMethod
}

function isRedirectResponse(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function redirectMethod(status: number, method: WorkflowHttpMethod): WorkflowHttpMethod {
  if (status === 303 && method !== 'HEAD') return 'GET'
  if ((status === 301 || status === 302) && method === 'POST') return 'GET'
  return method
}

function resolveStepUrl(stepUrl: string, baseUrl: string | undefined): string {
  if (isAbsoluteHttpUrl(stepUrl)) return new URL(stepUrl).href
  return new URL(stepUrl, baseUrl).href
}

function expectedStatusMatches(status: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return status >= 200 && status < 300
  return Array.isArray(expected) ? expected.includes(status) : status === expected
}

function formatExpectedStatus(expected: number | number[] | undefined): string {
  if (expected === undefined) return '2xx'
  return Array.isArray(expected) ? expected.join(',') : String(expected)
}

function parseResponseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const looksJson = contentType?.toLowerCase().includes('json') || /^[{[]/.test(trimmed)
  if (!looksJson) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function buildEndpointArtifactCompleteness(args: {
  ok: boolean
  responseArtifact?: string
  rawRef?: string
  artifactRef?: string
  projectedResponse?: unknown
}): WorkflowArtifactCompletenessReceipt {
  const projected = asRecord(args.projectedResponse)
  const artifactId = stringField(projected?.['artifactId'])
  const attemptLedgerId = stringField(projected?.['attemptLedgerId'])
  const produced = uniqueStrings([
    args.responseArtifact,
    args.artifactRef,
    args.rawRef,
    artifactId,
    attemptLedgerId,
  ].filter((value): value is string => Boolean(value)))
  const fallbackUsed = projected?.['fallbackUsed'] === true
  const usable = projected?.['usable'] !== false
  const validationStatus: WorkflowArtifactCompletenessReceipt['validationStatus'] = !args.ok || fallbackUsed || !usable
    ? 'fail'
    : 'pass'
  const fallbackStatus: WorkflowArtifactCompletenessReceipt['fallbackStatus'] = fallbackUsed || !usable
    ? 'failed_fallback'
    : 'none'
  const artifactRefs = [
    ...(args.responseArtifact ? [{ artifactId: args.responseArtifact, kind: 'response_artifact', path: args.responseArtifact, ref: args.responseArtifact }] : []),
    ...(artifactId ? [{ artifactId, kind: 'structured_output_artifact', ref: artifactId }] : []),
    ...(attemptLedgerId ? [{ artifactId: attemptLedgerId, kind: 'structured_output_attempts', ref: attemptLedgerId }] : []),
  ]
  return {
    expected: [],
    produced,
    missing: [],
    validationStatus,
    fallbackStatus,
    artifactRefs,
    ...(attemptLedgerId ? { attemptLedgerRef: attemptLedgerId } : {}),
  }
}

function summarizeWorkflowArtifactCompleteness(endpointCalls: WorkflowEndpointCallReceipt[]): WorkflowArtifactCompletenessReceipt {
  const receipts = endpointCalls.map(call => call.artifact_completeness).filter((value): value is WorkflowArtifactCompletenessReceipt => Boolean(value))
  const expected = uniqueStrings(receipts.flatMap(receipt => receipt.expected))
  const produced = uniqueStrings(receipts.flatMap(receipt => receipt.produced))
  const missing = uniqueStrings(receipts.flatMap(receipt => receipt.missing))
  const fallbackStatus: WorkflowArtifactCompletenessReceipt['fallbackStatus'] = receipts.some(receipt => receipt.fallbackStatus === 'failed_fallback')
    ? 'failed_fallback'
    : receipts.some(receipt => receipt.fallbackStatus === 'salvage')
      ? 'salvage'
      : receipts.some(receipt => receipt.fallbackStatus === 'repair')
        ? 'repair'
        : 'none'
  const validationStatus: WorkflowArtifactCompletenessReceipt['validationStatus'] = missing.length > 0 || fallbackStatus === 'failed_fallback' || receipts.some(receipt => receipt.validationStatus === 'fail')
    ? 'fail'
    : receipts.some(receipt => receipt.validationStatus === 'warn')
      ? 'warn'
      : 'pass'
  return {
    expected,
    produced,
    missing,
    validationStatus,
    fallbackStatus,
    artifactRefs: receipts.flatMap(receipt => receipt.artifactRefs),
    ...(receipts.find(receipt => receipt.attemptLedgerRef)?.attemptLedgerRef
      ? { attemptLedgerRef: receipts.find(receipt => receipt.attemptLedgerRef)?.attemptLedgerRef }
      : {}),
  }
}

function buildWorkflowConsumerReadiness(
  artifactCompleteness: WorkflowArtifactCompletenessReceipt,
  failedSteps: WorkflowFailedStepReceipt[],
  acceptance: WorkflowAcceptance,
): WorkflowConsumerReadinessReceipt {
  const blockers: WorkflowConsumerReadinessReceipt['blockers'] = []
  if (acceptance === 'fail') blockers.push({ code: 'workflow_acceptance_failed', message: 'Workflow acceptance failed' })
  for (const step of failedSteps.filter(step => step.required)) {
    blockers.push({ code: 'required_step_failed', message: step.reason, ref: step.step_id })
  }
  if (artifactCompleteness.missing.length > 0) {
    blockers.push({
      code: 'missing_required_artifact',
      message: `Missing required workflow artifacts: ${artifactCompleteness.missing.join(', ')}`,
    })
  }
  if (artifactCompleteness.fallbackStatus === 'failed_fallback') {
    blockers.push({ code: 'failed_fallback', message: 'Workflow includes failed fallback artifact' })
  }
  const usable = blockers.length === 0 && artifactCompleteness.validationStatus !== 'fail'
  return {
    consumerReady: usable,
    blockers,
    warnings: [],
    requiredArtifactsMissing: artifactCompleteness.missing,
    fallbackUsed: artifactCompleteness.fallbackStatus === 'failed_fallback',
    usable,
  }
}

async function loadWorkflowResumeState(
  receiptPath: string,
  steps: WorkflowStep[],
  snapshot?: WorkflowResumeSourceSnapshot,
): Promise<WorkflowResumeState> {
  let parsed: unknown
  if (snapshot) {
    if (resolve(snapshot.receiptRef) !== resolve(receiptPath)) {
      throw new WorkflowPlanValidationError(['resumeRunId receipt does not match the approved resume snapshot'])
    }
    if (snapshot.receiptContent === undefined) {
      throw new WorkflowPlanValidationError([
        `resumeRunId requires a previous receipt at ${receiptPath}: ${snapshot.receiptReadError ?? 'approved receipt snapshot is unavailable'}`,
      ])
    }
    try {
      parsed = JSON.parse(snapshot.receiptContent)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new WorkflowPlanValidationError([`resumeRunId requires a previous receipt at ${receiptPath}: ${message}`])
    }
  } else {
    try {
      parsed = JSON.parse(await readFile(receiptPath, 'utf-8'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new WorkflowPlanValidationError([`resumeRunId requires a previous receipt at ${receiptPath}: ${message}`])
    }
  }
  const previous = asRecord(parsed) as WorkflowRunReceipt | undefined
  if (!previous || previous.kind !== 'workflow_invocation_receipt' || !Array.isArray(previous.endpoint_calls)) {
    throw new WorkflowPlanValidationError([`resumeRunId previous receipt is not a workflow invocation receipt: ${receiptPath}`])
  }

  const stepIds = new Set(steps.map(step => step.id))
  const successfulCalls = new Map<string, WorkflowEndpointCallReceipt>()
  const stepResponses = new Map<string, unknown>()
  for (const call of previous.endpoint_calls) {
    if (!call.ok || !stepIds.has(call.step_id)) continue
    successfulCalls.set(call.step_id, call)
    const response = await responseFromPreviousCall(call, snapshot)
    if (response !== undefined) stepResponses.set(call.step_id, response)
  }

  return {
    previousRunId: previous.run_id,
    previousReceiptPath: receiptPath,
    previousEndpointCalls: previous.endpoint_calls.length,
    successfulCalls,
    stepResponses,
  }
}

async function responseFromPreviousCall(
  call: WorkflowEndpointCallReceipt,
  snapshot?: WorkflowResumeSourceSnapshot,
): Promise<unknown> {
  if (call.projected_response !== undefined) return call.projected_response
  const preview = parseResponseBody(call.response_preview ?? '', call.content_type)
  if (preview !== undefined) return preview
  const artifactPath = call.response_artifact ?? call.raw_ref ?? call.artifact_ref
  if (!artifactPath) return undefined
  if (snapshot) {
    const artifact = snapshot.responseArtifacts.find(candidate => candidate.ref === artifactPath)
    return artifact?.content === undefined
      ? undefined
      : parseResponseBody(artifact.content, call.content_type)
  }
  try {
    return parseResponseBody(await readFile(artifactPath, 'utf-8'), call.content_type)
  } catch {
    return undefined
  }
}

async function writeResponseArtifact(args: {
  artifactDir: string
  stepId: string
  contentType?: string
  raw: string
}): Promise<string> {
  await mkdir(args.artifactDir, { recursive: true })
  const ext = args.contentType?.toLowerCase().includes('json') ? 'json' : 'txt'
  const path = join(args.artifactDir, `${safeSegment(args.stepId)}.response.${ext}`)
  await writeFile(path, args.raw, 'utf-8')
  return path
}

function projectResponse(parsed: unknown, projection: string[]): unknown {
  const out: Record<string, unknown> = {}
  for (const rawPath of projection) {
    const segments = normalizeJsonPath(rawPath)
    if (segments.length === 0) continue
    const value = getByPath(parsed, segments)
    if (value !== undefined) setByPath(out, segments, value)
  }
  return out
}

function conditionMatches(condition: WorkflowCondition, stepResponses: Map<string, unknown>): boolean {
  const source = stepResponses.get(condition.from_step)
  const value = getByPath(source, normalizeJsonPath(condition.path))
  if (condition.exists !== undefined) {
    const exists = value !== undefined && value !== null
    if (exists !== condition.exists) return false
  }
  if ('equals' in condition && !jsonEqual(value, condition.equals)) return false
  if ('not_equals' in condition && jsonEqual(value, condition.not_equals)) return false
  return true
}

function normalizeJsonPath(path: string): string[] {
  return path
    .trim()
    .replace(/^\$\./, '')
    .replace(/^\$/, '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean)
}

function getByPath(value: unknown, segments: string[]): unknown {
  let current = value
  for (const segment of segments) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else {
      current = current[segment]
    }
  }
  return current
}

function setByPath(out: Record<string, unknown>, segments: string[], value: unknown): void {
  let current: Record<string, unknown> = out
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (index === segments.length - 1) {
      current[segment] = value
      return
    }
    const next = current[segment]
    if (!isRecord(next)) {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  }
}

function normalizeRequiredEndpointTarget(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  return Math.max(0, raw)
}

function normalizeRunId(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (trimmed) return safeSegment(trimmed)
  return `workflow-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
}

function resolveReceiptPath(cwd: string, runId: string, receiptPath: string | undefined): string {
  return receiptPath && receiptPath.trim()
    ? resolveFromCwd(cwd, receiptPath)
    : join(cwd, '.owlcoda-workflows', runId, 'receipt.json')
}

function defaultPlanSnapshotPath(receiptPath: string): string {
  return join(dirname(receiptPath), 'plan.json')
}

function stableOwlFootballTaskRunId(contract: OwlFootballHarnessContract): string {
  return safeSegment(`owlcoda-run-${contract.matchId}-${contract.stamp}`)
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow'
}

function resolveFromCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())
}

function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isValidExpectedStatus(value: unknown): boolean {
  if (typeof value === 'number') return isHttpStatus(value)
  return Array.isArray(value) && value.length > 0 && value.every(isHttpStatus)
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 100 && value <= 599
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function requiredNonEmpty(value: unknown, _field: string): string | undefined {
  return stringField(value)
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || /abort|timeout/i.test(err.message)
}
