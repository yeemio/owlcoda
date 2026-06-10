/**
 * Session export — saves conversations to ~/.owlcoda/exports/
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { getTokenUsage } from './trace.js'

export interface ExportedSession {
  sessionId: string
  model: string
  messageCount: number
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  exportedAt: string
  format: 'json' | 'markdown'
  messages?: unknown[]
}

function getExportDir(): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
  return path.join(owlcodaHome, 'exports')
}

function getSessionDir(): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
  return path.join(owlcodaHome, 'sessions')
}

async function loadSessionMessages(sessionId: string): Promise<unknown[]> {
  const sessionDir = getSessionDir()
  const sessionFile = path.join(sessionDir, `${sessionId}.json`)

  if (!existsSync(sessionFile)) return []

  try {
    const raw = await readFile(sessionFile, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data.messages) ? data.messages : []
  } catch {
    return []
  }
}

export async function exportSession(
  sessionId: string,
  model: string,
  messageCount: number,
  format: 'json' | 'markdown' = 'json',
): Promise<string> {
  const dir = getExportDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const usage = getTokenUsage()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const messages = await loadSessionMessages(sessionId)

  const session: ExportedSession = {
    sessionId,
    model,
    messageCount,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    },
    exportedAt: new Date().toISOString(),
    format,
    messages,
  }

  if (format === 'markdown') {
    const md = formatAsMarkdown(session)
    const filePath = path.join(dir, `session-${sessionId.slice(0, 8)}-${timestamp}.md`)
    await writeFile(filePath, md)
    return filePath
  }

  const filePath = path.join(dir, `session-${sessionId.slice(0, 8)}-${timestamp}.json`)
  await writeFile(filePath, JSON.stringify(session, null, 2))
  return filePath
}

function formatAsMarkdown(session: ExportedSession): string {
  const lines: string[] = [
    `# OwlCoda Session Export`,
    '',
    `- **Session**: ${session.sessionId}`,
    `- **Model**: ${session.model}`,
    `- **Messages**: ${session.messageCount}`,
    `- **Tokens**: ${session.tokenUsage.totalTokens} (in: ${session.tokenUsage.inputTokens}, out: ${session.tokenUsage.outputTokens})`,
    `- **Exported**: ${session.exportedAt}`,
    '',
    '---',
    '',
  ]

  for (const msg of session.messages ?? []) {
    const m = msg as { role?: string; content?: string | unknown[] }
    const role = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Assistant**' : `**${m.role ?? 'unknown'}**`
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)
    lines.push(`### ${role}`)
    lines.push('')
    lines.push(content)
    lines.push('')
  }

  return lines.join('\n')
}
