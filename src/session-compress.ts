/**
 * Session compression — trim old messages or summarize via LLM.
 */

import { writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { loadSession } from './history/sessions.js'

function getSessionPath(id: string): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
  return path.join(owlcodaHome, 'sessions', `${id}.json`)
}

function getBackupPath(id: string): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
  return path.join(owlcodaHome, 'sessions', `${id}-pre-compress.json`)
}

export interface CompressResult {
  originalMessages: number
  compressedMessages: number
  method: 'trim' | 'llm'
  backupPath: string
}

/**
 * Trim a session to keep only the last N messages.
 * Creates a backup of the original session first.
 */
export async function trimSession(sessionId: string, keepLast: number = 10): Promise<CompressResult> {
  const session = await loadSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const sessionPath = getSessionPath(sessionId)
  const backupPath = getBackupPath(sessionId)

  // Backup original
  if (!existsSync(backupPath)) {
    await copyFile(sessionPath, backupPath)
  }

  const originalCount = session.messages.length
  if (originalCount <= keepLast) {
    return {
      originalMessages: originalCount,
      compressedMessages: originalCount,
      method: 'trim',
      backupPath,
    }
  }

  // Keep the last N messages
  session.messages = session.messages.slice(-keepLast)
  session.meta.messageCount = session.messages.length
  session.meta.updatedAt = new Date().toISOString()

  await writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8')

  return {
    originalMessages: originalCount,
    compressedMessages: session.messages.length,
    method: 'trim',
    backupPath,
  }
}

/**
 * Compress a session using the LLM to generate a summary.
 * Replaces all messages with [summary + last N messages].
 */
export async function compressSessionWithLLM(
  sessionId: string,
  proxyUrl: string,
  model: string,
  keepLast: number = 5,
): Promise<CompressResult> {
  const session = await loadSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const sessionPath = getSessionPath(sessionId)
  const backupPath = getBackupPath(sessionId)

  // Backup original
  if (!existsSync(backupPath)) {
    await copyFile(sessionPath, backupPath)
  }

  const originalCount = session.messages.length
  if (originalCount <= keepLast + 1) {
    return {
      originalMessages: originalCount,
      compressedMessages: originalCount,
      method: 'llm',
      backupPath,
    }
  }

  // Messages to summarize (all except last N)
  const toSummarize = session.messages.slice(0, -keepLast)
  const toKeep = session.messages.slice(-keepLast)

  // Build summary request
  const summaryText = toSummarize.map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return `[${m.role}]: ${content.slice(0, 500)}`
  }).join('\n')

  try {
    const resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'owlcoda-internal', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Summarize this conversation concisely. Focus on key decisions, facts, and context that would be needed to continue the conversation:\n\n${summaryText}`,
        }],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!resp.ok) {
      throw new Error(`LLM returned ${resp.status}`)
    }

    const result = await resp.json() as { content?: Array<{ text?: string }> }
    const summary = result.content?.[0]?.text ?? 'Summary unavailable'

    // Replace messages with [summary message + last N]
    const summaryMessage = {
      role: 'assistant' as const,
      content: `[Session Summary — ${originalCount - keepLast} messages compressed]\n\n${summary}`,
      timestamp: new Date().toISOString(),
    }

    session.messages = [summaryMessage, ...toKeep]
    session.meta.messageCount = session.messages.length
    session.meta.updatedAt = new Date().toISOString()

    await writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8')

    return {
      originalMessages: originalCount,
      compressedMessages: session.messages.length,
      method: 'llm',
      backupPath,
    }
  } catch (err) {
    throw new Error(`LLM compression failed: ${err instanceof Error ? err.message : String(err)}. Use /compress --trim N as fallback.`)
  }
}
