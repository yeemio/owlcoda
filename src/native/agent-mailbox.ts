import {
  forgetRunLifecycleSnapshotsByKind,
  recordRunLifecycleSnapshot,
  transitionRunLifecycleSnapshot,
  type RunLifecycleStatus,
  type RunRecoveryPolicy,
} from './run-lifecycle.js'

export type AgentMailboxStatus = 'queued' | 'delivered' | 'acknowledged' | 'resolved'

export interface AgentMailboxMessage {
  messageId: string
  author: string
  recipient: string
  body: string
  status: AgentMailboxStatus
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  parentRunId?: string
  triggerTurn?: boolean
  reason?: string
}

export interface AgentMailboxSendInput {
  author: string
  recipient: string
  body: string
  parentRunId?: string
  triggerTurn?: boolean
}

export interface AgentMailboxListOptions {
  recipient?: string
  status?: AgentMailboxStatus
  limit?: number
}

let nextMailboxId = 1
const mailbox = new Map<string, AgentMailboxMessage>()

export function sendAgentMailboxMessage(input: AgentMailboxSendInput): AgentMailboxMessage {
  const now = new Date().toISOString()
  const message: AgentMailboxMessage = {
    messageId: `mailbox-${nextMailboxId++}`,
    author: input.author,
    recipient: input.recipient,
    body: input.body,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.triggerTurn !== undefined ? { triggerTurn: input.triggerTurn } : {}),
  }
  mailbox.set(message.messageId, message)
  mirrorMailboxMessageToRunLifecycle(message)
  return message
}

export function getAgentMailboxMessage(messageId: string): AgentMailboxMessage | undefined {
  return mailbox.get(messageId)
}

export function recentAgentMailboxMessages(options: AgentMailboxListOptions = {}): AgentMailboxMessage[] {
  const limit = parsePositiveLimit(options.limit, 20)
  return [...mailbox.values()]
    .filter((message) => !options.recipient || message.recipient === options.recipient)
    .filter((message) => !options.status || message.status === options.status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

export function resolveAgentMailboxMessage(messageId: string, reason?: string): AgentMailboxMessage | undefined {
  const existing = mailbox.get(messageId)
  if (!existing) return undefined
  const now = new Date().toISOString()
  const updated: AgentMailboxMessage = {
    ...existing,
    status: 'resolved',
    updatedAt: now,
    resolvedAt: now,
    ...(reason ? { reason } : {}),
  }
  mailbox.set(messageId, updated)
  mirrorMailboxMessageToRunLifecycle(updated)
  return updated
}

export function resetAgentMailboxForTesting(): void {
  mailbox.clear()
  nextMailboxId = 1
  forgetRunLifecycleSnapshotsByKind('mailbox_message')
}

export function formatAgentMailboxSummary(message: AgentMailboxMessage): string {
  const fields = [
    message.messageId,
    `status=${message.status}`,
    `author=${message.author}`,
    `recipient=${message.recipient}`,
    `body="${compactMailboxText(message.body, 80)}"`,
  ]
  if (message.parentRunId) fields.push(`parent=${message.parentRunId}`)
  if (message.triggerTurn !== undefined) fields.push(`triggerTurn=${String(message.triggerTurn)}`)
  return fields.join(' ')
}

export function formatAgentMailboxDetail(message: AgentMailboxMessage): string {
  const lines = [
    `Agent mailbox message ${message.messageId}`,
    `status=${message.status}`,
    `author=${message.author}`,
    `recipient=${message.recipient}`,
    `createdAt=${message.createdAt}`,
    `updatedAt=${message.updatedAt}`,
  ]
  if (message.resolvedAt) lines.push(`resolvedAt=${message.resolvedAt}`)
  if (message.parentRunId) lines.push(`parentRunId=${message.parentRunId}`)
  if (message.triggerTurn !== undefined) lines.push(`triggerTurn=${String(message.triggerTurn)}`)
  if (message.reason) lines.push(`reason=${message.reason}`)
  lines.push(`Body: ${message.body}`)
  return lines.join('\n')
}

function mirrorMailboxMessageToRunLifecycle(message: AgentMailboxMessage): void {
  const runId = `mailbox:${message.messageId}`
  const status = mailboxStatusToRunStatus(message.status)
  const recoveryPolicy = mailboxRecoveryPolicy(message)
  if (message.status === 'resolved') {
    transitionRunLifecycleSnapshot(runId, {
      status,
      finishedAt: message.resolvedAt ?? message.updatedAt,
      recoveryPolicy,
      evidence: {
        terminal_summary: message.reason ?? 'Mailbox message resolved.',
      },
    })
    return
  }
  recordRunLifecycleSnapshot({
    runId,
    kind: 'mailbox_message',
    status,
    objective: `Mailbox ${message.author} -> ${message.recipient}`,
    startedAt: message.createdAt,
    updatedAt: message.updatedAt,
    owner: 'agent_mailbox',
    ...(message.parentRunId ? { parentRunId: message.parentRunId } : {}),
    inspectCommand: `AgentMailboxGet messageId=${message.messageId}`,
    recoveryPolicy,
    evidence: {
      last_output_summary: compactMailboxText(message.body, 500),
    },
  })
}

function mailboxStatusToRunStatus(status: AgentMailboxStatus): RunLifecycleStatus {
  if (status === 'resolved') return 'completed'
  if (status === 'queued' || status === 'delivered' || status === 'acknowledged') return 'waiting'
  return 'waiting'
}

function mailboxRecoveryPolicy(message: AgentMailboxMessage): RunRecoveryPolicy {
  if (message.status === 'resolved') {
    return {
      schema_version: 1,
      strategy: 'report_terminal',
      next_command: `AgentMailboxGet messageId=${message.messageId}`,
      reason: 'Mailbox message is resolved; report the saved resolution instead of re-sending it.',
    }
  }
  return {
    schema_version: 1,
    strategy: 'deliver_or_inspect',
    next_command: `AgentMailboxGet messageId=${message.messageId}`,
    reason: 'Mailbox message is queued in runtime state; inspect it before sending duplicate instructions.',
  }
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), 100)
}

function compactMailboxText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}
