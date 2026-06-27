import type { RunKitRailFreshness, RunKitRailState } from './runtime-rail-service.js'
import type { BashSourceRef, ReviewChange } from './review-action-service.js'
import type { ReviewStatusRecord, ReviewStatusValue } from './review-status-service.js'
import type {
  AppServerApprovalRequest,
  AppServerApprovalResolveResult,
  AppServerInteractionKind,
} from './approval-service.js'
import type { RunKitTruthGateSummary, RunKitTruthProofSummary } from './truth-gateway.js'

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
      type: 'proof.appended'
      projectId: string
      proof: RunKitTruthProofSummary
    }
  | {
      type: 'gate.confirmed'
      projectId: string
      gateId: string
      gate: RunKitTruthGateSummary | null
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

export type AppServerEventListener = (event: AppServerEvent) => void

export interface AppServerEventBus {
  publish(event: AppServerEvent): void
  subscribe(listener: AppServerEventListener): () => void
}

export function createAppServerEventBus(): AppServerEventBus {
  const listeners = new Set<AppServerEventListener>()

  return {
    publish(event) {
      for (const listener of [...listeners]) {
        listener(event)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function formatServerSentEvent(event: AppServerEvent): string {
  return [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n')
}
