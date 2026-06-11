import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/native/conversation.js', () => ({
  createConversation: vi.fn((o) => ({ id: 'fresh', system: o.system, model: o.model, maxTokens: o.maxTokens, tools: o.tools ?? [], turns: [] })),
  addUserMessage: vi.fn(),
  runConversationLoop: vi.fn(async () => ({ conversation: { turns: [] }, finalText: '', iterations: 0 })),
  resolveDefaultMaxOutputTokens: vi.fn(() => 32_768),
}))
vi.mock('../../src/native/tool-defs.js', () => ({ buildNativeToolDefs: () => [] }))
vi.mock('../../src/native/session.js', async (orig) => ({
  ...(await orig() as object),
  loadSession: vi.fn(() => null),
  listSessions: vi.fn(() => []),
  saveSession: vi.fn(),
}))

import { classifyResumeRequest, runHeadless } from '../../src/native/headless.js'
import type { SessionFile } from '../../src/native/session.js'

const fakeSession = (id: string): SessionFile =>
  ({ id, model: 'm', system: 's', maxTokens: 100, turns: [] } as unknown as SessionFile)

// An explicit --resume must be honored or fail. Silently degrading a missing /
// corrupt session into a fresh session burns a scripted headless run with no
// prior context while the caller believes it resumed. #10
describe('classifyResumeRequest', () => {
  const deps = (sessions: SessionFile[], byId: Record<string, SessionFile>) => ({
    listSessions: () => sessions,
    loadSession: (id: string) => byId[id] ?? null,
  })

  it('returns fresh when no resume was requested', () => {
    expect(classifyResumeRequest(undefined, deps([], {})).kind).toBe('fresh')
  })

  it('resumes a session that loads', () => {
    const s = fakeSession('abc')
    const out = classifyResumeRequest('abc', deps([s], { abc: s }))
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.session.id).toBe('abc')
  })

  it('errors (not fresh) when an explicit id is missing or unreadable', () => {
    const out = classifyResumeRequest('ghost', deps([], {}))
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.requested).toBe('ghost')
      expect(out.message).toContain('ghost')
    }
  })

  it('errors when --resume last has no saved sessions', () => {
    const out = classifyResumeRequest('last', deps([], {}))
    expect(out.kind).toBe('error')
    if (out.kind === 'error') expect(out.message).toMatch(/no saved sessions/i)
  })

  it('resumes the most recent session for --resume last', () => {
    const s = fakeSession('newest')
    const out = classifyResumeRequest('last', deps([s], { newest: s }))
    expect(out.kind).toBe('resume')
  })
})

// Wiring: a missing --resume must make runHeadless exit non-zero, not silently
// run a fresh contextless session.
describe('runHeadless resume fail-fast (wiring)', () => {
  it('returns exitCode 1 and resumed:false for an unknown --resume id', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = await runHeadless({
        prompt: 'hi',
        model: 'm',
        resumeSession: 'does-not-exist',
      } as never)
      expect(result.exitCode).toBe(1)
      expect(result.resumed).toBe(false)
    } finally {
      writeSpy.mockRestore()
    }
  })
})
