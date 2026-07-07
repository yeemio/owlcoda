/**
 * OwlCoda Native TaskUpdate Tool
 *
 * Updates an existing task's fields (subject, description, status, etc.).
 *
 * Upstream parity notes:
 * - Upstream supports addBlocks/removeBlocks, teammate mailbox writes
 * - Supports 'deleted' as a special status that removes the task
 * - Our version: same update operations, simplified blocking
 */

import type { NativeToolDef, ToolResult } from './types.js'
import {
  updateTask,
  deleteTask,
  blockTask,
  getTask,
  updateTaskStep,
  type TaskStatus,
  type TaskStepStatus,
  type TaskVerificationCheck,
  type TaskVerificationResult,
} from './task-store.js'
import { findUnsafeVerificationCommand } from './task-verification-policy.js'

export interface TaskUpdateInput {
  taskId: string
  subject?: string
  description?: string
  status?: TaskStatus | 'deleted'
  activeForm?: string
  addBlocks?: string[]
  removeBlocks?: string[]
  /** Step ID to update (Slice 1). If present, performs a step-level update. */
  stepId?: string
  /** New status for the step (Slice 1). */
  stepStatus?: TaskStepStatus
  /** Complete the existing active step before moving this step to in_progress, if completion is legal. */
  completePrevious?: boolean
  /** Paths touched during this step (Slice 1). Appended to existing touchedPaths. */
  touchedPaths?: string[]
  /** Verification checks for this step (Slice 1). Replaces existing checks and clears stale results unless verificationResults is also supplied. */
  verification?: TaskVerificationCheck[]
  /** Verification results to record for this step (Slice 1). Replaces existing results. */
  verificationResults?: TaskVerificationResult[]
  /** Failure reason for failed/blocked/skipped steps (Slice 1). Required when stepStatus is 'failed', 'blocked', or 'skipped'. */
  failureReason?: string
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'deleted'])
const VALID_STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'skipped', 'cancelled'])

function formatStepUpdateFailure(result: Extract<ReturnType<typeof updateTaskStep>, { ok: false }>): ToolResult {
  if (!result.repairHint) {
    return { output: result.reason, isError: true }
  }

  return {
    output: [
      result.reason,
      `repairHint=${JSON.stringify(result.repairHint)}`,
      'To advance, first resolve the active step, then retry the requested step:',
      ...result.repairHint.commands.map(command => `  ${command}`),
    ].join('\n'),
    isError: true,
    metadata: {
      code: result.code,
      repairHint: result.repairHint,
    },
  }
}

export function createTaskUpdateTool(): NativeToolDef<TaskUpdateInput> {
  return {
    name: 'TaskUpdate',
    description:
      'Mutate one entry in the in-memory TODO tracker — change its subject, description, status, ' +
      'activeForm, or blocking relationships (status "deleted" removes the entry). ' +
      'For pure-TODO tasks this is the only way status advances. For command-backed TaskCreate entries, ' +
      'the command runner moves status to in_progress/completed/cancelled and records stdout/stderr/exitCode, ' +
      'but TaskUpdate remains the manual way to annotate, block, unblock, or correct the user-visible task record. ' +
      'No scheduler watches these tasks, and TaskUpdate itself never executes work. Use this every time you finish ' +
      'a non-command step, start a manual step, or abandon/remove one so the user sees accurate progress. For actually ' +
      'executing work, use Bash, Edit, Write, Agent, TaskCreate(command=...) for safe_readonly commands, or another execution tool first.',
    maturity: 'beta' as const,

    async execute(input: TaskUpdateInput): Promise<ToolResult> {
      const {
        taskId, subject, description, status, activeForm, addBlocks, removeBlocks,
        stepId, stepStatus, completePrevious, touchedPaths, verification, verificationResults, failureReason,
      } = input

      if (!taskId) {
        return { output: 'taskId is required.', isError: true }
      }
      const requestedTaskId = taskId
      const resolvedTaskId = normalizeTaskUpdateTaskId(taskId)

      // Handle deletion
      if (status === 'deleted') {
        const deleted = deleteTask(resolvedTaskId)
        if (!deleted) {
          return missingTaskResult(requestedTaskId, resolvedTaskId)
        }
        return {
          output: prependTaskIdAlias(`Deleted task ${resolvedTaskId}.`, requestedTaskId, resolvedTaskId),
          isError: false,
          metadata: { taskId: resolvedTaskId, action: 'deleted', ...taskIdAliasMetadata(requestedTaskId, resolvedTaskId) },
        }
      }

      // Validate task-level status
      if (status && !VALID_STATUSES.has(status)) {
        return {
          output: `Invalid status "${status}". Valid: pending, in_progress, completed, cancelled, blocked, deleted.`,
          isError: true,
        }
      }

      // Step-level update path (Slice 1)
      if (stepId !== undefined) {
        if (stepStatus !== undefined && !VALID_STEP_STATUSES.has(stepStatus)) {
          return {
            output: `Invalid stepStatus "${stepStatus}". Valid: pending, in_progress, completed, failed, blocked, skipped, cancelled.`,
            isError: true,
          }
        }
        const unsafeVerification = findUnsafeVerificationCommand(verification)
        if (unsafeVerification) {
          return {
            output: unsafeVerification.reason,
            isError: true,
          }
        }

        const result = updateTaskStep(resolvedTaskId, stepId, {
          status: stepStatus,
          completePrevious,
          touchedPaths,
          verification,
          verificationResults,
          failureReason,
        })

        if (!result.ok) {
          if (result.reason === `Task "${resolvedTaskId}" not found.`) {
            return missingTaskResult(requestedTaskId, resolvedTaskId)
          }
          return formatStepUpdateFailure(result)
        }

        const changes: string[] = []
        if (result.completedPreviousStepId) changes.push(`completedPrevious=${result.completedPreviousStepId}`)
        if (stepStatus) changes.push(`status=${stepStatus}`)
        if (touchedPaths?.length) changes.push(`touchedPaths +${touchedPaths.length}`)
        if (verification) changes.push(`verification spec ${verification.length} checks`)
        if (verificationResults?.length) {
          const passed = verificationResults.filter(r => r.passed).length
          changes.push(`verification ${passed}/${verificationResults.length} passed`)
        }
        if (failureReason) changes.push('failureReason set')

        // Also apply task-level changes if any were requested alongside step update
        if (subject || description || status || activeForm) {
          updateTask(resolvedTaskId, {
            subject,
            description,
            status: status as TaskStatus | undefined,
            activeForm,
          })
        }

        return {
          output: prependTaskIdAlias(
            `Updated task ${resolvedTaskId} step ${stepId}: ${changes.join(', ') || 'no changes'}`,
            requestedTaskId,
            resolvedTaskId,
          ),
          isError: false,
          metadata: {
            task: result.task,
            step: result.step,
            stepUpdate: true,
            ...(result.completedPreviousStepId ? { completedPreviousStepId: result.completedPreviousStepId } : {}),
            ...taskIdAliasMetadata(requestedTaskId, resolvedTaskId),
          },
        }
      }

      // Task-level update path (original behavior)
      const task = updateTask(resolvedTaskId, {
        subject,
        description,
        status: status as TaskStatus | undefined,
        activeForm,
      })

      if (!task) {
        return missingTaskResult(requestedTaskId, resolvedTaskId)
      }

      // Handle blocking changes
      if (addBlocks) {
        for (const blockedId of addBlocks) {
          blockTask(resolvedTaskId, blockedId)
        }
      }
      if (removeBlocks) {
        const t = getTask(resolvedTaskId)
        if (t) {
          for (const blockedId of removeBlocks) {
            t.blocks = t.blocks.filter(b => b !== blockedId)
            const blocked = getTask(blockedId)
            if (blocked) {
              blocked.blockedBy = blocked.blockedBy.filter(b => b !== resolvedTaskId)
            }
          }
        }
      }

      const changes: string[] = []
      if (subject) changes.push(`subject="${subject}"`)
      if (description) changes.push('description updated')
      if (status) changes.push(`status=${status}`)
      if (activeForm) changes.push(`activeForm="${activeForm}"`)
      if (addBlocks?.length) changes.push(`blocks +${addBlocks.join(',')}`)
      if (removeBlocks?.length) changes.push(`blocks -${removeBlocks.join(',')}`)

      return {
        output: prependTaskIdAlias(
          `Updated task ${resolvedTaskId}: ${changes.join(', ') || 'no changes'}`,
          requestedTaskId,
          resolvedTaskId,
        ),
        isError: false,
        metadata: { task, ...taskIdAliasMetadata(requestedTaskId, resolvedTaskId) },
      }
    },
  }
}

function normalizeTaskUpdateTaskId(value: string): string {
  if (value.startsWith('task:')) return value.slice('task:'.length)
  const short = /^t-(\d+)$/.exec(value)
  if (short) return `task-${short[1]}`
  return value
}

function prependTaskIdAlias(output: string, requestedTaskId: string, resolvedTaskId: string): string {
  if (requestedTaskId === resolvedTaskId) return output
  return [
    `Resolved taskId alias: ${requestedTaskId} -> ${resolvedTaskId}`,
    output,
  ].join('\n')
}

function taskIdAliasMetadata(requestedTaskId: string, resolvedTaskId: string): Record<string, unknown> {
  if (requestedTaskId === resolvedTaskId) return {}
  return {
    requested_task_id: requestedTaskId,
    resolved_task_id: resolvedTaskId,
  }
}

function missingTaskResult(requestedTaskId: string, resolvedTaskId: string): ToolResult {
  return {
    output: prependTaskIdAlias(
      `Task "${resolvedTaskId}" not found. Call TaskList to inspect existing task IDs or TaskCreate to create a new task; do not retry TaskUpdate with guessed IDs.`,
      requestedTaskId,
      resolvedTaskId,
    ),
    isError: true,
    metadata: {
      missingTask: true,
      recoveryAction: 'inspect_or_create_task',
      suggestedTools: ['TaskList', 'TaskCreate'],
      ...taskIdAliasMetadata(requestedTaskId, resolvedTaskId),
    },
  }
}
