/**
 * OwlCoda Native Task Store
 *
 * In-memory task management backing the Task* tools.
 * Tasks persist for the session lifetime.
 *
 * Upstream parity notes:
 * - Upstream uses utils/tasks.ts with file-backed JSON storage
 * - Supports task lists, hooks, teammate ownership
 * - Our version: in-memory Map with same field structure
 *
 * Execution layer (re-introduced 0.13.31):
 *   When `TaskCreate` is given a `command` and it has cleared the bash
 *   risk classifier (see tools/task-create.ts), we spawn a bash child
 *   here and store its handle in `runningProcesses`. Stdout / stderr are
 *   buffered on the Task itself so `TaskOutput` can surface them when
 *   the task hits a terminal state. Exit is event-driven (`child.on('exit')`),
 *   never polled. `TaskStop` writes status='cancelled' BEFORE sending
 *   SIGTERM so the exit handler doesn't race the stop and overwrite
 *   `cancelled` with `completed`. `resetTaskStore` SIGKILLs any survivors
 *   so test runs don't leak processes.
 *
 * Task Execution Mode v1 (Slice 1, 0.14.19+):
 *   Tasks can now carry a structured execution plan: `deliverables` and
 *   `steps`. Steps track state, expected artifacts, and verification.
 *   Use `updateTaskStep` / `getCurrentOrNextStep` / `taskHasOpenRequiredSteps`
 *   to drive the task execution loop.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { BashRiskClassification } from '../bash-risk.js'
import type { TaskPathScope } from '../protocol/types.js'
import {
  compactLongTaskText,
  forgetLongTaskSnapshot,
  forgetLongTaskSnapshotsBySource,
  recordLongTaskSnapshot,
  type LongTaskSnapshot,
} from '../long-task-lifecycle.js'

/** Task status values matching upstream TaskStatusSchema. */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked'

// ---------------------------------------------------------------------------
// Task Step types (Slice 1)
// ---------------------------------------------------------------------------

export type TaskStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type TaskStepAction =
  | { kind: 'local_tool'; recommendedTools?: string[] }
  | { kind: 'subagent'; agentType?: string; prompt?: string }
  | { kind: 'manual'; reason: string }

export type TaskVerificationKind =
  | 'file_exists'
  | 'file_contains'
  | 'artifact_count'
  | 'verification_pack'
  | 'command'
  | 'none'

export interface TaskVerificationRequiredMarker {
  marker: string
  label?: string
}

export interface TaskVerificationCheck {
  id: string
  kind: TaskVerificationKind
  packId?: 'html_deck' | string
  path?: string
  pattern?: string
  root?: string
  glob?: string
  min?: number
  deckPath?: string
  expectedSections?: number
  buildNotesPath?: string
  requiredMarkers?: Array<string | TaskVerificationRequiredMarker>
  minFileSizeBytes?: number
  minSectionBytes?: number
  forbiddenTerms?: string[]
  command?: string
  expectedExitCode?: number
  reason?: string
}

export interface TaskVerificationResult {
  checkId: string
  passed: boolean
  detail?: string
  checkedAt: string
  /**
   * True when the check can NEVER pass as authored, regardless of any work
   * the model does (missing required fields, unknown kind, command refused
   * by the risk classifier, invalid regex, placeholder path). Distinct from
   * a well-formed check whose artifact is merely not present yet. Re-running
   * TaskVerify on an unsatisfiable check is futile — the step's verification
   * spec must be edited via TaskUpdate. TaskVerify tags repeated runs with a
   * failureCategory so the loop guard stops the model.
   */
  unsatisfiable?: boolean
  metadata?: Record<string, unknown>
}

export interface TaskStep {
  id: string
  title: string
  description: string
  status: TaskStepStatus
  action: TaskStepAction
  expectedArtifacts: TaskPathScope[]
  verification: TaskVerificationCheck[]
  verificationResults: TaskVerificationResult[]
  touchedPaths: string[]
  startedAt?: string
  completedAt?: string
  failureReason?: string
}

/** Result of a step update operation — allows callers to surface errors via ToolResult. */
export type TaskStepUpdateResult =
  | { ok: true; task: Task; step: TaskStep }
  | { ok: false; reason: string }

export interface Task {
  id: string
  subject: string
  description: string
  status: TaskStatus
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks: string[]
  blockedBy: string[]
  owner?: string
  createdAt: string
  updatedAt: string
  /** Optional bash command this task is executing. */
  command?: string
  /** Working directory for `command` (defaults to process.cwd()). */
  cwd?: string
  /** Parent conversation id for scoped long-task lifecycle snapshots. */
  conversationId?: string
  /** Captured stdout (only populated for command-backed tasks). */
  stdout?: string
  /** Captured stderr (only populated for command-backed tasks). */
  stderr?: string
  /** Exit code from the spawned child (after natural exit). */
  exitCode?: number
  /** Spawn-level error message, if any. */
  error?: string
  /** Risk classification recorded at spawn time for audit. */
  bashRisk?: BashRiskClassification
  /** Structured deliverable paths for this task (Slice 1). */
  deliverables?: TaskPathScope[]
  /** Ordered execution steps (Slice 1). Undefined = pure TODO task (backward compat). */
  steps?: TaskStep[]
  /** ID of the currently active step (Slice 1). */
  currentStepId?: string
  /** Runtime lifecycle snapshot for command-backed long tasks. */
  longTaskSnapshot?: LongTaskSnapshot
}

let nextId = 1
const tasks = new Map<string, Task>()
const runningProcesses = new Map<string, ChildProcess>()

export interface TaskStoreSnapshot {
  schemaVersion: 1
  nextId: number
  tasks: Task[]
}

/** Generate a sequential task ID. */
function genId(): string {
  return `task-${nextId++}`
}

/** Create a new task. */
export function createTask(opts: {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
  command?: string
  cwd?: string
  conversationId?: string
  bashRisk?: BashRiskClassification
  deliverables?: TaskPathScope[]
  steps?: Array<Omit<Partial<TaskStep>, 'status'> & { title: string; description: string }>
}): Task {
  const now = new Date().toISOString()

  // Normalize steps: assign IDs, fill defaults
  let normalizedSteps: TaskStep[] | undefined
  if (opts.steps && opts.steps.length > 0) {
    normalizedSteps = opts.steps.map((s, i) => {
      const id = s.id ?? `step-${i + 1}`
      return {
        id,
        title: s.title,
        description: s.description,
        status: 'pending' as TaskStepStatus,
        action: s.action ?? { kind: 'local_tool' as const },
        expectedArtifacts: s.expectedArtifacts ?? [],
        verification: s.verification ?? [],
        verificationResults: [],
        touchedPaths: [],
        startedAt: undefined,
        completedAt: undefined,
        failureReason: undefined,
      }
    })
  }

  const task: Task = {
    id: genId(),
    subject: opts.subject,
    description: opts.description,
    status: 'pending',
    activeForm: opts.activeForm,
    metadata: opts.metadata,
    blocks: [],
    blockedBy: [],
    createdAt: now,
    updatedAt: now,
    command: opts.command,
    cwd: opts.cwd,
    conversationId: opts.conversationId,
    bashRisk: opts.bashRisk,
    deliverables: opts.deliverables ?? [],
    steps: normalizedSteps,
  }
  tasks.set(task.id, task)
  return task
}

// ---------------------------------------------------------------------------
// Step helpers (Slice 1)
// ---------------------------------------------------------------------------

/** Get a step from a task by step ID. */
export function getTaskStep(taskId: string, stepId: string): TaskStep | undefined {
  const task = tasks.get(taskId)
  return task?.steps?.find(s => s.id === stepId)
}

/**
 * Update a task step's mutable fields.
 *
 * Enforces transition rules:
 *   - Only one step may be `in_progress` per task (unless another is already in_progress)
 *   - `completed` requires all verification results to be passed (or none exist)
 *   - `failed` and `blocked` require `failureReason`
 *   - `completed` cannot be reopened (returns error)
 */
export function updateTaskStep(
  taskId: string,
  stepId: string,
  updates: Partial<Pick<TaskStep, 'status' | 'touchedPaths' | 'verification' | 'verificationResults' | 'failureReason'>>,
): TaskStepUpdateResult {
  const task = tasks.get(taskId)
  if (!task) return { ok: false, reason: `Task "${taskId}" not found.` }
  if (!task.steps) return { ok: false, reason: `Task "${taskId}" has no steps.` }

  const step = task.steps.find(s => s.id === stepId)
  if (!step) {
    const available = task.steps.map(s => s.id).join(', ')
    return { ok: false, reason: `Step "${stepId}" not found in task "${taskId}". Available steps: ${available}.` }
  }

  const newStatus = updates.status
  const effectiveVerification = updates.verification ?? step.verification
  const effectiveResults = updates.verificationResults ?? step.verificationResults

  if (
    step.status === 'completed'
    && (updates.verification !== undefined || updates.verificationResults !== undefined)
  ) {
    return {
      ok: false,
      reason: `Step "${stepId}" is already completed and cannot change verification spec or results.`,
    }
  }

  const verificationWeakeningBlocker = verificationSpecWeakeningBlocker(stepId, step, updates.verification)
  if (verificationWeakeningBlocker) {
    return {
      ok: false,
      reason: verificationWeakeningBlocker,
    }
  }

  // Validate transition
  if (newStatus !== undefined) {
    // Cannot reopen completed step
    if (step.status === 'completed') {
      return { ok: false, reason: `Step "${stepId}" is already completed and cannot be reopened.` }
    }

    // Only one in_progress at a time
    if (newStatus === 'in_progress') {
      const alreadyInProgress = task.steps.find(s => s.id !== stepId && s.status === 'in_progress')
      if (alreadyInProgress) {
        return {
          ok: false,
          reason: `Cannot set step "${stepId}" to in_progress: step "${alreadyInProgress.id}" is already in_progress. Complete or block it first.`,
        }
      }
    }

    // completed requires all verification results passed (if any exist)
    if (newStatus === 'completed') {
      const verificationBlocker = verificationCompletionBlocker(stepId, effectiveVerification, effectiveResults)
      if (verificationBlocker) {
        return {
          ok: false,
          reason: verificationBlocker,
        }
      }
    }

    // failed and blocked require failureReason
    if ((newStatus === 'failed' || newStatus === 'blocked') && !updates.failureReason && !step.failureReason) {
      return {
        ok: false,
        reason: `Cannot mark step "${stepId}" as ${newStatus} without a failureReason.`,
      }
    }
  }

  // Apply updates
  if (newStatus !== undefined) {
    step.status = newStatus
    if (newStatus === 'in_progress' && !step.startedAt) {
      step.startedAt = new Date().toISOString()
    }
    if (newStatus === 'completed') {
      step.completedAt = new Date().toISOString()
    }
  }
  if (updates.touchedPaths !== undefined) {
    step.touchedPaths = [...step.touchedPaths, ...updates.touchedPaths]
  }
  if (updates.verification !== undefined) {
    step.verification = updates.verification
    if (updates.verificationResults === undefined) {
      step.verificationResults = []
    }
  }
  if (updates.verificationResults !== undefined) {
    step.verificationResults = updates.verificationResults
  }
  if (updates.failureReason !== undefined) {
    step.failureReason = updates.failureReason
  }

  // Update currentStepId on the task
  if (newStatus === 'in_progress') {
    task.currentStepId = stepId
  } else if (newStatus !== undefined && task.currentStepId === stepId) {
    // Step moved away from in_progress — find next in_progress or clear
    const nextInProgress = task.steps.find(s => s.status === 'in_progress')
    task.currentStepId = nextInProgress?.id
  }

  task.updatedAt = new Date().toISOString()
  return { ok: true, task, step }
}

function verificationCompletionBlocker(
  stepId: string,
  checks: TaskVerificationCheck[],
  results: TaskVerificationResult[],
): string | null {
  if (checks.length === 0) {
    const failedResult = results.find(r => !r.passed)
    return failedResult
      ? `Cannot complete step "${stepId}": one or more verification checks failed. Fix the failures before marking completed.`
      : null
  }
  if (results.length === 0) {
    return `Cannot complete step "${stepId}": verification checks exist but no verification results are recorded. Run TaskVerify for this task and step after the latest work/spec before marking completed.`
  }
  const failedResult = results.find(r => !r.passed)
  if (failedResult) {
    return `Cannot complete step "${stepId}": one or more verification checks failed. Fix the failures before marking completed.`
  }
  const missing = checks.filter(check => !hasPassingResultForCheck(check, results)).map(check => check.id)
  if (missing.length > 0) {
    return `Cannot complete step "${stepId}": missing passing verification result(s) for check(s): ${missing.join(', ')}. Run TaskVerify after updating the artifact or verification spec.`
  }
  return null
}

function verificationSpecWeakeningBlocker(
  stepId: string,
  step: TaskStep,
  replacement: TaskVerificationCheck[] | undefined,
): string | null {
  if (replacement === undefined) return null
  const hasFailedEvidence = step.verificationResults.some(result => !result.passed)
  if (!hasFailedEvidence) return null
  if (replacement.length === 0 || replacement.some(check => check.kind === 'none')) {
    return `Cannot weaken verification for step "${stepId}" after failed verification evidence exists. Fix the artifact or replace the spec with concrete checks, then run TaskVerify again.`
  }
  return null
}

function hasPassingResultForCheck(check: TaskVerificationCheck, results: TaskVerificationResult[]): boolean {
  if (check.kind === 'verification_pack') {
    const prefix = `${check.id}.`
    return results.some(result =>
      result.passed && (result.checkId === check.id || result.checkId.startsWith(prefix)),
    )
  }
  return results.some(result => result.passed && result.checkId === check.id)
}

/**
 * Returns the current active step or the next pending step.
 * Priority: in_progress > first pending.
 * blocked steps are returned (not skipped) so callers know the plan is stuck.
 */
export function getCurrentOrNextStep(taskId: string): TaskStep | undefined {
  const task = tasks.get(taskId)
  if (!task?.steps) return undefined

  // Prefer in_progress
  const inProgress = task.steps.find(s => s.status === 'in_progress')
  if (inProgress) return inProgress

  // Next pending
  const pending = task.steps.find(s => s.status === 'pending')
  if (pending) return pending

  // Next blocked (stuck)
  return task.steps.find(s => s.status === 'blocked')
}

/**
 * Returns true if the task has any required steps that are not yet done.
 * A step is "open" if its status is pending, in_progress, failed, or blocked.
 * Tasks without steps always return false (pure TODO task).
 */
export function taskHasOpenRequiredSteps(task: Task): boolean {
  if (!task.steps) return false
  return task.steps.some(s =>
    s.status === 'pending' || s.status === 'in_progress' || s.status === 'failed' || s.status === 'blocked',
  )
}

/** Find the latest task with open required steps (for next-step auto-select). */
export function findLatestOpenTask(): Task | undefined {
  const allTasks = [...tasks.values()]
  return allTasks
    .filter(t => taskHasOpenRequiredSteps(t))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

// ---------------------------------------------------------------------------
// Next-step query helper (Slice 2)
// ---------------------------------------------------------------------------

export interface NextStepResult {
  taskId: string
  hasNext: boolean
  nextStep?: TaskStep
  reason?: 'no_tasks' | 'no_open_steps' | 'blocked'
}

/**
 * Find the next executable step for a given task (or the latest open task if taskId omitted).
 *
 * Rules:
 *   - in_progress step: return it (it's already active)
 *   - first pending step: return it
 *   - blocked step as next: return it with reason='blocked'
 *   - no open steps: hasNext=false, reason='no_open_steps'
 *   - no tasks at all: hasNext=false, reason='no_tasks'
 */
export function findNextStep(taskId?: string): NextStepResult {
  let task: Task | undefined

  if (taskId) {
    task = tasks.get(taskId)
    if (!task) return { taskId: taskId ?? '', hasNext: false, reason: 'no_tasks' }
  } else {
    task = findLatestOpenTask()
    if (!task) return { taskId: '', hasNext: false, reason: 'no_tasks' }
  }

  if (!task.steps || task.steps.length === 0) {
    return { taskId: task.id, hasNext: false, reason: 'no_open_steps' }
  }

  const next = getCurrentOrNextStep(task.id)
  if (!next) {
    return { taskId: task.id, hasNext: false, reason: 'no_open_steps' }
  }

  if (next.status === 'blocked') {
    return { taskId: task.id, hasNext: true, nextStep: next, reason: 'blocked' }
  }

  return { taskId: task.id, hasNext: true, nextStep: next }
}

/** Get a task by ID. */
export function getTask(id: string): Task | undefined {
  return tasks.get(id)
}

/** List all tasks. */
export function listTasks(): Task[] {
  return [...tasks.values()]
}

/** Return a serializable snapshot of task records. Runtime process handles are intentionally excluded. */
export function snapshotTaskStore(conversationId?: string): TaskStoreSnapshot {
  const scopedTasks = [...tasks.values()].filter(task =>
    conversationId === undefined
    || task.conversationId === conversationId
    || task.conversationId === undefined,
  )
  return {
    schemaVersion: 1,
    nextId,
    tasks: scopedTasks.map(cloneTaskRecord),
  }
}

/** Restore task records from a session snapshot. This never revives background child processes. */
export function restoreTaskStore(snapshot: TaskStoreSnapshot | null | undefined): void {
  resetTaskStore()
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks)) {
    return
  }

  let nextIdFromTasks = 1
  for (const task of snapshot.tasks) {
    if (!task || typeof task.id !== 'string') continue
    const cloned = cloneTaskRecord(task)
    if (isRestoredCommandTaskMissingProcess(cloned)) {
      recordTaskLongTaskSnapshot(cloned, 'incomplete', {
        timeoutKind: 'process_handle_missing_after_resume',
        lastProgress:
          'Task was restored from a saved session as in_progress, but this process has no live child process handle to wait on.',
      })
    }
    tasks.set(cloned.id, cloned)
    const match = /^task-(\d+)$/.exec(cloned.id)
    if (match) {
      nextIdFromTasks = Math.max(nextIdFromTasks, Number(match[1]) + 1)
    }
  }
  nextId = Math.max(snapshot.nextId || 1, nextIdFromTasks)
}

function cloneTaskRecord(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task
}

function isRestoredCommandTaskMissingProcess(task: Task): boolean {
  return task.command !== undefined
    && task.status === 'in_progress'
    && task.exitCode === undefined
}

/** Update a task's fields. Returns the updated task or undefined if not found. */
export function updateTask(
  id: string,
  updates: Partial<Pick<Task, 'subject' | 'description' | 'status' | 'activeForm' | 'metadata'>>,
): Task | undefined {
  const task = tasks.get(id)
  if (!task) return undefined

  if (updates.subject !== undefined) task.subject = updates.subject
  if (updates.description !== undefined) task.description = updates.description
  if (updates.status !== undefined) task.status = updates.status
  if (updates.activeForm !== undefined) task.activeForm = updates.activeForm
  if (updates.metadata !== undefined) task.metadata = { ...task.metadata, ...updates.metadata }
  task.updatedAt = new Date().toISOString()

  return task
}

/** Add a blocking relationship: taskId blocks blockedId. */
export function blockTask(taskId: string, blockedId: string): boolean {
  const task = tasks.get(taskId)
  const blocked = tasks.get(blockedId)
  if (!task || !blocked) return false
  if (!task.blocks.includes(blockedId)) task.blocks.push(blockedId)
  if (!blocked.blockedBy.includes(taskId)) blocked.blockedBy.push(taskId)
  return true
}

/** Delete a task. */
export function deleteTask(id: string): boolean {
  const task = tasks.get(id)
  if (!task) return false
  // Remove from blocking relationships
  for (const t of tasks.values()) {
    t.blocks = t.blocks.filter(bid => bid !== id)
    t.blockedBy = t.blockedBy.filter(bid => bid !== id)
  }
  // Drop any associated process handle (the caller is expected to have
  // already SIGTERM'd via `stopTask` or this is a test-only purge).
  const child = runningProcesses.get(id)
  if (child) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    runningProcesses.delete(id)
  }
  forgetLongTaskSnapshot(`task:${id}`)
  return tasks.delete(id)
}

/**
 * Stop a task: set status='cancelled' BEFORE signalling the child. This
 * ordering matters — the exit handler reads `task.status` to decide
 * whether to keep `cancelled` or transition to `completed`. If we
 * SIGTERM'd first, a fast-exiting child would race past us and the
 * handler would write `completed` over the user's stop request.
 */
export function stopTask(id: string): Task | undefined {
  const task = tasks.get(id)
  if (!task) return undefined
  if (task.status === 'completed' || task.status === 'cancelled') return task
  const updated = updateTask(id, { status: 'cancelled' })
  const child = runningProcesses.get(id)
  if (child) {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
  }
  if (updated?.command) recordTaskLongTaskSnapshot(updated, 'cancelled')
  return updated
}

/** Reset store (for testing). SIGKILLs any survivor children. */
export function resetTaskStore(): void {
  for (const [, child] of runningProcesses) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
  runningProcesses.clear()
  tasks.clear()
  forgetLongTaskSnapshotsBySource('task_command')
  nextId = 1
}

/**
 * Spawn the task's bash command and wire stdout/stderr/exit handlers.
 * Caller is responsible for having ALREADY classified the command with
 * `classifyBashCommand` and concluded it is safe to spawn — this fn does
 * NOT re-check risk.
 *
 * Returns immediately; the task transitions to terminal state via the
 * `exit` event. Caller can `await waitForTask(id, timeout)` if it needs
 * to block.
 */
export function spawnTaskCommand(taskId: string): void {
  const task = tasks.get(taskId)
  if (!task || !task.command) return

  // status flips to in_progress on spawn.
  task.status = 'in_progress'
  task.updatedAt = new Date().toISOString()
  task.stdout = ''
  task.stderr = ''
  recordTaskLongTaskSnapshot(task, 'running')

  let child: ChildProcess
  try {
    child = spawn('bash', ['-c', task.command], {
      cwd: task.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (err) {
    task.status = 'completed'
    task.error = err instanceof Error ? err.message : String(err)
    task.exitCode = -1
    task.updatedAt = new Date().toISOString()
    recordTaskLongTaskSnapshot(task, 'failed')
    return
  }

  runningProcesses.set(taskId, child)

  // Cap captured I/O to keep a runaway `cat /dev/zero`-style command
  // from ballooning memory. 1 MiB per stream is plenty for an audit
  // trail; consumers wanting full output should use `bash` directly.
  const MAX_BUF = 1024 * 1024
  child.stdout?.on('data', (chunk: Buffer) => {
    const cur = task.stdout?.length ?? 0
    if (cur >= MAX_BUF) return
    task.stdout = (task.stdout ?? '') + chunk.toString('utf8')
    task.updatedAt = new Date().toISOString()
    recordTaskLongTaskSnapshot(task, 'running')
    if (task.stdout!.length > MAX_BUF) {
      task.stdout = task.stdout!.slice(0, MAX_BUF) + '\n[truncated]'
      // Stop reading; caller already has all the audit data they get.
      try { child.stdout?.destroy() } catch { /* ignore */ }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const cur = task.stderr?.length ?? 0
    if (cur >= MAX_BUF) return
    task.stderr = (task.stderr ?? '') + chunk.toString('utf8')
    task.updatedAt = new Date().toISOString()
    recordTaskLongTaskSnapshot(task, 'running')
    if (task.stderr!.length > MAX_BUF) {
      task.stderr = task.stderr!.slice(0, MAX_BUF) + '\n[truncated]'
      try { child.stderr?.destroy() } catch { /* ignore */ }
    }
  })
  child.on('error', (err) => {
    task.error = err instanceof Error ? err.message : String(err)
    recordTaskLongTaskSnapshot(task, 'failed')
  })
  child.on('exit', (code, signal) => {
    runningProcesses.delete(taskId)
    // If `stopTask` already wrote 'cancelled', preserve it. Otherwise
    // transition to 'completed' regardless of code (non-zero exits are
    // still completion in the bash-task sense — the consumer reads
    // exitCode to know if it failed).
    if (task.status !== 'cancelled') {
      task.status = 'completed'
    }
    task.exitCode = typeof code === 'number' ? code : (signal ? -1 : 0)
    task.updatedAt = new Date().toISOString()
    const status = task.status === 'cancelled'
      ? 'cancelled'
      : task.exitCode === 0
        ? 'completed'
        : 'failed'
    recordTaskLongTaskSnapshot(task, status)
  })
}

function recordTaskLongTaskSnapshot(
  task: Task,
  status: LongTaskSnapshot['status'],
  extra: {
    timeoutKind?: string
    lastProgress?: string
  } = {},
): LongTaskSnapshot | undefined {
  if (!task.command) return undefined
  const outputSnippet = compactLongTaskText([
    task.stdout ? `stdout: ${task.stdout}` : '',
    task.stderr ? `stderr: ${task.stderr}` : '',
    task.error ? `error: ${task.error}` : '',
  ].filter(Boolean).join('\n'), 500)
  const snapshot = recordLongTaskSnapshot({
    longTaskId: `task:${task.id}`,
    source: 'task_command',
    status,
    objective: task.subject,
    startedAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(status !== 'running' && status !== 'incomplete' ? { finishedAt: task.updatedAt } : {}),
    taskId: task.id,
    command: task.command,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    inspectCommand: `TaskOutput task_id=${task.id} block=false`,
    ...(extra.timeoutKind ? { timeoutKind: extra.timeoutKind } : {}),
    ...(extra.lastProgress ? { lastProgress: extra.lastProgress } : {}),
    ...(outputSnippet ? { outputSnippet } : {}),
  })
  task.longTaskSnapshot = snapshot
  return snapshot
}

/** True iff this task currently has a live child process. */
export function hasRunningProcess(taskId: string): boolean {
  return runningProcesses.has(taskId)
}

/** Test/debug helper. */
export function _processCount(): number {
  return runningProcesses.size
}
