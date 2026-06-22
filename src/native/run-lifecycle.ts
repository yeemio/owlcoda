export type RunLifecycleKind =
  | 'task_command'
  | 'agent_run'
  | 'supervisor_process'
  | 'mailbox_message'
  | 'runtime_checkpoint'

export type RunLifecycleStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'timeout'
  | 'incomplete'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface RunRecoveryPolicy {
  schema_version: 1
  strategy: string
  next_command: string
  reason: string
}

export interface RunLifecycleEvidence {
  last_progress?: string
  last_output_summary?: string
  terminal_summary?: string
  timeout_kind?: string
  [key: string]: string | undefined
}

export interface RunLifecycleSnapshot {
  runId: string
  kind: RunLifecycleKind
  status: RunLifecycleStatus
  objective: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  owner: string
  parentRunId?: string
  inspectCommand: string
  recoveryPolicy?: RunRecoveryPolicy
  evidence?: RunLifecycleEvidence
}

export interface RunLifecycleCheckpointPayload {
  schema_version: 1
  kind: 'run_lifecycle_checkpoint'
  generated_at: string
  runs: RunLifecycleCheckpointEntry[]
}

export interface RunLifecycleCheckpointEntry {
  run_id: string
  kind: RunLifecycleKind
  status: RunLifecycleStatus
  objective: string
  started_at: string
  updated_at: string
  owner: string
  inspect_command: string
  finished_at?: string
  parent_run_id?: string
  recovery_policy?: RunRecoveryPolicy
  evidence?: RunLifecycleEvidence
}

const MAX_RUN_LIFECYCLE_SNAPSHOTS = 100
const runLifecycleSnapshots = new Map<string, RunLifecycleSnapshot>()

export function recordRunLifecycleSnapshot(
  snapshot: Omit<RunLifecycleSnapshot, 'updatedAt'> & { updatedAt?: string },
): RunLifecycleSnapshot {
  const now = new Date().toISOString()
  const existing = runLifecycleSnapshots.get(snapshot.runId)
  const merged: RunLifecycleSnapshot = {
    ...existing,
    ...snapshot,
    startedAt: snapshot.startedAt ?? existing?.startedAt ?? now,
    updatedAt: snapshot.updatedAt ?? now,
    ...(existing?.evidence || snapshot.evidence
      ? { evidence: { ...existing?.evidence, ...snapshot.evidence } }
      : {}),
  }

  if (!runLifecycleSnapshots.has(merged.runId) && runLifecycleSnapshots.size >= MAX_RUN_LIFECYCLE_SNAPSHOTS) {
    const oldest = runLifecycleSnapshots.keys().next().value
    if (oldest) runLifecycleSnapshots.delete(oldest)
  }
  runLifecycleSnapshots.set(merged.runId, merged)
  return merged
}

export function transitionRunLifecycleSnapshot(
  runId: string,
  updates: Partial<Omit<RunLifecycleSnapshot, 'runId' | 'kind' | 'objective' | 'startedAt' | 'owner' | 'inspectCommand'>>,
): RunLifecycleSnapshot | undefined {
  const existing = runLifecycleSnapshots.get(runId)
  if (!existing) return undefined
  return recordRunLifecycleSnapshot({
    ...existing,
    ...updates,
    evidence: { ...existing.evidence, ...updates.evidence },
  })
}

export function getRunLifecycleSnapshot(runId: string): RunLifecycleSnapshot | undefined {
  return runLifecycleSnapshots.get(runId)
}

export function recentRunLifecycleSnapshots(limit = 20): RunLifecycleSnapshot[] {
  return [...runLifecycleSnapshots.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, limit))
}

export function buildRunLifecycleCheckpointPayload(limit = 20): RunLifecycleCheckpointPayload {
  return {
    schema_version: 1,
    kind: 'run_lifecycle_checkpoint',
    generated_at: new Date().toISOString(),
    runs: recentRunLifecycleSnapshots(limit).map(toRunLifecycleCheckpointEntry),
  }
}

export function formatRunLifecycleSnapshotsForPrompt(limit = 20): string {
  const snapshots = recentRunLifecycleSnapshots(limit)
  if (snapshots.length === 0) return ''
  const lines = ['Runtime run lifecycle snapshots:']
  for (const snapshot of snapshots) {
    const fields = [
      snapshot.runId,
      `kind=${snapshot.kind}`,
      `status=${snapshot.status}`,
      `objective="${compactRunLifecycleText(snapshot.objective, 90)}"`,
      `inspect="${compactRunLifecycleText(snapshot.inspectCommand, 120)}"`,
    ]
    if (snapshot.parentRunId) fields.push(`parent=${snapshot.parentRunId}`)
    if (snapshot.recoveryPolicy) fields.push(`recovery=${snapshot.recoveryPolicy.strategy}`)
    if (snapshot.evidence?.last_progress) {
      fields.push(`lastProgress="${compactRunLifecycleText(snapshot.evidence.last_progress, 90)}"`)
    }
    lines.push(`- ${fields.join(' ')}`)
  }
  return lines.join('\n')
}

export function resetRunLifecycleForTesting(): void {
  runLifecycleSnapshots.clear()
}

export function forgetRunLifecycleSnapshotsByKind(kind: RunLifecycleKind): void {
  for (const [runId, snapshot] of runLifecycleSnapshots) {
    if (snapshot.kind === kind) runLifecycleSnapshots.delete(runId)
  }
}

function toRunLifecycleCheckpointEntry(snapshot: RunLifecycleSnapshot): RunLifecycleCheckpointEntry {
  return {
    run_id: snapshot.runId,
    kind: snapshot.kind,
    status: snapshot.status,
    objective: snapshot.objective,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    owner: snapshot.owner,
    inspect_command: snapshot.inspectCommand,
    ...(snapshot.finishedAt ? { finished_at: snapshot.finishedAt } : {}),
    ...(snapshot.parentRunId ? { parent_run_id: snapshot.parentRunId } : {}),
    ...(snapshot.recoveryPolicy ? { recovery_policy: snapshot.recoveryPolicy } : {}),
    ...(snapshot.evidence ? { evidence: snapshot.evidence } : {}),
  }
}

function compactRunLifecycleText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}
