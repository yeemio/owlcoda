import type {
  RuntimeEventLog,
  RuntimeEventRecord,
  RuntimeFactRefs,
  RuntimeRecoveryCheckpointRecord,
  RuntimeRecoveryLedger,
} from './protocol/types.js'

export interface RuntimeFactsForRun {
  schemaVersion: 1
  runId: string
  threadIds: string[]
  turnIds: string[]
  taskIds: string[]
  stepIds: string[]
  jobIds: string[]
  artifactIds: string[]
  checkpointIds: string[]
  proofIds: string[]
  eventIds: string[]
  checkpointRecordIds: string[]
  events: RuntimeEventRecord[]
  checkpoints: RuntimeRecoveryCheckpointRecord[]
  jobs: RuntimeFactJobLike[]
  artifacts: RuntimeFactArtifactLike[]
}

export interface RuntimeFactJobLike {
  jobId: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  factRefs?: RuntimeFactRefs
  artifacts?: Array<{ id?: string; path?: string; artifactType?: string }>
}

export interface RuntimeFactArtifactLike {
  id: string
  path?: string
  origin?: string
  artifactType?: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  jobId?: string
  proofId?: string
  factRefs?: RuntimeFactRefs
  participatesInFinal?: boolean
  status?: string
  structuredOutput?: RuntimeFactStructuredOutputLike
}

export interface RuntimeFactStructuredOutputLike {
  artifactKind?: string
  role?: string | null
  model?: string
  preset?: string
  requestFingerprint?: string | null
  schemaHash?: string | null
  policyHash?: string | null
  ok?: boolean
  artifact?: unknown
  rawText?: string
  rawThinkingText?: string | null
  parsed?: boolean
  schemaValid?: boolean
  validationErrors?: string[]
  repairCount?: number
  salvageUsed?: boolean
  fallbackUsed?: boolean
  stopReason?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  durationMs?: number | null
  capabilityGate?: Record<string, unknown> | null
  rerun?: boolean
  parentArtifactId?: string | null
  rerunOf?: string | null
  inputRef?: string | null
  artifactRef?: string | null
}

export function normalizeRuntimeFactRefs(input: RuntimeFactRefs | null | undefined): RuntimeFactRefs | undefined {
  if (!input) return undefined
  const out: RuntimeFactRefs = {}
  addRef(out, 'threadId', input.threadId)
  addRef(out, 'turnId', input.turnId)
  addRef(out, 'runId', input.runId)
  addRef(out, 'workCaseId', input.workCaseId)
  addRef(out, 'evidenceContextId', input.evidenceContextId)
  addRef(out, 'executionRunId', input.executionRunId)
  addRef(out, 'driverId', input.driverId)
  addRef(out, 'executionId', input.executionId)
  addRef(out, 'attemptId', input.attemptId)
  addRef(out, 'driverSessionId', input.driverSessionId)
  addRef(out, 'workspaceRunId', input.workspaceRunId)
  addRef(out, 'taskId', input.taskId)
  addRef(out, 'stepId', input.stepId)
  addRef(out, 'jobId', input.jobId)
  addRef(out, 'artifactId', input.artifactId)
  addRef(out, 'artifactPath', input.artifactPath)
  addRef(out, 'workflowReceiptRef', input.workflowReceiptRef)
  addRef(out, 'checkpointId', input.checkpointId)
  addRef(out, 'proofId', input.proofId)
  addRef(out, 'itemId', input.itemId)
  const workflowArtifactRefs = uniqueStrings(input.workflowArtifactRefs ?? [])
  if (workflowArtifactRefs.length > 0) out.workflowArtifactRefs = workflowArtifactRefs
  const coveredIds = uniqueStrings(input.coveredIds ?? [])
  if (coveredIds.length > 0) out.coveredIds = coveredIds
  return Object.keys(out).length > 0 ? out : undefined
}

export function mergeRuntimeFactRefs(
  ...refs: Array<RuntimeFactRefs | null | undefined>
): RuntimeFactRefs | undefined {
  const merged: RuntimeFactRefs = {}
  const workflowArtifactRefs: string[] = []
  const coveredIds: string[] = []
  for (const refsItem of refs) {
    if (!refsItem) continue
    addRefIfMissing(merged, 'threadId', refsItem.threadId)
    addRefIfMissing(merged, 'turnId', refsItem.turnId)
    addRefIfMissing(merged, 'runId', refsItem.runId)
    addRefIfMissing(merged, 'workCaseId', refsItem.workCaseId)
    addRefIfMissing(merged, 'evidenceContextId', refsItem.evidenceContextId)
    addRefIfMissing(merged, 'executionRunId', refsItem.executionRunId)
    addRefIfMissing(merged, 'driverId', refsItem.driverId)
    addRefIfMissing(merged, 'executionId', refsItem.executionId)
    addRefIfMissing(merged, 'attemptId', refsItem.attemptId)
    addRefIfMissing(merged, 'driverSessionId', refsItem.driverSessionId)
    addRefIfMissing(merged, 'workspaceRunId', refsItem.workspaceRunId)
    addRefIfMissing(merged, 'taskId', refsItem.taskId)
    addRefIfMissing(merged, 'stepId', refsItem.stepId)
    addRefIfMissing(merged, 'jobId', refsItem.jobId)
    addRefIfMissing(merged, 'artifactId', refsItem.artifactId)
    addRefIfMissing(merged, 'artifactPath', refsItem.artifactPath)
    addRefIfMissing(merged, 'workflowReceiptRef', refsItem.workflowReceiptRef)
    addRefIfMissing(merged, 'checkpointId', refsItem.checkpointId)
    addRefIfMissing(merged, 'proofId', refsItem.proofId)
    addRefIfMissing(merged, 'itemId', refsItem.itemId)
    workflowArtifactRefs.push(...(refsItem.workflowArtifactRefs ?? []))
    coveredIds.push(...(refsItem.coveredIds ?? []))
  }
  const normalizedWorkflowArtifactRefs = uniqueStrings(workflowArtifactRefs)
  if (normalizedWorkflowArtifactRefs.length > 0) merged.workflowArtifactRefs = normalizedWorkflowArtifactRefs
  const normalizedCoveredIds = uniqueStrings(coveredIds)
  if (normalizedCoveredIds.length > 0) merged.coveredIds = normalizedCoveredIds
  return normalizeRuntimeFactRefs(merged)
}

export function runtimeFactRefsFromPayload(payload: Record<string, unknown> | undefined): RuntimeFactRefs | undefined {
  if (!payload) return undefined
  const refs: RuntimeFactRefs = {}
  collectRuntimeFactRefs(payload, refs, 0)
  return normalizeRuntimeFactRefs(refs)
}

export function collectRuntimeFactsForRun(input: {
  runId: string
  runtimeEventLog?: RuntimeEventLog
  runtimeRecoveryLedger?: RuntimeRecoveryLedger
  jobs?: RuntimeFactJobLike[]
  artifacts?: RuntimeFactArtifactLike[]
}): RuntimeFactsForRun {
  const runId = input.runId.trim()
  const events = (input.runtimeEventLog?.events ?? []).filter(event => runtimeFactRefsMatchRun(event.factRefs, runId))
  const checkpoints = (input.runtimeRecoveryLedger?.checkpoints ?? [])
    .filter(checkpoint => runtimeFactRefsMatchRun(checkpoint.factRefs, runId))
  const jobs = (input.jobs ?? []).filter(job =>
    job.runId === runId || runtimeFactRefsMatchRun(job.factRefs, runId),
  )
  const artifacts = (input.artifacts ?? []).filter(artifact =>
    artifact.runId === runId || runtimeFactRefsMatchRun(artifact.factRefs, runId),
  )

  return {
    schemaVersion: 1,
    runId,
    threadIds: uniqueStrings([
      ...events.map(event => event.threadId ?? event.conversationId),
      ...checkpoints.map(checkpoint => checkpoint.threadId ?? checkpoint.conversationId),
      ...jobs.map(job => job.threadId ?? job.factRefs?.threadId),
      ...artifacts.map(artifact => artifact.threadId ?? artifact.factRefs?.threadId),
    ]),
    turnIds: uniqueStrings([
      ...events.map(event => event.turnId),
      ...checkpoints.map(checkpoint => checkpoint.turnId),
      ...jobs.map(job => job.turnId),
      ...artifacts.map(artifact => artifact.turnId),
      ...events.map(event => event.factRefs?.turnId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.turnId),
      ...jobs.map(job => job.factRefs?.turnId),
      ...artifacts.map(artifact => artifact.factRefs?.turnId),
    ]),
    taskIds: uniqueStrings([
      ...events.map(event => event.factRefs?.taskId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.taskId),
      ...jobs.map(job => job.taskId ?? job.factRefs?.taskId),
      ...artifacts.map(artifact => artifact.taskId ?? artifact.factRefs?.taskId),
    ]),
    stepIds: uniqueStrings([
      ...events.map(event => event.factRefs?.stepId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.stepId),
      ...artifacts.map(artifact => artifact.factRefs?.stepId),
    ]),
    jobIds: uniqueStrings([
      ...events.map(event => event.factRefs?.jobId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.jobId),
      ...jobs.map(job => job.jobId),
      ...artifacts.map(artifact => artifact.jobId ?? artifact.factRefs?.jobId),
    ]),
    artifactIds: uniqueStrings([
      ...events.map(event => event.factRefs?.artifactId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.artifactId),
      ...jobs.flatMap(job => (job.artifacts ?? []).map(artifact => artifact.id)),
      ...artifacts.map(artifact => artifact.id),
    ]),
    checkpointIds: uniqueStrings([
      ...events.map(event => event.checkpointId ?? event.factRefs?.checkpointId),
      ...checkpoints.map(checkpoint => checkpoint.id),
    ]),
    proofIds: uniqueStrings([
      ...events.map(event => event.factRefs?.proofId),
      ...checkpoints.map(checkpoint => checkpoint.factRefs?.proofId),
      ...artifacts.map(artifact => artifact.proofId ?? artifact.factRefs?.proofId),
    ]),
    eventIds: events.map(event => event.id),
    checkpointRecordIds: checkpoints.map(checkpoint => checkpoint.id),
    events,
    checkpoints,
    jobs,
    artifacts,
  }
}

function runtimeFactRefsMatchRun(refs: RuntimeFactRefs | undefined, runId: string): boolean {
  return Boolean(runId && refs?.runId === runId)
}

function collectRuntimeFactRefs(value: unknown, refs: RuntimeFactRefs, depth: number): void {
  if (!isRecord(value) || depth > 5) return
  readMappedFactKeys(value, refs)
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) collectRuntimeFactRefs(item, refs, depth + 1)
    } else if (isRecord(nested)) {
      collectRuntimeFactRefs(nested, refs, depth + 1)
    }
  }
}

function readMappedFactKeys(value: Record<string, unknown>, refs: RuntimeFactRefs): void {
  addRefIfMissing(refs, 'threadId', stringField(value['threadId']) ?? stringField(value['thread_id']))
  addRefIfMissing(refs, 'turnId', stringField(value['turnId']) ?? stringField(value['turn_id']) ?? stringField(value['source_turn_id']))
  addRefIfMissing(refs, 'runId', stringField(value['runId']) ?? stringField(value['run_id']))
  addRefIfMissing(refs, 'workCaseId', stringField(value['workCaseId']) ?? stringField(value['work_case_id']))
  addRefIfMissing(refs, 'evidenceContextId', stringField(value['evidenceContextId']) ?? stringField(value['evidence_context_id']))
  addRefIfMissing(refs, 'executionRunId', stringField(value['executionRunId']) ?? stringField(value['execution_run_id']))
  addRefIfMissing(refs, 'driverId', stringField(value['driverId']) ?? stringField(value['driver_id']))
  addRefIfMissing(refs, 'executionId', stringField(value['executionId']) ?? stringField(value['execution_id']))
  addRefIfMissing(refs, 'attemptId', stringField(value['attemptId']) ?? stringField(value['attempt_id']))
  addRefIfMissing(refs, 'driverSessionId', stringField(value['driverSessionId']) ?? stringField(value['driver_session_id']))
  addRefIfMissing(refs, 'workspaceRunId', stringField(value['workspaceRunId']) ?? stringField(value['workspace_run_id']))
  addRefIfMissing(refs, 'taskId', stringField(value['taskId']) ?? stringField(value['task_id']) ?? taskIdFromLongTaskId(value))
  addRefIfMissing(refs, 'stepId', stringField(value['stepId']) ?? stringField(value['step_id']))
  addRefIfMissing(refs, 'jobId', stringField(value['jobId']) ?? stringField(value['job_id']))
  addRefIfMissing(refs, 'artifactId', stringField(value['artifactId']) ?? stringField(value['artifact_id']))
  addRefIfMissing(refs, 'artifactPath', stringField(value['artifactPath']) ?? stringField(value['artifact_path']))
  addRefIfMissing(refs, 'workflowReceiptRef', stringField(value['workflowReceiptRef']) ?? stringField(value['workflow_receipt_ref']))
  addRefIfMissing(refs, 'checkpointId', stringField(value['checkpointId']) ?? stringField(value['checkpoint_id']))
  addRefIfMissing(refs, 'proofId', stringField(value['proofId']) ?? stringField(value['proof_id']))
  addRefIfMissing(refs, 'itemId', stringField(value['itemId']) ?? stringField(value['item_id']) ?? stringField(value['tool_use_id']))
  refs.workflowArtifactRefs = uniqueStrings([
    ...(refs.workflowArtifactRefs ?? []),
    ...stringArrayField(value['workflowArtifactRefs']),
    ...stringArrayField(value['workflow_artifact_refs']),
  ])
  refs.coveredIds = uniqueStrings([...(refs.coveredIds ?? []), ...stringArrayField(value['coveredIds']), ...stringArrayField(value['covered_ids'])])
}

function taskIdFromLongTaskId(value: Record<string, unknown>): string | undefined {
  const longTaskId = stringField(value['long_task_id'])
  return longTaskId?.startsWith('task:') ? longTaskId.slice('task:'.length) : undefined
}

function addRefIfMissing<K extends keyof RuntimeFactRefs>(
  refs: RuntimeFactRefs,
  key: K,
  value: RuntimeFactRefs[K] | undefined,
): void {
  if (refs[key] !== undefined) return
  addRef(refs, key, value)
}

function addRef<K extends keyof RuntimeFactRefs>(
  refs: RuntimeFactRefs,
  key: K,
  value: RuntimeFactRefs[K] | undefined,
): void {
  if (key === 'coveredIds') return
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  refs[key] = trimmed as RuntimeFactRefs[K]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'))
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))]
}
