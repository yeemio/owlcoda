import type { RunKitRailFreshness, RunKitRailState } from './runtime-rail-service.js'
import type { BashSourceRef, ReviewChange } from './review-action-service.js'
import type { ReviewStatusRecord, ReviewStatusValue } from './review-status-service.js'
import type {
  AppServerApprovalRequest,
  AppServerApprovalResolveResult,
  AppServerInteractionKind,
} from './approval-service.js'

export interface ReviewBatchEventItem {
  diffId: string
  status: string
  reason: string
  path: string
  toolName: ReviewChange['toolName']
  operation: ReviewChange['operation']
  mode: ReviewChange['mode']
}

export interface AppServerDiffPreview {
  path?: string
  additions?: number
  deletions?: number
  hunks?: unknown[]
  truncated?: boolean
}

export type AppServerEvent =
  | {
      type: 'runtimeRail.updated'
      projectId: string
      freshness: RunKitRailFreshness
      source: RunKitRailState['source']
    }
  | {
      type: 'project.updated'
      projectId: string
    }
  | {
      type: 'thread.updated'
      projectId: string
      threadId: string
      turnCount: number
    }
  | {
      type: 'turn.started'
      projectId: string
      threadId: string
      turnIndex: number
    }
  | {
      type: 'assistant.delta'
      projectId: string
      threadId: string
      text: string
    }
  | {
      type: 'command.started'
      projectId: string
      threadId: string
      commandId: string
      commandRef?: string
      statusRef?: string
      outputRef?: string
      sourceRefs?: BashSourceRef[]
      command: string
      cwd?: string
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'command.outputDelta'
      projectId: string
      threadId: string
      commandId: string
      lines: string[]
      delta: string
      totalLines: number
      totalBytes: number
      elapsedMs: number
      statusRef?: string
      outputRef?: string
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'command.completed'
      projectId: string
      threadId: string
      commandId: string
      result: string
      isError: boolean
      durationMs: number
      exitCode?: number
      commandRef?: string
      statusRef?: string
      outputRef?: string
      sourceRefs?: BashSourceRef[]
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'diff.started'
      projectId: string
      threadId: string
      diffId: string
      toolName: ReviewChange['toolName']
      input: Record<string, unknown>
      path?: string
      operation: ReviewChange['operation']
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'diff.completed'
      projectId: string
      threadId: string
      diffId: string
      toolName: ReviewChange['toolName']
      path?: string
      operation: ReviewChange['operation']
      result: string
      isError: boolean
      durationMs: number
      preview?: AppServerDiffPreview
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'tool.started'
      projectId: string
      threadId: string
      toolName: string
      input: Record<string, unknown>
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'tool.delta'
      projectId: string
      threadId: string
      toolName: string
      lines: string[]
      delta: string
      totalLines: number
      totalBytes: number
      elapsedMs: number
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'tool.completed'
      projectId: string
      threadId: string
      toolName: string
      isError: boolean
      durationMs: number
      result: string
      toolUseId?: string
      itemId?: string
      runtimeTurnId?: string
    }
  | {
      type: 'turn.completed'
      projectId: string
      threadId: string
      finalText: string
      iterations: number
      stopReason: string | null
      runtimeStarted?: boolean
    }
  | {
      type: 'turn.failed'
      projectId: string
      threadId: string
      message: string
      failureKind?: string
      failureCategory?: 'quota' | 'rate_limit' | 'offline' | 'timeout' | 'provider' | 'unknown'
      retryable?: boolean
    }
  | {
      type: 'turn.interrupted'
      projectId: string
      threadId: string
      status: 'not_running' | 'interrupted'
      reason: 'no_active_turn' | 'abort_signal_sent'
    }
  | {
      type: 'approval.requested'
      projectId: string
      threadId: string
      approvalId: string
      toolName: string
      approval: AppServerApprovalRequest
    }
  | {
      type: 'approval.resolved'
      projectId: string
      threadId: string
      approvalId: string
      toolName: string
      approved: boolean
      status: AppServerApprovalResolveResult['status']
      resolvedAt: number
    }
  | {
      type: 'interaction.requested'
      projectId: string
      threadId: string
      interactionId: string
      kind: AppServerInteractionKind
      interaction: AppServerApprovalRequest
    }
  | {
      type: 'interaction.resolved'
      projectId: string
      threadId: string
      interactionId: string
      kind: AppServerInteractionKind
      toolName: string
      status: AppServerApprovalResolveResult['status']
      approved?: boolean
      answer?: string
      resolvedAt: number
    }
  | {
      type: 'review.batchCompleted'
      projectId: string
      threadId: string
      action: 'apply' | 'revert'
      status: 'applied' | 'reverted' | 'blocked' | 'failed'
      diffIds: string[]
      transactionId?: string
      items: ReviewBatchEventItem[]
    }
  | {
      type: 'review.statusUpdated'
      projectId: string
      threadId: string
      diffId: string
      status: ReviewStatusValue
      updatedBy: string
      reviewStatus: ReviewStatusRecord
    }

export interface AppServerEventCursor {
  oldestAvailableSequence: number
  latestSequence: number
  afterSequence: number
}

export type AppServerEventEnvelope = AppServerEvent & {
  schemaVersion: 1
  eventId: string
  sequence: number
  occurredAt: string
  workspaceId: string
  payload: Record<string, unknown>
  artifactRefs: string[]
}

export interface AppServerEventReplay {
  available: boolean
  events: AppServerEventEnvelope[]
  cursor: AppServerEventCursor
}

export interface AppServerEventBusOptions {
  maxRetainedEvents?: number
  now?: () => string
}

export type AppServerEventListener = (event: AppServerEventEnvelope) => void

export interface AppServerEventBus {
  publish(event: AppServerEvent): void
  subscribe(listener: AppServerEventListener): () => void
  replay(afterSequence: number): AppServerEventReplay
  cursor(): AppServerEventCursor
}

export function createAppServerEventBus(options: AppServerEventBusOptions = {}): AppServerEventBus {
  const listeners = new Set<AppServerEventListener>()
  const retained: AppServerEventEnvelope[] = []
  const maxRetainedEvents = Math.max(1, Math.floor(options.maxRetainedEvents ?? 1_000))
  const now = options.now ?? (() => new Date().toISOString())
  let nextSequence = 1

  const cursor = (): AppServerEventCursor => ({
    oldestAvailableSequence: retained[0]?.sequence ?? nextSequence,
    latestSequence: nextSequence - 1,
    afterSequence: nextSequence - 1,
  })

  return {
    publish(event) {
      const envelope = envelopeEvent(event, nextSequence++, now())
      retained.push(envelope)
      if (retained.length > maxRetainedEvents) retained.splice(0, retained.length - maxRetainedEvents)
      for (const listener of [...listeners]) {
        listener(envelope)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    replay(afterSequence) {
      const current = cursor()
      const available = Number.isSafeInteger(afterSequence)
        && afterSequence >= current.oldestAvailableSequence - 1
        && afterSequence <= current.latestSequence
      return {
        available,
        events: available ? retained.filter(event => event.sequence > afterSequence) : [],
        cursor: current,
      }
    },
    cursor,
  }
}

export function formatServerSentEvent(event: AppServerEventEnvelope): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n')
}

function envelopeEvent(event: AppServerEvent, sequence: number, occurredAt: string): AppServerEventEnvelope {
  const source = event as AppServerEvent & Record<string, unknown>
  const {
    type,
    projectId,
    threadId: _threadId,
    turnId: _turnId,
    itemId: _itemId,
    artifactRefs: sourceArtifactRefs,
    ...payload
  } = source
  const artifactRefs = Array.isArray(sourceArtifactRefs)
    ? sourceArtifactRefs.filter((value): value is string => typeof value === 'string')
    : []
  const workspaceId = projectId
  return {
    ...event,
    schemaVersion: 1,
    eventId: `${workspaceId}:${sequence}`,
    sequence,
    occurredAt,
    workspaceId,
    payload,
    artifactRefs,
  } as AppServerEventEnvelope
}
