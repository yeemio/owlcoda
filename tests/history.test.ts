/**
 * Tests for src/history/sessions.ts — session persistence.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// We need to override OWLCODA_HOME so sessions go to a temp dir
const TEST_HOME = join(tmpdir(), `owlcoda-sessions-test-${randomBytes(4).toString('hex')}`)
process.env['OWLCODA_HOME'] = TEST_HOME

import {
  createSession,
  saveMessage,
  loadSession,
  getLastSessionId,
  listSessions,
  deleteSession,
  updateSessionModel,
} from '../dist/history/sessions.js'

beforeEach(() => {
  // Clean the sessions dir before each test
  const sessDir = join(TEST_HOME, 'sessions')
  if (existsSync(sessDir)) rmSync(sessDir, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true })
  delete process.env['OWLCODA_HOME']
})

describe('session lifecycle', () => {
  it('createSession returns an ID in YYYYMMDD-hex format', async () => {
    const id = await createSession('qwen2.5-coder:32b', '/tmp')
    expect(id).toMatch(/^\d{8}-[0-9a-f]{6}$/)
  })

  it('loadSession returns the created session', async () => {
    const id = await createSession('gpt-oss-120b-MXFP4-Q4', '/home/user')
    const session = await loadSession(id)
    expect(session).not.toBeNull()
    expect(session!.meta.id).toBe(id)
    expect(session!.meta.model).toBe('gpt-oss-120b-MXFP4-Q4')
    expect(session!.meta.cwd).toBe('/home/user')
    expect(session!.messages).toHaveLength(0)
  })

  it('loadSession returns null for nonexistent ID', async () => {
    const session = await loadSession('nonexistent-id')
    expect(session).toBeNull()
  })

  it('getLastSessionId returns the most recently created session', async () => {
    await createSession('model-a', '/tmp')
    const id2 = await createSession('model-b', '/tmp')
    const lastId = await getLastSessionId()
    expect(lastId).toBe(id2)
  })
})

describe('saveMessage', () => {
  it('appends user message to session', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hello world')
    const session = await loadSession(id)
    expect(session!.messages).toHaveLength(1)
    expect(session!.messages[0]!.role).toBe('user')
    expect(session!.messages[0]!.content).toBe('Hello world')
    expect(session!.meta.preview).toBe('Hello world')
    expect(session!.meta.messageCount).toBe(1)
  })

  it('appends assistant message', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hi')
    await saveMessage(id, 'assistant', 'Hello! How can I help?')
    const session = await loadSession(id)
    expect(session!.messages).toHaveLength(2)
    expect(session!.messages[1]!.role).toBe('assistant')
  })

  it('preserves first user message as preview', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'first message')
    await saveMessage(id, 'user', 'second message')
    const session = await loadSession(id)
    expect(session!.meta.preview).toBe('first message')
  })

  it('throws for nonexistent session', async () => {
    await expect(saveMessage('no-such-id', 'user', 'hi')).rejects.toThrow()
  })
})

describe('listSessions', () => {
  it('returns empty array when no sessions exist', async () => {
    const list = await listSessions()
    expect(list).toEqual([])
  })

  it('returns session metas sorted by updatedAt desc', async () => {
    const id1 = await createSession('model-a', '/tmp')
    const id2 = await createSession('model-b', '/tmp')
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10))
    // Update id1 so it's more recent
    await saveMessage(id1, 'user', 'updated')

    const list = await listSessions()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(id1)  // id1 updated more recently
    expect(list[1]!.id).toBe(id2)
  })

  it('respects limit parameter', async () => {
    await createSession('m1', '/tmp')
    await createSession('m2', '/tmp')
    await createSession('m3', '/tmp')

    const list = await listSessions(2)
    expect(list).toHaveLength(2)
  })
})

describe('deleteSession', () => {
  it('deletes an existing session', async () => {
    const id = await createSession('test-model', '/tmp')
    const deleted = await deleteSession(id)
    expect(deleted).toBe(true)
    const session = await loadSession(id)
    expect(session).toBeNull()
  })

  it('returns false for nonexistent session', async () => {
    const deleted = await deleteSession('no-such-id')
    expect(deleted).toBe(false)
  })
})

describe('updateSessionModel', () => {
  it('updates the model on an existing session', async () => {
    const id = await createSession('model-a', '/tmp')
    await updateSessionModel(id, 'model-b')
    const session = await loadSession(id)
    expect(session!.meta.model).toBe('model-b')
  })

  it('updates updatedAt timestamp', async () => {
    const id = await createSession('model-a', '/tmp')
    const before = (await loadSession(id))!.meta.updatedAt
    await new Promise(r => setTimeout(r, 10))
    await updateSessionModel(id, 'model-b')
    const after = (await loadSession(id))!.meta.updatedAt
    expect(after > before).toBe(true)
  })

  it('is a no-op for nonexistent session', async () => {
    // Should not throw
    await updateSessionModel('no-such-id', 'model-x')
  })

  it('session resume after model switch restores switched model', async () => {
    // Simulate: create session with model-a, switch to model-b, resume
    const id = await createSession('model-a', '/tmp')
    await saveMessage(id, 'user', 'hello')
    await updateSessionModel(id, 'model-b')
    const resumed = await loadSession(id)
    expect(resumed!.meta.model).toBe('model-b')
    expect(resumed!.messages).toHaveLength(1)
  })
})
