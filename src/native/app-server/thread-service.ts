import { join } from 'node:path'
import { buildSystemPrompt } from '../system-prompt.js'
import { addUserMessage, createConversation } from '../conversation.js'
import { getSessionsDir, listSessions, loadSession, restoreConversation, saveSession, type SessionFile } from '../session.js'
import type { ProjectSummary } from './project-service.js'
import type { Conversation, ConversationModelIdentity } from '../protocol/types.js'

const THREAD_LIST_DEFAULT_LIMIT = 100
const THREAD_LIST_MAX_LIMIT = 200

export interface ThreadStartInput {
  project: ProjectSummary
  title?: string
  model?: string
  systemPrompt?: string
  tools?: Conversation['tools']
  modelIdentity?: ConversationModelIdentity
}

export interface AppServerThread {
  id: string
  projectId: string
  title: string
  model: string
  status: 'ready'
  createdAt: number
  updatedAt: number
  cwd: string
  sessionPath: string
  turnCount: number
}

export interface ThreadStartResult {
  thread: AppServerThread
}

export interface ThreadListInput {
  project: ProjectSummary
  limit?: number
  offset?: number
  query?: string
}

export interface ThreadListResult {
  threads: AppServerThread[]
  totalCount: number
  offset: number
  limit: number
  hasMore: boolean
  query?: string
}

export interface ThreadResumeInput {
  project: ProjectSummary
  threadId: string
}

export interface ThreadResumeResult {
  thread: AppServerThread
}

export interface TurnStartInput {
  project: ProjectSummary
  threadId: string
  input: string
  tools?: Conversation['tools']
}

export interface TurnStartResult {
  projectId: string
  threadId: string
  status: 'accepted'
  turn: {
    index: number
    role: 'user'
  }
  thread: AppServerThread
}

export interface TurnInterruptInput {
  project: ProjectSummary
  threadId: string
}

export interface TurnInterruptResult {
  projectId: string
  threadId: string
  status: 'not_running' | 'interrupted'
  reason: 'no_active_turn' | 'abort_signal_sent'
}

export function startThread(input: ThreadStartInput): ThreadStartResult {
  const now = Date.now()
  const model = normalizeString(input.model) ?? 'app-server-unselected'
  const title = normalizeString(input.title) ?? 'Untitled desktop thread'
  const conversation = createConversation({
    system: input.systemPrompt ?? buildSystemPrompt({
      cwd: input.project.root,
      includeToolDescriptions: false,
    }),
    model,
    tools: input.tools ?? [],
    modelIdentity: input.modelIdentity ?? { id: model, backendModel: model },
  })
  const sessionPath = saveSession(conversation, title, { cwd: input.project.root })

  return {
    thread: {
      id: conversation.id,
      projectId: input.project.id,
      title,
      model,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      cwd: input.project.root,
      sessionPath,
      turnCount: 0,
    },
  }
}

export function listThreads(input: ThreadListInput): ThreadListResult {
  const offset = normalizeOffset(input.offset)
  const limit = normalizeLimit(input.limit)
  const query = normalizeString(input.query)
  const sessions = uniqueSessionsById(listSessions().filter(session => session.cwd === input.project.root))
    .filter(session => !query || sessionMatchesQuery(session, query))
  const threads = sessions
    .slice(offset, offset + limit)
    .map(session => sessionToThread(session, input.project))

  return {
    threads,
    totalCount: sessions.length,
    offset,
    limit,
    hasMore: offset + threads.length < sessions.length,
    ...(query ? { query } : {}),
  }
}

export function resumeThread(input: ThreadResumeInput): ThreadResumeResult | null {
  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null
  return {
    thread: sessionToThread(session, input.project),
  }
}

export function startTurn(input: TurnStartInput): TurnStartResult | null {
  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null

  const conversation = restoreConversation(session, input.tools ?? session.tools ?? [])
  const turnIndex = conversation.turns.length
  addUserMessage(conversation, input.input)
  const sessionPath = saveSession(conversation, session.title, { cwd: input.project.root })
  const updatedSession = loadSession(conversation.id) ?? {
    ...session,
    turns: conversation.turns,
    updatedAt: Date.now(),
  }

  return {
    projectId: input.project.id,
    threadId: conversation.id,
    status: 'accepted',
    turn: {
      index: turnIndex,
      role: 'user',
    },
    thread: {
      ...sessionToThread(updatedSession, input.project),
      sessionPath,
    },
  }
}

export function interruptTurn(input: TurnInterruptInput): TurnInterruptResult | null {
  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null
  return {
    projectId: input.project.id,
    threadId: session.id,
    status: 'not_running',
    reason: 'no_active_turn',
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sessionToThread(session: SessionFile, project: ProjectSummary): AppServerThread {
  return {
    id: session.id,
    projectId: project.id,
    title: session.title ?? 'Untitled session',
    model: session.model,
    status: 'ready',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd ?? '',
    sessionPath: join(getSessionsDir(), `${sanitizeSessionId(session.id)}.json`),
    turnCount: session.turns.length,
  }
}

function uniqueSessionsById(sessions: SessionFile[]): SessionFile[] {
  const byId = new Map<string, SessionFile>()
  for (const session of sessions) {
    const existing = byId.get(session.id)
    if (!existing || session.updatedAt > existing.updatedAt) {
      byId.set(session.id, session)
    }
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

function sessionMatchesQuery(session: SessionFile, query: string): boolean {
  const needle = query.toLowerCase()
  return [
    session.id,
    session.title ?? '',
    session.model,
    session.cwd ?? '',
  ].some(value => value.toLowerCase().includes(needle))
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return THREAD_LIST_DEFAULT_LIMIT
  return Math.min(THREAD_LIST_MAX_LIMIT, Math.max(1, Math.floor(value)))
}

function normalizeOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}
