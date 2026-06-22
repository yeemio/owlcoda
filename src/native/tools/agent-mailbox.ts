import {
  formatAgentMailboxDetail,
  formatAgentMailboxSummary,
  getAgentMailboxMessage,
  recentAgentMailboxMessages,
  resolveAgentMailboxMessage,
  sendAgentMailboxMessage,
  type AgentMailboxStatus,
} from '../agent-mailbox.js'
import type { NativeToolDef, ToolResult } from './types.js'

export interface AgentMailboxSendToolInput {
  author: string
  recipient: string
  body: string
  parentRunId?: string
  triggerTurn?: boolean
}

export interface AgentMailboxListToolInput {
  recipient?: string
  status?: AgentMailboxStatus
  limit?: number
}

export interface AgentMailboxGetToolInput {
  messageId: string
}

export interface AgentMailboxResolveToolInput {
  messageId: string
  reason?: string
}

export function createAgentMailboxSendTool(): NativeToolDef<AgentMailboxSendToolInput> {
  return {
    name: 'AgentMailboxSend',
    description:
      'Queue a structured parent/agent mailbox message in runtime state. This records author, recipient, trigger intent, parent run, and recovery-visible lifecycle state; it does not directly resume a sub-agent turn.',
    maturity: 'beta',
    async execute(input: AgentMailboxSendToolInput): Promise<ToolResult> {
      const author = requiredString(input?.author)
      const recipient = requiredString(input?.recipient)
      const body = requiredString(input?.body)
      if (!author) return { output: 'author is required.', isError: true }
      if (!recipient) return { output: 'recipient is required.', isError: true }
      if (!body) return { output: 'body is required.', isError: true }
      const message = sendAgentMailboxMessage({
        author,
        recipient,
        body,
        ...(requiredString(input.parentRunId) ? { parentRunId: requiredString(input.parentRunId) } : {}),
        ...(typeof input.triggerTurn === 'boolean' ? { triggerTurn: input.triggerTurn } : {}),
      })
      return {
        output: `AgentMailboxSend: queued ${message.messageId}\n${formatAgentMailboxSummary(message)}`,
        isError: false,
        metadata: { message },
      }
    },
  }
}

export function createAgentMailboxListTool(): NativeToolDef<AgentMailboxListToolInput> {
  return {
    name: 'AgentMailboxList',
    description:
      'List structured parent/agent mailbox messages. Read-only; this does not deliver, resume, retry, or mutate agents.',
    maturity: 'beta',
    async execute(input: AgentMailboxListToolInput = {}): Promise<ToolResult> {
      const messages = recentAgentMailboxMessages({
        ...(requiredString(input.recipient) ? { recipient: requiredString(input.recipient) } : {}),
        ...(isMailboxStatus(input.status) ? { status: input.status } : {}),
        limit: input.limit,
      })
      if (messages.length === 0) {
        return {
          output: 'No Agent mailbox messages are available.',
          isError: false,
          metadata: { messages: [] },
        }
      }
      return {
        output: messages.map(formatAgentMailboxSummary).join('\n'),
        isError: false,
        metadata: { messages },
      }
    },
  }
}

export function createAgentMailboxGetTool(): NativeToolDef<AgentMailboxGetToolInput> {
  return {
    name: 'AgentMailboxGet',
    description:
      'Read one structured parent/agent mailbox message by messageId. Read-only; this does not deliver, resume, retry, or mutate agents.',
    maturity: 'beta',
    async execute(input: AgentMailboxGetToolInput): Promise<ToolResult> {
      const messageId = requiredString(input?.messageId)
      if (!messageId) return { output: 'messageId is required.', isError: true }
      const message = getAgentMailboxMessage(messageId)
      if (!message) {
        return {
          output: `Agent mailbox message "${messageId}" not found.`,
          isError: true,
          metadata: { messageId },
        }
      }
      return {
        output: formatAgentMailboxDetail(message),
        isError: false,
        metadata: { message },
      }
    },
  }
}

export function createAgentMailboxResolveTool(): NativeToolDef<AgentMailboxResolveToolInput> {
  return {
    name: 'AgentMailboxResolve',
    description:
      'Mark a structured parent/agent mailbox message as resolved in runtime state. Internal-state only; this does not deliver, resume, retry, or mutate agents.',
    maturity: 'beta',
    async execute(input: AgentMailboxResolveToolInput): Promise<ToolResult> {
      const messageId = requiredString(input?.messageId)
      if (!messageId) return { output: 'messageId is required.', isError: true }
      const message = resolveAgentMailboxMessage(messageId, requiredString(input.reason))
      if (!message) {
        return {
          output: `Agent mailbox message "${messageId}" not found.`,
          isError: true,
          metadata: { messageId },
        }
      }
      return {
        output: `AgentMailboxResolve: resolved ${message.messageId}\n${formatAgentMailboxSummary(message)}`,
        isError: false,
        metadata: { message },
      }
    },
  }
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isMailboxStatus(value: unknown): value is AgentMailboxStatus {
  return value === 'queued' || value === 'delivered' || value === 'acknowledged' || value === 'resolved'
}
