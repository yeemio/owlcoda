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
import { getTask, type Task } from './task-store.js'

export interface TaskOutputInput {
  task_id: string
  /** Whether to wait for the task to complete (default: true) */
  block?: boolean
  /** Max wait time in ms (default: 30000) */
  timeout?: number
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
  return lines.join('\n')
}

export function createTaskOutputTool(): NativeToolDef<TaskOutputInput> {
  return {
    name: 'TaskOutput',
    description:
      'Get output from a task by ID. Optionally blocks until the task completes.',
    maturity: 'beta' as const,

    async execute(input: TaskOutputInput): Promise<ToolResult> {
      const { task_id, block = true, timeout = 30000 } = input

      if (!task_id) {
        return { output: 'Error: task_id is required.', isError: true }
      }

      const task = getTask(task_id)
      if (!task) {
        return { output: `Task "${task_id}" not found.`, isError: true }
      }

      const isTerminal = task.status === 'completed' || task.status === 'cancelled'

      if (isTerminal || !block) {
        return {
          output: formatTaskOutput(task),
          isError: false,
          metadata: {
            retrieval_status: 'success',
            task: {
              task_id: task.id,
              status: task.status,
              description: task.description,
            },
          },
        }
      }

      // Block: poll until terminal or timeout
      const deadline = Date.now() + timeout
      const pollInterval = 500

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval))
        const current = getTask(task_id)
        if (!current) {
          return { output: `Task "${task_id}" was deleted while waiting.`, isError: true }
        }
        if (current.status === 'completed' || current.status === 'cancelled') {
          return {
            output: formatTaskOutput(current),
            isError: false,
            metadata: {
              retrieval_status: 'success',
              task: {
                task_id: current.id,
                status: current.status,
                description: current.description,
              },
            },
          }
        }
      }

      // Timeout — return current state
      const final = getTask(task_id)
      return {
        output: `Timeout waiting for task ${task_id} (${timeout}ms). Current status: ${final?.status ?? 'unknown'}`,
        isError: false,
        metadata: {
          retrieval_status: 'timeout',
          task: final ? {
            task_id: final.id,
            status: final.status,
            description: final.description,
          } : null,
        },
      }
    },
  }
}
