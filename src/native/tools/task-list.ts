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
    description:
      'List the entries in the in-memory TODO tracker that backs TaskCreate / TaskUpdate. ' +
      'This does NOT discover background processes, scheduled jobs, or remote agents — ' +
      'the only tasks visible here are the ones explicitly recorded via TaskCreate in this session, ' +
      'and their status is whatever was last written via TaskUpdate (nothing advances on its own). ' +
      'Use this to review the planning surface you have been maintaining for the user. ' +
      'For listing live shells, use Bash with the appropriate inspection command; for parallel work units, use Agent.',
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
          t.status === 'in_progress' ? '▶' :
          t.status === 'blocked' ? '!' :
          t.status === 'cancelled' ? '✗' : '○'
        const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : ''

        // Show step progress for structured plans
        let stepSuffix = ''
        if (t.steps && t.steps.length > 0) {
          const completed = t.steps.filter(s => s.status === 'completed').length
          const blockedSteps = t.steps.filter(s => s.status === 'blocked').length
          const skippedSteps = t.steps.filter(s => s.status === 'skipped').length
          const currentStep = t.currentStepId ? ` current=${t.currentStepId}` : ''
          const stepParts = [`steps ${completed}/${t.steps.length}`]
          if (blockedSteps > 0) stepParts.push(`${blockedSteps} blocked`)
          if (skippedSteps > 0) stepParts.push(`${skippedSteps} skipped`)
          stepSuffix = ` ${stepParts.join(' · ')}${currentStep}`
        }

        return `${statusIcon} ${t.id}: ${t.subject} [${t.status}]${stepSuffix}${blocked}`
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
            stepCount: t.steps?.length ?? 0,
            completedSteps: t.steps?.filter(s => s.status === 'completed').length ?? 0,
            blockedSteps: t.steps?.filter(s => s.status === 'blocked').length ?? 0,
            skippedSteps: t.steps?.filter(s => s.status === 'skipped').length ?? 0,
            currentStepId: t.currentStepId ?? null,
          })),
        },
      }
    },
  }
}
