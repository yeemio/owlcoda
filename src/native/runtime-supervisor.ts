import type { LongTaskProcessIdentity, LongTaskSnapshot } from './long-task-lifecycle.js'
import {
  forgetRunLifecycleSnapshotsByKind,
  recordRunLifecycleSnapshot,
  type RunLifecycleStatus,
  type RunRecoveryPolicy,
} from './run-lifecycle.js'

export type RuntimeSupervisorProcessStatus =
  | 'running'
  | 'incomplete'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'

export interface RuntimeSupervisorEvidence {
  last_progress?: string
  last_output_summary?: string
  terminal_summary?: string
  timeout_kind?: string
}

export interface RuntimeSupervisorProcessSnapshot {
  processId: string
  runId: string
  status: RuntimeSupervisorProcessStatus
  objective: string
  command: string
  cwd?: string
  conversationId?: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  inspectCommand: string
  processIdentity?: LongTaskProcessIdentity
  recoveryPolicy: RunRecoveryPolicy
  evidence?: RuntimeSupervisorEvidence
}

export interface RuntimeSupervisorListOptions {
  limit?: number
  conversationId?: string
}

const MAX_RUNTIME_SUPERVISOR_PROCESSES = 100
const supervisorProcesses = new Map<string, RuntimeSupervisorProcessSnapshot>()

export function recordRuntimeSupervisorProcess(
  snapshot: Omit<RuntimeSupervisorProcessSnapshot, 'updatedAt' | 'recoveryPolicy'> & {
    updatedAt?: string
    recoveryPolicy?: RunRecoveryPolicy
  },
): RuntimeSupervisorProcessSnapshot {
  const now = new Date().toISOString()
  const existing = supervisorProcesses.get(snapshot.processId)
  const merged: RuntimeSupervisorProcessSnapshot = {
    ...existing,
    ...snapshot,
    startedAt: snapshot.startedAt ?? existing?.startedAt ?? now,
    updatedAt: snapshot.updatedAt ?? now,
    recoveryPolicy: snapshot.recoveryPolicy ?? existing?.recoveryPolicy ?? runtimeSupervisorRecoveryPolicy(snapshot.status, snapshot.inspectCommand),
    ...(existing?.evidence || snapshot.evidence
      ? { evidence: { ...existing?.evidence, ...snapshot.evidence } }
      : {}),
  }

  if (!supervisorProcesses.has(merged.processId) && supervisorProcesses.size >= MAX_RUNTIME_SUPERVISOR_PROCESSES) {
    const oldest = supervisorProcesses.keys().next().value
    if (oldest) supervisorProcesses.delete(oldest)
  }
  supervisorProcesses.set(merged.processId, merged)
  mirrorRuntimeSupervisorProcessToRunLifecycle(merged)
  return merged
}

export function recordRuntimeSupervisorProcessFromLongTaskSnapshot(
  snapshot: LongTaskSnapshot,
): RuntimeSupervisorProcessSnapshot | undefined {
  if (snapshot.source !== 'task_command' || !snapshot.taskId || !snapshot.command) return undefined
  return recordRuntimeSupervisorProcess({
    processId: `process:${snapshot.taskId}`,
    runId: snapshot.longTaskId,
    status: mapLongTaskStatusToSupervisorStatus(snapshot.status),
    objective: snapshot.objective,
    command: snapshot.command,
    ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
    inspectCommand: snapshot.inspectCommand,
    ...(snapshot.processIdentity ? { processIdentity: snapshot.processIdentity } : {}),
    recoveryPolicy: runtimeSupervisorRecoveryPolicy(mapLongTaskStatusToSupervisorStatus(snapshot.status), snapshot.inspectCommand),
    evidence: {
      ...(snapshot.lastProgress ? { last_progress: snapshot.lastProgress } : {}),
      ...(snapshot.outputSnippet ? { last_output_summary: snapshot.outputSnippet } : {}),
      ...(snapshot.timeoutKind ? { timeout_kind: snapshot.timeoutKind } : {}),
    },
  })
}

export function getRuntimeSupervisorProcess(processId: string): RuntimeSupervisorProcessSnapshot | undefined {
  return supervisorProcesses.get(processId)
}

export function recentRuntimeSupervisorProcesses(
  options: RuntimeSupervisorListOptions = {},
): RuntimeSupervisorProcessSnapshot[] {
  const limit = parsePositiveLimit(options.limit, 20)
  return [...supervisorProcesses.values()]
    .filter((snapshot) => !options.conversationId || snapshot.conversationId === options.conversationId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

export function forgetRuntimeSupervisorProcessesByRunPrefix(prefix: string): void {
  for (const [processId, snapshot] of supervisorProcesses) {
    if (snapshot.runId.startsWith(prefix)) supervisorProcesses.delete(processId)
  }
  forgetRunLifecycleSnapshotsByKind('supervisor_process')
}

export function resetRuntimeSupervisorForTesting(): void {
  supervisorProcesses.clear()
  forgetRunLifecycleSnapshotsByKind('supervisor_process')
}

export function formatRuntimeSupervisorProcessSummary(snapshot: RuntimeSupervisorProcessSnapshot): string {
  const fields = [
    snapshot.processId,
    `run=${snapshot.runId}`,
    `status=${snapshot.status}`,
    `objective="${compactSupervisorText(snapshot.objective, 80)}"`,
  ]
  if (snapshot.processIdentity) fields.push(`pid=${snapshot.processIdentity.pid}`)
  if (snapshot.recoveryPolicy) fields.push(`recovery=${snapshot.recoveryPolicy.strategy}`)
  return fields.join(' ')
}

export function formatRuntimeSupervisorProcessDetail(snapshot: RuntimeSupervisorProcessSnapshot): string {
  const lines = [
    `Runtime supervisor process ${snapshot.processId}`,
    `run=${snapshot.runId}`,
    `status=${snapshot.status}`,
    `objective=${snapshot.objective}`,
    `command=${snapshot.command}`,
    `startedAt=${snapshot.startedAt}`,
    `updatedAt=${snapshot.updatedAt}`,
  ]
  if (snapshot.finishedAt) lines.push(`finishedAt=${snapshot.finishedAt}`)
  if (snapshot.cwd) lines.push(`cwd=${snapshot.cwd}`)
  if (snapshot.conversationId) lines.push(`conversationId=${snapshot.conversationId}`)
  if (snapshot.processIdentity) {
    lines.push(`ProcessIdentity: pid=${snapshot.processIdentity.pid} cwd=${snapshot.processIdentity.cwd} spawnedAt=${snapshot.processIdentity.spawnedAt}`)
  }
  lines.push(`Inspect: ${snapshot.inspectCommand}`)
  lines.push(`Recovery: strategy=${snapshot.recoveryPolicy.strategy} next="${snapshot.recoveryPolicy.next_command}" reason=${snapshot.recoveryPolicy.reason}`)
  if (snapshot.evidence?.timeout_kind) lines.push(`timeoutKind=${snapshot.evidence.timeout_kind}`)
  if (snapshot.evidence?.last_progress) lines.push(`lastProgress=${snapshot.evidence.last_progress}`)
  if (snapshot.evidence?.last_output_summary) lines.push(`lastOutput=${snapshot.evidence.last_output_summary}`)
  return lines.join('\n')
}

function mirrorRuntimeSupervisorProcessToRunLifecycle(snapshot: RuntimeSupervisorProcessSnapshot): void {
  recordRunLifecycleSnapshot({
    runId: snapshot.processId,
    kind: 'supervisor_process',
    status: mapSupervisorStatusToRunStatus(snapshot.status),
    objective: snapshot.objective,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
    owner: 'runtime_supervisor',
    parentRunId: snapshot.runId,
    inspectCommand: snapshot.inspectCommand,
    recoveryPolicy: snapshot.recoveryPolicy,
    evidence: {
      ...(snapshot.evidence?.last_progress ? { last_progress: snapshot.evidence.last_progress } : {}),
      ...(snapshot.evidence?.last_output_summary ? { last_output_summary: snapshot.evidence.last_output_summary } : {}),
      ...(snapshot.evidence?.terminal_summary ? { terminal_summary: snapshot.evidence.terminal_summary } : {}),
      ...(snapshot.evidence?.timeout_kind ? { timeout_kind: snapshot.evidence.timeout_kind } : {}),
      ...(snapshot.processIdentity ? { pid: String(snapshot.processIdentity.pid) } : {}),
    },
  })
}

function mapLongTaskStatusToSupervisorStatus(status: LongTaskSnapshot['status']): RuntimeSupervisorProcessStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'timeout') return 'timeout'
  if (status === 'incomplete' || status === 'partial' || status === 'inferred') return 'incomplete'
  return 'running'
}

function mapSupervisorStatusToRunStatus(status: RuntimeSupervisorProcessStatus): RunLifecycleStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'timeout') return 'timeout'
  if (status === 'incomplete') return 'incomplete'
  return 'running'
}

function runtimeSupervisorRecoveryPolicy(
  status: RuntimeSupervisorProcessStatus,
  inspectCommand: string,
): RunRecoveryPolicy {
  if (status === 'running') {
    return {
      schema_version: 1,
      strategy: 'runtime_await',
      next_command: inspectCommand,
      reason: 'Runtime supervisor has a live process identity or task handle; inspect or use bounded runtime await instead of polling manually.',
    }
  }
  if (status === 'incomplete' || status === 'timeout') {
    return {
      schema_version: 1,
      strategy: 'inspect_process_before_replace',
      next_command: inspectCommand,
      reason: 'Runtime no longer has a waitable handle. Inspect saved output and process identity before replacing or retrying work.',
    }
  }
  return {
    schema_version: 1,
    strategy: 'report_terminal',
    next_command: inspectCommand,
    reason: 'Process is terminal; report saved terminal evidence instead of waiting.',
  }
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), MAX_RUNTIME_SUPERVISOR_PROCESSES)
}

function compactSupervisorText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}
