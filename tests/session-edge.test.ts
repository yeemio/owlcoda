/**
 * Session persistence edge case tests — round-trip, ordering, missing sessions, empty messages.
 * Uses temp directory to avoid polluting real ~/.owlcoda/sessions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

// Redirect OwlCoda session storage to a temp directory
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-session-test-'))
  vi.stubEnv('OWLCODA_HOME', tempDir)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
})

describe('session persistence edge cases', () => {
  it('createSession + loadSession round-trip', async () => {
    // Dynamic import after env is set
    const { createSession, loadSession } = await import('../src/history/sessions.js')
    const id = await createSession('test-model', '/tmp')
    expect(id).toBeTruthy()
    expect(id).toMatch(/^\d{8}-[a-f0-9]{6}$/)

    const session = await loadSession(id)
    expect(session).not.toBeNull()
    expect(session!.meta.id).toBe(id)
    expect(session!.meta.model).toBe('test-model')
    expect(session!.meta.cwd).toBe('/tmp')
    expect(session!.messages).toEqual([])
    expect(session!.meta.messageCount).toBe(0)
  })

  it('loadSession with non-existent ID returns null', async () => {
    const { loadSession } = await import('../src/history/sessions.js')
    const result = await loadSession('nonexistent-999999')
    expect(result).toBeNull()
  })

  it('saveMessage increments messageCount and updates updatedAt', async () => {
    const { createSession, saveMessage, loadSession } = await import('../src/history/sessions.js')
    const id = await createSession('test-model', '/tmp')
    const beforeSave = new Date().toISOString()

    // Small delay to ensure updatedAt differs
    await new Promise(r => setTimeout(r, 10))
    await saveMessage(id, 'user', 'Hello world')

    const session = await loadSession(id)
    expect(session!.meta.messageCount).toBe(1)
    expect(session!.messages).toHaveLength(1)
    expect(session!.messages[0].role).toBe('user')
    expect(session!.messages[0].content).toBe('Hello world')
    expect(session!.meta.updatedAt >= beforeSave).toBe(true)
  })

  it('saveMessage sets preview from first user message', async () => {
    const { createSession, saveMessage, loadSession } = await import('../src/history/sessions.js')
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'What is the meaning of life?')

    const session = await loadSession(id)
    expect(session!.meta.preview).toBe('What is the meaning of life?')
  })

  it('saveMessage throws for non-existent session', async () => {
    const { saveMessage } = await import('../src/history/sessions.js')
    await expect(saveMessage('does-not-exist', 'user', 'hi')).rejects.toThrow('not found')
  })

  it('listSessions returns sessions sorted by updatedAt descending', async () => {
    const { createSession, saveMessage, listSessions } = await import('../src/history/sessions.js')

    const id1 = await createSession('model-a', '/tmp')
    await new Promise(r => setTimeout(r, 15))
    const id2 = await createSession('model-b', '/tmp')
    await new Promise(r => setTimeout(r, 15))
    await saveMessage(id1, 'user', 'updated later')

    const sessions = await listSessions(100)
    // id1 was updated last (saveMessage), so it should be first
    const ids = sessions.map(s => s.id)
    const idx1 = ids.indexOf(id1)
    const idx2 = ids.indexOf(id2)
    expect(idx1).toBeLessThan(idx2)
  })

  it('session with empty messages array persists correctly', async () => {
    const { createSession, loadSession } = await import('../src/history/sessions.js')
    const id = await createSession('empty-model', '/tmp')
    const session = await loadSession(id)
    expect(session!.messages).toEqual([])
    expect(session!.meta.messageCount).toBe(0)
  })

  it('deleteSession removes session file', async () => {
    const { createSession, loadSession, deleteSession } = await import('../src/history/sessions.js')
    const id = await createSession('delete-me', '/tmp')
    expect(await loadSession(id)).not.toBeNull()

    const deleted = await deleteSession(id)
    expect(deleted).toBe(true)
    expect(await loadSession(id)).toBeNull()
  })

  it('deleteSession returns false for non-existent session', async () => {
    const { deleteSession } = await import('../src/history/sessions.js')
    const result = await deleteSession('never-existed')
    expect(result).toBe(false)
  })

  it('updateSessionModel changes model field', async () => {
    const { createSession, loadSession, updateSessionModel } = await import('../src/history/sessions.js')
    const id = await createSession('old-model', '/tmp')
    await updateSessionModel(id, 'new-model')
    const session = await loadSession(id)
    expect(session!.meta.model).toBe('new-model')
  })

  it('getLastSessionId returns most recently touched session', async () => {
    const { createSession, getLastSessionId } = await import('../src/history/sessions.js')
    const id = await createSession('latest', '/tmp')
    const lastId = await getLastSessionId()
    expect(lastId).toBe(id)
  })
})
