/**
 * OwlCoda Native TaskList Tool
 *
 * Lists all tasks in the session task list.
 *
 * Upstream parity notes:
 * - Upstream lists tasks with owner, team context, blockedBy
 * - Our version: flat list from in-memory store
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { listTasks } from './task-store.js'

export interface TaskListInput {
  // No parameters required
}

export function createTaskListTool(): NativeToolDef<TaskListInput> {
  return {
    name: 'TaskList',
    description: 'List all tasks in the session task list with their status.',
    maturity: 'beta' as const,

    async execute(_input: TaskListInput): Promise<ToolResult> {
      const tasks = listTasks()

      if (tasks.length === 0) {
        return {
          output: 'No tasks found.',
          isError: false,
          metadata: { tasks: [] },
        }
      }

      const lines = tasks.map(t => {
        const statusIcon =
          t.status === 'completed' ? '✓' :
          t.status === 'in_progress' ? '⏳' :
          t.status === 'blocked' ? '🚫' :
          t.status === 'cancelled' ? '✗' : '○'
        const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : ''
        return `${statusIcon} ${t.id}: ${t.subject} [${t.status}]${blocked}`
      })

      return {
        output: `Tasks (${tasks.length}):\n${lines.join('\n')}`,
        isError: false,
        metadata: {
          tasks: tasks.map(t => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            blockedBy: t.blockedBy,
          })),
        },
      }
    },
  }
}
