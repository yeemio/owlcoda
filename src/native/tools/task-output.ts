/**
 * OwlCoda Native TaskOutput Tool
 *
 * Retrieves output from a task by ID, optionally blocking until completion.
 *
 * Upstream parity notes:
 * - Upstream reads from disk-based task output, supports bash/agent task types
 * - Polls with configurable timeout, returns structured output
 * - Our version: reads from in-memory task store with optional polling
 */

import type { NativeToolDef, ToolResult } from './types.js'
import {
  buildLongTaskLifecycleVerdict,
  buildLongTaskProcessLiveness,
  formatLongTaskLifecycleVerdictLine,
  formatLongTaskProcessIdentityLine,
  formatLongTaskProcessLivenessLine,
  formatLongTaskWaitPolicyLine,
} from '../long-task-lifecycle.js'
import {
  getTask,
  getCurrentOrNextStep,
  hasRunningProcess,
  taskHasOpenRequiredSteps,
  type Task,
  type TaskStep,
} from './task-store.js'

export interface TaskOutputInput {
  task_id: string
  /** Whether to wait for the task to complete (default: true) */
  block?: boolean
  /** Max wait time in ms (default: 30000) */
  timeout?: number
}

const STEP_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
  failed: '✗',
  blocked: '!',
  cancelled: '-',
}

function normalizeTaskId(value: string): string {
  return value.startsWith('task:') ? value.slice('task:'.length) : value
}

function prependAliasResolution(output: string, requestedTaskId: string, resolvedTaskId: string): string {
  if (requestedTaskId === resolvedTaskId) return output
  return [
    `Resolved task_id alias: ${requestedTaskId} -> ${resolvedTaskId}`,
    output,
  ].join('\n')
}

function aliasResolutionMetadata(requestedTaskId: string, resolvedTaskId: string): Record<string, unknown> {
  if (requestedTaskId === resolvedTaskId) return {}
  return {
    requested_task_id: requestedTaskId,
    resolved_task_id: resolvedTaskId,
  }
}

function formatStepLine(step: TaskStep): string {
  const icon = STEP_ICON[step.status] ?? '?'
  const label = `${icon} ${step.id} ${step.title} [${step.status}]`
  return step.failureReason ? `${label} ${step.failureReason}` : label
}

function formatNextStepSection(task: Task): string {
  const next = getCurrentOrNextStep(task.id)
  if (!next) return ''

  const lines = [`\nNext:`, `  ${next.id} ${next.title}`]
  if (next.expectedArtifacts.length > 0) {
    lines.push('  Expected artifacts:')
    for (const a of next.expectedArtifacts) {
      lines.push(`    - ${a.kind} ${a.origin} ${a.path}`)
    }
  }
  if (next.verification.length > 0) {
    lines.push('  Verification:')
    for (const v of next.verification) {
      if (v.kind === 'file_exists') lines.push(`    - file_exists ${v.path}`)
      else if (v.kind === 'file_contains') lines.push(`    - file_contains ${v.path} /${v.pattern}/`)
      else if (v.kind === 'artifact_count') lines.push(`    - artifact_count ${v.root} ${v.glob} min=${v.min}`)
      else if (v.kind === 'command') lines.push(`    - command ${v.command}`)
      else if (v.kind === 'none') lines.push(`    - none (${v.reason})`)
    }
  }
  return lines.join('\n')
}

function formatTaskOutput(task: Task): string {
  const lines = [
    `Task: ${task.id}`,
    `Subject: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ]
  if (task.activeForm) lines.push(`Active: ${task.activeForm}`)
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.join(', ')}`)
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(', ')}`)

  // Structured plan board (Slice 1)
  if (task.steps) {
    if (task.deliverables && task.deliverables.length > 0) {
      lines.push('\nDeliverables:')
      for (const d of task.deliverables) {
        lines.push(`  - ${d.kind} ${d.origin} ${d.path}`)
      }
    }
    lines.push('\nSteps:')
    for (const step of task.steps) {
      lines.push('  ' + formatStepLine(step))
    }
    lines.push(formatNextStepSection(task))
    return lines.join('\n')
  }

  // Command-backed tasks: surface command, exit code, and captured I/O.
  // Pure-todo tasks (no command) keep the original output shape.
  if (task.command !== undefined) {
    lines.push(`Command: ${task.command}`)
    const lifecycleLine = formatLongTaskLifecycleVerdictLine(task.longTaskSnapshot)
    if (lifecycleLine) lines.push(lifecycleLine)
    const processIdentityLine = formatLongTaskProcessIdentityLine(task.longTaskSnapshot)
    if (processIdentityLine) lines.push(processIdentityLine)
    const processLivenessLine = formatLongTaskProcessLivenessLine(task.longTaskSnapshot)
    if (processLivenessLine) lines.push(processLivenessLine)
    const waitPolicyLine = formatLongTaskWaitPolicyLine(task.longTaskSnapshot)
    if (waitPolicyLine) lines.push(waitPolicyLine)
    if (task.exitCode !== undefined) lines.push(`ExitCode: ${task.exitCode}`)
    if (task.error) lines.push(`Error: ${task.error}`)
    if (task.stdout && task.stdout.length > 0) {
      lines.push('--- stdout ---')
      lines.push(task.stdout.replace(/\n+$/, ''))
    }
    if (task.stderr && task.stderr.length > 0) {
      lines.push('--- stderr ---')
      lines.push(task.stderr.replace(/\n+$/, ''))
    }
  }
  return lines.join('\n')
}

function commandMetadata(task: Task): Record<string, unknown> {
  if (task.command === undefined) return {}
  return {
    command: task.command,
    stdout: task.stdout ?? '',
    stderr: task.stderr ?? '',
    exitCode: task.exitCode,
    ...(task.error ? { error: task.error } : {}),
  }
}

function buildTaskMeta(task: Task): Record<string, unknown> {
  const base: Record<string, unknown> = {
    task_id: task.id,
    status: task.status,
    description: task.description,
  }
  if (task.steps) {
    const nextStep = getCurrentOrNextStep(task.id)
    const completedCount = task.steps.filter(s => s.status === 'completed').length
    base.stepCount = task.steps.length
    base.completedSteps = completedCount
    base.currentStepId = task.currentStepId ?? null
    base.openStepCount = task.steps.filter(s =>
      s.status === 'pending' || s.status === 'in_progress' || s.status === 'failed' || s.status === 'blocked',
    ).length
    base.nextStep = nextStep ? {
      id: nextStep.id,
      title: nextStep.title,
      status: nextStep.status,
      expectedArtifacts: nextStep.expectedArtifacts,
      verification: nextStep.verification,
    } : null
  }
  if (task.longTaskSnapshot) {
    base.longTaskSnapshot = task.longTaskSnapshot
  }
  return base
}

function taskLifecycleMetadata(task: Task): Record<string, unknown> {
  const verdict = buildLongTaskLifecycleVerdict(task.longTaskSnapshot)
  const liveness = buildLongTaskProcessLiveness(task.longTaskSnapshot)
  return {
    ...(verdict ? { long_task_lifecycle: verdict } : {}),
    ...(liveness ? { process_liveness: liveness } : {}),
  }
}

export function createTaskOutputTool(): NativeToolDef<TaskOutputInput> {
  return {
    name: 'TaskOutput',
    description:
      'Read one task entry from the in-memory store, returning its current status snapshot. ' +
      'For structured task plans (created with steps), returns the execution board with step statuses ' +
      'and the next step to execute — block=true returns immediately for structured plans (no background producer). ' +
      'For command-backed tasks, returns captured stdout/stderr/exitCode. ' +
      'If a command-backed task was restored without a live process handle, block=true returns an incomplete snapshot immediately. ' +
      'For pure-TODO tasks (no command), block=true only resolves if TaskUpdate changes status to completed/cancelled. ' +
      'Metadata includes nextStep with expected artifacts and verification for structured plans.',
    maturity: 'beta' as const,

    async execute(input: TaskOutputInput): Promise<ToolResult> {
      const { task_id, block = true, timeout = 30000 } = input

      if (!task_id) {
        return { output: 'Error: task_id is required.', isError: true }
      }

      const resolvedTaskId = normalizeTaskId(task_id)
      const aliasMetadata = aliasResolutionMetadata(task_id, resolvedTaskId)
      const task = getTask(resolvedTaskId)
      if (!task) {
        return {
          output: prependAliasResolution(`Task "${task_id}" not found.`, task_id, resolvedTaskId),
          isError: true,
          metadata: aliasMetadata,
        }
      }

      // Structured plan: block=true returns immediately — there is no background producer
      const isStructuredPlan = task.steps !== undefined
      const isTerminal = task.status === 'completed' || task.status === 'cancelled'
      const isDetachedCommand = task.command !== undefined
        && task.status === 'in_progress'
        && !hasRunningProcess(task.id)

      if (block && isDetachedCommand) {
        return {
          output: prependAliasResolution([
            formatTaskOutput(task),
            '',
            'Runtime note: this command-backed task is in_progress, but OwlCoda has no live process handle in this process. It cannot be waited on; inspect captured output and rerun or replace the command if needed.',
          ].join('\n'), task_id, resolvedTaskId),
          isError: false,
          metadata: {
            ...aliasMetadata,
            retrieval_status: 'incomplete',
            ...taskLifecycleMetadata(task),
            task: {
              ...buildTaskMeta(task),
              ...commandMetadata(task),
            },
          },
        }
      }

      if (isTerminal || !block || isStructuredPlan) {
        return {
          output: prependAliasResolution(formatTaskOutput(task), task_id, resolvedTaskId),
          isError: false,
          metadata: {
            ...aliasMetadata,
            retrieval_status: 'success',
            ...taskLifecycleMetadata(task),
            task: {
              ...buildTaskMeta(task),
              ...(!isStructuredPlan ? commandMetadata(task) : {}),
            },
          },
        }
      }

      // Block: poll until terminal or timeout (command-backed / pure-TODO tasks only)
      const deadline = Date.now() + timeout
      const pollInterval = 500

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval))
        const current = getTask(resolvedTaskId)
        if (!current) {
          return {
            output: prependAliasResolution(`Task "${task_id}" was deleted while waiting.`, task_id, resolvedTaskId),
            isError: true,
            metadata: aliasMetadata,
          }
        }
        if (current.status === 'completed' || current.status === 'cancelled') {
          return {
            output: prependAliasResolution(formatTaskOutput(current), task_id, resolvedTaskId),
            isError: false,
            metadata: {
              ...aliasMetadata,
              retrieval_status: 'success',
              ...taskLifecycleMetadata(current),
              task: {
                ...buildTaskMeta(current),
                ...commandMetadata(current),
              },
            },
          }
        }
      }

      // Timeout — return current state
      const final = getTask(resolvedTaskId)
      return {
        output: prependAliasResolution(final
          ? [
              `Timeout waiting for task ${resolvedTaskId} (${timeout}ms). Current status: ${final.status}`,
              '',
              formatTaskOutput(final),
            ].join('\n')
          : `Timeout waiting for task ${resolvedTaskId} (${timeout}ms). Current status: unknown`, task_id, resolvedTaskId),
        isError: false,
        metadata: {
          ...aliasMetadata,
          retrieval_status: 'timeout',
          ...(final ? taskLifecycleMetadata(final) : {}),
          task: final ? buildTaskMeta(final) : null,
        },
      }
    },
  }
}
