import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

describe('session search', () => {
  const testHome = '/tmp/owlcoda-test-search'
  const sessionsDir = path.join(testHome, 'sessions')

  function writeSession(id: string, preview: string, messages: Array<{ role: string; content: string }>) {
    const session = {
      meta: {
        id,
        model: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        preview,
        cwd: '/tmp',
      },
      messages: messages.map(m => ({ ...m, timestamp: new Date().toISOString() })),
    }
    writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2))
  }

  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true })
    mkdirSync(sessionsDir, { recursive: true })
    vi.stubEnv('OWLCODA_HOME', testHome)
  })

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('searchSessions finds matches in preview', async () => {
    writeSession('search-1', 'fixing authentication bug', [
      { role: 'user', content: 'help me fix auth' },
    ])
    writeSession('search-2', 'database optimization', [
      { role: 'user', content: 'optimize queries' },
    ])
    const { searchSessions } = await import('../src/history/sessions.js')
    const results = await searchSessions('authentication')
    expect(results.length).toBe(1)
    expect(results[0].meta.id).toBe('search-1')
  })

  it('searchSessions finds matches in message content', async () => {
    writeSession('search-3', 'general chat', [
      { role: 'user', content: 'How do I handle error boundaries in React?' },
      { role: 'assistant', content: 'Error boundaries catch rendering errors...' },
    ])
    const { searchSessions } = await import('../src/history/sessions.js')
    const results = await searchSessions('error boundaries')
    expect(results.length).toBe(1)
    expect(results[0].matchedPreview).toContain('error boundaries')
  })

  it('searchSessions is case insensitive', async () => {
    writeSession('search-4', 'TypeScript Setup', [
      { role: 'user', content: 'Help with TYPESCRIPT' },
    ])
    const { searchSessions } = await import('../src/history/sessions.js')
    const results = await searchSessions('typescript')
    expect(results.length).toBe(1)
  })

  it('searchSessions respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      writeSession(`search-lim-${i}`, `test query ${i}`, [
        { role: 'user', content: 'test query content' },
      ])
    }
    const { searchSessions } = await import('../src/history/sessions.js')
    const results = await searchSessions('test query', 2)
    expect(results.length).toBe(2)
  })

  it('searchSessions returns empty for no match', async () => {
    writeSession('search-5', 'hello world', [
      { role: 'user', content: 'simple greeting' },
    ])
    const { searchSessions } = await import('../src/history/sessions.js')
    const results = await searchSessions('zzz-nonexistent-term')
    expect(results.length).toBe(0)
  })
})
