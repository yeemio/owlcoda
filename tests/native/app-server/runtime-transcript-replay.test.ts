import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuntimeTranscript } from '../../../src/native/app-server/runtime-transcript-service.js'
import { createConversation } from '../../../src/native/conversation.js'
import { appendRuntimeEvent } from '../../../src/native/runtime-events.js'
import { deleteSession, saveSession } from '../../../src/native/session.js'

const createdSessions: string[] = []
const temporaryProjectRoots: string[] = []
let previousOwlcodaHome: string | undefined
let isolatedOwlcodaHome = ''

beforeAll(() => {
  previousOwlcodaHome = process.env['OWLCODA_HOME']
  isolatedOwlcodaHome = mkdtempSync(join(tmpdir(), 'owlcoda-runtime-replay-test-home-'))
  process.env['OWLCODA_HOME'] = isolatedOwlcodaHome
})

afterEach(() => {
  for (const id of createdSessions.splice(0)) deleteSession(id)
  for (const root of temporaryProjectRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  if (previousOwlcodaHome === undefined) {
    delete process.env['OWLCODA_HOME']
  } else {
    process.env['OWLCODA_HOME'] = previousOwlcodaHome
  }
  rmSync(isolatedOwlcodaHome, { recursive: true, force: true })
})

describe('runtime transcript replay model', () => {
  it('omits runtime-only prompt and superseded answer text from the user transcript', () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'runtime replay system', model: 'replay-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'Read package.json.' }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 2,
      content: [{ type: 'text', text: 'Premature answer.' }],
      audience: 'runtime',
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 3,
      content: [{ type: 'text', text: '[Runtime task-step] Continue the internal workflow.' }],
      audience: 'runtime',
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 3.5,
      content: [{ type: 'text', text: '[Runtime truth resume snapshot]\nLegacy persisted runtime recovery context.' }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 4,
      content: [{ type: 'text', text: 'Final answer.' }],
    })
    saveSession(conversation, 'Runtime-only transcript session', { cwd: projectRoot })
    createdSessions.push(conversation.id)

    const transcript = readRuntimeTranscript({ projectRoot, threadId: conversation.id })

    expect(transcript?.itemCount).toBe(2)
    expect(transcript?.items.map(item => item.kind === 'message' ? `${item.role}:${item.text}` : item.kind)).toEqual([
      'user:Read package.json.',
      'assistant:Final answer.',
    ])
  })

  it('builds a complete replay model with stable runtime associations', () => {
    const projectRoot = makeTemporaryProjectRoot()
    const targetPath = join(projectRoot, 'target.txt')
    writeFileSync(targetPath, 'alpha\n', 'utf8')
    const conversation = createConversation({ system: 'runtime replay system', model: 'replay-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'Please change alpha.' }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 2,
      content: [
        { type: 'text', text: 'I will edit.' },
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'edit',
          input: { path: targetPath, oldStr: 'alpha\n', newStr: 'beta\n' },
        },
      ],
    })
    conversation.turns.push({
      role: 'user',
      timestamp: 3,
      content: [{
        type: 'tool_result',
        tool_use_id: 'edit-1',
        content: `Edited ${targetPath}`,
        is_error: false,
        metadata: { path: targetPath },
      }],
    })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 4,
      content: [{ type: 'text', text: 'Done.' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-26T01:00:00.000Z',
      turnId: 'runtime-turn-1',
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_started',
      at: '2026-06-26T01:00:01.000Z',
      turnId: 'runtime-turn-1',
      itemId: 'edit-1',
      payload: {
        tool_name: 'edit',
        tool_use_id: 'edit-1',
        diff_id: 'diff-1',
        interaction_id: 'interaction-1',
      },
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T01:00:02.000Z',
      turnId: 'runtime-turn-1',
      itemId: 'edit-1',
      payload: {
        tool_name: 'edit',
        tool_use_id: 'edit-1',
        diff_id: 'diff-1',
        interaction_id: 'interaction-1',
        is_error: false,
      },
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_completed',
      at: '2026-06-26T01:00:03.000Z',
      turnId: 'runtime-turn-1',
      payload: {
        stop_reason: 'end_turn',
        iterations: 1,
        request_count: 1,
        input_tokens: 10,
        output_tokens: 5,
        assistant_response_count: 1,
        assistant_text_chars: 12,
        final_text_chars: 5,
        tool_use_count: 1,
        executed_tool_count: 1,
        empty_response_count: 0,
      },
    })
    saveSession(conversation, 'Replay session', { cwd: projectRoot })
    createdSessions.push(conversation.id)

    const transcript = readRuntimeTranscript({ projectRoot, threadId: conversation.id })

    expect(transcript?.replay).toMatchObject({
      schemaVersion: 1,
      source: 'runtime_event_log',
      threadId: conversation.id,
      status: 'complete',
      reconnectStrategy: 'replay_from_persisted_session',
      eventCount: 4,
      itemCount: 4,
      associations: {
        threadId: conversation.id,
        turnIds: ['runtime-turn-1'],
        itemIds: ['edit-1'],
        toolUseIds: ['edit-1'],
        diffIds: ['diff-1'],
        interactionIds: ['interaction-1'],
      },
      diagnostics: [],
    })
    expect(transcript?.replay.timeline).toEqual([
      {
        id: 'runtime_event-1',
        seq: 1,
        kind: 'turn_started',
        at: '2026-06-26T01:00:00.000Z',
        source: 'runtime_event_log',
        threadId: conversation.id,
        turnId: 'runtime-turn-1',
      },
      {
        id: 'runtime_event-2',
        seq: 2,
        kind: 'item_started',
        at: '2026-06-26T01:00:01.000Z',
        source: 'runtime_event_log',
        threadId: conversation.id,
        turnId: 'runtime-turn-1',
        itemId: 'edit-1',
        toolUseId: 'edit-1',
        diffId: 'diff-1',
        interactionId: 'interaction-1',
      },
      {
        id: 'runtime_event-3',
        seq: 3,
        kind: 'item_completed',
        at: '2026-06-26T01:00:02.000Z',
        source: 'runtime_event_log',
        threadId: conversation.id,
        turnId: 'runtime-turn-1',
        itemId: 'edit-1',
        toolUseId: 'edit-1',
        diffId: 'diff-1',
        interactionId: 'interaction-1',
      },
      {
        id: 'runtime_event-4',
        seq: 4,
        kind: 'turn_completed',
        at: '2026-06-26T01:00:03.000Z',
        source: 'runtime_event_log',
        threadId: conversation.id,
        turnId: 'runtime-turn-1',
      },
    ])
  })

  it('marks replay incomplete when persisted runtime events have unclosed turns or items', () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'runtime replay system', model: 'replay-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'start' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-06-26T01:10:00.000Z',
      turnId: 'runtime-turn-open',
    })
    appendRuntimeEvent(conversation, {
      kind: 'item_started',
      at: '2026-06-26T01:10:01.000Z',
      turnId: 'runtime-turn-open',
      itemId: 'tool-open',
      payload: { tool_name: 'edit', tool_use_id: 'tool-open' },
    })
    saveSession(conversation, 'Incomplete replay session', { cwd: projectRoot })
    createdSessions.push(conversation.id)

    const transcript = readRuntimeTranscript({ projectRoot, threadId: conversation.id })

    expect(transcript?.replay).toMatchObject({
      status: 'incomplete',
      eventCount: 2,
      associations: {
        turnIds: ['runtime-turn-open'],
        itemIds: ['tool-open'],
        toolUseIds: ['tool-open'],
      },
      diagnostics: [
        'unclosed runtime turn: runtime-turn-open',
        'unclosed runtime item: tool-open',
      ],
    })
  })

  it('returns cursor-based text-only increments without replaying prior TUI output', () => {
    const projectRoot = makeTemporaryProjectRoot()
    const conversation = createConversation({ system: 'runtime replay system', model: 'replay-model' })
    conversation.turns.push({
      role: 'assistant',
      timestamp: 1,
      content: [
        { type: 'text', text: '\u001b[2J\u001b[Hfirst\u001b[31m red\u001b[0m' },
        { type: 'text', text: 'second' },
      ],
    })
    saveSession(conversation, 'Incremental transcript', { cwd: projectRoot })
    createdSessions.push(conversation.id)

    const first = readRuntimeTranscript({ projectRoot, threadId: conversation.id, cursor: 0 })
    expect(first?.items.map(item => item.kind === 'message' ? item.text : '')).toEqual(['first red', 'second'])
    expect(first?.nextCursor).toBe(2)

    const unchanged = readRuntimeTranscript({ projectRoot, threadId: conversation.id, cursor: first?.nextCursor })
    expect(unchanged?.cursor).toBe(2)
    expect(unchanged?.nextCursor).toBe(2)
    expect(unchanged?.items).toEqual([])
  })
})

function makeTemporaryProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-runtime-replay-project-'))
  temporaryProjectRoots.push(root)
  return root
}
