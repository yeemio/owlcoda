import {
  abortJob,
  finishJob,
  getJob,
  listJobs,
  recordJobCleanup,
  type JobRecord,
  type JobStatus,
  type JobType,
} from '../job-supervisor.js'
import { stopTask } from './task-store.js'
import type { NativeToolDef, ToolResult } from './types.js'

export interface JobListInput {
  limit?: number
  status?: JobStatus | string
  type?: JobType | string
}

export interface JobGetInput {
  jobId: string
}

export interface JobCancelInput {
  jobId: string
  reason?: string
}

export interface JobSuggestedAction {
  kind: 'read_output' | 'cancel' | 'recover' | 'open_artifact'
  label: string
  command?: string
  path?: string
  reason?: string
}

const DEFAULT_JOB_LIMIT = 20
const MAX_JOB_LIMIT = 50

export function createJobListTool(): NativeToolDef<JobListInput> {
  return {
    name: 'JobList',
    description:
      'Read-only inspection of platform job supervisor records. ' +
      'This reports job identity, status, process identity, deadlines, cleanup evidence, and recovery hints; it does not wait, cancel, resume, or mutate jobs.',
    maturity: 'beta' as const,
    async execute(input: JobListInput = {}): Promise<ToolResult> {
      const limit = parsePositiveLimit(input.limit, DEFAULT_JOB_LIMIT)
      const filters = jobFilters(input)
      const jobs = listJobs()
        .filter((job) => !filters.status || job.status === filters.status)
        .filter((job) => !filters.type || job.type === filters.type)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)

      if (jobs.length === 0) {
        return {
          output: filters.status || filters.type
            ? 'No platform job records match the filters.'
            : 'No platform job records are available.',
          isError: false,
          metadata: {
            jobs: [],
            count: 0,
            ...(Object.keys(filters).length > 0 ? { filters } : {}),
          },
        }
      }

      return {
        output: jobs.map(formatJobSummary).join('\n'),
        isError: false,
        metadata: {
          jobs,
          count: jobs.length,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
        },
      }
    },
  }
}

export function createJobGetTool(): NativeToolDef<JobGetInput> {
  return {
    name: 'JobGet',
    description:
      'Read one platform job supervisor record by jobId. Read-only; this does not wait, cancel, resume, or mutate the job.',
    maturity: 'beta' as const,
    async execute(input: JobGetInput): Promise<ToolResult> {
      const jobId = typeof input?.jobId === 'string' ? input.jobId.trim() : ''
      if (!jobId) return { output: 'jobId is required.', isError: true }

      const job = getJob(jobId)
      if (!job) {
        return {
          output: `Platform job "${jobId}" not found.`,
          isError: true,
          metadata: { jobId },
        }
      }

      const actions = suggestedJobActions(job)
      return {
        output: formatJobDetail(job, actions),
        isError: false,
        metadata: { job, actions },
      }
    },
  }
}

export function createJobCancelTool(): NativeToolDef<JobCancelInput> {
  return {
    name: 'JobCancel',
    description:
      'Cancel one platform job supervisor record. Command-backed TaskCreate jobs are routed through TaskStop-style cleanup; ' +
      'jobs without a live cancel adapter are marked cancelled with explicit cleanup evidence and are not claimed to have killed an external process.',
    maturity: 'beta' as const,
    async execute(input: JobCancelInput): Promise<ToolResult> {
      const jobId = typeof input?.jobId === 'string' ? input.jobId.trim() : ''
      if (!jobId) return { output: 'jobId is required.', isError: true }

      const job = getJob(jobId)
      if (!job) {
        return {
          output: `Platform job "${jobId}" not found.`,
          isError: true,
          metadata: { jobId },
        }
      }
      if (isTerminalJobStatus(job.status)) {
        return {
          output: `Platform job ${jobId} is already terminal (${job.status}); no cancellation was applied.`,
          isError: false,
          metadata: { job, alreadyTerminal: true },
        }
      }

      const reason = normalizeOptionalString(input.reason) ?? 'user_cancel'
      if (job.type === 'command' && job.source?.kind === 'task') {
        const task = stopTask(job.source.id)
        const updatedJob = getJob(jobId) ?? job
        if (!task) {
          cancelSupervisorOnlyJob(jobId, reason, false, false)
          return {
            output: `Cancelled platform job ${jobId}; source task ${job.source.id} was not available, so only the supervisor record was updated.`,
            isError: false,
            metadata: { job: getJob(jobId), cancelledVia: 'supervisor_record', sourceTaskMissing: true },
          }
        }
        return {
          output: `Cancelled platform job ${jobId} via TaskStop cleanup path.`,
          isError: false,
          metadata: { job: updatedJob, task, cancelledVia: 'TaskStop' },
        }
      }

      const liveCancelAdapter = abortJob(jobId, reason)
      const updatedJob = cancelSupervisorOnlyJob(jobId, reason, liveCancelAdapter, liveCancelAdapter)
      return {
        output: liveCancelAdapter
          ? `Cancelled platform job ${jobId}; live cancel adapter was signalled for type=${job.type}.`
          : `Cancelled platform job ${jobId}; no live cancel adapter is registered for type=${job.type}.`,
        isError: false,
        metadata: { job: updatedJob, cancelledVia: 'supervisor_record', liveCancelAdapter },
      }
    },
  }
}

function cancelSupervisorOnlyJob(
  jobId: string,
  reason: string,
  cleanupAttempted: boolean,
  cleanupSucceeded: boolean,
): JobRecord | undefined {
  finishJob(jobId, 'cancelled', {
    stage: 'cancelled',
    terminationReason: reason,
  })
  recordJobCleanup(jobId, {
    attempted: cleanupAttempted,
    succeeded: cleanupSucceeded,
    remainingPids: [],
  })
  return getJob(jobId)
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'timeout'
}

function jobFilters(input: JobListInput): { status?: string; type?: string } {
  return {
    ...(normalizeOptionalString(input.status) ? { status: normalizeOptionalString(input.status)! } : {}),
    ...(normalizeOptionalString(input.type) ? { type: normalizeOptionalString(input.type)! } : {}),
  }
}

function formatJobSummary(job: JobRecord): string {
  const parts = [
    job.jobId,
    `type=${job.type}`,
    `status=${job.status}`,
    `stage=${job.stage}`,
    `updated=${job.updatedAt}`,
  ]
  if (job.pid !== undefined) parts.push(`pid=${job.pid}`)
  if (job.source) parts.push(`source=${job.source.kind}:${job.source.id}`)
  if (job.recoveryHint) parts.push(`recovery=${job.recoveryHint}`)
  return parts.join(' ')
}

function formatJobDetail(job: JobRecord, actions: JobSuggestedAction[] = []): string {
  const lines = [
    `ID: ${job.jobId}`,
    `Type: ${job.type}`,
    `Status: ${job.status}`,
    `Stage: ${job.stage}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
  ]
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`)
  if (job.endedAt) lines.push(`Ended: ${job.endedAt}`)
  if (job.cwd) lines.push(`Cwd: ${job.cwd}`)
  if (job.command) lines.push(`Command: ${job.command}`)
  if (job.tool) lines.push(`Tool: ${job.tool}`)
  if (job.provider) lines.push(`Provider: ${job.provider}`)
  if (job.pid !== undefined) lines.push(`PID: ${job.pid}`)
  if (job.processGroup !== undefined) lines.push(`ProcessGroup: ${job.processGroup}`)
  if (job.externalHandle) lines.push(`ExternalHandle: ${job.externalHandle}`)
  if (job.deadlineAt) lines.push(`Deadline: ${job.deadlineAt}`)
  if (job.stageDeadlineAt) lines.push(`StageDeadline: ${job.stageDeadlineAt}`)
  if (job.terminationReason) lines.push(`TerminationReason: ${job.terminationReason}`)
  if (job.cleanupAttempted !== undefined) lines.push(`CleanupAttempted: ${job.cleanupAttempted}`)
  if (job.cleanupSucceeded !== undefined) lines.push(`CleanupSucceeded: ${job.cleanupSucceeded}`)
  if (job.remainingPids !== undefined) lines.push(`RemainingPids: ${job.remainingPids.join(',')}`)
  if (job.source) lines.push(`Source: ${job.source.kind}:${job.source.id}`)
  if (job.recoveryHint) lines.push(`Recovery: ${job.recoveryHint}`)
  if (job.error) lines.push(`Error: ${job.error}`)
  if (job.lastOutput) {
    lines.push('Last output:')
    lines.push(job.lastOutput)
  }
  if (job.artifacts.length > 0) {
    lines.push('Artifacts:')
    for (const artifact of job.artifacts) {
      lines.push(`  - ${artifact.path}${artifact.artifactType ? ` (${artifact.artifactType})` : ''}`)
    }
  }
  if (actions.length > 0) {
    lines.push('Suggested actions:')
    for (const action of actions) {
      const commandOrPath = action.command ? `: ${action.command}` : action.path ? `: ${action.path}` : ''
      const reason = action.reason ? ` (${action.reason})` : ''
      lines.push(`  - ${action.label}${commandOrPath}${reason}`)
    }
  }
  return lines.join('\n')
}

function suggestedJobActions(job: JobRecord): JobSuggestedAction[] {
  const actions: JobSuggestedAction[] = []
  const seenCommands = new Set<string>()

  if (job.type === 'command' && job.source?.kind === 'task') {
    addCommandAction(actions, seenCommands, {
      kind: 'read_output',
      label: 'Read command output',
      command: `TaskOutput task_id=${job.source.id} block=false`,
      reason: 'command-backed task output is tracked by TaskOutput',
    })
  }

  if (job.status === 'queued' || job.status === 'running' || job.status === 'waiting') {
    addCommandAction(actions, seenCommands, {
      kind: 'cancel',
      label: 'Cancel job',
      command: `JobCancel jobId=${job.jobId}`,
      reason: job.type === 'command'
        ? 'routes through TaskStop cleanup when possible'
        : 'marks supervisor state unless a live adapter exists',
    })
  }

  if (job.recoveryHint) {
    addCommandAction(actions, seenCommands, {
      kind: 'recover',
      label: 'Inspect recovery hint',
      command: job.recoveryHint,
    })
  }

  for (const artifact of job.artifacts.slice(0, 5)) {
    actions.push({
      kind: 'open_artifact',
      label: artifact.artifactType ? `Open artifact (${artifact.artifactType})` : 'Open artifact',
      path: artifact.path,
    })
  }

  return actions
}

function addCommandAction(
  actions: JobSuggestedAction[],
  seenCommands: Set<string>,
  action: JobSuggestedAction & { command: string },
): void {
  if (seenCommands.has(action.command)) return
  seenCommands.add(action.command)
  actions.push(action)
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded <= 0) return fallback
  return Math.min(rounded, MAX_JOB_LIMIT)
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
