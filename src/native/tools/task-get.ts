/**
 * OwlCoda Native TaskGet Tool
 *
 * Retrieves a single task by ID with full details.
 *
 * Upstream parity notes:
 * - Upstream returns task with blocks/blockedBy arrays, owner info
 * - Our version: same shape from in-memory store
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { getTask } from './task-store.js'

export interface TaskGetInput {
  taskId: string
}

export function createTaskGetTool(): NativeToolDef<TaskGetInput> {
  return {
    name: 'TaskGet',
    description: 'Retrieve a task by ID with full details.',
    maturity: 'beta' as const,

    async execute(input: TaskGetInput): Promise<ToolResult> {
      const { taskId } = input
      if (!taskId) {
        return { output: 'taskId is required.', isError: true }
      }

      const task = getTask(taskId)
      if (!task) {
        return {
          output: `Task "${taskId}" not found.`,
          isError: true,
        }
      }

      const lines = [
        `ID: ${task.id}`,
        `Subject: ${task.subject}`,
        `Status: ${task.status}`,
        `Description: ${task.description}`,
      ]
      if (task.activeForm) lines.push(`Active form: ${task.activeForm}`)
      if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.join(', ')}`)
      if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(', ')}`)
      lines.push(`Created: ${task.createdAt}`)
      lines.push(`Updated: ${task.updatedAt}`)

      return {
        output: lines.join('\n'),
        isError: false,
        metadata: { task },
      }
    },
  }
}
