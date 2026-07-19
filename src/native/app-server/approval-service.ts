import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AskUserQuestionOpts } from '../tools/types.js'
import type { RiskClass } from '../protocol/task-permission-types.js'

export type AppServerApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'answered'
export type AppServerApprovalDecision = 'approve' | 'deny'
export type AppServerInteractionKind = 'tool_approval' | 'task_scope_approval' | 'user_question'
export type AppServerInteractionSource = 'live' | 'restored'

export interface AppServerTaskScopePayload {
  attemptedPath: string
  attemptedPaths: string[]
  allowedPaths: string[]
  message: string
}

export interface AppServerInteractionRequest {
  id: string
  kind: AppServerInteractionKind
  source: AppServerInteractionSource
  projectId: string
  threadId: string
  toolName: string
  input: Record<string, unknown>
  riskClass?: RiskClass
  riskReason?: string
  status: 'pending'
  createdAt: number
  question?: string
  options?: AskUserQuestionOpts['options']
  multiSelect?: boolean
  taskScope?: AppServerTaskScopePayload
}

export type AppServerApprovalRequest = AppServerInteractionRequest

export interface AppServerApprovalListInput {
  projectId?: string
  threadId?: string
}

export interface AppServerApprovalListResult {
  approvals: AppServerApprovalRequest[]
}

export interface AppServerInteractionListResult {
  interactions: AppServerInteractionRequest[]
}

export interface AppServerApprovalResolveInput {
  approvalId: string
  decision: AppServerApprovalDecision
}

export interface AppServerInteractionRespondInput {
  interactionId: string
  decision?: AppServerApprovalDecision
  answer?: string
}

export interface AppServerApprovalResolveResult {
  approvalId: string
  interactionId: string
  kind: AppServerInteractionKind
  source: AppServerInteractionSource
  projectId: string
  threadId: string
  toolName: string
  status: Exclude<AppServerApprovalStatus, 'pending'>
  resolvedAt: number
  answer?: string
}

export interface AppServerApprovalBrokerOptions {
  storagePath?: string
  onRequested?: (approval: AppServerInteractionRequest) => void
  onResolved?: (result: AppServerApprovalResolveResult) => void
}

export interface AppServerApprovalBroker {
  requestApproval(input: {
    projectId: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    riskClass: RiskClass
    riskReason: string
    signal?: AbortSignal
  }): Promise<boolean>
  requestTaskScopeApproval(input: {
    projectId: string
    threadId: string
    toolName: string
    toolInput: Record<string, unknown>
    riskClass: RiskClass
    riskReason: string
    taskScope: AppServerTaskScopePayload
    signal?: AbortSignal
  }): Promise<boolean>
  requestUserQuestion(input: {
    projectId: string
    threadId: string
    toolName: string
    question: string
    opts?: AskUserQuestionOpts
    signal?: AbortSignal
  }): Promise<string>
  listApprovals(input?: AppServerApprovalListInput): AppServerApprovalListResult
  listInteractions(input?: AppServerApprovalListInput): AppServerInteractionListResult
  resolveApproval(input: AppServerApprovalResolveInput): AppServerApprovalResolveResult | null
  respondInteraction(input: AppServerInteractionRespondInput): AppServerApprovalResolveResult | null
  discardRestoredInteractions(input?: AppServerApprovalListInput): number
}

interface PendingInteraction {
  interaction: AppServerInteractionRequest
  settle?: (response: InteractionResponse) => void
  abortListener?: () => void
}

interface InteractionResponse {
  approved: boolean
  answer: string
}

interface StoredInteractionFile {
  schemaVersion?: string
  interactions?: unknown[]
}

export function createAppServerApprovalBroker(
  options: AppServerApprovalBrokerOptions = {},
): AppServerApprovalBroker {
  const pending = new Map<string, PendingInteraction>()
  for (const interaction of loadStoredInteractions(options.storagePath)) {
    pending.set(interaction.id, { interaction })
  }
  let nextInteractionId = nextIdFromPending(pending)

  const persist = () => persistInteractions(options.storagePath, [...pending.values()].map(item => item.interaction))

  const requestInteraction = (
    interaction: Omit<AppServerInteractionRequest, 'id' | 'source' | 'status' | 'createdAt'>,
    signal: AbortSignal | undefined,
  ): Promise<InteractionResponse> => {
    const request: AppServerInteractionRequest = {
      ...interaction,
      id: `${interaction.kind === 'tool_approval' ? 'approval' : 'interaction'}-${nextInteractionId++}`,
      source: 'live',
      status: 'pending',
      createdAt: Date.now(),
    }
    return new Promise<InteractionResponse>((resolve) => {
      const item: PendingInteraction = {
        interaction: request,
        settle: resolve,
      }
      if (signal) {
        if (signal.aborted) {
          resolve({ approved: false, answer: '' })
          return
        }
        const onAbort = () => {
          settleInteraction(request.id, 'cancelled', undefined)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        item.abortListener = () => signal.removeEventListener('abort', onAbort)
      }
      pending.set(request.id, item)
      persist()
      options.onRequested?.(request)
    })
  }

  const settleInteraction = (
    interactionId: string,
    status: Exclude<AppServerApprovalStatus, 'pending'>,
    answer: string | undefined,
  ): AppServerApprovalResolveResult | null => {
    const item = pending.get(interactionId)
    if (!item) return null
    pending.delete(interactionId)
    persist()
    item.abortListener?.()
    const result: AppServerApprovalResolveResult = {
      approvalId: interactionId,
      interactionId,
      kind: item.interaction.kind,
      source: item.interaction.source,
      projectId: item.interaction.projectId,
      threadId: item.interaction.threadId,
      toolName: item.interaction.toolName,
      status,
      resolvedAt: Date.now(),
      ...(answer !== undefined ? { answer } : {}),
    }
    item.settle?.({
      approved: status === 'approved',
      answer: status === 'answered' ? answer ?? '' : '',
    })
    options.onResolved?.(result)
    return result
  }

  return {
    async requestApproval(input) {
      const response = await requestInteraction({
        kind: 'tool_approval',
        projectId: input.projectId,
        threadId: input.threadId,
        toolName: input.toolName,
        input: input.toolInput,
        riskClass: input.riskClass,
        riskReason: input.riskReason,
      }, input.signal)
      return response.approved
    },
    async requestTaskScopeApproval(input) {
      const response = await requestInteraction({
        kind: 'task_scope_approval',
        projectId: input.projectId,
        threadId: input.threadId,
        toolName: input.toolName,
        input: input.toolInput,
        riskClass: input.riskClass,
        riskReason: input.riskReason,
        taskScope: input.taskScope,
      }, input.signal)
      return response.approved
    },
    async requestUserQuestion(input) {
      const response = await requestInteraction({
        kind: 'user_question',
        projectId: input.projectId,
        threadId: input.threadId,
        toolName: input.toolName,
        input: {
          question: input.question,
          ...(input.opts?.options ? { options: input.opts.options } : {}),
          ...(input.opts?.multiSelect !== undefined ? { multiSelect: input.opts.multiSelect } : {}),
        },
        question: input.question,
        options: input.opts?.options,
        multiSelect: input.opts?.multiSelect,
      }, input.signal)
      return response.answer
    },
    listApprovals(input = {}) {
      const approvals = filterInteractions([...pending.values()].map(item => item.interaction), input)
        .filter(interaction => interaction.kind !== 'user_question')
      return { approvals }
    },
    listInteractions(input = {}) {
      return {
        interactions: filterInteractions([...pending.values()].map(item => item.interaction), input),
      }
    },
    resolveApproval(input) {
      if (pending.get(input.approvalId)?.interaction.source === 'restored') return null
      return settleInteraction(input.approvalId, input.decision === 'approve' ? 'approved' : 'denied', undefined)
    },
    respondInteraction(input) {
      const item = pending.get(input.interactionId)
      if (!item || item.interaction.source === 'restored') return null
      if (item.interaction.kind === 'user_question') {
        if (input.decision === 'deny') {
          return settleInteraction(input.interactionId, 'denied', undefined)
        }
        return settleInteraction(input.interactionId, 'answered', input.answer ?? '')
      }
      return settleInteraction(input.interactionId, input.decision === 'approve' ? 'approved' : 'denied', undefined)
    },
    discardRestoredInteractions(input = {}) {
      const ids = filterInteractions([...pending.values()].map(item => item.interaction), input)
        .filter(interaction => interaction.source === 'restored')
        .map(interaction => interaction.id)
      for (const id of ids) settleInteraction(id, 'cancelled', undefined)
      return ids.length
    },
  }
}

function filterInteractions(
  interactions: AppServerInteractionRequest[],
  input: AppServerApprovalListInput,
): AppServerInteractionRequest[] {
  return interactions
    .filter(interaction => !input.projectId || interaction.projectId === input.projectId)
    .filter(interaction => !input.threadId || interaction.threadId === input.threadId)
    .sort((left, right) => left.createdAt - right.createdAt)
}

function loadStoredInteractions(storagePath: string | undefined): AppServerInteractionRequest[] {
  if (!storagePath || !existsSync(storagePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(storagePath, 'utf8')) as StoredInteractionFile
    return Array.isArray(parsed.interactions)
      ? parsed.interactions.filter(isStoredInteraction).map(interaction => ({
          ...interaction,
          source: 'restored',
          status: 'pending',
        }))
      : []
  } catch {
    return []
  }
}

function persistInteractions(storagePath: string | undefined, interactions: AppServerInteractionRequest[]): void {
  if (!storagePath) return
  mkdirSync(dirname(storagePath), { recursive: true })
  writeFileSync(storagePath, JSON.stringify({
    schemaVersion: '1.0',
    interactions,
  }, null, 2), 'utf8')
}

function isStoredInteraction(value: unknown): value is AppServerInteractionRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.projectId === 'string'
    && typeof record.threadId === 'string'
    && typeof record.toolName === 'string'
    && typeof record.kind === 'string'
}

function nextIdFromPending(pending: Map<string, PendingInteraction>): number {
  let next = 1
  for (const id of pending.keys()) {
    const match = /-(\d+)$/.exec(id)
    if (!match) continue
    next = Math.max(next, Number(match[1]) + 1)
  }
  return next
}
