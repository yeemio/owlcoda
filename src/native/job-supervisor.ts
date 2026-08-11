import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RuntimeFactRefs } from './protocol/types.js'
import { mergeRuntimeFactRefs } from './runtime-facts.js'

export type JobType = 'command' | 'agent' | 'browser' | 'api' | (string & {})
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'detached'
  | 'recovering'
  | 'unrecoverable'
  | 'orphaned'

export type JobTerminalStatus =
  | 'done'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'unrecoverable'
  | 'orphaned'

export type JobRecoveryClass =
  | 'not_started'
  | 'active'
  | 'terminal'
  | 'detached_process'
  | 'external_reconnect_required'
  | 'unrecoverable'
  | 'orphaned'

export interface JobStateDescriptor {
  status: JobStatus
  terminal: boolean
  canCancel: boolean
  canResume: boolean
  requiresProof: boolean
  userMessage: string
}

export const JOB_STATE_MACHINE: Record<JobStatus, JobStateDescriptor> = {
  queued: {
    status: 'queued',
    terminal: false,
    canCancel: true,
    canResume: false,
    requiresProof: false,
    userMessage: 'Job is queued and has not started.',
  },
  running: {
    status: 'running',
    terminal: false,
    canCancel: true,
    canResume: false,
    requiresProof: false,
    userMessage: 'Job is running under the current runtime.',
  },
  waiting: {
    status: 'waiting',
    terminal: false,
    canCancel: true,
    canResume: true,
    requiresProof: false,
    userMessage: 'Job is waiting for external input or runtime continuation.',
  },
  done: {
    status: 'done',
    terminal: true,
    canCancel: false,
    canResume: false,
    requiresProof: true,
    userMessage: 'Job completed successfully. Legacy status; prefer completed for new records.',
  },
  completed: {
    status: 'completed',
    terminal: true,
    canCancel: false,
    canResume: false,
    requiresProof: true,
    userMessage: 'Job completed successfully.',
  },
  failed: {
    status: 'failed',
    terminal: true,
    canCancel: false,
    canResume: true,
    requiresProof: true,
    userMessage: 'Job failed with an explicit error or non-zero outcome.',
  },
  cancelled: {
    status: 'cancelled',
    terminal: true,
    canCancel: false,
    canResume: false,
    requiresProof: true,
    userMessage: 'Job was cancelled and must carry cleanup evidence.',
  },
  timeout: {
    status: 'timeout',
    terminal: true,
    canCancel: false,
    canResume: true,
    requiresProof: true,
    userMessage: 'Job timed out; inspect output and decide whether to retry.',
  },
  detached: {
    status: 'detached',
    terminal: false,
    canCancel: true,
    canResume: true,
    requiresProof: true,
    userMessage: 'Job process appears to exist, but the current runtime no longer owns its live handle.',
  },
  recovering: {
    status: 'recovering',
    terminal: false,
    canCancel: true,
    canResume: true,
    requiresProof: false,
    userMessage: 'Job has a recovery handle or source record and needs runtime reconciliation.',
  },
  unrecoverable: {
    status: 'unrecoverable',
    terminal: true,
    canCancel: false,
    canResume: false,
    requiresProof: true,
    userMessage: 'Job cannot be safely recovered; inspect recorded output or restart explicitly.',
  },
  orphaned: {
    status: 'orphaned',
    terminal: true,
    canCancel: false,
    canResume: false,
    requiresProof: true,
    userMessage: 'Job was active but has no process, external handle, or source record to recover from.',
  },
}

export interface JobArtifactRef {
  id?: string
  path: string
  artifactType?: string
}

export interface JobRecord {
  schemaVersion: 1
  jobId: string
  type: JobType
  status: JobStatus
  stage: string
  createdAt: string
  startedAt?: string
  updatedAt: string
  endedAt?: string
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  factRefs?: RuntimeFactRefs
  cwd?: string
  command?: string
  tool?: string
  provider?: string
  pid?: number
  processGroup?: number
  externalHandle?: string
  artifacts: JobArtifactRef[]
  lastOutput?: string
  error?: string
  recoveryHint?: string
  recoveryClass?: JobRecoveryClass
  recoveryReason?: string
  recoveryUpdatedAt?: string
  resumeCommand?: string
  proofRequired?: boolean
  deadlineAt?: string
  stageDeadlineAt?: string
  terminationReason?: string
  cleanupAttempted?: boolean
  cleanupSucceeded?: boolean
  remainingPids?: number[]
  source?: {
    kind: string
    id: string
  }
}

export interface JobRegistrySnapshot {
  schemaVersion: 1
  jobs: JobRecord[]
}

export interface CreateJobInput {
  jobId?: string
  type: JobType
  stage?: string
  cwd?: string
  command?: string
  tool?: string
  provider?: string
  recoveryHint?: string
  deadlineMs?: number
  stageDeadlineMs?: number
  artifacts?: JobArtifactRef[]
  source?: JobRecord['source']
  threadId?: string
  turnId?: string
  runId?: string
  taskId?: string
  factRefs?: RuntimeFactRefs
}

export interface RuntimeRestartReconcileOptions {
  now?: string
  isProcessAlive?: (pid: number) => boolean
}

export interface JobReconciliationResult {
  jobId: string
  previousStatus: JobStatus
  status: JobStatus
  recoveryClass?: JobRecoveryClass
  action: 'unchanged' | 'detached' | 'recovering' | 'unrecoverable' | 'orphaned'
  reason: string
}

export interface ResetJobSupervisorOptions {
  clearPersisted?: boolean
}

const jobs = new Map<string, JobRecord>()
const jobAbortAdapters = new Map<string, (reason: string) => void>()
let jobStoreLoaded = false
let jobStoreWarned = false

export function createJob(input: CreateJobInput): JobRecord {
  ensureJobStoreLoaded()
  const now = new Date()
  const jobId = input.jobId ?? `job-${randomUUID()}`
  const sourceTaskId = input.source?.kind === 'task' ? input.source.id : undefined
  const factRefs = mergeRuntimeFactRefs(input.factRefs, {
    threadId: input.threadId,
    turnId: input.turnId,
    runId: input.runId,
    taskId: input.taskId ?? sourceTaskId,
    jobId,
  })
  const job: JobRecord = {
    schemaVersion: 1,
    jobId,
    type: input.type,
    status: 'queued',
    stage: input.stage ?? 'queued',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    artifacts: input.artifacts ?? [],
    ...(factRefs?.threadId ? { threadId: factRefs.threadId } : {}),
    ...(factRefs?.turnId ? { turnId: factRefs.turnId } : {}),
    ...(factRefs?.runId ? { runId: factRefs.runId } : {}),
    ...(factRefs?.taskId ? { taskId: factRefs.taskId } : {}),
    ...(factRefs ? { factRefs } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.recoveryHint ? { recoveryHint: input.recoveryHint } : {}),
    recoveryClass: 'not_started',
    proofRequired: false,
    ...(input.deadlineMs && input.deadlineMs > 0 ? { deadlineAt: new Date(now.getTime() + input.deadlineMs).toISOString() } : {}),
    ...(input.stageDeadlineMs && input.stageDeadlineMs > 0 ? { stageDeadlineAt: new Date(now.getTime() + input.stageDeadlineMs).toISOString() } : {}),
    ...(input.source ? { source: input.source } : {}),
  }
  jobs.set(job.jobId, job)
  persistJobRegistry()
  return cloneJob(job)
}

export function startJob(
  jobId: string,
  details: { pid?: number; processGroup?: number; externalHandle?: string; stage?: string } = {},
): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  const now = new Date().toISOString()
  job.status = 'running'
  job.stage = details.stage ?? 'running'
  job.startedAt = job.startedAt ?? now
  job.updatedAt = now
  job.recoveryClass = 'active'
  delete job.recoveryReason
  job.recoveryUpdatedAt = now
  job.proofRequired = false
  if (details.pid !== undefined) job.pid = details.pid
  if (details.processGroup !== undefined) job.processGroup = details.processGroup
  if (details.externalHandle !== undefined) job.externalHandle = details.externalHandle
  persistJobRegistry()
  return cloneJob(job)
}

export function appendJobOutput(jobId: string, output: string, maxChars = 2000): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  const next = `${job.lastOutput ?? ''}${output}`
  job.lastOutput = next.length > maxChars ? next.slice(next.length - maxChars) : next
  job.updatedAt = new Date().toISOString()
  persistJobRegistry()
  return cloneJob(job)
}

export function mergeJobFactRefs(jobId: string, factRefs: RuntimeFactRefs): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  const mergedFactRefs = mergeRuntimeFactRefs(job.factRefs, factRefs, { jobId })
  if (!mergedFactRefs) return cloneJob(job)
  job.factRefs = mergedFactRefs
  if (mergedFactRefs.threadId) job.threadId = mergedFactRefs.threadId
  if (mergedFactRefs.turnId) job.turnId = mergedFactRefs.turnId
  if (mergedFactRefs.runId) job.runId = mergedFactRefs.runId
  if (mergedFactRefs.taskId) job.taskId = mergedFactRefs.taskId
  job.updatedAt = new Date().toISOString()
  persistJobRegistry()
  return cloneJob(job)
}

export function addJobArtifacts(jobId: string, artifacts: JobArtifactRef[]): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  job.artifacts.push(...artifacts.map(artifact => ({ ...artifact })))
  job.updatedAt = new Date().toISOString()
  persistJobRegistry()
  return cloneJob(job)
}

export function finishJob(
  jobId: string,
  status: JobTerminalStatus,
  details: {
    stage?: string
    error?: string
    terminationReason?: string
  } = {},
): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  const now = new Date().toISOString()
  if (job.status === 'cancelled' && status !== 'cancelled') {
    job.updatedAt = now
    persistJobRegistry()
    return cloneJob(job)
  }
  job.status = status
  job.stage = details.stage ?? status
  job.updatedAt = now
  job.endedAt = now
  job.recoveryClass = status === 'unrecoverable' ? 'unrecoverable' : status === 'orphaned' ? 'orphaned' : 'terminal'
  job.recoveryUpdatedAt = now
  job.proofRequired = getJobStateDescriptor(status).requiresProof
  if (details.error !== undefined) job.error = details.error
  if (details.terminationReason !== undefined) {
    job.terminationReason = details.terminationReason
    job.recoveryReason = details.terminationReason
  }
  persistJobRegistry()
  return cloneJob(job)
}

export function markJobDetached(
  jobId: string,
  details: {
    reason: string
    updatedAt?: string
    recoveryHint?: string
    resumeCommand?: string
  },
): JobRecord | undefined {
  return updateJobRecoveryState(jobId, {
    status: 'detached',
    recoveryClass: 'detached_process',
    stage: 'detached',
    reason: details.reason,
    updatedAt: details.updatedAt,
    recoveryHint: details.recoveryHint,
    resumeCommand: details.resumeCommand,
  })
}

export function markJobRecovering(
  jobId: string,
  details: {
    reason: string
    updatedAt?: string
    recoveryHint?: string
    resumeCommand?: string
  },
): JobRecord | undefined {
  return updateJobRecoveryState(jobId, {
    status: 'recovering',
    recoveryClass: 'external_reconnect_required',
    stage: 'recovering',
    reason: details.reason,
    updatedAt: details.updatedAt,
    recoveryHint: details.recoveryHint,
    resumeCommand: details.resumeCommand,
  })
}

export function markJobUnrecoverable(
  jobId: string,
  details: {
    reason: string
    updatedAt?: string
    error?: string
  },
): JobRecord | undefined {
  return updateJobRecoveryState(jobId, {
    status: 'unrecoverable',
    recoveryClass: 'unrecoverable',
    stage: 'unrecoverable',
    reason: details.reason,
    updatedAt: details.updatedAt,
    error: details.error,
  })
}

export function markJobOrphaned(
  jobId: string,
  details: {
    reason: string
    updatedAt?: string
  },
): JobRecord | undefined {
  return updateJobRecoveryState(jobId, {
    status: 'orphaned',
    recoveryClass: 'orphaned',
    stage: 'orphaned',
    reason: details.reason,
    updatedAt: details.updatedAt,
  })
}

export function reconcileJobsAfterRuntimeRestart(
  options: RuntimeRestartReconcileOptions = {},
): JobReconciliationResult[] {
  ensureJobStoreLoaded()
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const results: JobReconciliationResult[] = []
  for (const job of jobs.values()) {
    if (!isRestartReconciliationCandidate(job.status)) {
      results.push({
        jobId: job.jobId,
        previousStatus: job.status,
        status: job.status,
        recoveryClass: job.recoveryClass,
        action: 'unchanged',
        reason: 'job status is not active across restart',
      })
      continue
    }

    const previousStatus = job.status
    let updated: JobRecord | undefined
    let action: JobReconciliationResult['action'] = 'unchanged'
    let reason = ''

    if (job.pid !== undefined) {
      if (isProcessAlive(job.pid)) {
        action = 'detached'
        reason = `Runtime restarted while pid ${job.pid} still appears alive; live abort/output adapters are not bound.`
        updated = markJobDetached(job.jobId, {
          reason,
          updatedAt: options.now,
          recoveryHint: job.recoveryHint,
          resumeCommand: job.recoveryHint,
        })
      } else {
        action = 'unrecoverable'
        reason = `Runtime restarted and pid ${job.pid} is no longer alive.`
        updated = markJobUnrecoverable(job.jobId, {
          reason,
          updatedAt: options.now,
        })
      }
    } else if (job.externalHandle || job.source) {
      action = 'recovering'
      reason = job.externalHandle
        ? `Runtime restarted with external handle ${job.externalHandle}; provider-specific reconciliation is required.`
        : `Runtime restarted with source ${job.source?.kind}:${job.source?.id}; inspect the source to reconcile status.`
      updated = markJobRecovering(job.jobId, {
        reason,
        updatedAt: options.now,
        recoveryHint: job.recoveryHint,
        resumeCommand: job.recoveryHint,
      })
    } else {
      action = 'orphaned'
      reason = 'Runtime restarted while job was active, but no pid, external handle, or source record is available.'
      updated = markJobOrphaned(job.jobId, {
        reason,
        updatedAt: options.now,
      })
    }

    results.push({
      jobId: job.jobId,
      previousStatus,
      status: updated?.status ?? job.status,
      recoveryClass: updated?.recoveryClass ?? job.recoveryClass,
      action,
      reason,
    })
  }
  return results
}

export function recordJobCleanup(
  jobId: string,
  details: {
    attempted: boolean
    succeeded: boolean
    remainingPids?: number[]
  },
): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  job.cleanupAttempted = details.attempted
  job.cleanupSucceeded = details.succeeded
  job.remainingPids = details.remainingPids ?? []
  job.updatedAt = new Date().toISOString()
  persistJobRegistry()
  return cloneJob(job)
}

export function getJob(jobId: string | undefined): JobRecord | undefined {
  ensureJobStoreLoaded()
  if (!jobId) return undefined
  const job = jobs.get(jobId)
  return job ? cloneJob(job) : undefined
}

export function listJobs(): JobRecord[] {
  ensureJobStoreLoaded()
  return [...jobs.values()].map(cloneJob)
}

export function snapshotJobRegistry(sourceIds?: Set<string>): JobRegistrySnapshot {
  ensureJobStoreLoaded()
  const selected = [...jobs.values()]
    .filter((job) => !sourceIds || !job.source || sourceIds.has(job.source.id))
    .map(cloneJob)
  return {
    schemaVersion: 1,
    jobs: selected,
  }
}

export function restoreJobRegistry(snapshot: JobRegistrySnapshot | null | undefined): void {
  jobs.clear()
  jobAbortAdapters.clear()
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.jobs)) return
  for (const job of snapshot.jobs) {
    if (!job || typeof job.jobId !== 'string') continue
    jobs.set(job.jobId, cloneJob(job))
  }
  jobStoreLoaded = true
  persistJobRegistry()
}

export function resetJobSupervisor(options: ResetJobSupervisorOptions = {}): void {
  jobs.clear()
  jobAbortAdapters.clear()
  jobStoreLoaded = false
  if (options.clearPersisted) {
    clearPersistedJobRegistry()
  }
}

export function registerJobAbortAdapter(jobId: string, abort: (reason: string) => void): void {
  jobAbortAdapters.set(jobId, abort)
}

export function unregisterJobAbortAdapter(jobId: string): void {
  jobAbortAdapters.delete(jobId)
}

export function abortJob(jobId: string, reason = 'user_cancel'): boolean {
  const abort = jobAbortAdapters.get(jobId)
  if (!abort) return false
  abort(reason)
  return true
}

export function getJobStateDescriptor(status: JobStatus): JobStateDescriptor {
  return JOB_STATE_MACHINE[status]
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return getJobStateDescriptor(status).terminal
}

function updateJobRecoveryState(
  jobId: string,
  details: {
    status: JobStatus
    recoveryClass: JobRecoveryClass
    stage: string
    reason: string
    updatedAt?: string
    recoveryHint?: string
    resumeCommand?: string
    error?: string
  },
): JobRecord | undefined {
  ensureJobStoreLoaded()
  const job = jobs.get(jobId)
  if (!job) return undefined
  const now = details.updatedAt ?? new Date().toISOString()
  job.status = details.status
  job.stage = details.stage
  job.updatedAt = now
  job.recoveryClass = details.recoveryClass
  job.recoveryReason = details.reason
  job.recoveryUpdatedAt = now
  job.proofRequired = getJobStateDescriptor(details.status).requiresProof
  if (details.recoveryHint !== undefined) job.recoveryHint = details.recoveryHint
  if (details.resumeCommand !== undefined) job.resumeCommand = details.resumeCommand
  if (details.error !== undefined) job.error = details.error
  if (getJobStateDescriptor(details.status).terminal) {
    job.endedAt = job.endedAt ?? now
    job.terminationReason = job.terminationReason ?? details.reason
  }
  persistJobRegistry()
  return cloneJob(job)
}

function isRestartReconciliationCandidate(status: JobStatus): boolean {
  return status === 'queued'
    || status === 'running'
    || status === 'waiting'
    || status === 'detached'
    || status === 'recovering'
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined
    return code === 'EPERM'
  }
}

function cloneJob(job: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(job)) as JobRecord
}

function ensureJobStoreLoaded(): void {
  if (jobStoreLoaded || !isJobStoreEnabled()) return
  jobStoreLoaded = true
  const path = resolveJobStorePath()
  if (!existsSync(path)) return
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as JobRegistrySnapshot
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.jobs)) return
    jobs.clear()
    for (const job of snapshot.jobs) {
      if (!job || typeof job.jobId !== 'string') continue
      jobs.set(job.jobId, cloneJob(job))
    }
  } catch (err) {
    warnJobStore(`could not load job registry ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function persistJobRegistry(): void {
  if (!isJobStoreEnabled()) return
  const path = resolveJobStorePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tempPath = `${path}.tmp-${process.pid}`
    const snapshot: JobRegistrySnapshot = {
      schemaVersion: 1,
      jobs: [...jobs.values()].map(cloneJob),
    }
    writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8')
    renameSync(tempPath, path)
  } catch (err) {
    warnJobStore(`could not persist job registry ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function clearPersistedJobRegistry(): void {
  if (!isJobStoreEnabled()) return
  try {
    rmSync(resolveJobStorePath(), { force: true })
  } catch {
    // Best-effort cleanup for tests and explicit maintenance.
  }
}

function isJobStoreEnabled(): boolean {
  if (process.env['OWLCODA_JOB_STORE'] === '0') return false
  if (process.env['OWLCODA_JOB_STORE_PATH']) return true
  if (process.env['VITEST_WORKER_ID']) return false
  return true
}

function resolveJobStorePath(): string {
  const explicit = process.env['OWLCODA_JOB_STORE_PATH']
  if (explicit?.trim()) return explicit
  const root = process.env['OWLCODA_HOME']?.trim() || join(homedir(), '.owlcoda')
  return join(root, 'jobs.json')
}

function warnJobStore(message: string): void {
  if (jobStoreWarned) return
  jobStoreWarned = true
  console.error(`[owlcoda] job supervisor store disabled for this process: ${message}`)
}
