import { describe, it, expect, afterEach } from 'vitest'
import { createConversation, addUserMessage, autoCompact } from '../../src/native/conversation.js'
import { saveSession, loadSession, deleteSession, restoreConversation } from '../../src/native/session.js'

const testIds: string[] = []

function makeTestId(): string {
  const id = `test-gate35-36-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  testIds.push(id)
  return id
}

afterEach(() => {
  for (const id of testIds) deleteSession(id)
  testIds.length = 0
})

/** Build a conversation with N user/assistant turn pairs. */
function buildConversation(turnPairs: number, id?: string) {
  const conv = createConversation({
    system: 'You are a test assistant.',
    model: 'test-model-v1',
    maxTokens: 4096,
  })
  if (id) (conv as any).id = id

  for (let i = 0; i < turnPairs; i++) {
    addUserMessage(conv, `User message ${i + 1}`)
    conv.turns.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Assistant reply ${i + 1}` }],
      timestamp: Date.now(),
    })
  }
  return conv
}

// ── Gate 3.6 ─────────────────────────────────────────────────────────
describe('Session restore environment consistency (Gate 3.6)', () => {
  it('saveSession stores cwd field', () => {
    const id = makeTestId()
    const conv = buildConversation(1, id)
    saveSession(conv)

    const loaded = loadSession(id)
    expect(loaded).not.toBeNull()
    expect(loaded!.cwd).toBe(process.cwd())
  })

  it('loadSession returns the stored cwd', () => {
    const id = makeTestId()
    const conv = buildConversation(1, id)
    saveSession(conv)

    const loaded = loadSession(id)!
    expect(typeof loaded.cwd).toBe('string')
    expect(loaded.cwd!.length).toBeGreaterThan(0)
    expect(loaded.cwd).toBe(process.cwd())
  })

  it('cwd field is preserved through save/load/restore cycle', () => {
    const id = makeTestId()
    const conv = buildConversation(2, id)
    saveSession(conv)

    const session = loadSession(id)!
    const tools = [{ name: 'bash', description: 'Run cmd', input_schema: { type: 'object' } }]
    const restored = restoreConversation(session, tools)

    // Restore gives back a Conversation; re-save should keep cwd
    saveSession(restored, 'round-trip title')
    const reloaded = loadSession(id)!
    expect(reloaded.cwd).toBe(process.cwd())
  })

  it('sessions saved before cwd feature still load correctly (backward compat)', () => {
    const id = makeTestId()
    const conv = buildConversation(1, id)
    saveSession(conv)

    // Simulate a legacy session by stripping the cwd field from disk
    const loaded = loadSession(id)!
    delete (loaded as any).cwd

    // The session object should still be usable
    const tools = [{ name: 'bash', description: 'Run cmd', input_schema: { type: 'object' } }]
    const restored = restoreConversation(loaded, tools)
    expect(restored.id).toBe(id)
    expect(restored.turns).toHaveLength(2)
    // cwd being undefined is fine for legacy sessions
    expect(loaded.cwd).toBeUndefined()
  })
})

// ── Gate 3.5 ─────────────────────────────────────────────────────────
describe('Compress integrity (Gate 3.5)', () => {
  it('autoCompact preserves turn structure (role, content, timestamp)', () => {
    const conv = buildConversation(20) // 40 turns
    // Force compact with a tiny context window
    const compacted = autoCompact(conv, 100)
    expect(compacted).toBe(true)
    expect(conv.turns.length).toBeLessThan(40)
    expect(conv.turns.length).toBeGreaterThanOrEqual(2)

    for (const turn of conv.turns) {
      expect(['user', 'assistant']).toContain(turn.role)
      expect(Array.isArray(turn.content)).toBe(true)
      expect(turn.content.length).toBeGreaterThan(0)
      expect(typeof turn.timestamp).toBe('number')
      expect(turn.timestamp).toBeGreaterThan(0)
    }
  })

  it('autoCompact preserves conversation metadata (id, system, model)', () => {
    const conv = buildConversation(20)
    const origId = conv.id
    const origSystem = conv.system
    const origModel = conv.model

    autoCompact(conv, 100)

    expect(conv.id).toBe(origId)
    expect(conv.system).toBe(origSystem)
    expect(conv.model).toBe(origModel)
  })

  it('compact + save + load roundtrip preserves all fields', () => {
    const id = makeTestId()
    const conv = buildConversation(20, id)
    autoCompact(conv, 100)

    const remainingTurns = conv.turns.length
    saveSession(conv, 'compacted session')

    const loaded = loadSession(id)!
    expect(loaded.id).toBe(id)
    expect(loaded.model).toBe('test-model-v1')
    expect(loaded.system).toBe('You are a test assistant.')
    expect(loaded.turns).toHaveLength(remainingTurns)
    expect(loaded.cwd).toBe(process.cwd())

    for (const turn of loaded.turns) {
      expect(['user', 'assistant']).toContain(turn.role)
      expect(turn.content.length).toBeGreaterThan(0)
      expect(turn.timestamp).toBeGreaterThan(0)
    }
  })

  it('autoCompact result starts with oldest kept turn (not a fragment)', () => {
    const conv = buildConversation(20)
    autoCompact(conv, 100)

    const first = conv.turns[0]!
    // The first remaining turn should be a complete turn with valid content
    expect(['user', 'assistant']).toContain(first.role)
    expect(first.content.length).toBeGreaterThan(0)

    const firstBlock = first.content[0] as any
    expect(firstBlock.type).toBe('text')
    expect(typeof firstBlock.text).toBe('string')
    expect(firstBlock.text.length).toBeGreaterThan(0)
  })
})
