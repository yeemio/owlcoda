/**
 * Proxy-mode training data collector.
 *
 * In proxy mode, owlcoda proxies /v1/messages from a compatibility client.
 * Each request contains the full conversation history + the response.
 * This module builds a Session object from request/response data and
 * feeds it to the standard collector pipeline (quality scoring → collection).
 */

import { randomBytes } from 'node:crypto'
import type { Session, SessionMessage } from '../history/sessions.js'
import { isTrainingCollectionEnabled, onSessionEndCollect } from './collector.js'

interface ProxyMessage {
  role: string
  content: unknown
}

interface ProxyCollectInput {
  /** Full messages array from the request body */
  requestMessages: ProxyMessage[]
  /** Response content blocks from the assistant */
  responseContent: unknown
  /** Model used for the request */
  model: string
}

/**
 * Build a Session from a proxy request/response pair and attempt collection.
 * Fire-and-forget — never throws, logs errors internally.
 */
export async function collectProxyExchange(input: ProxyCollectInput): Promise<void> {
  // Master gate — opt-in only. Avoids constructing the Session object at all
  // when training data collection is disabled.
  if (!isTrainingCollectionEnabled()) return

  try {
    const { requestMessages, responseContent, model } = input

    // Build session messages from request conversation + response
    const messages: SessionMessage[] = []
    const now = new Date().toISOString()

    for (const msg of requestMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
          timestamp: now,
        })
      }
    }

    // Append the new assistant response
    if (responseContent) {
      messages.push({
        role: 'assistant',
        content: responseContent,
        timestamp: now,
      })
    }

    // Need enough messages for quality scoring to be meaningful
    if (messages.length < 4) return

    // Extract preview from first user message
    const firstUser = messages.find(m => m.role === 'user')
    const preview = firstUser
      ? (typeof firstUser.content === 'string'
          ? firstUser.content
          : JSON.stringify(firstUser.content)
        ).slice(0, 80)
      : ''

    const sessionId = `proxy-${Date.now()}-${randomBytes(3).toString('hex')}`

    const session: Session = {
      meta: {
        id: sessionId,
        model,
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
        preview,
        cwd: 'proxy',
        tags: ['proxy-collected'],
      },
      messages,
    }

    await onSessionEndCollect(session)
  } catch {
    // Fire-and-forget — never crash the proxy
  }
}
