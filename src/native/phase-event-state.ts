/**
 * Shadow phase-event ledger for the phase-aware runtime.
 *
 * Slice 1 records events only. No gate or nudge reads these events yet, so this
 * module must stay append-only and behavior-neutral.
 */

import type { TaskExecutionState } from './protocol/types.js'
import type { PhaseEvent, PhaseEventKind, TurnPhase } from './protocol/task-permission-types.js'

export interface RecordPhaseEventArgs {
  iter: number
  kind: PhaseEventKind
  tool?: string
  detail?: string
  evidenceKind?: string
  phaseHint?: TurnPhase
}

export function recordPhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  args: RecordPhaseEventArgs,
): PhaseEvent {
  const event: PhaseEvent = {
    iter: args.iter,
    kind: args.kind,
    ts: Date.now(),
  }
  if (args.tool !== undefined) event.tool = args.tool
  if (args.detail !== undefined) event.detail = args.detail
  if (args.evidenceKind !== undefined) event.evidenceKind = args.evidenceKind
  if (args.phaseHint !== undefined) event.phaseHint = args.phaseHint
  taskState.phaseEvents.push(event)
  return event
}

export function recordAssistantTextPhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  text: string,
): PhaseEvent | null {
  if (!text.trim()) return null
  return recordPhaseEvent(taskState, {
    iter,
    kind: 'assistant_text',
    detail: text.slice(0, 240),
    phaseHint: 'report',
  })
}

export function recordRuntimeNudgePhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  nudgeKind: string,
): PhaseEvent {
  return recordPhaseEvent(taskState, {
    iter,
    kind: 'runtime_nudge',
    detail: nudgeKind,
  })
}

export function recordToolPhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  kind: Extract<PhaseEventKind, 'tool_proposed' | 'tool_started' | 'tool_completed'>,
  tool: string,
  detail?: string,
): PhaseEvent {
  const args: RecordPhaseEventArgs = {
    iter,
    kind,
    tool,
    phaseHint: phaseHintForTool(tool, kind),
  }
  if (detail !== undefined) args.detail = detail
  return recordPhaseEvent(taskState, args)
}

export function recordPermissionPhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  kind: Extract<PhaseEventKind, 'permission_requested' | 'permission_granted' | 'permission_denied'>,
  tool: string,
): PhaseEvent {
  return recordPhaseEvent(taskState, {
    iter,
    kind,
    tool,
  })
}

export function recordPostGrantEvidencePhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  evidenceKind: string,
  detail: string,
): PhaseEvent {
  return recordPhaseEvent(taskState, {
    iter,
    kind: 'post_grant_evidence',
    evidenceKind,
    detail,
    phaseHint: 'execute',
  })
}

export function recordVerificationEvidencePhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  tool: string,
  detail: string,
): PhaseEvent {
  return recordPhaseEvent(taskState, {
    iter,
    kind: 'verification_evidence',
    tool,
    detail,
    phaseHint: 'verify',
  })
}

export function recordCompletionClaimPhaseEvent(
  taskState: Pick<TaskExecutionState, 'phaseEvents'>,
  iter: number,
  text: string,
): PhaseEvent {
  return recordPhaseEvent(taskState, {
    iter,
    kind: 'completion_claim',
    detail: text.slice(0, 240),
    phaseHint: 'report',
  })
}

function phaseHintForTool(
  tool: string,
  kind: Extract<PhaseEventKind, 'tool_proposed' | 'tool_started' | 'tool_completed'>,
): TurnPhase {
  if (tool === 'DeliveryAudit' || tool === 'TaskVerify' || tool === 'ArtifactVerify') return 'verify'
  if (tool === 'Read' || tool === 'read' || tool === 'Grep' || tool === 'grep' || tool === 'Glob' || tool === 'glob') return 'explore'
  if (tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TodoWrite') return 'plan'
  if (kind === 'tool_completed') return 'execute'
  return 'execute'
}
