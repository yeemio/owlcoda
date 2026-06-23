import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type JobType = 'command' | 'agent' | 'browser' | 'api' | (string & {})
export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timeout'

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
  const job: JobRecord = {
    schemaVersion: 1,
    jobId: input.jobId ?? `job-${randomUUID()}`,
    type: input.type,
    status: 'queued',
    stage: input.stage ?? 'queued',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    artifacts: input.artifacts ?? [],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.recoveryHint ? { recoveryHint: input.recoveryHint } : {}),
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
  status: Exclude<JobStatus, 'queued' | 'running' | 'waiting'>,
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
  if (details.error !== undefined) job.error = details.error
  if (details.terminationReason !== undefined) job.terminationReason = details.terminationReason
  persistJobRegistry()
  return cloneJob(job)
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
