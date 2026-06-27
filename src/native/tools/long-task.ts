import {
  buildLongTaskLifecycleVerdict,
  formatLongTaskLifecycleVerdictLine,
  formatLongTaskReplacementPolicyLine,
  formatLongTaskWaitPolicyLine,
  getLongTaskSnapshot,
  recentLongTaskSnapshots,
  type LongTaskLifecycleVerdict,
  type LongTaskSnapshot,
} from '../long-task-lifecycle.js'
import { classifyBashCommand, primaryBashRiskReason } from '../bash-risk.js'
import { createTask, getTask, spawnTaskCommand } from './task-store.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface LongTaskListInput {
  limit?: number
}

export interface LongTaskGetInput {
  longTaskId: string
}

export interface LongTaskAwaitInput {
  longTaskId: string
  timeoutMs?: number
}

export interface LongTaskReplaceInput {
  longTaskId: string
  command?: string
  cwd?: string
  subject?: string
  description?: string
  reason?: string
}

const DEFAULT_LONG_TASK_LIMIT = 20
const MAX_LONG_TASK_LIMIT = 50

interface LongTaskRegistryEntry {
  snapshot: LongTaskSnapshot
  verdict: LongTaskLifecycleVerdict | undefined
}

export function createLongTaskListTool(): NativeToolDef<LongTaskListInput> {
  return {
    name: 'LongTaskList',
    description:
      'Read-only inspection of runtime-owned long-task lifecycle records for command-backed tasks and Agent runs. ' +
      'This reports status, supervision state, waitability, and inspect commands; it does not wait, resume, retry, or mutate work.',
    maturity: 'beta' as const,
    async execute(input: LongTaskListInput = {}, context?: ToolExecutionContext): Promise<ToolResult> {
      const limit = parsePositiveLimit(input.limit, DEFAULT_LONG_TASK_LIMIT)
      const snapshots = recentLongTaskSnapshots(limit, conversationFilter(context))
      if (snapshots.length === 0) {
        return {
          output: 'No long-task lifecycle records are available for this conversation.',
          isError: false,
          metadata: { long_tasks: [] },
        }
      }

      const entries = snapshots.map(toLongTaskRegistryEntry)
      return {
        output: entries.map(entry => formatLongTaskListLine(entry.snapshot)).join('\n'),
        isError: false,
        metadata: { long_tasks: entries },
      }
    },
  }
}

export function createLongTaskGetTool(): NativeToolDef<LongTaskGetInput> {
  return {
    name: 'LongTaskGet',
    description:
      'Read one runtime-owned long-task lifecycle record by longTaskId. Read-only; this does not wait, resume, retry, or mutate work.',
    maturity: 'beta' as const,
    async execute(input: LongTaskGetInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const longTaskId = typeof input?.longTaskId === 'string' ? input.longTaskId.trim() : ''
      if (!longTaskId) return { output: 'longTaskId is required.', isError: true }

      const snapshot = getLongTaskSnapshot(longTaskId)
      if (!snapshot || !matchesConversation(snapshot, context?.conversationId)) {
        return {
          output: `Long task "${longTaskId}" not found.`,
          isError: true,
          metadata: { longTaskId },
        }
      }

      return {
        output: formatLongTaskDetail(snapshot),
        isError: false,
        metadata: {
          snapshot,
          long_task_lifecycle: buildLongTaskLifecycleVerdict(snapshot),
        },
      }
    },
  }
}

export function createLongTaskAwaitTool(): NativeToolDef<LongTaskAwaitInput> {
  return {
    name: 'LongTaskAwait',
    description:
      'Runtime-managed bounded wait for one waitable long-task lifecycle record. ' +
      'Use this instead of Sleep or bash polling when LongTaskGet/LongTaskList wait_policy says runtime_await. ' +
      'Read-only; this does not resume, retry, or mutate work.',
    maturity: 'beta' as const,
    async execute(input: LongTaskAwaitInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const longTaskId = typeof input?.longTaskId === 'string' ? input.longTaskId.trim() : ''
      if (!longTaskId) return { output: 'longTaskId is required.', isError: true }

      const initial = getLongTaskSnapshot(longTaskId)
      if (!initial || !matchesConversation(initial, context?.conversationId)) {
        return {
          output: `Long task "${longTaskId}" not found.`,
          isError: true,
          metadata: { longTaskId },
        }
      }

      const initialVerdict = buildLongTaskLifecycleVerdict(initial)
      if (!initialVerdict) {
        return {
          output: `LongTaskAwait: not_waitable ${longTaskId}\n\nNo lifecycle verdict is available for this long task.`,
          isError: false,
          metadata: { await_status: 'not_waitable', snapshot: initial },
        }
      }

      if (initialVerdict.terminal) {
        return formatAwaitResult(initial.status, initial)
      }

      if (!initialVerdict.can_wait || initialVerdict.wait_policy.strategy !== 'runtime_await') {
        return formatAwaitResult('not_waitable', initial)
      }

      const waitMs = clampWaitMs(input.timeoutMs, initialVerdict.wait_policy.recommended_wait_ms, initialVerdict.wait_policy.max_wait_ms)
      const pollMs = Math.max(50, Math.min(initialVerdict.wait_policy.poll_interval_ms ?? 500, waitMs || 50))
      const deadline = Date.now() + waitMs
      let current = initial

      while (Date.now() < deadline) {
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
        const next = getLongTaskSnapshot(longTaskId)
        if (next && matchesConversation(next, context?.conversationId)) {
          current = next
          const verdict = buildLongTaskLifecycleVerdict(current)
          if (verdict?.terminal || !verdict?.can_wait) {
            return formatAwaitResult(current.status, current)
          }
        }
      }

      return formatAwaitResult('timeout', current)
    },
  }
}

export function createLongTaskReplaceTool(): NativeToolDef<LongTaskReplaceInput> {
  return {
    name: 'LongTaskReplace',
    description:
      'Start a classified replacement command task for a long-task record whose wait_policy is replace_or_retry. ' +
      'Only task_command records with a safe_readonly command are auto-replaceable; Agent records require an explicit new Agent call.',
    maturity: 'beta' as const,
    async execute(input: LongTaskReplaceInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const longTaskId = typeof input?.longTaskId === 'string' ? input.longTaskId.trim() : ''
      if (!longTaskId) return { output: 'longTaskId is required.', isError: true }

      const snapshot = getLongTaskSnapshot(longTaskId)
      if (!snapshot || !matchesConversation(snapshot, context?.conversationId)) {
        return {
          output: `Long task "${longTaskId}" not found.`,
          isError: true,
          metadata: { longTaskId },
        }
      }

      const verdict = buildLongTaskLifecycleVerdict(snapshot)
      const replacementPolicy = verdict?.replacement_policy
      if (!verdict || verdict.wait_policy.strategy !== 'replace_or_retry') {
        return replacementNotSupported(snapshot, 'This long task is not in replace_or_retry wait policy.')
      }

      if (snapshot.source === 'agent') {
        return replacementNotSupported(
          snapshot,
          'Agent records require an explicit new Agent call after inspecting the saved run; runtime will not replay an old Agent prompt automatically.',
        )
      }

      if (!replacementPolicy?.available || replacementPolicy.strategy !== 'task_command_replace') {
        return replacementNotSupported(snapshot, replacementPolicy?.reason ?? 'No replacement policy is available for this long task.')
      }

      const commandToRun = normalizeOptionalString(input.command) ?? snapshot.command?.trim()
      if (!commandToRun) {
        return {
          output: `LongTaskReplace: not_supported ${snapshot.longTaskId}\n\nNo original or replacement command is available.`,
          isError: false,
          metadata: {
            replacement_status: 'not_supported',
            original_long_task_id: snapshot.longTaskId,
            reason: 'missing_command',
          },
        }
      }

      const bashRisk = classifyBashCommand(commandToRun)
      if (bashRisk.level !== 'safe_readonly') {
        return {
          output:
            `LongTaskReplace refused by risk classifier: ${bashRisk.level} ` +
            `(${primaryBashRiskReason(bashRisk)}). Use an explicit bash call with operator approval for this command.`,
          isError: true,
          metadata: {
            replacement_status: 'refused',
            original_long_task_id: snapshot.longTaskId,
            bashRisk: {
              level: bashRisk.level,
              reasons: bashRisk.reasons,
              command: bashRisk.command,
            },
          },
        }
      }

      const replacementReason = normalizeOptionalString(input.reason)
        ?? replacementPolicy.reason
      const subject = normalizeOptionalString(input.subject)
        ?? `Replacement for ${snapshot.longTaskId}`
      const description = normalizeOptionalString(input.description)
        ?? `Runtime replacement for ${snapshot.longTaskId}: ${snapshot.objective}`
      const cwd = normalizeOptionalString(input.cwd) ?? snapshot.cwd

      const replacement = createTask({
        subject,
        description,
        command: commandToRun,
        cwd,
        conversationId: context?.conversationId ?? snapshot.conversationId,
        bashRisk,
        metadata: {
          replacementForLongTaskId: snapshot.longTaskId,
          replacementReason,
          replacementStartedAt: new Date().toISOString(),
          replacementSource: 'LongTaskReplace',
        },
      })
      spawnTaskCommand(replacement.id)
      const runningTask = getTask(replacement.id) ?? replacement
      const replacementLongTaskId = `task:${replacement.id}`

      return {
        output: [
          'LongTaskReplace: started replacement',
          `original_long_task_id=${snapshot.longTaskId}`,
          `replacement_long_task_id=${replacementLongTaskId}`,
          `replacement_task_id=${replacement.id}`,
          `command=${commandToRun}`,
          cwd ? `cwd=${cwd}` : '',
          '',
          formatLongTaskReplacementPolicyLine(snapshot),
          `TaskOutputCommand: TaskOutput task_id=${replacement.id} block=false`,
        ].filter(Boolean).join('\n'),
        isError: false,
        metadata: {
          replacement_status: 'started',
          original_long_task_id: snapshot.longTaskId,
          replacement_long_task_id: replacementLongTaskId,
          replacement_task_id: replacement.id,
          replacement_reason: replacementReason,
          command: commandToRun,
          ...(cwd ? { cwd } : {}),
          original_long_task_snapshot: snapshot,
          replacement_task: runningTask,
          bashRisk: {
            level: bashRisk.level,
            reasons: bashRisk.reasons,
          },
          ...(runningTask.longTaskSnapshot ? { longTaskSnapshot: runningTask.longTaskSnapshot } : {}),
        },
      }
    },
  }
}

function toLongTaskRegistryEntry(snapshot: LongTaskSnapshot): LongTaskRegistryEntry {
  return {
    snapshot,
    verdict: buildLongTaskLifecycleVerdict(snapshot),
  }
}

function formatLongTaskListLine(snapshot: LongTaskSnapshot): string {
  const verdict = buildLongTaskLifecycleVerdict(snapshot)
  const fields = [
    snapshot.longTaskId,
    `source=${snapshot.source}`,
    `status=${snapshot.status}`,
  ]
  if (verdict) {
    fields.push(
      `supervision_state=${verdict.supervision_state}`,
      `can_wait=${String(verdict.can_wait)}`,
      `terminal=${String(verdict.terminal)}`,
      `next_action=${verdict.next_action}`,
      `wait_strategy=${verdict.wait_policy.strategy}`,
    )
  }
  if (snapshot.taskId) fields.push(`task_id=${snapshot.taskId}`)
  if (snapshot.agentId) fields.push(`agent_id=${snapshot.agentId}`)
  if (snapshot.timeoutKind) fields.push(`timeout=${snapshot.timeoutKind}`)
  fields.push(`inspect="${escapeQuotedField(snapshot.inspectCommand)}"`)
  return fields.join(' ')
}

function formatLongTaskDetail(snapshot: LongTaskSnapshot): string {
  const lines = [
    `Long task ${snapshot.longTaskId}`,
    `source=${snapshot.source}`,
    `status=${snapshot.status}`,
    `objective=${snapshot.objective}`,
    `startedAt=${snapshot.startedAt}`,
    `updatedAt=${snapshot.updatedAt}`,
  ]
  if (snapshot.finishedAt) lines.push(`finishedAt=${snapshot.finishedAt}`)
  if (snapshot.conversationId) lines.push(`conversationId=${snapshot.conversationId}`)
  if (snapshot.taskId) lines.push(`taskId=${snapshot.taskId}`)
  if (snapshot.agentId) lines.push(`agentId=${snapshot.agentId}`)
  if (snapshot.agentType) lines.push(`agentType=${snapshot.agentType}`)
  if (snapshot.model) lines.push(`model=${snapshot.model}`)
  if (snapshot.command) lines.push(`command=${snapshot.command}`)
  if (snapshot.cwd) lines.push(`cwd=${snapshot.cwd}`)
  if (snapshot.promptSnippet) lines.push(`prompt=${snapshot.promptSnippet}`)
  if (snapshot.timeoutKind) lines.push(`timeoutKind=${snapshot.timeoutKind}`)
  const lifecycleLine = formatLongTaskLifecycleVerdictLine(snapshot)
  if (lifecycleLine) lines.push(lifecycleLine)
  const waitPolicyLine = formatLongTaskWaitPolicyLine(snapshot)
  if (waitPolicyLine) lines.push(waitPolicyLine)
  const replacementPolicyLine = formatLongTaskReplacementPolicyLine(snapshot)
  if (replacementPolicyLine) lines.push(replacementPolicyLine)
  lines.push(`Inspect: ${snapshot.inspectCommand}`)
  if (snapshot.lastProgress) lines.push(`Last progress: ${snapshot.lastProgress}`)
  if (snapshot.outputSnippet) {
    lines.push('Output snippet:')
    lines.push(snapshot.outputSnippet)
  }
  return lines.join('\n')
}

function conversationFilter(context?: ToolExecutionContext): { conversationId?: string } {
  return context?.conversationId ? { conversationId: context.conversationId } : {}
}

function matchesConversation(snapshot: LongTaskSnapshot, conversationId: string | undefined): boolean {
  return conversationId === undefined || snapshot.conversationId === conversationId
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), MAX_LONG_TASK_LIMIT)
}

function clampWaitMs(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  const requested = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
  return Math.max(0, Math.min(requested, max))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatAwaitResult(awaitStatus: string, snapshot: LongTaskSnapshot): ToolResult {
  return {
    output: [
      `LongTaskAwait: ${awaitStatus} ${snapshot.longTaskId}`,
      '',
      formatLongTaskDetail(snapshot),
    ].join('\n'),
    isError: false,
    metadata: {
      await_status: awaitStatus,
      snapshot,
      long_task_lifecycle: buildLongTaskLifecycleVerdict(snapshot),
    },
  }
}

function replacementNotSupported(snapshot: LongTaskSnapshot, reason: string): ToolResult {
  return {
    output: [
      `LongTaskReplace: not_supported ${snapshot.longTaskId}`,
      '',
      reason,
      snapshot.source === 'agent'
        ? 'Agent records require an explicit new Agent call; inspect the record first and include the recovered prompt/context deliberately.'
        : '',
      formatLongTaskReplacementPolicyLine(snapshot),
    ].filter(Boolean).join('\n'),
    isError: false,
    metadata: {
      replacement_status: 'not_supported',
      original_long_task_id: snapshot.longTaskId,
      reason,
    },
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function escapeQuotedField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
