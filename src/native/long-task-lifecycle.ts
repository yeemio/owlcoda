export type LongTaskSource = 'agent' | 'task_command'

export type LongTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'partial'
  | 'incomplete'
  | 'inferred'

export interface LongTaskSnapshot {
  longTaskId: string
  source: LongTaskSource
  status: LongTaskStatus
  objective: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  conversationId?: string
  taskId?: string
  agentId?: string
  agentType?: string
  model?: string
  command?: string
  cwd?: string
  promptSnippet?: string
  inspectCommand: string
  parentTaskId?: string | null
  parentStepId?: string | null
  timeoutKind?: string
  lastProgress?: string
  outputSnippet?: string
  processIdentity?: LongTaskProcessIdentity
}

export interface LongTaskProcessIdentity {
  schema_version: 1
  pid: number
  command: string
  cwd: string
  spawnedAt: string
}

export interface LongTaskVerdictProcessIdentity {
  schema_version: 1
  pid: number
  command: string
  cwd: string
  spawned_at: string
}

export type LongTaskProcessLivenessStatus =
  | 'alive'
  | 'not_running'
  | 'permission_unknown'
  | 'unknown'

export interface LongTaskProcessLiveness {
  schema_version: 1
  pid: number
  status: LongTaskProcessLivenessStatus
  confidence: 'pid_only'
  next_action: 'inspect_process_before_replace' | 'replace_or_retry'
  reason: string
}

export type LongTaskSupervisionState =
  | 'live'
  | 'lost_handle'
  | 'terminal'
  | 'timeout'
  | 'unknown'

export type LongTaskNextAction =
  | 'inspect_again_later'
  | 'rerun_or_replace_command'
  | 'retry_or_report_incomplete'
  | 'retry_or_report_timeout'
  | 'report_terminal_result'
  | 'inspect_record'

export type LongTaskWaitStrategy =
  | 'runtime_await'
  | 'inspect_later'
  | 'replace_or_retry'
  | 'report_terminal'

export type LongTaskReplacementStrategy =
  | 'task_command_replace'
  | 'manual_agent_retry'
  | 'none'

export interface LongTaskWaitPolicy {
  schema_version: 1
  strategy: LongTaskWaitStrategy
  recommended_wait_ms: number
  max_wait_ms: number
  stop_polling: boolean
  next_check_command: string
  reason: string
  poll_interval_ms?: number
}

export interface LongTaskReplacementPolicy {
  schema_version: 1
  available: boolean
  strategy: LongTaskReplacementStrategy
  next_command: string
  reason: string
}

export interface LongTaskLifecycleVerdict {
  schema_version: 1
  long_task_id: string
  source: LongTaskSource
  status: LongTaskStatus
  supervision_state: LongTaskSupervisionState
  terminal: boolean
  can_wait: boolean
  inspect_command: string
  next_action: LongTaskNextAction
  wait_policy: LongTaskWaitPolicy
  replacement_policy?: LongTaskReplacementPolicy
  task_id?: string
  agent_id?: string
  conversation_id?: string
  timeout_kind?: string
  process_identity?: LongTaskVerdictProcessIdentity
  reattach_hint?: 'inspect_process_before_replace'
}

const MAX_LONG_TASK_SNAPSHOTS = 50
const longTaskSnapshots = new Map<string, LongTaskSnapshot>()

export interface LongTaskSnapshotFilter {
  conversationId?: string
}

export interface LongTaskSnapshotFormatOptions extends LongTaskSnapshotFilter {
  limit?: number
}

export interface LongTaskCheckpointPayload {
  schema_version: 1
  kind: 'long_task_checkpoint'
  generated_at: string
  long_tasks: LongTaskCheckpointPayloadEntry[]
}

export interface LongTaskCheckpointPayloadEntry {
  long_task_id: string
  source: LongTaskSource
  status: LongTaskStatus
  objective: string
  started_at: string
  updated_at: string
  inspect_command: string
  finished_at?: string
  conversation_id?: string
  task_id?: string
  agent_id?: string
  agent_type?: string
  model?: string
  command?: string
  cwd?: string
  prompt_snippet?: string
  parent_task_id?: string | null
  parent_step_id?: string | null
  timeout_kind?: string
  last_progress?: string
  output_snippet?: string
  process_identity?: LongTaskVerdictProcessIdentity
}

export function recordLongTaskSnapshot(
  snapshot: Omit<LongTaskSnapshot, 'updatedAt'> & { updatedAt?: string },
): LongTaskSnapshot {
  const now = new Date().toISOString()
  const existing = longTaskSnapshots.get(snapshot.longTaskId)
  const merged: LongTaskSnapshot = {
    ...existing,
    ...snapshot,
    startedAt: snapshot.startedAt ?? existing?.startedAt ?? now,
    updatedAt: snapshot.updatedAt ?? now,
  }

  if (!longTaskSnapshots.has(merged.longTaskId) && longTaskSnapshots.size >= MAX_LONG_TASK_SNAPSHOTS) {
    const oldest = longTaskSnapshots.keys().next().value
    if (oldest) longTaskSnapshots.delete(oldest)
  }
  longTaskSnapshots.set(merged.longTaskId, merged)
  return merged
}

export function getLongTaskSnapshot(longTaskId: string): LongTaskSnapshot | undefined {
  return longTaskSnapshots.get(longTaskId)
}

export function forgetLongTaskSnapshot(longTaskId: string): void {
  longTaskSnapshots.delete(longTaskId)
}

export function forgetLongTaskSnapshotsBySource(source: LongTaskSource): void {
  for (const [id, snapshot] of longTaskSnapshots) {
    if (snapshot.source === source) longTaskSnapshots.delete(id)
  }
}

export function resetLongTaskLifecycleForTesting(): void {
  longTaskSnapshots.clear()
}

export function recentLongTaskSnapshots(
  limit = 5,
  filter: LongTaskSnapshotFilter = {},
): LongTaskSnapshot[] {
  return [...longTaskSnapshots.values()]
    .filter((snapshot) => matchesLongTaskSnapshotFilter(snapshot, filter))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, limit))
}

export function formatLongTaskSnapshotsForCheckpoint(
  options: number | LongTaskSnapshotFormatOptions = 5,
): string {
  const limit = typeof options === 'number' ? options : options.limit ?? 5
  const filter = typeof options === 'number'
    ? {}
    : { conversationId: options.conversationId }
  const snapshots = recentLongTaskSnapshots(limit, filter)
  if (snapshots.length === 0) return ''

  const lines = ['Runtime long-task snapshots:']
  for (const snapshot of snapshots) {
    lines.push(formatLongTaskSnapshotLine(snapshot))
  }
  return lines.join('\n')
}

export function buildLongTaskCheckpointPayload(
  options: number | LongTaskSnapshotFormatOptions = 5,
): LongTaskCheckpointPayload | null {
  const limit = typeof options === 'number' ? options : options.limit ?? 5
  const filter = typeof options === 'number'
    ? {}
    : { conversationId: options.conversationId }
  const snapshots = recentLongTaskSnapshots(limit, filter)
  if (snapshots.length === 0) return null
  return {
    schema_version: 1,
    kind: 'long_task_checkpoint',
    generated_at: new Date().toISOString(),
    long_tasks: snapshots.map(toLongTaskCheckpointPayloadEntry),
  }
}

export function formatLongTaskCheckpointPayloadForPrompt(
  options: number | LongTaskSnapshotFormatOptions = 5,
): string {
  const payload = buildLongTaskCheckpointPayload(options)
  if (!payload) return ''
  return [
    'Runtime long-task checkpoint payload:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

export function buildLongTaskLifecycleVerdict(
  snapshot: LongTaskSnapshot | undefined,
): LongTaskLifecycleVerdict | undefined {
  if (!snapshot) return undefined
  const supervisionState = inferSupervisionState(snapshot)
  const terminal = isTerminalLongTaskStatus(snapshot.status)
  const waitPolicy = inferWaitPolicy(snapshot, supervisionState)
  const replacementPolicy = inferReplacementPolicy(snapshot, supervisionState, waitPolicy)
  return {
    schema_version: 1,
    long_task_id: snapshot.longTaskId,
    source: snapshot.source,
    status: snapshot.status,
    supervision_state: supervisionState,
    terminal,
    can_wait: supervisionState === 'live',
    inspect_command: snapshot.inspectCommand,
    next_action: inferNextAction(snapshot, supervisionState),
    wait_policy: waitPolicy,
    ...(replacementPolicy ? { replacement_policy: replacementPolicy } : {}),
    ...(snapshot.taskId ? { task_id: snapshot.taskId } : {}),
    ...(snapshot.agentId ? { agent_id: snapshot.agentId } : {}),
    ...(snapshot.conversationId ? { conversation_id: snapshot.conversationId } : {}),
    ...(snapshot.timeoutKind ? { timeout_kind: snapshot.timeoutKind } : {}),
    ...(snapshot.processIdentity ? { process_identity: toVerdictProcessIdentity(snapshot.processIdentity) } : {}),
    ...(snapshot.processIdentity ? { reattach_hint: 'inspect_process_before_replace' as const } : {}),
  }
}

export function formatLongTaskLifecycleVerdictLine(
  snapshot: LongTaskSnapshot | undefined,
): string {
  const verdict = buildLongTaskLifecycleVerdict(snapshot)
  if (!verdict) return ''
  return [
    'Lifecycle:',
    `status=${verdict.status}`,
    `supervision_state=${verdict.supervision_state}`,
    `can_wait=${String(verdict.can_wait)}`,
    `terminal=${String(verdict.terminal)}`,
    `next_action=${verdict.next_action}`,
  ].join(' ')
}

export function formatLongTaskReplacementPolicyLine(
  snapshot: LongTaskSnapshot | undefined,
): string {
  const verdict = buildLongTaskLifecycleVerdict(snapshot)
  const policy = verdict?.replacement_policy
  if (!policy || policy.strategy === 'none') return ''
  return [
    'ReplacementPolicy:',
    `strategy=${policy.strategy}`,
    `available=${String(policy.available)}`,
    `next_command="${compact(policy.next_command, 120)}"`,
  ].join(' ')
}

export function formatLongTaskWaitPolicyLine(
  snapshot: LongTaskSnapshot | undefined,
): string {
  const verdict = buildLongTaskLifecycleVerdict(snapshot)
  if (!verdict) return ''
  const policy = verdict.wait_policy
  return [
    'WaitPolicy:',
    `strategy=${policy.strategy}`,
    `recommended_wait_ms=${policy.recommended_wait_ms}`,
    `max_wait_ms=${policy.max_wait_ms}`,
    `stop_polling=${String(policy.stop_polling)}`,
    `next_check="${compact(policy.next_check_command, 120)}"`,
  ].join(' ')
}

function formatLongTaskSnapshotLine(snapshot: LongTaskSnapshot): string {
  const fields = [
    snapshot.longTaskId,
    `source=${snapshot.source}`,
    `status=${snapshot.status}`,
    `objective="${compact(snapshot.objective, 90)}"`,
  ]
  if (snapshot.command) fields.push(`command="${compact(snapshot.command, 120)}"`)
  if (snapshot.processIdentity) fields.push(`pid=${snapshot.processIdentity.pid}`)
  if (snapshot.promptSnippet) fields.push(`prompt="${compact(snapshot.promptSnippet, 120)}"`)
  if (snapshot.lastProgress) fields.push(`lastProgress="${compact(snapshot.lastProgress, 90)}"`)
  if (snapshot.timeoutKind) fields.push(`timeout=${snapshot.timeoutKind}`)
  if (snapshot.inspectCommand) fields.push(`inspect="${compact(snapshot.inspectCommand, 120)}"`)
  if (snapshot.outputSnippet) fields.push(`latest="${compact(snapshot.outputSnippet, 120)}"`)
  return `- ${fields.join(' ')}`
}

function toLongTaskCheckpointPayloadEntry(snapshot: LongTaskSnapshot): LongTaskCheckpointPayloadEntry {
  return {
    long_task_id: snapshot.longTaskId,
    source: snapshot.source,
    status: snapshot.status,
    objective: snapshot.objective,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    inspect_command: snapshot.inspectCommand,
    ...(snapshot.finishedAt ? { finished_at: snapshot.finishedAt } : {}),
    ...(snapshot.conversationId ? { conversation_id: snapshot.conversationId } : {}),
    ...(snapshot.taskId ? { task_id: snapshot.taskId } : {}),
    ...(snapshot.agentId ? { agent_id: snapshot.agentId } : {}),
    ...(snapshot.agentType ? { agent_type: snapshot.agentType } : {}),
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.command ? { command: snapshot.command } : {}),
    ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
    ...(snapshot.promptSnippet ? { prompt_snippet: snapshot.promptSnippet } : {}),
    ...(snapshot.parentTaskId !== undefined ? { parent_task_id: snapshot.parentTaskId } : {}),
    ...(snapshot.parentStepId !== undefined ? { parent_step_id: snapshot.parentStepId } : {}),
    ...(snapshot.timeoutKind ? { timeout_kind: snapshot.timeoutKind } : {}),
    ...(snapshot.lastProgress ? { last_progress: snapshot.lastProgress } : {}),
    ...(snapshot.outputSnippet ? { output_snippet: snapshot.outputSnippet } : {}),
    ...(snapshot.processIdentity ? { process_identity: toVerdictProcessIdentity(snapshot.processIdentity) } : {}),
  }
}

export function formatLongTaskProcessIdentityLine(
  snapshot: LongTaskSnapshot | undefined,
): string {
  if (!snapshot?.processIdentity) return ''
  const identity = snapshot.processIdentity
  return [
    'ProcessIdentity:',
    `pid=${identity.pid}`,
    `command="${compact(identity.command, 120)}"`,
    `cwd="${compact(identity.cwd, 120)}"`,
    `spawned_at=${identity.spawnedAt}`,
    'reattach_hint="inspect_process_before_replace"',
  ].join(' ')
}

export function buildLongTaskProcessLiveness(
  snapshot: LongTaskSnapshot | undefined,
): LongTaskProcessLiveness | undefined {
  const identity = snapshot?.processIdentity
  if (!identity) return undefined

  try {
    process.kill(identity.pid, 0)
    return {
      schema_version: 1,
      pid: identity.pid,
      status: 'alive',
      confidence: 'pid_only',
      next_action: 'inspect_process_before_replace',
      reason: 'The OS still reports this PID as alive. PID reuse is possible, so inspect the process before replacing the work.',
    }
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : ''
    if (code === 'ESRCH') {
      return {
        schema_version: 1,
        pid: identity.pid,
        status: 'not_running',
        confidence: 'pid_only',
        next_action: 'replace_or_retry',
        reason: 'The OS reports no process for this PID. Replacement may be appropriate after inspecting captured output.',
      }
    }
    if (code === 'EPERM') {
      return {
        schema_version: 1,
        pid: identity.pid,
        status: 'permission_unknown',
        confidence: 'pid_only',
        next_action: 'inspect_process_before_replace',
        reason: 'The OS refused the liveness probe. Inspect the process before replacing the work.',
      }
    }
    return {
      schema_version: 1,
      pid: identity.pid,
      status: 'unknown',
      confidence: 'pid_only',
      next_action: 'inspect_process_before_replace',
      reason: 'The runtime could not classify this PID liveness probe. Inspect the process before replacing the work.',
    }
  }
}

export function formatLongTaskProcessLivenessLine(
  snapshot: LongTaskSnapshot | undefined,
): string {
  const liveness = buildLongTaskProcessLiveness(snapshot)
  if (!liveness) return ''
  return [
    'ProcessLiveness:',
    `status=${liveness.status}`,
    `confidence=${liveness.confidence}`,
    `pid=${liveness.pid}`,
    `next_action=${liveness.next_action}`,
  ].join(' ')
}

function inferSupervisionState(snapshot: LongTaskSnapshot): LongTaskSupervisionState {
  if (snapshot.status === 'running') return 'live'
  if (snapshot.status === 'timeout') return 'timeout'
  if (snapshot.status === 'incomplete' && isLostHandleTimeoutKind(snapshot.timeoutKind)) return 'lost_handle'
  if (isTerminalLongTaskStatus(snapshot.status)) return 'terminal'
  return 'unknown'
}

function inferNextAction(
  snapshot: LongTaskSnapshot,
  supervisionState: LongTaskSupervisionState,
): LongTaskNextAction {
  if (supervisionState === 'live') return 'inspect_again_later'
  if (supervisionState === 'timeout') return 'retry_or_report_timeout'
  if (supervisionState === 'terminal') return 'report_terminal_result'
  if (supervisionState === 'lost_handle') {
    return snapshot.source === 'task_command'
      ? 'rerun_or_replace_command'
      : 'retry_or_report_incomplete'
  }
  return 'inspect_record'
}

function inferWaitPolicy(
  snapshot: LongTaskSnapshot,
  supervisionState: LongTaskSupervisionState,
): LongTaskWaitPolicy {
  if (supervisionState === 'live') {
    return {
      schema_version: 1,
      strategy: 'runtime_await',
      recommended_wait_ms: 5000,
      max_wait_ms: 30000,
      poll_interval_ms: 500,
      stop_polling: false,
      next_check_command: `LongTaskAwait longTaskId=${snapshot.longTaskId} timeoutMs=5000`,
      reason: 'Runtime can wait for a bounded interval; use LongTaskAwait instead of Sleep or bash polling.',
    }
  }

  if (supervisionState === 'terminal') {
    return {
      schema_version: 1,
      strategy: 'report_terminal',
      recommended_wait_ms: 0,
      max_wait_ms: 0,
      stop_polling: true,
      next_check_command: snapshot.inspectCommand,
      reason: 'The long task is terminal; report the result instead of waiting.',
    }
  }

  if (supervisionState === 'lost_handle' || supervisionState === 'timeout') {
    return {
      schema_version: 1,
      strategy: 'replace_or_retry',
      recommended_wait_ms: 0,
      max_wait_ms: 0,
      stop_polling: true,
      next_check_command: snapshot.inspectCommand,
      reason: 'Runtime cannot make progress by waiting; inspect the record and replace or retry the work.',
    }
  }

  return {
    schema_version: 1,
    strategy: 'inspect_later',
    recommended_wait_ms: 0,
    max_wait_ms: 0,
    stop_polling: true,
    next_check_command: snapshot.inspectCommand,
    reason: 'Runtime cannot prove this record is waitable; inspect the source record before deciding.',
  }
}

function inferReplacementPolicy(
  snapshot: LongTaskSnapshot,
  supervisionState: LongTaskSupervisionState,
  waitPolicy: LongTaskWaitPolicy,
): LongTaskReplacementPolicy | undefined {
  if (waitPolicy.strategy !== 'replace_or_retry') return undefined

  if (
    snapshot.source === 'task_command'
    && snapshot.command
    && (supervisionState === 'lost_handle' || supervisionState === 'timeout')
  ) {
    return {
      schema_version: 1,
      available: true,
      strategy: 'task_command_replace',
      next_command: `LongTaskReplace longTaskId=${snapshot.longTaskId}`,
      reason: 'The original command has no waitable runtime handle; the runtime can start a classified replacement command task.',
    }
  }

  if (
    snapshot.source === 'agent'
    && (supervisionState === 'lost_handle' || supervisionState === 'timeout')
  ) {
    return {
      schema_version: 1,
      available: false,
      strategy: 'manual_agent_retry',
      next_command: snapshot.inspectCommand,
      reason: 'Agent runs are not automatically replayed; inspect the record and launch an explicit new Agent call if retrying is still warranted.',
    }
  }

  return {
    schema_version: 1,
    available: false,
    strategy: 'none',
    next_command: snapshot.inspectCommand,
    reason: 'No runtime-owned replacement action is available for this record.',
  }
}

function isLostHandleTimeoutKind(timeoutKind: string | undefined): boolean {
  return timeoutKind === 'process_handle_missing_after_resume'
    || timeoutKind === 'agent_run_handle_missing_after_resume'
}

function isTerminalLongTaskStatus(status: LongTaskStatus): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'timeout'
    || status === 'cancelled'
    || status === 'partial'
    || status === 'inferred'
}

function toVerdictProcessIdentity(
  identity: LongTaskProcessIdentity,
): LongTaskVerdictProcessIdentity {
  return {
    schema_version: 1,
    pid: identity.pid,
    command: identity.command,
    cwd: identity.cwd,
    spawned_at: identity.spawnedAt,
  }
}

export function compactLongTaskText(value: string, limit = 500): string {
  return compact(value, limit)
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}

function matchesLongTaskSnapshotFilter(
  snapshot: LongTaskSnapshot,
  filter: LongTaskSnapshotFilter,
): boolean {
  if (filter.conversationId !== undefined) {
    return snapshot.conversationId === filter.conversationId
  }
  return true
}
