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
import { getTask, getCurrentOrNextStep, taskHasOpenRequiredSteps } from './task-store.js'

const TASK_GET_PREVIEW_MAX_BYTES = 1024
const TASK_GET_PREVIEW_TAIL_LINES = 12

/**
 * Format a captured stdout/stderr stream as an inline preview for TaskGet.
 * Shows the last few lines (where errors usually live) up to a byte cap;
 * full content remains available via TaskOutput.
 */
function previewStream(text: string): string {
  const trimmed = text.length > TASK_GET_PREVIEW_MAX_BYTES
    ? '… [truncated, ' + (text.length - TASK_GET_PREVIEW_MAX_BYTES) + ' more bytes]\n'
      + text.slice(text.length - TASK_GET_PREVIEW_MAX_BYTES)
    : text
  const lines = trimmed.split('\n')
  if (lines.length <= TASK_GET_PREVIEW_TAIL_LINES) return trimmed.trimEnd()
  return '… [head elided]\n' + lines.slice(-TASK_GET_PREVIEW_TAIL_LINES).join('\n').trimEnd()
}

export interface TaskGetInput {
  taskId: string
}

export function createTaskGetTool(): NativeToolDef<TaskGetInput> {
  return {
    name: 'TaskGet',
    description:
      'Read one entry from the in-memory TODO tracker that backs TaskCreate / TaskUpdate, by its taskId. ' +
      'It returns the subject/description/status/blocking fields and, in metadata, the full task record. ' +
      'For command-backed tasks, use TaskOutput to read captured stdout/stderr/exitCode; TaskGet is the metadata view, ' +
      'not the output stream. For pure-TODO tasks, there is no execution output because no command was attached. ' +
      'Use this when you need the full record for a task you (or a previous turn) created via TaskCreate. For file content use Read.',
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

      // Structured task plan (Slice 1)
      if (task.steps && task.steps.length > 0) {
        const completedCount = task.steps.filter(s => s.status === 'completed').length
        lines.push(`Steps: ${completedCount}/${task.steps.length} completed`)
        if (task.deliverables && task.deliverables.length > 0) {
          lines.push('Deliverables:')
          for (const d of task.deliverables) {
            lines.push(`  - ${d.kind} ${d.origin} ${d.path}`)
          }
        }
        lines.push('Step details:')
        for (const step of task.steps) {
          const icon = { pending: '○', in_progress: '▶', completed: '✓', failed: '✗', blocked: '!', cancelled: '-' }[step.status] ?? '?'
          lines.push(`  ${icon} ${step.id}: ${step.title} [${step.status}]`)
          if (step.description) lines.push(`    ${step.description}`)
          if (step.touchedPaths.length > 0) lines.push(`    touchedPaths: ${step.touchedPaths.join(', ')}`)
          if (step.verificationResults.length > 0) {
            const p = step.verificationResults.filter(r => r.passed).length
            lines.push(`    verification: ${p}/${step.verificationResults.length} passed`)
          }
          if (step.failureReason) lines.push(`    failureReason: ${step.failureReason}`)
        }
        const nextStep = getCurrentOrNextStep(task.id)
        if (nextStep) {
          lines.push(`Next step: ${nextStep.id} ${nextStep.title}`)
          if (nextStep.expectedArtifacts.length > 0) {
            lines.push('  Expected artifacts:')
            for (const a of nextStep.expectedArtifacts) lines.push(`    - ${a.kind} ${a.origin} ${a.path}`)
          }
          if (nextStep.verification.length > 0) {
            lines.push('  Verification:')
            for (const v of nextStep.verification) lines.push(`    - ${v.kind} ${v.path ?? v.root ?? ''}`)
          }
        }
      } else {
        // Command-backed tasks: surface execution result inline.
        if (typeof task.exitCode === 'number') {
          lines.push(`ExitCode: ${task.exitCode}`)
        }
        if (task.stdout && task.stdout.length > 0) {
          lines.push(`Stdout (${task.stdout.length} bytes):`)
          lines.push(previewStream(task.stdout))
        }
        if (task.stderr && task.stderr.length > 0) {
          lines.push(`Stderr (${task.stderr.length} bytes):`)
          lines.push(previewStream(task.stderr))
        }
      }

      lines.push(`Created: ${task.createdAt}`)
      lines.push(`Updated: ${task.updatedAt}`)

      // Build next-step metadata for structured plans (Slice 2 prep)
      const nextStep = task.steps ? getCurrentOrNextStep(task.id) : undefined
      const metaTask = {
        ...task,
        ...(task.steps ? {
          stepCount: task.steps.length,
          completedSteps: task.steps.filter(s => s.status === 'completed').length,
          hasOpenRequiredSteps: taskHasOpenRequiredSteps(task),
          nextStep: nextStep ? {
            id: nextStep.id,
            title: nextStep.title,
            status: nextStep.status,
            expectedArtifacts: nextStep.expectedArtifacts,
            verification: nextStep.verification,
          } : null,
        } : {}),
      }

      return {
        output: lines.join('\n'),
        isError: false,
        metadata: { task: metaTask },
      }
    },
  }
}
