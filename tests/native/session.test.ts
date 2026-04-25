import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  restoreConversation,
  getSessionsDir,
} from '../../src/native/session.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'

// Use a temp dir to avoid polluting real sessions
const REAL_DIR = getSessionsDir()
let tmpDir: string

// We'll mock the sessions dir by writing to the real dir then cleaning up
// Instead, let's test the core logic with real save/load

describe('Native Session Persistence', () => {
  const testId = `test-session-${Date.now()}`

  afterEach(() => {
    // Clean up test sessions
    deleteSession(testId)
  })

  it('saves and loads a conversation', () => {
    const conv = createConversation({
      system: 'Be helpful',
      model: 'test-model',
      maxTokens: 2048,
    })
    // Override ID for predictable testing
    ;(conv as any).id = testId

    addUserMessage(conv, 'Hello there')

    const filePath = saveSession(conv, 'Test Session')
    expect(filePath).toContain(testId)
    expect(fs.existsSync(filePath)).toBe(true)

    const loaded = loadSession(testId)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(testId)
    expect(loaded!.model).toBe('test-model')
    expect(loaded!.system).toBe('Be helpful')
    expect(loaded!.maxTokens).toBe(2048)
    expect(loaded!.title).toBe('Test Session')
    expect(loaded!.turns).toHaveLength(1)
    expect(loaded!.version).toBe(1)
  })

  it('returns null for non-existent session', () => {
    expect(loadSession('non-existent-id-123')).toBeNull()
  })

  it('updates existing session on re-save', () => {
    const conv = createConversation({
      system: 'test',
      model: 'm',
    })
    ;(conv as any).id = testId

    addUserMessage(conv, 'first')
    saveSession(conv)
    const first = loadSession(testId)!
    expect(first.turns).toHaveLength(1)

    addUserMessage(conv, 'second')
    saveSession(conv)
    const second = loadSession(testId)!
    expect(second.turns).toHaveLength(2)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
  })

  it('derives title from first user message', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'What is the meaning of life?')
    saveSession(conv)

    const loaded = loadSession(testId)!
    expect(loaded.title).toBe('What is the meaning of life?')
  })

  it('truncates long titles', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    const longMsg = 'A'.repeat(100)
    addUserMessage(conv, longMsg)
    saveSession(conv)

    const loaded = loadSession(testId)!
    expect(loaded.title!.length).toBeLessThanOrEqual(81) // 80 chars + ellipsis
    expect(loaded.title).toContain('…')
  })

  it('listSessions returns saved sessions', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hi')
    saveSession(conv)

    const sessions = listSessions()
    const found = sessions.find((s) => s.id === testId)
    expect(found).toBeDefined()
    expect(found!.model).toBe('m')
  })

  it('deleteSession removes the file', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    saveSession(conv)
    expect(loadSession(testId)).not.toBeNull()

    const deleted = deleteSession(testId)
    expect(deleted).toBe(true)
    expect(loadSession(testId)).toBeNull()
  })

  it('deleteSession returns false for non-existent', () => {
    expect(deleteSession('doesnt-exist-123')).toBe(false)
  })

  it('restoreConversation rebuilds a Conversation object', () => {
    const conv = createConversation({ system: 'test', model: 'qwen', maxTokens: 8192 })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hello')
    saveSession(conv)

    const session = loadSession(testId)!
    const tools = [{ name: 'bash', description: 'Run cmd', input_schema: { type: 'object' } }]
    const restored = restoreConversation(session, tools)

    expect(restored.id).toBe(testId)
    expect(restored.model).toBe('qwen')
    expect(restored.maxTokens).toBe(8192)
    expect(restored.turns).toHaveLength(1)
    expect(restored.tools).toHaveLength(1)
    expect(restored.tools[0]!.name).toBe('bash')
  })

  it('persists and restores pending retry state (attempt count only)', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code', maxTokens: 8192 })
    ;(conv as any).id = testId
    addUserMessage(conv, '继续')
    conv.options = {
      pendingRetry: { attemptCount: 1 },
    }
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.pendingRetry?.attemptCount).toBe(1)

    const restored = restoreConversation(session, [])
    expect(restored.options?.pendingRetry?.attemptCount).toBe(1)
  })

  it('omits pendingRetry when conversation has no retry state', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hi')
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.pendingRetry).toBeUndefined()

    const restored = restoreConversation(session, [])
    expect(restored.options?.pendingRetry).toBeUndefined()
  })

  it('persists and restores task execution state', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'Only touch `src/native/conversation.ts`.')
    conv.options = {
      taskState: ensureTaskExecutionState(conv, process.cwd()),
    }
    conv.options.taskState!.run.status = 'drifted'
    conv.options.taskState!.run.lastGuardReason = 'blocked example'
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.taskState?.contract.objective).toContain('Only touch')
    expect(session.taskState?.run.status).toBe('drifted')

    const restored = restoreConversation(session, [])
    expect(restored.options?.taskState?.contract.scopeMode).toBe('explicit_paths')
    expect(restored.options?.taskState?.run.lastGuardReason).toBe('blocked example')
  })

  it('sanitizes dangling assistant tool_use turns on save and restore', () => {
    const conv = createConversation({ system: 'test', model: 'qwen' })
    ;(conv as any).id = testId
    conv.turns.push(
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'edit:38', name: 'edit', input: { path: 'foo.ts' } } as any],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        timestamp: 3,
      },
    )

    saveSession(conv)
    expect(conv.turns).toHaveLength(2)
    expect(conv.turns[1]!.role).toBe('user')

    const session = loadSession(testId)!
    const restored = restoreConversation(session, [])
    expect(restored.turns).toHaveLength(2)
    expect(restored.turns.map(t => t.role)).toEqual(['user', 'user'])
  })

  it('sanitizes session ID in file path', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = 'bad/path/../../../etc/passwd'
    const filePath = saveSession(conv)
    // The filename portion should not contain slashes
    const filename = path.basename(filePath)
    expect(filename).not.toContain('/')
    expect(filename).toContain('bad_path')
    // Cleanup
    deleteSession('bad/path/../../../etc/passwd')
  })
})
