/**
 * OwlCoda Native TaskStop Tool
 *
 * Stops a running task by setting its status to cancelled.
 *
 * Upstream parity notes:
 * - Upstream kills background processes, supports shell_id alias
 * - Our version: marks task as cancelled in the store
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { stopTask, getTask } from './task-store.js'

export interface TaskStopInput {
  task_id?: string
  /** Deprecated alias for task_id. */
  shell_id?: string
}

export function createTaskStopTool(): NativeToolDef<TaskStopInput> {
  return {
    name: 'TaskStop',
    description: 'Stop a running background task by setting it to cancelled.',
    maturity: 'beta' as const,

    async execute(input: TaskStopInput): Promise<ToolResult> {
      const taskId = input.task_id ?? input.shell_id
      if (!taskId) {
        return { output: 'task_id is required.', isError: true }
      }

      const existing = getTask(taskId)
      if (!existing) {
        return { output: `Task "${taskId}" not found.`, isError: true }
      }

      if (existing.status === 'completed' || existing.status === 'cancelled') {
        return {
          output: `Task ${taskId} is already ${existing.status}.`,
          isError: false,
          metadata: { task_id: taskId, task_type: 'task', status: existing.status },
        }
      }

      const task = stopTask(taskId)
      if (!task) {
        return { output: `Failed to stop task "${taskId}".`, isError: true }
      }

      return {
        output: `Stopped task ${taskId}: "${task.subject}"`,
        isError: false,
        metadata: {
          message: `Task ${taskId} cancelled`,
          task_id: taskId,
          task_type: 'task',
          command: task.description,
        },
      }
    },
  }
}
