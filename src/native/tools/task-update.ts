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
import { updateTask, deleteTask, blockTask, getTask, type TaskStatus } from './task-store.js'

export interface TaskUpdateInput {
  taskId: string
  subject?: string
  description?: string
  status?: TaskStatus | 'deleted'
  activeForm?: string
  addBlocks?: string[]
  removeBlocks?: string[]
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'deleted'])

export function createTaskUpdateTool(): NativeToolDef<TaskUpdateInput> {
  return {
    name: 'TaskUpdate',
    description:
      'Update a task\'s fields — subject, description, status, or blocking relationships. ' +
      'Use status "deleted" to remove a task.',
    maturity: 'beta' as const,

    async execute(input: TaskUpdateInput): Promise<ToolResult> {
      const { taskId, subject, description, status, activeForm, addBlocks, removeBlocks } = input

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

      // Validate status
      if (status && !VALID_STATUSES.has(status)) {
        return {
          output: `Invalid status "${status}". Valid: pending, in_progress, completed, cancelled, blocked, deleted.`,
          isError: true,
        }
      }

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
