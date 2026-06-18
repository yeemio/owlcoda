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
  /** Paths touched during this step (Slice 1). Appended to existing touchedPaths. */
  touchedPaths?: string[]
  /** Verification checks for this step (Slice 1). Replaces existing checks and clears stale results unless verificationResults is also supplied. */
  verification?: TaskVerificationCheck[]
  /** Verification results to record for this step (Slice 1). Replaces existing results. */
  verificationResults?: TaskVerificationResult[]
  /** Failure reason for failed/blocked steps (Slice 1). Required when stepStatus is 'failed' or 'blocked'. */
  failureReason?: string
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'deleted'])
const VALID_STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled'])

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
        stepId, stepStatus, touchedPaths, verification, verificationResults, failureReason,
      } = input

      if (!taskId) {
        return { output: 'taskId is required.', isError: true }
      }

      // Handle deletion
      if (status === 'deleted') {
        const deleted = deleteTask(taskId)
        if (!deleted) {
          return { output: `Task "${taskId}" not found.`, isError: true }
        }
        return {
          output: `Deleted task ${taskId}.`,
          isError: false,
          metadata: { taskId, action: 'deleted' },
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
            output: `Invalid stepStatus "${stepStatus}". Valid: pending, in_progress, completed, failed, blocked, cancelled.`,
            isError: true,
          }
        }

        const result = updateTaskStep(taskId, stepId, {
          status: stepStatus,
          touchedPaths,
          verification,
          verificationResults,
          failureReason,
        })

        if (!result.ok) {
          return { output: result.reason, isError: true }
        }

        const changes: string[] = []
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
          updateTask(taskId, {
            subject,
            description,
            status: status as TaskStatus | undefined,
            activeForm,
          })
        }

        return {
          output: `Updated task ${taskId} step ${stepId}: ${changes.join(', ') || 'no changes'}`,
          isError: false,
          metadata: { task: result.task, step: result.step, stepUpdate: true },
        }
      }

      // Task-level update path (original behavior)
      const task = updateTask(taskId, {
        subject,
        description,
        status: status as TaskStatus | undefined,
        activeForm,
      })

      if (!task) {
        return { output: `Task "${taskId}" not found.`, isError: true }
      }

      // Handle blocking changes
      if (addBlocks) {
        for (const blockedId of addBlocks) {
          blockTask(taskId, blockedId)
        }
      }
      if (removeBlocks) {
        const t = getTask(taskId)
        if (t) {
          for (const blockedId of removeBlocks) {
            t.blocks = t.blocks.filter(b => b !== blockedId)
            const blocked = getTask(blockedId)
            if (blocked) {
              blocked.blockedBy = blocked.blockedBy.filter(b => b !== taskId)
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
        output: `Updated task ${taskId}: ${changes.join(', ') || 'no changes'}`,
        isError: false,
        metadata: { task },
      }
    },
  }
}
