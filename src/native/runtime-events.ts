import type {
  Conversation,
  ConversationTurn,
  RuntimeEventKind,
  RuntimeEventLog,
  RuntimeEventRecord,
  RuntimeRecoveryCheckpointKind,
  RuntimeRecoveryCheckpointRecord,
  RuntimeRecoveryLedger,
} from './protocol/types.js'

const MAX_RUNTIME_EVENTS = 200

export function appendRuntimeEvent(
  conversation: Conversation,
  input: {
    kind: RuntimeEventKind
    at?: string
    turnId?: string
    itemId?: string
    checkpointId?: string
    checkpointKind?: RuntimeRecoveryCheckpointKind
    payload?: Record<string, unknown>
  },
): RuntimeEventRecord {
  const at = input.at ?? new Date().toISOString()
  const existing = conversation.options?.runtimeEventLog
  const seq = existing?.nextSeq ?? ((existing?.events.length ?? 0) + 1)
  const event: RuntimeEventRecord = {
    id: `runtime_event-${seq}`,
    seq,
    kind: input.kind,
    at,
    conversationId: conversation.id,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    ...(input.checkpointKind ? { checkpointKind: input.checkpointKind } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  }
  const events = [...(existing?.events ?? []), event].slice(-MAX_RUNTIME_EVENTS)
  conversation.options = {
    ...conversation.options,
    runtimeEventLog: {
      schemaVersion: 1,
      updatedAt: at,
      nextSeq: seq + 1,
      events,
    },
  }
  return event
}

export function recordCheckpointInstalledEvent(
  conversation: Conversation,
  checkpoint: RuntimeRecoveryCheckpointRecord,
): RuntimeEventRecord {
  return appendRuntimeEvent(conversation, {
    kind: 'checkpoint_installed',
    at: checkpoint.generatedAt,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.kind,
    payload: {
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      disposition: checkpoint.disposition ?? 'active',
      inspect_commands: checkpoint.inspectCommands,
    },
  })
}

export function recordCheckpointResolvedEvent(
  conversation: Conversation,
  checkpoint: RuntimeRecoveryCheckpointRecord,
): RuntimeEventRecord {
  return appendRuntimeEvent(conversation, {
    kind: 'checkpoint_resolved',
    at: checkpoint.dispositionUpdatedAt,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.kind,
    payload: {
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      disposition: checkpoint.disposition ?? 'resolved',
      reason: checkpoint.dispositionReason,
    },
  })
}

export interface RuntimeTruthReconstruction {
  latestContextReplacement: {
    checkpoint: RuntimeRecoveryCheckpointRecord
    event: RuntimeEventRecord
    replacementHistory: ConversationTurn[]
    suffixEvents: RuntimeEventRecord[]
  } | null
}

export function reconstructRuntimeTruthFromEvents(input: {
  runtimeEventLog?: RuntimeEventLog
  runtimeRecoveryLedger?: RuntimeRecoveryLedger
}): RuntimeTruthReconstruction {
  const events = input.runtimeEventLog?.events ?? []
  const checkpoints = input.runtimeRecoveryLedger?.checkpoints ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.checkpointKind !== 'context_replacement_checkpoint') continue
    if (event.kind !== 'checkpoint_installed' && event.kind !== 'checkpoint_resolved') continue
    const checkpoint = checkpoints.find((item) =>
      item.id === event.checkpointId
      && item.kind === 'context_replacement_checkpoint'
      && isActiveOrResolved(item),
    )
    if (!checkpoint) continue
    return {
      latestContextReplacement: {
        checkpoint,
        event,
        replacementHistory: replacementHistoryFromCheckpoint(checkpoint),
        suffixEvents: events.slice(index + 1),
      },
    }
  }
  return { latestContextReplacement: null }
}

function isActiveOrResolved(checkpoint: RuntimeRecoveryCheckpointRecord): boolean {
  const disposition = checkpoint.disposition ?? 'active'
  return disposition === 'active' || disposition === 'resolved'
}

function replacementHistoryFromCheckpoint(checkpoint: RuntimeRecoveryCheckpointRecord): ConversationTurn[] {
  const container = objectField(checkpoint.payload['context_replacement'])
  const history = container?.['replacement_history']
  return Array.isArray(history) ? history as ConversationTurn[] : []
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
