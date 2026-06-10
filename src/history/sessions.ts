/**
 * OwlCoda session persistence — save/load/list conversation sessions.
 * Storage: ~/.owlcoda/sessions/<id>.json
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getOwlcodaDir } from '../paths.js'

// ─── Types ───

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: unknown  // string or ContentBlock[]
  timestamp: string
}

export interface SessionMeta {
  id: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** First user message (for display) */
  preview: string
  cwd: string
  tags?: string[]
  parentId?: string
  branchName?: string
}

export interface Session {
  meta: SessionMeta
  messages: SessionMessage[]
}

// ─── Paths ───

function getSessionsDir(): string {
  return join(getOwlcodaDir(), 'sessions')
}

function getSessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`)
}

function getLastSessionPath(): string {
  return join(getSessionsDir(), '.last')
}

// ─── ID generation ───

function generateSessionId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = randomBytes(3).toString('hex')
  return `${date}-${rand}`
}

function nextSessionTimestamp(previous?: string): string {
  const nowMs = Date.now()
  const prevMs = previous ? Date.parse(previous) : Number.NaN
  const nextMs = Number.isFinite(prevMs) ? Math.max(nowMs, prevMs + 1) : nowMs
  return new Date(nextMs).toISOString()
}

// ─── Core operations ───

/**
 * Ensure sessions directory exists.
 */
async function ensureSessionsDir(): Promise<void> {
  const dir = getSessionsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Create a new session and return its ID.
 */
export async function createSession(model: string, cwd: string): Promise<string> {
  await ensureSessionsDir()
  const id = generateSessionId()
  const timestamp = nextSessionTimestamp()
  const session: Session = {
    meta: {
      id,
      model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      preview: '',
      cwd,
    },
    messages: [],
  }
  await writeFile(getSessionPath(id), JSON.stringify(session, null, 2), 'utf-8')
  await writeFile(getLastSessionPath(), id, 'utf-8')
  return id
}

/**
 * Save a message to an existing session.
 */
export async function saveMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: unknown,
): Promise<void> {
  const session = await loadSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const msg: SessionMessage = {
    role,
    content,
    timestamp: nextSessionTimestamp(session.meta.updatedAt),
  }
  session.messages.push(msg)
  session.meta.messageCount = session.messages.length
  session.meta.updatedAt = msg.timestamp

  // Update preview from first user message
  if (role === 'user' && !session.meta.preview) {
    const text = typeof content === 'string' ? content : JSON.stringify(content)
    session.meta.preview = text.slice(0, 80)
  }

  await writeFile(getSessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8')
  await writeFile(getLastSessionPath(), sessionId, 'utf-8')
}

/**
 * Load a session by ID.
 */
export async function loadSession(sessionId: string): Promise<Session | null> {
  const path = getSessionPath(sessionId)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

/**
 * Get the last used session ID.
 */
export async function getLastSessionId(): Promise<string | null> {
  const path = getLastSessionPath()
  if (!existsSync(path)) return null
  try {
    const id = (await readFile(path, 'utf-8')).trim()
    if (existsSync(getSessionPath(id))) return id
    return null
  } catch {
    return null
  }
}

/**
 * List all sessions, sorted by updatedAt descending.
 */
export async function listSessions(limit: number = 20): Promise<SessionMeta[]> {
  await ensureSessionsDir()
  const dir = getSessionsDir()
  const files = await readdir(dir)
  const jsonFiles = files.filter(f => f.endsWith('.json'))

  const metas: SessionMeta[] = []
  for (const f of jsonFiles) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      const session = JSON.parse(raw) as Session
      metas.push(session.meta)
    } catch {
      // Skip corrupt files
    }
  }

  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return metas.slice(0, limit)
}

/**
 * Update the model on an existing session (e.g. after /model switch in REPL).
 */
export async function updateSessionModel(sessionId: string, model: string): Promise<void> {
  const session = await loadSession(sessionId)
  if (!session) return
  session.meta.model = model
  session.meta.updatedAt = nextSessionTimestamp(session.meta.updatedAt)
  await writeFile(getSessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8')
}

/**
 * Delete a session by ID.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const path = getSessionPath(sessionId)
  if (!existsSync(path)) return false
  const { unlink } = await import('node:fs/promises')
  await unlink(path)
  return true
}

// ─── Tags ───

export async function addSessionTag(sessionId: string, tag: string): Promise<boolean> {
  const session = await loadSession(sessionId)
  if (!session) return false
  if (!session.meta.tags) session.meta.tags = []
  if (session.meta.tags.includes(tag)) return false
  session.meta.tags.push(tag)
  session.meta.updatedAt = nextSessionTimestamp(session.meta.updatedAt)
  await writeFile(getSessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8')
  return true
}

export async function removeSessionTag(sessionId: string, tag: string): Promise<boolean> {
  const session = await loadSession(sessionId)
  if (!session) return false
  if (!session.meta.tags) return false
  const idx = session.meta.tags.indexOf(tag)
  if (idx === -1) return false
  session.meta.tags.splice(idx, 1)
  session.meta.updatedAt = nextSessionTimestamp(session.meta.updatedAt)
  await writeFile(getSessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8')
  return true
}

export async function findSessionsByTag(tag: string, limit: number = 20): Promise<SessionMeta[]> {
  const all = await listSessions(1000)
  return all.filter(m => m.tags?.includes(tag)).slice(0, limit)
}

// ─── Content search ───

export interface SearchResult {
  meta: SessionMeta
  matchedPreview: string
}

export async function searchSessions(query: string, limit: number = 10): Promise<SearchResult[]> {
  await ensureSessionsDir()
  const dir = getSessionsDir()
  const files = await readdir(dir)
  const jsonFiles = files.filter(f => f.endsWith('.json'))
  const lowerQuery = query.toLowerCase()
  const results: SearchResult[] = []

  for (const f of jsonFiles) {
    if (results.length >= limit) break
    try {
      const raw = await readFile(join(dir, f), 'utf-8')
      const session = JSON.parse(raw) as Session

      // Search preview first
      if (session.meta.preview?.toLowerCase().includes(lowerQuery)) {
        results.push({ meta: session.meta, matchedPreview: session.meta.preview })
        continue
      }

      // Search message content
      for (const msg of session.messages) {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        const lower = text.toLowerCase()
        const idx = lower.indexOf(lowerQuery)
        if (idx !== -1) {
          const start = Math.max(0, idx - 30)
          const end = Math.min(text.length, idx + query.length + 30)
          const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
          results.push({ meta: session.meta, matchedPreview: snippet })
          break
        }
      }
    } catch {
      // Skip corrupt files
    }
  }

  return results
}

// ─── Branching ───

/**
 * Branch (deep copy) a session. Creates a new session linked to the parent.
 */
export async function branchSession(sourceId: string, branchName?: string): Promise<string> {
  const source = await loadSession(sourceId)
  if (!source) throw new Error(`Session ${sourceId} not found`)

  await ensureSessionsDir()
  const newId = generateSessionId()
  const timestamp = nextSessionTimestamp(source.meta.updatedAt)
  const branch: Session = {
    meta: {
      ...source.meta,
      id: newId,
      createdAt: timestamp,
      updatedAt: timestamp,
      parentId: sourceId,
      branchName: branchName || undefined,
    },
    messages: JSON.parse(JSON.stringify(source.messages)),
  }

  await writeFile(getSessionPath(newId), JSON.stringify(branch, null, 2), 'utf-8')
  return newId
}

/**
 * List all sessions that were branched from a given session.
 */
export async function listBranches(sessionId: string): Promise<SessionMeta[]> {
  const all = await listSessions(1000)
  return all.filter(m => m.parentId === sessionId)
}
