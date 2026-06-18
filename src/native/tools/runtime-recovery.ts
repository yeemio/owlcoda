import type { RuntimeRecoveryCheckpointRecord } from '../protocol/types.js'
import { getUnresolvedRuntimeRecoveryCheckpoints } from '../runtime-recovery-ledger.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface RuntimeRecoveryListInput {
  limit?: number
  includeResolved?: boolean
}

export interface RuntimeRecoveryGetInput {
  checkpointId: string
}

export function createRuntimeRecoveryListTool(): NativeToolDef<RuntimeRecoveryListInput> {
  return {
    name: 'RuntimeRecoveryList',
    description:
      'List durable runtime recovery checkpoints for the current conversation. Read-only; this does not resume, retry, or mutate tasks, agents, or background work.',
    maturity: 'beta' as const,
    async execute(input: RuntimeRecoveryListInput = {}, context?: ToolExecutionContext): Promise<ToolResult> {
      const checkpoints = input.includeResolved
        ? checkpointsFromContext(context)
        : getUnresolvedRuntimeRecoveryCheckpoints(context?.runtimeRecoveryLedger)
      if (checkpoints.length === 0) {
        return {
          output: input.includeResolved
            ? 'No runtime recovery checkpoints are available for this conversation.'
            : 'No unresolved runtime recovery checkpoints are available for this conversation.',
          isError: false,
          metadata: { checkpoints: [] },
        }
      }
      const limit = parsePositiveLimit(input.limit, 20)
      const selected = checkpoints.slice(-limit)
      return {
        output: selected.map(formatCheckpointSummary).join('\n'),
        isError: false,
        metadata: { checkpoints: selected },
      }
    },
  }
}

export function createRuntimeRecoveryGetTool(): NativeToolDef<RuntimeRecoveryGetInput> {
  return {
    name: 'RuntimeRecoveryGet',
    description:
      'Read one durable runtime recovery checkpoint by checkpointId. Read-only; this does not resume, retry, or mutate tasks, agents, or background work.',
    maturity: 'beta' as const,
    async execute(input: RuntimeRecoveryGetInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const checkpointId = typeof input?.checkpointId === 'string' ? input.checkpointId.trim() : ''
      if (!checkpointId) return { output: 'checkpointId is required.', isError: true }
      const checkpoint = checkpointsFromContext(context).find((item) => item.id === checkpointId)
      if (!checkpoint) {
        return {
          output: `Runtime recovery checkpoint "${checkpointId}" not found in the current conversation ledger.`,
          isError: true,
          metadata: { checkpointId },
        }
      }
      return {
        output: formatCheckpointDetail(checkpoint),
        isError: false,
        metadata: { checkpoint },
      }
    },
  }
}

function checkpointsFromContext(context?: ToolExecutionContext): RuntimeRecoveryCheckpointRecord[] {
  return context?.runtimeRecoveryLedger?.checkpoints ?? []
}

function formatCheckpointSummary(checkpoint: RuntimeRecoveryCheckpointRecord): string {
  const inspect = checkpoint.inspectCommands.length > 0
    ? ` inspect=${checkpoint.inspectCommands.join(' | ')}`
    : ''
  const target = checkpointTargetLabel(checkpoint)
  return `${checkpoint.id} kind=${checkpoint.kind} disposition=${checkpoint.disposition ?? 'active'} generated=${checkpoint.generatedAt}${target ? ` target=${target}` : ''}${inspect}`
}

function formatCheckpointDetail(checkpoint: RuntimeRecoveryCheckpointRecord): string {
  const lines = [
    `ID: ${checkpoint.id}`,
    `Kind: ${checkpoint.kind}`,
    `Disposition: ${checkpoint.disposition ?? 'active'}`,
    `Conversation: ${checkpoint.conversationId}`,
    `Generated: ${checkpoint.generatedAt}`,
  ]
  if (checkpoint.dispositionUpdatedAt) lines.push(`Disposition updated: ${checkpoint.dispositionUpdatedAt}`)
  if (checkpoint.dispositionReason) lines.push(`Disposition reason: ${checkpoint.dispositionReason}`)
  if (checkpoint.inspectCommands.length > 0) {
    lines.push('Inspect commands:')
    for (const command of checkpoint.inspectCommands) lines.push(`  - ${command}`)
  }
  lines.push('Payload:')
  lines.push(JSON.stringify(checkpoint.payload, null, 2))
  return lines.join('\n')
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded <= 0) return fallback
  return Math.min(rounded, 20)
}

function checkpointTargetLabel(checkpoint: RuntimeRecoveryCheckpointRecord): string | null {
  if (checkpoint.kind === 'blocked_task_checkpoint') {
    const blocked = objectField(checkpoint.payload['blocked_task'])
    const taskId = stringField(blocked?.['task_id'])
    const stepId = stringField(blocked?.['step_id'])
    return taskId && stepId ? `${taskId}/${stepId}` : null
  }
  if (checkpoint.kind === 'long_task_checkpoint') {
    const tasks = Array.isArray(checkpoint.payload['long_tasks']) ? checkpoint.payload['long_tasks'] : []
    const ids = tasks
      .map((item) => stringField(objectField(item)?.['long_task_id']))
      .filter((value): value is string => Boolean(value))
    return ids.length > 0 ? ids.join(',') : null
  }
  if (checkpoint.kind === 'child_run_synthesis_checkpoint') {
    const children = Array.isArray(checkpoint.payload['children']) ? checkpoint.payload['children'] : []
    const ids = children
      .map((item) => stringField(objectField(item)?.['agent_id']))
      .filter((value): value is string => Boolean(value))
    return ids.length > 0 ? ids.join(',') : null
  }
  if (checkpoint.kind === 'long_task_synthesis_checkpoint') {
    const tasks = Array.isArray(checkpoint.payload['long_tasks']) ? checkpoint.payload['long_tasks'] : []
    const ids = tasks
      .map((item) => stringField(objectField(item)?.['long_task_id']))
      .filter((value): value is string => Boolean(value))
    return ids.length > 0 ? ids.join(',') : null
  }
  if (checkpoint.kind === 'long_task_replacement_checkpoint') {
    const replacement = objectField(checkpoint.payload['replacement'])
    const originalLongTaskId = stringField(replacement?.['original_long_task_id'])
      ?? stringField(replacement?.['originalLongTaskId'])
    const replacementLongTaskId = stringField(replacement?.['replacement_long_task_id'])
      ?? stringField(replacement?.['replacementLongTaskId'])
    return originalLongTaskId && replacementLongTaskId
      ? `${originalLongTaskId}->${replacementLongTaskId}`
      : null
  }
  if (checkpoint.kind === 'verification_repair_checkpoint') {
    const repair = objectField(checkpoint.payload['verification_repair'])
    const taskId = stringField(repair?.['task_id'])
    const stepId = stringField(repair?.['step_id'])
    return taskId && stepId ? `${taskId}/${stepId}` : null
  }
  return null
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
