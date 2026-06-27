import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSession, restoreConversation, saveSession, type SessionFile } from '../session.js'
import type { ConversationTurn, RuntimeEventRecord } from '../protocol/types.js'
import { appendRuntimeEvent } from '../runtime-events.js'
import { readRuntimeTranscript } from './runtime-transcript-service.js'
import type { AppServerInteractionRequest } from './approval-service.js'

export type AppServerTurnStatus =
  | 'idle'
  | 'saved_only'
  | 'running'
  | 'waiting_for_interaction'
  | 'completed'
  | 'recovered'
  | 'stale'

export type AppServerTurnStatusReason =
  | 'no_turns'
  | 'runtime_not_started'
  | 'active_loop'
  | 'pending_interaction'
  | 'turn_completed'
  | 'app_server_mark_recovered'
  | 'runtime_event_unclosed'

export type AppServerTurnRecoveryAction = 'mark_recovered'

export interface AppServerTurnStatusInput {
  projectRoot: string
  projectId?: string
  threadId: string
  runtimeActive?: boolean
  interactions?: AppServerInteractionRequest[]
}

export interface AppServerTurnRecoverInput extends AppServerTurnStatusInput {
  action: AppServerTurnRecoveryAction
  note?: string
}

export type AppServerTurnRecoverOutput =
  | {
      ok: true
      result: AppServerTurnRecoverResult
    }
  | {
      ok: false
      status: AppServerTurnStatusResult
      reason: string
      suggestedAction: string
      message: string
    }

export interface AppServerTurnRecoverResult {
  threadId: string
  projectId?: string
  action: AppServerTurnRecoveryAction
  previousStatus: AppServerTurnStatusResult
  status: AppServerTurnStatusResult
  recoveryEvent: RuntimeEventRecord
}

export interface AppServerTurnStatusResult {
  threadId: string
  projectId?: string
  status: AppServerTurnStatus
  reason: AppServerTurnStatusReason
  runtimeActive: boolean
  turnCount: number
  itemCount: number
  runtimeEventCount: number
  pendingInteractionCount: number
  lastTurn?: AppServerTurnStatusLastTurn
  lastRuntimeEvent?: AppServerTurnStatusRuntimeEvent
  lastInteraction?: AppServerTurnStatusInteraction
  resumeHint: AppServerTurnStatusResumeHint
}

export interface AppServerTurnStatusLastTurn {
  index: number
  role: ConversationTurn['role']
  timestamp: number
}

export interface AppServerTurnStatusRuntimeEvent {
  id: string
  kind: RuntimeEventRecord['kind']
  at: string
  turnId?: string
  itemId?: string
}

export interface AppServerTurnStatusInteraction {
  id: string
  kind: AppServerInteractionRequest['kind']
  source: AppServerInteractionRequest['source']
  toolName: string
  createdAt: number
}

export interface AppServerTurnStatusResumeHint {
  action:
    | 'start_turn'
    | 'inspect_saved_turn'
    | 'watch_live_events'
    | 'resolve_pending_interaction'
    | 'inspect_transcript_before_retry'
    | 'none'
  message: string
}

export function recoverTurn(input: AppServerTurnRecoverInput): AppServerTurnRecoverOutput | null {
  const session = loadStatusSession(input)
  if (!session) return null
  const previousStatus = readTurnStatus(input)
  if (!previousStatus) return null

  if (previousStatus.status === 'waiting_for_interaction') {
    return {
      ok: false,
      status: previousStatus,
      reason: 'pending_interaction',
      suggestedAction: 'interaction/respond',
      message: 'Resolve the pending interaction before marking this turn recovered.',
    }
  }
  if (previousStatus.status === 'running') {
    return {
      ok: false,
      status: previousStatus,
      reason: 'active_loop',
      suggestedAction: 'turn/interrupt',
      message: 'Interrupt or wait for the active runtime loop before marking this turn recovered.',
    }
  }
  if (previousStatus.status !== 'stale' && previousStatus.status !== 'saved_only') {
    return {
      ok: false,
      status: previousStatus,
      reason: 'status_not_recoverable',
      suggestedAction: previousStatus.resumeHint.action,
      message: `Turn status ${previousStatus.status} does not need mark_recovered.`,
    }
  }

  const conversation = restoreConversation(session, session.tools ?? [])
  const recoveryEvent = appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    turnId: previousStatus.lastRuntimeEvent?.turnId,
    payload: {
      intervention_kind: 'app_server_turn_recovery',
      action: input.action,
      source: 'turn/recover',
      previous_status: previousStatus.status,
      previous_reason: previousStatus.reason,
      ...(input.note ? { note: input.note } : {}),
    },
  })
  saveSession(conversation, session.title, { cwd: input.projectRoot })
  const status = readTurnStatus(input)
  if (!status) return null

  return {
    ok: true,
    result: {
      threadId: session.id,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      action: input.action,
      previousStatus,
      status,
      recoveryEvent,
    },
  }
}

export function readTurnStatus(input: AppServerTurnStatusInput): AppServerTurnStatusResult | null {
  const session = loadStatusSession(input)
  if (!session) return null
  const transcript = readRuntimeTranscript({
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    threadId: input.threadId,
  })
  const events = session.runtimeEventLog?.events ?? []
  const lastRuntimeEvent = events.at(-1)
  const pendingInteractions = [...(input.interactions ?? [])]
    .filter(interaction => interaction.threadId === input.threadId && interaction.status === 'pending')
    .sort((left, right) => left.createdAt - right.createdAt)
  const runtimeActive = input.runtimeActive === true
  const status = classifyTurnStatus({
    turnCount: session.turns.length,
    runtimeActive,
    pendingInteractionCount: pendingInteractions.length,
    lastRuntimeEvent,
  })

  return {
    threadId: session.id,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    status: status.status,
    reason: status.reason,
    runtimeActive,
    turnCount: session.turns.length,
    itemCount: transcript?.itemCount ?? transcriptItemCountFromSession(session),
    runtimeEventCount: events.length,
    pendingInteractionCount: pendingInteractions.length,
    ...(lastTurn(session) ? { lastTurn: lastTurn(session)! } : {}),
    ...(lastRuntimeEvent ? { lastRuntimeEvent: runtimeEventSummary(lastRuntimeEvent) } : {}),
    ...(pendingInteractions.length > 0 ? { lastInteraction: interactionSummary(pendingInteractions.at(-1)!) } : {}),
    resumeHint: resumeHintForStatus(status.status),
  }
}

function classifyTurnStatus(input: {
  turnCount: number
  runtimeActive: boolean
  pendingInteractionCount: number
  lastRuntimeEvent?: RuntimeEventRecord
}): { status: AppServerTurnStatus; reason: AppServerTurnStatusReason } {
  if (input.pendingInteractionCount > 0) {
    return { status: 'waiting_for_interaction', reason: 'pending_interaction' }
  }
  if (input.runtimeActive) {
    return { status: 'running', reason: 'active_loop' }
  }
  if (input.turnCount === 0) {
    return { status: 'idle', reason: 'no_turns' }
  }
  if (!input.lastRuntimeEvent) {
    return { status: 'saved_only', reason: 'runtime_not_started' }
  }
  if (input.lastRuntimeEvent.kind === 'turn_completed') {
    return { status: 'completed', reason: 'turn_completed' }
  }
  if (isAppServerRecoveryEvent(input.lastRuntimeEvent)) {
    return { status: 'recovered', reason: 'app_server_mark_recovered' }
  }
  return { status: 'stale', reason: 'runtime_event_unclosed' }
}

function resumeHintForStatus(status: AppServerTurnStatus): AppServerTurnStatusResumeHint {
  switch (status) {
    case 'idle':
      return {
        action: 'start_turn',
        message: 'No turn has been started for this thread.',
      }
    case 'saved_only':
      return {
        action: 'inspect_saved_turn',
        message: 'The user turn was saved, but no runtime loop started for it.',
      }
    case 'running':
      return {
        action: 'watch_live_events',
        message: 'A runtime loop is active in this App Server process.',
      }
    case 'waiting_for_interaction':
      return {
        action: 'resolve_pending_interaction',
        message: 'The runtime is waiting for a pending approval or user response.',
      }
    case 'completed':
      return {
        action: 'none',
        message: 'The latest runtime turn completed.',
      }
    case 'recovered':
      return {
        action: 'start_turn',
        message: 'The previous unclosed turn was marked recovered by App Server.',
      }
    case 'stale':
      return {
        action: 'inspect_transcript_before_retry',
        message: 'The persisted runtime event log has an unclosed turn and no active loop in this process.',
      }
  }
}

function loadStatusSession(input: AppServerTurnStatusInput): SessionFile | null {
  const session = loadSession(input.threadId)
  if (!session) return null
  const root = canonicalExistingPath(input.projectRoot)
  const cwd = session.cwd ? canonicalExistingPath(session.cwd) : root
  if (cwd !== root) return null
  return session
}

function lastTurn(session: SessionFile): AppServerTurnStatusLastTurn | null {
  const index = session.turns.length - 1
  const turn = session.turns[index]
  if (!turn) return null
  return {
    index,
    role: turn.role,
    timestamp: turn.timestamp,
  }
}

function runtimeEventSummary(event: RuntimeEventRecord): AppServerTurnStatusRuntimeEvent {
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
  }
}

function interactionSummary(interaction: AppServerInteractionRequest): AppServerTurnStatusInteraction {
  return {
    id: interaction.id,
    kind: interaction.kind,
    source: interaction.source,
    toolName: interaction.toolName,
    createdAt: interaction.createdAt,
  }
}

function transcriptItemCountFromSession(session: SessionFile): number {
  return session.turns.reduce((count, turn) => count + turn.content.length, 0)
}

function isAppServerRecoveryEvent(event: RuntimeEventRecord): boolean {
  return event.kind === 'runtime_intervention'
    && event.payload?.['intervention_kind'] === 'app_server_turn_recovery'
    && event.payload?.['action'] === 'mark_recovered'
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}
