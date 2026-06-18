import { createHash } from 'node:crypto'
import type {
  AnthropicContentBlock,
  Conversation,
  ConversationTurn,
  RuntimeRecoveryCheckpointDisposition,
  RuntimeRecoveryCheckpointKind,
  RuntimeRecoveryCheckpointRecord,
  RuntimeRecoveryLedger,
} from './protocol/types.js'
import {
  recordCheckpointInstalledEvent,
  recordCheckpointResolvedEvent,
} from './runtime-events.js'

const MAX_RUNTIME_RECOVERY_CHECKPOINTS = 20

export function appendRuntimeRecoveryCheckpoint(
  conversation: Conversation,
  input: {
    kind: RuntimeRecoveryCheckpointKind
    payload: Record<string, unknown>
    inspectCommands?: string[]
    generatedAt?: string
  },
): RuntimeRecoveryCheckpointRecord {
  const generatedAt = input.generatedAt ?? stringField(input.payload['generated_at']) ?? new Date().toISOString()
  const existing = conversation.options?.runtimeRecoveryLedger
  const previous = existing?.checkpoints ?? []
  const inspectCommands = normalizeInspectCommands(input.inspectCommands ?? extractInspectCommands(input.payload))
  const id = `${input.kind}-${previous.length + 1}`
  const identity = checkpointIdentity(input.kind, input.payload)
  const record: RuntimeRecoveryCheckpointRecord = {
    id,
    kind: input.kind,
    generatedAt,
    conversationId: conversation.id,
    disposition: 'active',
    payload: input.payload,
    inspectCommands,
  }

  const supersededAt = generatedAt
  const checkpoints = [
    ...previous.map((checkpoint) => {
      if (!identity || !isUnresolvedRuntimeRecoveryCheckpoint(checkpoint)) return checkpoint
      if (checkpointIdentity(checkpoint.kind, checkpoint.payload) !== identity) return checkpoint
      return withDisposition(
        checkpoint,
        'superseded',
        supersededAt,
        `Superseded by newer checkpoint ${id}.`,
      )
    }),
    record,
  ].slice(-MAX_RUNTIME_RECOVERY_CHECKPOINTS)
  conversation.options = {
    ...conversation.options,
    runtimeRecoveryLedger: {
      schemaVersion: 1,
      updatedAt: generatedAt,
      lastPromptedAt: existing?.lastPromptedAt,
      checkpoints,
    },
  }
  recordCheckpointInstalledEvent(conversation, record)
  return record
}

export function appendContextReplacementCheckpoint(
  conversation: Conversation,
  input: {
    inputHistory: ConversationTurn[]
    replacementHistory: ConversationTurn[]
    reason: string
    windowId: string
    sourceTurnId: string
    generatedAt?: string
  },
): RuntimeRecoveryCheckpointRecord {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  return appendRuntimeRecoveryCheckpoint(conversation, {
    kind: 'context_replacement_checkpoint',
    generatedAt,
    payload: {
      schema_version: 1,
      kind: 'context_replacement_checkpoint',
      generated_at: generatedAt,
      context_replacement: {
        input_history_digest: digestConversationTurns(input.inputHistory),
        replacement_history: input.replacementHistory,
        reason: input.reason,
        window_id: input.windowId,
        source_turn_id: input.sourceTurnId,
        ledger_status: 'active',
      },
    },
  })
}

export function markBlockedTaskRecoveryCheckpointResolved(
  conversation: Conversation,
  input: {
    taskId: string
    stepId: string
    reason?: string
    updatedAt?: string
  },
): number {
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `blocked_task:${input.taskId}:${input.stepId}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Task ${input.taskId} step ${input.stepId} completed.`,
  })
}

export function markBlockedTaskRecoveryCheckpointAcknowledged(
  conversation: Conversation,
  input: {
    taskId: string
    stepId: string
    reason?: string
    updatedAt?: string
  },
): number {
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `blocked_task:${input.taskId}:${input.stepId}`,
    disposition: 'acknowledged',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Blocked checkpoint for task ${input.taskId} step ${input.stepId} was reported.`,
  })
}

export function markChildRunSynthesisCheckpointResolved(
  conversation: Conversation,
  input: {
    agentIds: string[]
    reason?: string
    updatedAt?: string
  },
): number {
  const agentIds = [...new Set(input.agentIds.map((id) => id.trim()).filter(Boolean))].sort()
  if (agentIds.length === 0) return 0
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `child_runs:${agentIds.join(',')}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Child-run synthesis report produced for ${agentIds.join(', ')}.`,
  })
}

export function markLongTaskRecoveryCheckpointResolved(
  conversation: Conversation,
  input: {
    longTaskIds: string[]
    reason?: string
    updatedAt?: string
  },
): number {
  const longTaskIds = [...new Set(input.longTaskIds.map((id) => id.trim()).filter(Boolean))].sort()
  if (longTaskIds.length === 0) return 0
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `long_task:${longTaskIds.join(',')}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Long-task checkpoint resolved for ${longTaskIds.join(', ')}.`,
  })
}

export function markLongTaskSynthesisCheckpointResolved(
  conversation: Conversation,
  input: {
    longTaskIds: string[]
    reason?: string
    updatedAt?: string
  },
): number {
  const longTaskIds = [...new Set(input.longTaskIds.map((id) => id.trim()).filter(Boolean))].sort()
  if (longTaskIds.length === 0) return 0
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `long_task_synthesis:${longTaskIds.join(',')}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Long-task synthesis report produced for ${longTaskIds.join(', ')}.`,
  })
}

export function markLongTaskReplacementCheckpointResolved(
  conversation: Conversation,
  input: {
    originalLongTaskId: string
    replacementLongTaskId: string
    reason?: string
    updatedAt?: string
  },
): number {
  const originalLongTaskId = input.originalLongTaskId.trim()
  const replacementLongTaskId = input.replacementLongTaskId.trim()
  if (!originalLongTaskId || !replacementLongTaskId) return 0
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `long_task_replacement:${originalLongTaskId}:${replacementLongTaskId}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Long-task replacement ${originalLongTaskId} -> ${replacementLongTaskId} was reported.`,
  })
}

export function markVerificationRepairCheckpointAcknowledged(
  conversation: Conversation,
  input: {
    taskId: string
    stepId: string
    reason?: string
    updatedAt?: string
  },
): number {
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `verification_repair:${input.taskId}:${input.stepId}`,
    disposition: 'acknowledged',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Verification repair checkpoint for task ${input.taskId} step ${input.stepId} was reported.`,
  })
}

export function markVerificationRepairCheckpointResolved(
  conversation: Conversation,
  input: {
    taskId: string
    stepId: string
    reason?: string
    updatedAt?: string
  },
): number {
  return updateRuntimeRecoveryCheckpointDisposition(conversation, {
    identity: `verification_repair:${input.taskId}:${input.stepId}`,
    disposition: 'resolved',
    updatedAt: input.updatedAt,
    reason: input.reason ?? `Verification passed for task ${input.taskId} step ${input.stepId}.`,
  })
}

export function getUnresolvedRuntimeRecoveryCheckpoints(
  ledger: RuntimeRecoveryLedger | undefined,
): RuntimeRecoveryCheckpointRecord[] {
  return (ledger?.checkpoints ?? [])
    .filter((checkpoint) =>
      checkpoint.kind !== 'context_replacement_checkpoint'
      && isUnresolvedRuntimeRecoveryCheckpoint(checkpoint),
    )
}

export function isUnresolvedRuntimeRecoveryCheckpoint(
  checkpoint: RuntimeRecoveryCheckpointRecord,
): boolean {
  const disposition = checkpoint.disposition ?? 'active'
  return disposition === 'active' || disposition === 'acknowledged'
}

export function injectRuntimeRecoveryLedgerPromptIfNeeded(conversation: Conversation): boolean {
  const prunedStalePrompt = pruneRuntimeRecoveryLedgerPromptTurns(conversation)
  ensureLongTaskSynthesisCheckpointIfNeeded(conversation)
  const ledger = conversation.options?.runtimeRecoveryLedger
  if (!ledger || getUnresolvedRuntimeRecoveryCheckpoints(ledger).length === 0) return false
  if (ledger.lastPromptedAt === ledger.updatedAt && !prunedStalePrompt) return false
  if (!lastTurnIsUserAuthoredText(conversation)) return false

  conversation.turns.push({
    role: 'user',
    content: [{
      type: 'text',
      text: buildRuntimeRecoveryLedgerPrompt(ledger),
    }],
    timestamp: Date.now(),
  })
  conversation.options = {
    ...conversation.options,
    runtimeRecoveryLedger: {
      ...ledger,
      lastPromptedAt: ledger.updatedAt,
    },
  }
  return true
}

function pruneRuntimeRecoveryLedgerPromptTurns(conversation: Conversation): boolean {
  const before = conversation.turns.length
  conversation.turns = conversation.turns.filter((turn) => !isRuntimeRecoveryLedgerPromptTurn(turn))
  return conversation.turns.length !== before
}

export function buildRuntimeRecoveryLedgerPrompt(ledger: RuntimeRecoveryLedger): string {
  const unresolved = getUnresolvedRuntimeRecoveryCheckpoints(ledger)
  const resolvedCheckpointCount = ledger.checkpoints.length - unresolved.length
  const synthesis = unresolved
    .filter((checkpoint) => checkpoint.kind === 'long_task_synthesis_checkpoint')
    .at(-1)
  if (synthesis) return buildLongTaskSynthesisCheckpointPrompt(synthesis, resolvedCheckpointCount)
  const verificationRepair = unresolved
    .filter((checkpoint) =>
      checkpoint.kind === 'verification_repair_checkpoint'
      && (checkpoint.disposition ?? 'active') === 'active'
    )
    .at(-1)
  if (verificationRepair) return buildVerificationRepairCheckpointPrompt(verificationRepair, resolvedCheckpointCount)
  const payload = {
    schema_version: 1,
    kind: 'runtime_recovery_ledger',
    updated_at: ledger.updatedAt,
    unresolved_checkpoints: unresolved.slice(-5),
    resolved_checkpoint_count: resolvedCheckpointCount,
  }
  return [
    '[Runtime recovery ledger]',
    'Durable runtime recovery checkpoints from the saved session are available.',
    'Use these structured records as runtime truth for resume/recovery; do not infer completion from transcript memory alone.',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'If work remains blocked or incomplete, report the checkpoint kind, inspect command, and smallest next action before using tools.',
  ].join('\n')
}

function buildVerificationRepairCheckpointPrompt(
  checkpoint: RuntimeRecoveryCheckpointRecord,
  resolvedCheckpointCount: number,
): string {
  const payload = {
    ...checkpoint.payload,
    checkpoint_id: checkpoint.id,
    resolved_checkpoint_count: resolvedCheckpointCount,
  }
  const repair = objectField(checkpoint.payload['verification_repair'])
  const taskId = stringField(repair?.['task_id']) ?? '(unknown task)'
  const stepId = stringField(repair?.['step_id']) ?? '(unknown step)'
  return [
    '[Runtime verification-repair checkpoint]',
    `Task ${taskId} step ${stepId} has failed verification and needs a repair contract before more tool calls.`,
    'Use this runtime snapshot as the source of truth; do not keep re-running verification or invent workaround completion.',
    '',
    '[Runtime verification-repair checkpoint payload]',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'Your next reply MUST be plain text with no tool_use blocks.',
    'Report the failed check IDs, evidence already observed, whether the artifact or verification spec needs repair, and the exact next TaskVerify command to run after repair.',
    'Do not call TaskVerify, bash, Sleep, Agent, or other tools until the user replies. The only allowed tool escape is TaskUpdate for the same task/step with stepStatus="blocked" or "failed" and a concrete failureReason.',
  ].join('\n')
}

function buildLongTaskSynthesisCheckpointPrompt(
  checkpoint: RuntimeRecoveryCheckpointRecord,
  resolvedCheckpointCount: number,
): string {
  const payload = {
    ...checkpoint.payload,
    checkpoint_id: checkpoint.id,
    resolved_checkpoint_count: resolvedCheckpointCount,
  }
  const count = Array.isArray(checkpoint.payload['long_tasks'])
    ? checkpoint.payload['long_tasks'].length
    : 0
  return [
    '[Runtime long-task synthesis checkpoint]',
    `${count} unresolved long-task recovery records were found across multiple runtime checkpoints.`,
    'Use this as the parent recovery contract; do not reconstruct scattered status from transcript memory.',
    '',
    '[Runtime long-task synthesis payload]',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'Your next reply MUST be plain text with no tool_use blocks.',
    'Report one line per long task. For each item include long_task_id, source, status, evidence already observed, inspect_command, and the smallest next action.',
    'Do not call RuntimeRecoveryList, RuntimeRecoveryGet, TaskOutput, AgentRunGet, bash, Sleep, Agent, or other tools until the user replies.',
  ].join('\n')
}

function ensureLongTaskSynthesisCheckpointIfNeeded(conversation: Conversation): RuntimeRecoveryCheckpointRecord | null {
  const ledger = conversation.options?.runtimeRecoveryLedger
  if (!ledger) return null
  const payload = buildLongTaskSynthesisPayload(ledger)
  if (!payload) return null
  const longTaskIds = longTaskSynthesisIdsFromPayload(payload)
  if (longTaskIds.length < 2) return null
  const existing = getUnresolvedRuntimeRecoveryCheckpoints(ledger)
    .find((checkpoint) =>
      checkpoint.kind === 'long_task_synthesis_checkpoint'
      && sameStringSet(longTaskSynthesisIdsFromPayload(checkpoint.payload), longTaskIds)
    )
  if (existing) return existing
  return appendRuntimeRecoveryCheckpoint(conversation, {
    kind: 'long_task_synthesis_checkpoint',
    payload,
  })
}

function buildLongTaskSynthesisPayload(ledger: RuntimeRecoveryLedger): Record<string, unknown> | null {
  const unresolved = getUnresolvedRuntimeRecoveryCheckpoints(ledger)
    .filter((checkpoint) => checkpoint.kind !== 'long_task_synthesis_checkpoint')
  const entries: Record<string, unknown>[] = []
  const sourceCheckpointIds: string[] = []

  for (const checkpoint of unresolved) {
    if (checkpoint.kind === 'long_task_checkpoint') {
      const tasks = Array.isArray(checkpoint.payload['long_tasks']) ? checkpoint.payload['long_tasks'] : []
      for (const task of tasks) {
        const record = objectField(task)
        const longTaskId = stringField(record?.['long_task_id']) ?? stringField(record?.['longTaskId'])
        if (!record || !longTaskId) continue
        entries.push({
          ...record,
          long_task_id: longTaskId,
          source_checkpoint_id: checkpoint.id,
          source_checkpoint_kind: checkpoint.kind,
        })
      }
    }
    if (checkpoint.kind === 'child_run_synthesis_checkpoint') {
      const children = Array.isArray(checkpoint.payload['children']) ? checkpoint.payload['children'] : []
      for (const child of children) {
        const record = objectField(child)
        const agentId = stringField(record?.['agent_id']) ?? stringField(record?.['agentId'])
        if (!record || !agentId) continue
        entries.push({
          long_task_id: `agent:${agentId}`,
          source: 'agent',
          status: stringField(record['status']) ?? 'failed',
          ...(stringField(record['description']) ? { objective: stringField(record['description']) } : {}),
          ...(stringField(record['failure_category']) ? { failure_category: stringField(record['failure_category']) } : {}),
          ...(stringField(record['timeout_kind']) ? { timeout_kind: stringField(record['timeout_kind']) } : {}),
          ...(stringField(record['inspect_command']) ? { inspect_command: stringField(record['inspect_command']) } : {}),
          ...(stringField(record['last_progress']) ? { last_progress: stringField(record['last_progress']) } : {}),
          ...(stringField(record['output_snippet']) ? { output_snippet: stringField(record['output_snippet']) } : {}),
          source_checkpoint_id: checkpoint.id,
          source_checkpoint_kind: checkpoint.kind,
        })
      }
    }
    if (entries.some((entry) => entry['source_checkpoint_id'] === checkpoint.id)) {
      sourceCheckpointIds.push(checkpoint.id)
    }
  }

  const dedupedEntries = dedupeLongTaskSynthesisEntries(entries)
  const dedupedSourceIds = [...new Set(sourceCheckpointIds)]
  if (dedupedEntries.length < 2 || dedupedSourceIds.length < 2) return null

  return {
    schema_version: 1,
    kind: 'long_task_synthesis_checkpoint',
    generated_at: new Date().toISOString(),
    source_checkpoint_ids: dedupedSourceIds,
    long_task_count: dedupedEntries.length,
    long_tasks: dedupedEntries,
  }
}

function dedupeLongTaskSynthesisEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    const id = stringField(entry['long_task_id'])
    if (!id) continue
    if (!byId.has(id)) byId.set(id, entry)
  }
  return [...byId.values()].sort((a, b) =>
    String(a['long_task_id']).localeCompare(String(b['long_task_id'])),
  )
}

function longTaskSynthesisIdsFromPayload(payload: Record<string, unknown>): string[] {
  const tasks = Array.isArray(payload['long_tasks']) ? payload['long_tasks'] : []
  return tasks
    .map((item) => stringField(objectField(item)?.['long_task_id']) ?? stringField(objectField(item)?.['longTaskId']))
    .filter((value): value is string => Boolean(value))
    .sort()
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((value, index) => value === right[index])
}

function updateRuntimeRecoveryCheckpointDisposition(
  conversation: Conversation,
  input: {
    identity: string
    disposition: RuntimeRecoveryCheckpointDisposition
    reason: string
    updatedAt?: string
  },
): number {
  const ledger = conversation.options?.runtimeRecoveryLedger
  if (!ledger || ledger.checkpoints.length === 0) return 0
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  let updatedCount = 0
  const resolvedCheckpoints: RuntimeRecoveryCheckpointRecord[] = []
  const checkpoints = ledger.checkpoints.map((checkpoint) => {
    if (!isUnresolvedRuntimeRecoveryCheckpoint(checkpoint)) return checkpoint
    if (checkpointIdentity(checkpoint.kind, checkpoint.payload) !== input.identity) return checkpoint
    updatedCount += 1
    const updated = withDisposition(checkpoint, input.disposition, updatedAt, input.reason)
    if (input.disposition === 'resolved') resolvedCheckpoints.push(updated)
    return updated
  })
  if (updatedCount === 0) return 0
  conversation.options = {
    ...conversation.options,
    runtimeRecoveryLedger: {
      ...ledger,
      updatedAt,
      checkpoints,
    },
  }
  for (const checkpoint of resolvedCheckpoints) {
    recordCheckpointResolvedEvent(conversation, checkpoint)
  }
  return updatedCount
}

function withDisposition(
  checkpoint: RuntimeRecoveryCheckpointRecord,
  disposition: RuntimeRecoveryCheckpointDisposition,
  updatedAt: string,
  reason: string,
): RuntimeRecoveryCheckpointRecord {
  return {
    ...checkpoint,
    disposition,
    dispositionUpdatedAt: updatedAt,
    dispositionReason: reason,
  }
}

function checkpointIdentity(kind: RuntimeRecoveryCheckpointKind, payload: Record<string, unknown>): string | null {
  if (kind === 'blocked_task_checkpoint') {
    const blocked = objectField(payload['blocked_task'])
    const taskId = stringField(blocked?.['task_id'])
    const stepId = stringField(blocked?.['step_id'])
    return taskId && stepId ? `blocked_task:${taskId}:${stepId}` : null
  }
  if (kind === 'long_task_checkpoint') {
    const tasks = Array.isArray(payload['long_tasks']) ? payload['long_tasks'] : []
    const ids = tasks
      .map((item) => stringField(objectField(item)?.['long_task_id']))
      .filter((value): value is string => Boolean(value))
      .sort()
    return ids.length > 0 ? `long_task:${ids.join(',')}` : null
  }
  if (kind === 'child_run_synthesis_checkpoint') {
    const children = Array.isArray(payload['children']) ? payload['children'] : []
    const ids = children
      .map((item) => stringField(objectField(item)?.['agent_id']))
      .filter((value): value is string => Boolean(value))
      .sort()
    return ids.length > 0 ? `child_runs:${ids.join(',')}` : null
  }
  if (kind === 'long_task_synthesis_checkpoint') {
    const ids = longTaskSynthesisIdsFromPayload(payload)
    return ids.length > 0 ? `long_task_synthesis:${ids.join(',')}` : null
  }
  if (kind === 'long_task_replacement_checkpoint') {
    const replacement = objectField(payload['replacement'])
    const originalLongTaskId = stringField(replacement?.['original_long_task_id'])
      ?? stringField(replacement?.['originalLongTaskId'])
    const replacementLongTaskId = stringField(replacement?.['replacement_long_task_id'])
      ?? stringField(replacement?.['replacementLongTaskId'])
    return originalLongTaskId && replacementLongTaskId
      ? `long_task_replacement:${originalLongTaskId}:${replacementLongTaskId}`
      : null
  }
  if (kind === 'context_replacement_checkpoint') {
    const replacement = objectField(payload['context_replacement'])
    const windowId = stringField(replacement?.['window_id']) ?? stringField(replacement?.['windowId'])
    const sourceTurnId = stringField(replacement?.['source_turn_id']) ?? stringField(replacement?.['sourceTurnId'])
    return windowId && sourceTurnId
      ? `context_replacement:${windowId}:${sourceTurnId}`
      : null
  }
  if (kind === 'verification_repair_checkpoint') {
    const repair = objectField(payload['verification_repair'])
    const taskId = stringField(repair?.['task_id'])
    const stepId = stringField(repair?.['step_id'])
    return taskId && stepId ? `verification_repair:${taskId}:${stepId}` : null
  }
  return null
}

function lastTurnIsUserAuthoredText(conversation: Conversation): boolean {
  const last = conversation.turns.at(-1)
  if (!last || last.role !== 'user') return false
  if (last.content.some((block) => block.type === 'tool_result')) return false
  const text = last.content
    .map(textFromBlock)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim()
  return text.length > 0 && !text.startsWith('[Runtime ')
}

function isRuntimeRecoveryLedgerPromptTurn(turn: Conversation['turns'][number]): boolean {
  if (turn.role !== 'user') return false
  if (turn.content.some((block) => block.type === 'tool_result')) return false
  const text = turn.content
    .map(textFromBlock)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim()
  return text.startsWith('[Runtime recovery ledger]')
    || text.startsWith('[Runtime long-task synthesis checkpoint]')
    || text.startsWith('[Runtime verification-repair checkpoint]')
}

function extractInspectCommands(value: unknown): string[] {
  const out: string[] = []
  visit(value, (key, item) => {
    if (key === 'inspect_command' && typeof item === 'string' && item.trim()) {
      out.push(item.trim())
    }
  })
  return out
}

function textFromBlock(block: AnthropicContentBlock): string | undefined {
  return block.type === 'text' && 'text' in block ? block.text : undefined
}

function visit(value: unknown, onField: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onField)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    onField(key, item)
    visit(item, onField)
  }
}

function normalizeInspectCommands(commands: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const command of commands) {
    const trimmed = command.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function digestConversationTurns(turns: ConversationTurn[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(turns)).digest('hex')}`
}
