/**
 * OwlCoda Native TaskStop Tool
 *
 * Stops a task by setting its status to cancelled and, for
 * command-backed tasks, SIGTERM'ing the associated child process.
 *
 * Upstream parity notes:
 * - Upstream kills background processes, supports shell_id alias
 * - Our version: marks task as cancelled and signals command-backed
 *   child processes tracked in task-store.ts
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
    description:
      'Cancel one task entry in the in-memory task store. For command-backed tasks created by TaskCreate(command=...), ' +
      'this also sends SIGTERM to the tracked child process before preserving status="cancelled". For pure-TODO tasks ' +
      '(no command), it only records the cancellation because there is no process to signal. This does NOT cancel Agent ' +
      'sub-conversations, remote jobs, cron entries, HTTP requests, or arbitrary shells that were not launched by TaskCreate. ' +
      'Use this when you want to stop a TaskCreate-launched safe_readonly command or mark planned work as abandoned; ' +
      'use TaskUpdate(status="deleted") to remove the entry after cancellation.',
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
