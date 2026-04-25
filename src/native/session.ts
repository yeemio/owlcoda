/**
 * OwlCoda Native Session Persistence
 *
 * Save and load conversation sessions as JSON files.
 * Sessions are stored in ~/.owlcoda/native-sessions/.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type {
  Conversation,
  ConversationTurn,
  PendingRetryState,
  TaskExecutionState,
} from './protocol/types.js'
import { sanitizeConversationTurns } from './protocol/request.js'

function getDefaultSessionsDir(): string {
  const home = process.env['OWLCODA_HOME']
  if (home) return path.join(home, 'sessions')
  return path.join(os.homedir(), '.owlcoda', 'sessions')
}

/** Serializable session format. */
export interface SessionFile {
  version: 1
  id: string
  model: string
  system: string
  maxTokens: number
  temperature?: number
  turns: ConversationTurn[]
  createdAt: number
  updatedAt: number
  title?: string
  cwd?: string
  tags?: string[]
  parentId?: string
  branchName?: string
  pendingRetry?: PendingRetryState
  taskState?: TaskExecutionState
}

/** Ensure sessions directory exists. Returns true on success. */
function ensureDir(): boolean {
  try {
    fs.mkdirSync(getDefaultSessionsDir(), { recursive: true })
    return true
  } catch {
    return false
  }
}

let sessionPersistenceWarned = false
function warnPersistenceFailure(reason: string): void {
  if (sessionPersistenceWarned) return
  sessionPersistenceWarned = true
  // One-shot: the REPL is still usable, the in-memory conversation is
  // intact, but resume/history won't have this session on disk.
  console.error(`\n⚠️  Session persistence disabled for this process: ${reason}`)
  console.error(`    The current chat continues; it just won't be saved to ~/.owlcoda/sessions/.`)
  console.error(`    Check disk space and permissions on that directory if you want resume to work.\n`)
}

/** Get the file path for a session ID. */
function sessionPath(id: string): string {
  // Sanitize: only allow alphanumeric, dash, underscore
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(getDefaultSessionsDir(), `${safe}.json`)
}

/** Save a conversation to disk. Returns the file path on success, or an
 *  empty string if persistence failed (disk full, permission denied, etc.).
 *  A one-time warning is printed on the first failure; subsequent saves
 *  fail silently so the REPL isn't spammed every turn. The in-memory
 *  conversation is never affected by persistence failure. */
export function saveSession(conversation: Conversation, title?: string): string {
  if (!ensureDir()) {
    warnPersistenceFailure('could not create sessions directory')
    return ''
  }

  const existing = loadSession(conversation.id)
  const now = Date.now()
  const sanitizedTurns = sanitizeConversationTurns(conversation.turns)
  conversation.turns = sanitizedTurns

  const session: SessionFile = {
    version: 1,
    id: conversation.id,
    model: conversation.model,
    system: conversation.system,
    maxTokens: conversation.maxTokens,
    temperature: conversation.temperature,
    turns: sanitizedTurns,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    title: title ?? existing?.title ?? deriveTitle(conversation),
    cwd: process.cwd(),
    pendingRetry: conversation.options?.pendingRetry,
    taskState: conversation.options?.taskState,
  }

  const filePath = sessionPath(conversation.id)
  try {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
    return filePath
  } catch (err) {
    warnPersistenceFailure((err as Error).message)
    return ''
  }
}

/** Load a session from disk. Returns null if not found. */
export function loadSession(id: string): SessionFile | null {
  // Resolve 'last' to the most recently updated session
  if (id === 'last') {
    const all = listSessions()
    if (all.length === 0) return null
    return all[0] ?? null // listSessions returns sorted by updatedAt desc
  }

  // Also support partial ID match (prefix)
  const filePath = sessionPath(id)
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as SessionFile
      if (data.version !== 1) return null
      return data
    } catch {
      return null
    }
  }

  // Try prefix match
  const all = listSessions()
  const match = all.find(s => s.id.startsWith(id))
  return match ?? null
}

/** Restore a Conversation object from a saved session. */
export function restoreConversation(
  session: SessionFile,
  tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>,
): Conversation {
  const conversation: Conversation = {
    id: session.id,
    system: session.system,
    turns: sanitizeConversationTurns(session.turns),
    tools,
    model: session.model,
    maxTokens: session.maxTokens,
    temperature: session.temperature,
  }
  if (session.pendingRetry) {
    conversation.options = {
      ...conversation.options,
      pendingRetry: session.pendingRetry,
    }
  }
  if (session.taskState) {
    conversation.options = {
      ...conversation.options,
      taskState: session.taskState,
    }
  }
  return conversation
}

/** List all saved sessions, newest first. */
export function listSessions(): SessionFile[] {
  ensureDir()

  const sessDir = getDefaultSessionsDir()
  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.json'))
  const sessions: SessionFile[] = []

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(sessDir, file), 'utf-8')
      const data = JSON.parse(raw) as SessionFile
      if (data.version === 1) sessions.push(data)
    } catch {
      // Skip corrupted files
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Delete a saved session. Returns true if deleted. */
export function deleteSession(id: string): boolean {
  const filePath = sessionPath(id)
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

/** Derive a title from the first user message. */
function deriveTitle(conversation: Conversation): string {
  for (const turn of conversation.turns) {
    if (turn.role !== 'user') continue
    for (const block of turn.content) {
      if (block.type === 'text' && 'text' in block) {
        const text = (block as { type: 'text'; text: string }).text
        return text.slice(0, 80) + (text.length > 80 ? '…' : '')
      }
    }
  }
  return 'Untitled session'
}

// ─── Tags ───

/** Add a tag to a saved session. Returns false if session not found or tag already exists. */
export function addSessionTag(id: string, tag: string): boolean {
  const session = loadSession(id)
  if (!session) return false
  if (!session.tags) session.tags = []
  if (session.tags.includes(tag)) return false
  session.tags.push(tag)
  session.updatedAt = Date.now()
  const filePath = sessionPath(id)
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
  return true
}

/** Remove a tag from a saved session. Returns false if session not found or tag not present. */
export function removeSessionTag(id: string, tag: string): boolean {
  const session = loadSession(id)
  if (!session) return false
  if (!session.tags) return false
  const idx = session.tags.indexOf(tag)
  if (idx === -1) return false
  session.tags.splice(idx, 1)
  session.updatedAt = Date.now()
  const filePath = sessionPath(id)
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
  return true
}

/** Get tags for a session. */
export function getSessionTags(id: string): string[] {
  const session = loadSession(id)
  return session?.tags ?? []
}

/** Find sessions by tag. */
export function findSessionsByTag(tag: string): SessionFile[] {
  return listSessions().filter(s => s.tags?.includes(tag))
}

// ─── Branching ───

/** Branch (deep copy) a session. Returns the new session ID. */
export function branchSession(id: string, branchName?: string): string {
  const source = loadSession(id)
  if (!source) throw new Error(`Session ${id} not found`)

  ensureDir()
  const now = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const newId = `conv-${now}-${rand}`

  const branch: SessionFile = {
    ...source,
    id: newId,
    createdAt: now,
    updatedAt: now,
    parentId: id,
    branchName: branchName || undefined,
    turns: JSON.parse(JSON.stringify(source.turns)),
    tags: [],
  }

  const filePath = sessionPath(newId)
  fs.writeFileSync(filePath, JSON.stringify(branch, null, 2), 'utf-8')
  return newId
}

/** List branches of a session. */
export function listBranches(id: string): SessionFile[] {
  return listSessions().filter(s => s.parentId === id)
}

// ─── Compression ───

export interface CompressResult {
  originalMessages: number
  compressedMessages: number
  method: 'trim' | 'llm'
  backupPath: string
}

/** Trim a session to keep only the last N turns. Creates a backup first. */
export function trimSessionTurns(id: string, keepLast: number = 10): CompressResult {
  const session = loadSession(id)
  if (!session) throw new Error(`Session ${id} not found`)

  const filePath = sessionPath(id)
  const backupPath = filePath.replace('.json', '-pre-compress.json')

  // Backup original
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath)
  }

  const originalCount = session.turns.length
  if (originalCount <= keepLast) {
    return { originalMessages: originalCount, compressedMessages: originalCount, method: 'trim', backupPath }
  }

  session.turns = session.turns.slice(-keepLast)
  session.updatedAt = Date.now()
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')

  return { originalMessages: originalCount, compressedMessages: session.turns.length, method: 'trim', backupPath }
}

/** Compress a session using LLM summarization. */
export async function compressSessionWithLLM(
  id: string,
  proxyUrl: string,
  model: string,
  keepLast: number = 10,
): Promise<CompressResult> {
  const session = loadSession(id)
  if (!session) throw new Error(`Session ${id} not found`)

  const filePath = sessionPath(id)
  const backupPath = filePath.replace('.json', '-pre-compress.json')

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath)
  }

  const originalCount = session.turns.length
  if (originalCount <= keepLast + 2) {
    return { originalMessages: originalCount, compressedMessages: originalCount, method: 'llm', backupPath }
  }

  // Split: old turns to summarize, recent turns to keep
  const oldTurns = session.turns.slice(0, -keepLast)
  const recentTurns = session.turns.slice(-keepLast)

  // Build text from old turns
  const text = oldTurns.map(t => {
    const role = t.role
    const content = t.content.map(b => ('text' in b ? (b as { text: string }).text : '')).join('')
    return `${role}: ${content}`
  }).join('\n\n')

  // Ask LLM to summarize
  try {
    const resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'local' },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: 'You are a conversation compressor. Output a concise summary paragraph preserving essential context for continuing the conversation. Be factual and dense.',
        messages: [{ role: 'user', content: `Summarize this conversation:\n\n${text}` }],
      }),
    })
    const data = await resp.json() as { content?: Array<{ text?: string }> }
    const summary = data.content?.[0]?.text ?? '[Compression summary unavailable]'

    session.turns = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: `[Compressed summary of ${oldTurns.length} earlier turns]\n\n${summary}` }], timestamp: Date.now() },
      ...recentTurns,
    ]
  } catch {
    // Fallback to simple trim if LLM fails
    session.turns = recentTurns
  }

  session.updatedAt = Date.now()
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')

  return { originalMessages: originalCount, compressedMessages: session.turns.length, method: 'llm', backupPath }
}

/** Rename a session title. */
export function renameSession(id: string, newTitle: string): boolean {
  const session = loadSession(id)
  if (!session) return false
  session.title = newTitle
  session.updatedAt = Date.now()
  const filePath = sessionPath(id)
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
  return true
}

/** Get the sessions directory path (for testing). */
export function getSessionsDir(): string {
  return getDefaultSessionsDir()
}
