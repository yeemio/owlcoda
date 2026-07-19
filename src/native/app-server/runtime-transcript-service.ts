import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSession, type SessionFile } from '../session.js'
import type {
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from '../../types.js'
import type { ConversationTurn, RuntimeEventRecord } from '../protocol/types.js'
import { isRuntimeTruthResumePromptTurn } from '../runtime-events.js'

export type RuntimeTranscriptItemStatus = 'pending' | 'completed' | 'failed'

export interface RuntimeTranscriptReadInput {
  projectRoot: string
  projectId?: string
  threadId: string
  /** Return only transcript items at or after this append-only cursor. */
  cursor?: number
}

export interface RuntimeTranscriptResult {
  threadId: string
  projectId?: string
  title?: string
  model: string
  status: 'ready'
  createdAt: number
  updatedAt: number
  itemCount: number
  cursor: number
  nextCursor: number
  runtimeEventCount: number
  items: RuntimeTranscriptItem[]
  replay?: RuntimeTranscriptReplay
}

export interface RuntimeTranscriptReplay {
  schemaVersion: 1
  source: 'runtime_event_log'
  threadId: string
  status: 'complete' | 'incomplete'
  reconnectStrategy: 'replay_from_persisted_session'
  eventCount: number
  itemCount: number
  timeline: RuntimeTranscriptReplayEvent[]
  associations: RuntimeTranscriptReplayAssociations
  diagnostics: string[]
}

export interface RuntimeTranscriptReplayEvent {
  id: string
  seq: number
  kind: RuntimeEventRecord['kind']
  at: string
  source: 'runtime_event_log'
  threadId: string
  turnId?: string
  itemId?: string
  toolUseId?: string
  diffId?: string
  interactionId?: string
}

export interface RuntimeTranscriptReplayAssociations {
  threadId: string
  turnIds: string[]
  itemIds: string[]
  toolUseIds: string[]
  diffIds: string[]
  interactionIds: string[]
}

export type RuntimeTranscriptItem =
  | RuntimeTranscriptMessageItem
  | RuntimeTranscriptToolCallItem
  | RuntimeTranscriptToolResultItem

export interface RuntimeTranscriptMessageItem {
  id: string
  kind: 'message'
  role: ConversationTurn['role']
  text: string
  timestamp: number
  turnIndex: number
  contentIndex: number
}

export interface RuntimeTranscriptToolCallItem {
  id: string
  kind: 'tool_call'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  status: RuntimeTranscriptItemStatus
  timestamp: number
  turnIndex: number
  contentIndex: number
  result?: RuntimeTranscriptToolResult
  resultTurnIndex?: number
  resultContentIndex?: number
  completedAt?: number
  runtime?: RuntimeTranscriptRuntimeAnchor
}

export interface RuntimeTranscriptToolResultItem {
  id: string
  kind: 'tool_result'
  toolUseId: string
  status: RuntimeTranscriptItemStatus
  timestamp: number
  turnIndex: number
  contentIndex: number
  result: RuntimeTranscriptToolResult
  runtime?: RuntimeTranscriptRuntimeAnchor
}

export interface RuntimeTranscriptToolResult {
  content: string
  isError: boolean
  metadata?: Record<string, unknown>
}

export interface RuntimeTranscriptRuntimeAnchor {
  turnId?: string
  runId?: string
  itemId?: string
  startedAt?: string
  completedAt?: string
  eventIds: string[]
}

interface ToolResultLocation {
  block: AnthropicToolResultBlock
  turn: ConversationTurn
  turnIndex: number
  contentIndex: number
}

export function readRuntimeTranscript(input: RuntimeTranscriptReadInput): RuntimeTranscriptResult | null {
  const session = loadTranscriptSession(input)
  if (!session) return null

  const toolUseIds = collectToolUseIds(session.turns)
  const toolResults = collectToolResults(session.turns)
  const runtimeAnchors = runtimeAnchorsByItem(session.runtimeEventLog?.events ?? [])
  const items: RuntimeTranscriptItem[] = []

  session.turns.forEach((turn, turnIndex) => {
    if (turn.audience === 'runtime' || isRuntimeTruthResumePromptTurn(turn)) return
    turn.content.forEach((block, contentIndex) => {
      if (isTextBlock(block)) {
        items.push({
          id: `turn:${turnIndex}:text:${contentIndex}`,
          kind: 'message',
          role: turn.role,
          text: block.text,
          timestamp: turn.timestamp,
          turnIndex,
          contentIndex,
        })
        return
      }
      if (block.type === 'thinking') return
      if (isToolUseBlock(block)) {
        const result = toolResults.get(block.id)
        const anchor = runtimeAnchors.get(block.id)
        const item: RuntimeTranscriptToolCallItem = {
          id: `tool:${block.id}`,
          kind: 'tool_call',
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
          status: result ? (result.block.is_error === true ? 'failed' : 'completed') : 'pending',
          timestamp: turn.timestamp,
          turnIndex,
          contentIndex,
        }
        if (result) {
          item.result = toolResultFromBlock(result.block)
          item.resultTurnIndex = result.turnIndex
          item.resultContentIndex = result.contentIndex
          item.completedAt = result.turn.timestamp
        }
        if (anchor) item.runtime = anchor
        items.push(item)
        return
      }
      if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
        const anchor = runtimeAnchors.get(block.tool_use_id)
        items.push({
          id: `tool-result:${block.tool_use_id}:${turnIndex}:${contentIndex}`,
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          status: block.is_error === true ? 'failed' : 'completed',
          timestamp: turn.timestamp,
          turnIndex,
          contentIndex,
          result: toolResultFromBlock(block),
          ...(anchor ? { runtime: anchor } : {}),
        })
      }
    })
  })

  const cursor = normalizeTranscriptCursor(input.cursor, items.length)
  const incrementalItems = items.slice(cursor).map(sanitizeTranscriptItem)

  return {
    threadId: session.id,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(session.title ? { title: session.title } : {}),
    model: session.model,
    status: 'ready',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    itemCount: items.length,
    cursor,
    nextCursor: items.length,
    runtimeEventCount: session.runtimeEventLog?.events.length ?? 0,
    items: incrementalItems,
    ...(session.runtimeEventLog?.events.length
      ? { replay: buildRuntimeTranscriptReplay(session.id, session.runtimeEventLog.events) }
      : {}),
  }
}

function normalizeTranscriptCursor(cursor: number | undefined, itemCount: number): number {
  if (cursor === undefined) return 0
  if (!Number.isSafeInteger(cursor) || cursor < 0) return 0
  return Math.min(cursor, itemCount)
}

function sanitizeTranscriptItem(item: RuntimeTranscriptItem): RuntimeTranscriptItem {
  if (item.kind === 'message') {
    return { ...item, text: stripTerminalControlSequences(item.text) }
  }
  if (item.kind === 'tool_call' && item.result) {
    return { ...item, result: sanitizeToolResult(item.result) }
  }
  if (item.kind === 'tool_result') {
    return { ...item, result: sanitizeToolResult(item.result) }
  }
  return item
}

function sanitizeToolResult(result: RuntimeTranscriptToolResult): RuntimeTranscriptToolResult {
  return { ...result, content: stripTerminalControlSequences(result.content) }
}

/** Keep raw PTY capture in its artifact; machine transcript reads contain text only. */
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
}

function buildRuntimeTranscriptReplay(threadId: string, events: RuntimeEventRecord[]): RuntimeTranscriptReplay {
  const associations: RuntimeTranscriptReplayAssociations = {
    threadId,
    turnIds: [],
    itemIds: [],
    toolUseIds: [],
    diffIds: [],
    interactionIds: [],
  }
  const openTurns = new Set<string>()
  const openItems = new Set<string>()
  const timeline: RuntimeTranscriptReplayEvent[] = events.map(event => {
    const toolUseId = stringField(event.payload, 'tool_use_id') ?? stringField(event.payload, 'toolUseId')
    const diffId = stringField(event.payload, 'diff_id') ?? stringField(event.payload, 'diffId')
    const interactionId = stringField(event.payload, 'interaction_id') ?? stringField(event.payload, 'interactionId')

    addUnique(associations.turnIds, event.turnId)
    addUnique(associations.itemIds, event.itemId)
    addUnique(associations.toolUseIds, toolUseId)
    addUnique(associations.diffIds, diffId)
    addUnique(associations.interactionIds, interactionId)

    if (event.kind === 'turn_started' && event.turnId) openTurns.add(event.turnId)
    if (event.kind === 'turn_completed' && event.turnId) openTurns.delete(event.turnId)
    if (event.kind === 'item_started' && event.itemId) openItems.add(event.itemId)
    if (event.kind === 'item_completed' && event.itemId) openItems.delete(event.itemId)

    return {
      id: event.id,
      seq: event.seq,
      kind: event.kind,
      at: event.at,
      source: 'runtime_event_log',
      threadId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(diffId ? { diffId } : {}),
      ...(interactionId ? { interactionId } : {}),
    }
  })

  const diagnostics = [
    ...[...openTurns].map(turnId => `unclosed runtime turn: ${turnId}`),
    ...[...openItems].map(itemId => `unclosed runtime item: ${itemId}`),
  ]

  return {
    schemaVersion: 1,
    source: 'runtime_event_log',
    threadId,
    status: diagnostics.length === 0 ? 'complete' : 'incomplete',
    reconnectStrategy: 'replay_from_persisted_session',
    eventCount: events.length,
    itemCount: timeline.length,
    timeline,
    associations,
    diagnostics,
  }
}

function addUnique(target: string[], value: string | null | undefined): void {
  if (!value || target.includes(value)) return
  target.push(value)
}

function loadTranscriptSession(input: RuntimeTranscriptReadInput): SessionFile | null {
  const session = loadSession(input.threadId)
  if (!session) return null
  const root = canonicalExistingPath(input.projectRoot)
  const cwd = session.cwd ? canonicalExistingPath(session.cwd) : root
  if (cwd !== root) return null
  return session
}

function collectToolUseIds(turns: ConversationTurn[]): Set<string> {
  const ids = new Set<string>()
  for (const turn of turns) {
    for (const block of turn.content) {
      if (isToolUseBlock(block)) ids.add(block.id)
    }
  }
  return ids
}

function collectToolResults(turns: ConversationTurn[]): Map<string, ToolResultLocation> {
  const results = new Map<string, ToolResultLocation>()
  turns.forEach((turn, turnIndex) => {
    turn.content.forEach((block, contentIndex) => {
      if (isToolResultBlock(block)) {
        results.set(block.tool_use_id, {
          block,
          turn,
          turnIndex,
          contentIndex,
        })
      }
    })
  })
  return results
}

function runtimeAnchorsByItem(events: RuntimeEventRecord[]): Map<string, RuntimeTranscriptRuntimeAnchor> {
  const anchors = new Map<string, RuntimeTranscriptRuntimeAnchor>()
  for (const event of events) {
    const itemId = event.itemId ?? stringField(event.payload, 'tool_use_id') ?? stringField(event.payload, 'toolUseId')
    if (!itemId) continue
    const anchor = anchors.get(itemId) ?? {
      itemId,
      eventIds: [],
    }
    if (event.turnId && !anchor.turnId) anchor.turnId = event.turnId
    const runId = event.runId ?? event.factRefs?.runId
    if (runId && !anchor.runId) anchor.runId = runId
    anchor.eventIds.push(event.id)
    if (event.kind === 'item_started') anchor.startedAt = event.at
    if (event.kind === 'item_completed') anchor.completedAt = event.at
    anchors.set(itemId, anchor)
  }
  return anchors
}

function toolResultFromBlock(block: AnthropicToolResultBlock): RuntimeTranscriptToolResult {
  return {
    content: toolResultContentText(block.content),
    isError: block.is_error === true,
    ...(block.metadata ? { metadata: block.metadata } : {}),
  }
}

function toolResultContentText(content: AnthropicToolResultBlock['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(isTextBlock)
      .map(block => block.text)
      .join('\n')
  }
  return ''
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === 'text'
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: AnthropicContentBlock): block is AnthropicToolResultBlock {
  return block.type === 'tool_result'
}
