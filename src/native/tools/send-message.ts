/**
 * OwlCoda Native SendMessage Tool
 *
 * Sends a message to another agent (teammate) by name.
 * In our architecture, messages are queued for teammate task IDs.
 *
 * Upstream parity notes:
 * - Upstream sends via UDS sockets, bridge, or in-process teammate tasks
 * - Our version: in-memory message queue keyed by recipient name
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface SendMessageInput {
  to: string
  message: string | Record<string, unknown>
  summary?: string
}

/** In-memory message queues keyed by recipient name */
const messageQueues = new Map<string, Array<{ from: string; message: unknown; timestamp: string }>>()

export function getMessageQueue(recipientName: string): Array<{ from: string; message: unknown; timestamp: string }> {
  return messageQueues.get(recipientName) ?? []
}

export function clearMessageQueues(): void {
  messageQueues.clear()
}

export function createSendMessageTool(senderName = 'team-lead'): NativeToolDef<SendMessageInput> {
  return {
    name: 'SendMessage',
    description:
      'Append one entry to an in-memory message queue keyed by the recipient name (Map<string, Array>). ' +
      'There is no consumer wired up to drain these queues — no teammate process polls them, no agent loop reads them, ' +
      'no IPC bridge forwards them; messages are written and stay there until the session ends. This is fire-and-forget ' +
      'into a Map, not real inter-agent communication. ' +
      'Use this only when the user explicitly wants to test the queue API or you are mocking out a teammate workflow. ' +
      'For actual handoff to a subagent, use Agent (which forks and runs a real subprocess); ' +
      'to communicate with the user, just write text in your reply.',
    maturity: 'beta' as const,

    async execute(input: SendMessageInput): Promise<ToolResult> {
      const { to, message, summary } = input

      if (!to) {
        return { output: 'Error: "to" (recipient name) is required.', isError: true }
      }
      if (!message) {
        return { output: 'Error: "message" is required.', isError: true }
      }

      // Handle broadcast
      const recipients = to === '*' ? [...messageQueues.keys()] : [to]

      if (recipients.length === 0 && to === '*') {
        return {
          output: 'No teammates to broadcast to.',
          isError: false,
          metadata: { sent: 0 },
        }
      }

      for (const recipient of recipients) {
        if (!messageQueues.has(recipient)) {
          messageQueues.set(recipient, [])
        }
        messageQueues.get(recipient)!.push({
          from: senderName,
          message,
          timestamp: new Date().toISOString(),
        })
      }

      const label = summary ?? (typeof message === 'string' ? message.slice(0, 80) : JSON.stringify(message).slice(0, 80))
      return {
        output: `Message sent to ${to === '*' ? `all (${recipients.length})` : to}: ${label}`,
        isError: false,
        metadata: { to, sent: recipients.length },
      }
    },
  }
}
