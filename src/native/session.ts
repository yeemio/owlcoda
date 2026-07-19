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
  ConversationContextCapability,
  ConversationModelIdentity,
  ConversationTurn,
  ConversationUsageTotals,
  PendingRetryState,
  ReasoningEffort,
  RuntimeEventLog,
  RuntimeRecoveryLedger,
  TaskExecutionState,
} from './protocol/types.js'
import { sanitizeConversationTurns } from './protocol/request.js'
import {
  restoreTaskStore,
  snapshotTaskStore,
  type TaskStoreSnapshot,
} from './tools/task-store.js'
import {
  restoreAgentRunHistory,
  snapshotAgentRunHistory,
  type AgentRunHistorySnapshot,
} from './tools/agent.js'
import {
  restoreJobRegistry,
  snapshotJobRegistry,
  type JobRegistrySnapshot,
} from './job-supervisor.js'
import { applyRuntimeTruthResumeSnapshot } from './runtime-events.js'
import type { OperatingModeState } from './modes.js'

export type SessionWorkspaceIdentity =
  | {
      mode: 'project'
      projectRoot: string
      workspacePath: string
    }
  | {
      mode: 'managed'
      workspaceId: string
      projectRoot: string
      workspacePath: string
      branch: string
      baseCommit: string
      ledgerPath: string
    }

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
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
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
  modelIdentity?: ConversationModelIdentity
  usageTotals?: ConversationUsageTotals
  contextCapability?: ConversationContextCapability
  operatingModeState?: OperatingModeState
  reasoningEffort?: ReasoningEffort
  runtimeRecoveryLedger?: RuntimeRecoveryLedger
  runtimeEventLog?: RuntimeEventLog
  taskStore?: TaskStoreSnapshot
  agentRunStore?: AgentRunHistorySnapshot
  jobRegistry?: JobRegistrySnapshot
  workspace?: SessionWorkspaceIdentity
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
const cwdSessionCatalog = new Map<string, { catalogToken: string; ids: string[] }>()
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
export function saveSession(
  conversation: Conversation,
  title?: string,
  options: { cwd?: string; workspace?: SessionWorkspaceIdentity } = {},
): string {
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
    tools: conversation.tools,
    turns: sanitizedTurns,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    title: title ?? existing?.title ?? deriveTitle(conversation),
    cwd: options.cwd ?? process.cwd(),
    pendingRetry: conversation.options?.pendingRetry,
    taskState: conversation.options?.taskState,
    modelIdentity: conversation.options?.modelIdentity,
    usageTotals: conversation.options?.usageTotals,
    contextCapability: conversation.options?.contextCapability,
    operatingModeState: conversation.options?.operatingModeState,
    reasoningEffort: conversation.options?.reasoningEffort,
    runtimeRecoveryLedger: conversation.options?.runtimeRecoveryLedger,
    runtimeEventLog: conversation.options?.runtimeEventLog,
    taskStore: snapshotTaskStore(conversation.id),
    jobRegistry: snapshotJobRegistry(),
    workspace: options.workspace ?? existing?.workspace,
  }
  const agentRunStore = snapshotAgentRunHistory(conversation.id)
  if (agentRunStore.records.length > 0) {
    session.agentRunStore = agentRunStore
  }

  const filePath = sessionPath(conversation.id)
  try {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
    refreshCachedSessionMembership(session.id, session.cwd ?? process.cwd())
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

export function handoffSessionWorkspace(input: {
  threadId: string
  expectedWorkspace: SessionWorkspaceIdentity
  targetWorkspace: SessionWorkspaceIdentity
}): SessionFile {
  const session = loadSession(input.threadId)
  if (
    !session
    || session.cwd !== input.expectedWorkspace.workspacePath
    || !sameWorkspaceIdentity(session.workspace, input.expectedWorkspace)
  ) {
    throw new Error('Thread workspace changed before handoff')
  }

  const moved: SessionFile = {
    ...session,
    cwd: input.targetWorkspace.workspacePath,
    workspace: input.targetWorkspace,
    updatedAt: Date.now(),
  }
  const filePath = sessionPath(session.id)
  const temporaryPath = `${filePath}.handoff-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(moved, null, 2), 'utf-8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
  refreshCachedSessionMembership(moved.id, moved.cwd ?? process.cwd())
  return moved
}

function sameWorkspaceIdentity(
  actual: SessionWorkspaceIdentity | undefined,
  expected: SessionWorkspaceIdentity,
): boolean {
  if (!actual || actual.mode !== expected.mode) return false
  if (actual.projectRoot !== expected.projectRoot || actual.workspacePath !== expected.workspacePath) return false
  if (actual.mode === 'project' && expected.mode === 'project') return true
  if (actual.mode !== 'managed' || expected.mode !== 'managed') return false
  return actual.workspaceId === expected.workspaceId
    && actual.branch === expected.branch
    && actual.baseCommit === expected.baseCommit
    && actual.ledgerPath === expected.ledgerPath
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
  if (session.modelIdentity) {
    conversation.options = {
      ...conversation.options,
      modelIdentity: session.modelIdentity,
    }
  }
  if (session.usageTotals) {
    conversation.options = {
      ...conversation.options,
      usageTotals: session.usageTotals,
    }
  }
  if (session.contextCapability) {
    conversation.options = {
      ...conversation.options,
      contextCapability: session.contextCapability,
    }
  }
  if (session.operatingModeState) {
    conversation.options = {
      ...conversation.options,
      operatingModeState: session.operatingModeState,
    }
  }
  if (session.reasoningEffort) {
    conversation.options = {
      ...conversation.options,
      reasoningEffort: session.reasoningEffort,
    }
  }
  if (session.runtimeRecoveryLedger) {
    conversation.options = {
      ...conversation.options,
      runtimeRecoveryLedger: session.runtimeRecoveryLedger,
    }
  }
  if (session.runtimeEventLog) {
    conversation.options = {
      ...conversation.options,
      runtimeEventLog: session.runtimeEventLog,
    }
  }
  if (session.taskStore) {
    restoreTaskStore(session.taskStore)
  }
  restoreAgentRunHistory(session.agentRunStore, session.runtimeRecoveryLedger, session.id)
  if (session.jobRegistry) {
    restoreJobRegistry(session.jobRegistry)
  }
  applyRuntimeTruthResumeSnapshot(conversation)
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

/** List sessions for one project without reparsing every unrelated history on each Desktop refresh. */
export function listSessionsForCwd(cwd: string): SessionFile[] {
  ensureDir()
  const sessDir = getDefaultSessionsDir()
  const catalogToken = readSessionCatalogToken(sessDir)
  const cached = cwdSessionCatalog.get(cwd)
  if (!cached || cached.catalogToken !== catalogToken) {
    const sessions = listSessions().filter(session => session.cwd === cwd)
    cwdSessionCatalog.set(cwd, {
      catalogToken: readSessionCatalogToken(sessDir),
      ids: sessions.map(session => session.id),
    })
    return sessions
  }
  return cached.ids
    .map(id => loadSession(id))
    .filter((session): session is SessionFile => session?.cwd === cwd)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function readSessionCatalogToken(sessDir: string): string {
  return fs.readdirSync(sessDir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      try {
        const stat = fs.statSync(path.join(sessDir, file))
        return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      } catch {
        return `${file}:missing`
      }
    })
    .join('|')
}

function refreshCachedSessionMembership(id: string, cwd: string): void {
  const sessDir = getDefaultSessionsDir()
  const catalogToken = readSessionCatalogToken(sessDir)
  for (const [projectCwd, cached] of cwdSessionCatalog) {
    const ids = cached.ids.filter(candidate => candidate !== id)
    if (projectCwd === cwd) ids.unshift(id)
    cwdSessionCatalog.set(projectCwd, { catalogToken, ids })
  }
}

/** Delete a saved session. Returns true if deleted. */
export function deleteSession(id: string): boolean {
  const filePath = sessionPath(id)
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  const catalogToken = readSessionCatalogToken(getDefaultSessionsDir())
  for (const [cwd, cached] of cwdSessionCatalog) {
    cwdSessionCatalog.set(cwd, { catalogToken, ids: cached.ids.filter(candidate => candidate !== id) })
  }
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
