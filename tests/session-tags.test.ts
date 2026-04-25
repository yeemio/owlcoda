import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('session tags', () => {
  const testHome = '/tmp/owlcoda-test-tags'
  const sessionsDir = path.join(testHome, 'sessions')

  function writeSession(id: string, meta: Record<string, unknown>, messages: unknown[] = []) {
    const session = {
      meta: { id, model: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: messages.length, preview: '', cwd: '/tmp', ...meta },
      messages,
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

  it('addSessionTag adds a tag', async () => {
    writeSession('tag-test-1', {})
    const { addSessionTag } = await import('../src/history/sessions.js')
    const ok = await addSessionTag('tag-test-1', 'important')
    expect(ok).toBe(true)
    const raw = JSON.parse(readFileSync(path.join(sessionsDir, 'tag-test-1.json'), 'utf-8'))
    expect(raw.meta.tags).toContain('important')
  })

  it('addSessionTag rejects duplicates', async () => {
    writeSession('tag-test-2', { tags: ['existing'] })
    const { addSessionTag } = await import('../src/history/sessions.js')
    const ok = await addSessionTag('tag-test-2', 'existing')
    expect(ok).toBe(false)
  })

  it('removeSessionTag removes a tag', async () => {
    writeSession('tag-test-3', { tags: ['a', 'b', 'c'] })
    const { removeSessionTag } = await import('../src/history/sessions.js')
    const ok = await removeSessionTag('tag-test-3', 'b')
    expect(ok).toBe(true)
    const raw = JSON.parse(readFileSync(path.join(sessionsDir, 'tag-test-3.json'), 'utf-8'))
    expect(raw.meta.tags).toEqual(['a', 'c'])
  })

  it('findSessionsByTag returns matching sessions', async () => {
    writeSession('tag-s1', { tags: ['debug'] })
    writeSession('tag-s2', { tags: ['debug', 'prod'] })
    writeSession('tag-s3', { tags: ['prod'] })
    const { findSessionsByTag } = await import('../src/history/sessions.js')
    const results = await findSessionsByTag('debug')
    expect(results.length).toBe(2)
    expect(results.map(r => r.id).sort()).toEqual(['tag-s1', 'tag-s2'])
  })
})
