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
      'Send a message to another agent (teammate). Messages are queued ' +
      'and delivered when the recipient processes its next tool round.',
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
