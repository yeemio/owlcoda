/**
 * OwlCoda Native TaskCreate Tool
 *
 * Creates a new task in the session task list.
 *
 * Upstream parity notes:
 * - Upstream creates tasks with hooks, teammate ownership, task lists
 * - Our version: in-memory task store, same input/output shape
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { createTask } from './task-store.js'

export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

export function createTaskCreateTool(): NativeToolDef<TaskCreateInput> {
  return {
    name: 'TaskCreate',
    description:
      'Create a new task in the session task list. Tasks track work items ' +
      'with status (pending, in_progress, completed, cancelled, blocked).',
    maturity: 'beta' as const,

    async execute(input: TaskCreateInput): Promise<ToolResult> {
      const { subject, description, activeForm, metadata } = input

      if (!subject || !description) {
        return {
          output: 'Both subject and description are required.',
          isError: true,
        }
      }

      const task = createTask({ subject, description, activeForm, metadata })

      return {
        output: `Created task ${task.id}: "${task.subject}"`,
        isError: false,
        metadata: { task: { id: task.id, subject: task.subject } },
      }
    },
  }
}
