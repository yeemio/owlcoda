import { join } from 'node:path'
import { buildSystemPrompt } from '../system-prompt.js'
import { addRuntimeMessage, addUserMessage, createConversation } from '../conversation.js'
import {
  getSessionsDir,
  listSessionsForCwd,
  loadSession,
  restoreConversation,
  saveSession,
  type SessionFile,
  type SessionWorkspaceIdentity,
} from '../session.js'
import type { ProjectSummary } from './project-service.js'
import type { Conversation, ConversationModelIdentity, ReasoningEffort } from '../protocol/types.js'
import type { AnthropicContentBlock } from '../../types.js'
import type { OperatingMode } from '../modes.js'
import { appendRuntimeEvent, isRuntimeTruthResumePromptTurn } from '../runtime-events.js'

const THREAD_LIST_DEFAULT_LIMIT = 100
const THREAD_LIST_MAX_LIMIT = 200
const THREAD_READ_DEFAULT_LIMIT = 50
const THREAD_READ_MAX_LIMIT = 200

export interface ThreadStartInput {
  project: ProjectSummary
  title?: string
  model?: string
  systemPrompt?: string
  tools?: Conversation['tools']
  modelIdentity?: ConversationModelIdentity
  permissionMode?: OperatingMode
  workspaceMode?: 'project' | 'managed'
  workspace?: SessionWorkspaceIdentity
  reasoningEffort?: ReasoningEffort
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
  permissionMode: OperatingMode
  workspaceMode: 'project' | 'managed'
  workspace: SessionWorkspaceIdentity
  reasoningEffort?: ReasoningEffort
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
  model?: string
  modelIdentity?: ConversationModelIdentity
  reasoningEffort?: ReasoningEffort | null
}

export interface ThreadResumeResult {
  thread: AppServerThread
}

export interface ThreadReadInput {
  project: ProjectSummary
  threadId: string
  limit?: number
  cursor?: string
}

export interface AppServerThreadTurn {
  id: string
  index: number
  role: Conversation['turns'][number]['role']
  model?: string
  timestamp: number
  content: Conversation['turns'][number]['content']
}

export interface ThreadReadResult {
  thread: AppServerThread
  items: AppServerThreadTurn[]
  snapshotCursor: string
  page: {
    startIndex: number
    limit: number
    totalCount: number
    hasMore: boolean
    nextCursor: string | null
  }
}

export interface TurnStartInput {
  project: ProjectSummary
  threadId: string
  input: string | AnthropicContentBlock[]
  attachments?: Array<{ id: string; mediaType: string; size: number; status: 'attached' }>
  tools?: Conversation['tools']
  retry?: boolean
  title?: string
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
  attachments?: Array<{ id: string; mediaType: string; size: number; status: 'attached' }>
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
  conversation.options = {
    ...conversation.options,
    operatingModeState: { mode: input.permissionMode ?? 'normal' },
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  }
  const workspace = input.workspace ?? {
    mode: 'project' as const,
    projectRoot: input.project.root,
    workspacePath: input.project.root,
  }
  if ((input.workspaceMode ?? 'project') !== workspace.mode) {
    throw new Error('Thread workspace mode does not match workspace identity')
  }
  const sessionPath = saveSession(conversation, title, { cwd: input.project.root, workspace })

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
      permissionMode: input.permissionMode ?? 'normal',
      workspaceMode: workspace.mode,
      workspace,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    },
  }
}

export function listThreads(input: ThreadListInput): ThreadListResult {
  const offset = normalizeOffset(input.offset)
  const limit = normalizeLimit(input.limit)
  const query = normalizeString(input.query)
  const sessions = uniqueSessionsById(listSessionsForCwd(input.project.root))
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
  let session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null
  const model = normalizeString(input.model)
  if ((model && model !== session.model) || input.reasoningEffort !== undefined) {
    const conversation = restoreConversation(session, session.tools ?? [])
    if (model) conversation.model = model
    conversation.options = {
      ...conversation.options,
      ...(model ? { modelIdentity: input.modelIdentity ?? { id: model, backendModel: model } } : {}),
    }
    if (input.reasoningEffort === null) {
      delete conversation.options.reasoningEffort
    } else if (input.reasoningEffort) {
      conversation.options.reasoningEffort = input.reasoningEffort
    }
    saveSession(conversation, session.title, { cwd: input.project.root })
    session = loadSession(input.threadId) ?? session
  }
  return {
    thread: sessionToThread(session, input.project),
  }
}

export function readThread(input: ThreadReadInput): ThreadReadResult | null {
  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null
  const visibleTurns = session.turns.filter(turn => turn.audience !== 'runtime' && !isRuntimeTruthResumePromptTurn(turn))
  const cursor = input.cursor ? decodeThreadCursor(input.cursor, input.threadId) : null
  const totalCount = cursor?.snapshotTurnCount ?? visibleTurns.length
  if (totalCount > visibleTurns.length) throw new Error('Thread cursor is no longer available')
  const startIndex = cursor?.nextIndex ?? 0
  if (startIndex > totalCount) throw new Error('Thread cursor is outside the snapshot')
  const limit = normalizeReadLimit(input.limit)
  const endIndex = Math.min(totalCount, startIndex + limit)
  const snapshot = { version: 1 as const, threadId: session.id, snapshotTurnCount: totalCount }

  return {
    thread: sessionToThread(session, input.project),
    items: visibleTurns.slice(startIndex, endIndex).map((turn, offset) => ({
      id: `${session.id}:turn:${startIndex + offset}`,
      index: startIndex + offset,
      role: turn.role,
      ...(turn.model ? { model: turn.model } : {}),
      timestamp: turn.timestamp,
      content: turn.content.filter(block => block.type !== 'thinking').map(block => ({ ...block })),
    })),
    snapshotCursor: encodeCursor(snapshot),
    page: {
      startIndex,
      limit,
      totalCount,
      hasMore: endIndex < totalCount,
      nextCursor: endIndex < totalCount ? encodeCursor({ ...snapshot, nextIndex: endIndex }) : null,
    },
  }
}

export function startTurn(input: TurnStartInput): TurnStartResult | null {
  const session = loadSession(input.threadId)
  if (!session || session.cwd !== input.project.root) return null

  const conversation = restoreConversation(session, input.tools ?? session.tools ?? [])
  const turnIndex = conversation.turns.length
  if (input.retry) addRuntimeMessage(conversation, input.input, { supersedeLatestAssistant: true })
  else addUserMessage(conversation, input.input)
  const selectedTurn = conversation.turns.at(-1)
  if (selectedTurn) selectedTurn.model = conversation.model
  if (input.attachments?.length) {
    appendRuntimeEvent(conversation, {
      kind: 'runtime_intervention',
      factRefs: { threadId: conversation.id, coveredIds: input.attachments.map(item => item.id) },
      payload: {
        intervention_kind: 'image_input_routed',
        model: conversation.model,
        attached_count: input.attachments.length,
        blocked_count: 0,
        artifacts: input.attachments.map(item => ({ artifact_id: item.id, media_type: item.mediaType, size: item.size, status: item.status })),
      },
    })
  }
  const title = turnIndex === 0 && /^(?:Untitled desktop thread|Untitled session)$/.test(session.title ?? '')
    ? normalizeString(input.title) ?? session.title
    : session.title
  const sessionPath = saveSession(conversation, title, { cwd: input.project.root })
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
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
    turnCount: session.turns.filter(turn => turn.audience !== 'runtime' && !isRuntimeTruthResumePromptTurn(turn)).length,
    permissionMode: session.operatingModeState?.mode ?? 'normal',
    workspaceMode: session.workspace?.mode ?? 'project',
    workspace: session.workspace ?? {
      mode: 'project',
      projectRoot: project.root,
      workspacePath: project.root,
    },
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
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

function normalizeReadLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return THREAD_READ_DEFAULT_LIMIT
  return Math.min(THREAD_READ_MAX_LIMIT, Math.max(1, Math.floor(value)))
}

interface ThreadCursorPayload {
  version: 1
  threadId: string
  snapshotTurnCount: number
  nextIndex?: number
}

function encodeCursor(cursor: ThreadCursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeThreadCursor(value: string, threadId: string): Required<ThreadCursorPayload> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ThreadCursorPayload>
    if (
      parsed.version !== 1
      || parsed.threadId !== threadId
      || !Number.isSafeInteger(parsed.snapshotTurnCount)
      || (parsed.snapshotTurnCount ?? -1) < 0
      || !Number.isSafeInteger(parsed.nextIndex)
      || (parsed.nextIndex ?? -1) < 0
    ) throw new Error('invalid cursor')
    return parsed as Required<ThreadCursorPayload>
  } catch {
    throw new Error('Invalid thread cursor')
  }
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}
