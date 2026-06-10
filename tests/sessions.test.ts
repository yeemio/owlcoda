import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect sessions dir to temp
let tempDir: string

vi.mock('../src/paths.js', () => ({
  getOwlcodaDir: () => tempDir,
}))

// Dynamic import after mock
const {
  createSession,
  saveMessage,
  loadSession,
  getLastSessionId,
  listSessions,
  updateSessionModel,
  deleteSession,
  addSessionTag,
  removeSessionTag,
  findSessionsByTag,
  searchSessions,
  branchSession,
  listBranches,
} = await import('../src/history/sessions.js')

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-sess-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('session persistence', () => {
  describe('createSession', () => {
    it('creates a session and returns an ID', async () => {
      const id = await createSession('test-model', '/tmp')
      expect(id).toMatch(/^\d{8}-[a-f0-9]{6}$/)
    })

    it('writes a valid JSON file', async () => {
      const id = await createSession('test-model', '/home/user')
      const raw = await readFile(join(tempDir, 'sessions', `${id}.json`), 'utf-8')
      const session = JSON.parse(raw)
      expect(session.meta.id).toBe(id)
      expect(session.meta.model).toBe('test-model')
      expect(session.meta.cwd).toBe('/home/user')
      expect(session.meta.messageCount).toBe(0)
      expect(session.messages).toEqual([])
    })

    it('updates .last pointer', async () => {
      const id = await createSession('m', '/')
      const last = (await readFile(join(tempDir, 'sessions', '.last'), 'utf-8')).trim()
      expect(last).toBe(id)
    })

    it('creates sessions dir if missing', async () => {
      const id = await createSession('m', '/')
      const files = await readdir(join(tempDir, 'sessions'))
      expect(files).toContain(`${id}.json`)
    })
  })

  describe('saveMessage', () => {
    it('appends a user message', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'Hello world')
      const session = await loadSession(id)
      expect(session!.messages).toHaveLength(1)
      expect(session!.messages[0].role).toBe('user')
      expect(session!.messages[0].content).toBe('Hello world')
      expect(session!.meta.messageCount).toBe(1)
    })

    it('sets preview from first user message', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'Tell me about TypeScript')
      const session = await loadSession(id)
      expect(session!.meta.preview).toBe('Tell me about TypeScript')
    })

    it('truncates long preview to 80 chars', async () => {
      const id = await createSession('m', '/')
      const longMsg = 'A'.repeat(200)
      await saveMessage(id, 'user', longMsg)
      const session = await loadSession(id)
      expect(session!.meta.preview).toHaveLength(80)
    })

    it('does not overwrite preview on subsequent user messages', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'first message')
      await saveMessage(id, 'user', 'second message')
      const session = await loadSession(id)
      expect(session!.meta.preview).toBe('first message')
    })

    it('appends multiple messages in order', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'q1')
      await saveMessage(id, 'assistant', 'a1')
      await saveMessage(id, 'user', 'q2')
      const session = await loadSession(id)
      expect(session!.messages).toHaveLength(3)
      expect(session!.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
      expect(session!.meta.messageCount).toBe(3)
    })

    it('handles content blocks (non-string)', async () => {
      const id = await createSession('m', '/')
      const blocks = [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1' }]
      await saveMessage(id, 'assistant', blocks)
      const session = await loadSession(id)
      expect(session!.messages[0].content).toEqual(blocks)
    })

    it('throws for nonexistent session', async () => {
      await expect(saveMessage('nonexistent', 'user', 'hi')).rejects.toThrow('not found')
    })

    it('updates .last pointer on save', async () => {
      const id1 = await createSession('m', '/')
      const id2 = await createSession('m', '/')
      await saveMessage(id1, 'user', 'hello')
      const last = (await readFile(join(tempDir, 'sessions', '.last'), 'utf-8')).trim()
      expect(last).toBe(id1)
    })
  })

  describe('loadSession', () => {
    it('returns null for nonexistent session', async () => {
      const result = await loadSession('does-not-exist')
      expect(result).toBeNull()
    })

    it('returns null for corrupt JSON', async () => {
      const id = await createSession('m', '/')
      const path = join(tempDir, 'sessions', `${id}.json`)
      const { writeFile: wf } = await import('node:fs/promises')
      await wf(path, '{corrupt json!!!', 'utf-8')
      const result = await loadSession(id)
      expect(result).toBeNull()
    })

    it('round-trips session data', async () => {
      const id = await createSession('gpt-4', '/projects/app')
      await saveMessage(id, 'user', 'Write tests')
      await saveMessage(id, 'assistant', 'Here are the tests...')

      const session = await loadSession(id)
      expect(session).not.toBeNull()
      expect(session!.meta.model).toBe('gpt-4')
      expect(session!.meta.cwd).toBe('/projects/app')
      expect(session!.messages).toHaveLength(2)
    })
  })

  describe('getLastSessionId', () => {
    it('returns null when no sessions exist', async () => {
      const result = await getLastSessionId()
      expect(result).toBeNull()
    })

    it('returns the most recent session', async () => {
      await createSession('m', '/')
      const id2 = await createSession('m', '/')
      const last = await getLastSessionId()
      expect(last).toBe(id2)
    })

    it('returns null if .last points to deleted session', async () => {
      const id = await createSession('m', '/')
      await deleteSession(id)
      const last = await getLastSessionId()
      expect(last).toBeNull()
    })
  })

  describe('listSessions', () => {
    it('returns empty array when no sessions', async () => {
      const list = await listSessions()
      expect(list).toEqual([])
    })

    it('returns sessions sorted by updatedAt descending', async () => {
      const id1 = await createSession('m', '/')
      const id2 = await createSession('m', '/')
      // Force id2 to have a later updatedAt by saving a message
      await saveMessage(id2, 'user', 'newer')
      const list = await listSessions()
      expect(list[0].id).toBe(id2)
      expect(list[1].id).toBe(id1)
    })

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await createSession('m', '/')
      }
      const list = await listSessions(3)
      expect(list).toHaveLength(3)
    })

    it('skips corrupt files gracefully', async () => {
      const id = await createSession('m', '/')
      const { writeFile: wf } = await import('node:fs/promises')
      await wf(join(tempDir, 'sessions', 'corrupt.json'), 'not json', 'utf-8')
      const list = await listSessions()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(id)
    })
  })

  describe('updateSessionModel', () => {
    it('changes the model', async () => {
      const id = await createSession('old-model', '/')
      await updateSessionModel(id, 'new-model')
      const session = await loadSession(id)
      expect(session!.meta.model).toBe('new-model')
    })

    it('silently ignores nonexistent session', async () => {
      await expect(updateSessionModel('nope', 'model')).resolves.toBeUndefined()
    })
  })

  describe('deleteSession', () => {
    it('deletes existing session', async () => {
      const id = await createSession('m', '/')
      const result = await deleteSession(id)
      expect(result).toBe(true)
      expect(await loadSession(id)).toBeNull()
    })

    it('returns false for nonexistent session', async () => {
      const result = await deleteSession('nope')
      expect(result).toBe(false)
    })
  })

  describe('tags', () => {
    it('adds a tag', async () => {
      const id = await createSession('m', '/')
      const result = await addSessionTag(id, 'important')
      expect(result).toBe(true)
      const session = await loadSession(id)
      expect(session!.meta.tags).toContain('important')
    })

    it('prevents duplicate tags', async () => {
      const id = await createSession('m', '/')
      await addSessionTag(id, 'test')
      const result = await addSessionTag(id, 'test')
      expect(result).toBe(false)
      const session = await loadSession(id)
      expect(session!.meta.tags).toHaveLength(1)
    })

    it('removes a tag', async () => {
      const id = await createSession('m', '/')
      await addSessionTag(id, 'remove-me')
      const result = await removeSessionTag(id, 'remove-me')
      expect(result).toBe(true)
      const session = await loadSession(id)
      expect(session!.meta.tags).toEqual([])
    })

    it('returns false when removing nonexistent tag', async () => {
      const id = await createSession('m', '/')
      const result = await removeSessionTag(id, 'nope')
      expect(result).toBe(false)
    })

    it('returns false for nonexistent session (add)', async () => {
      const result = await addSessionTag('nope', 'tag')
      expect(result).toBe(false)
    })

    it('returns false for nonexistent session (remove)', async () => {
      const result = await removeSessionTag('nope', 'tag')
      expect(result).toBe(false)
    })
  })

  describe('findSessionsByTag', () => {
    it('finds sessions with a given tag', async () => {
      const id1 = await createSession('m', '/')
      const id2 = await createSession('m', '/')
      await createSession('m', '/') // no tag
      await addSessionTag(id1, 'prod')
      await addSessionTag(id2, 'prod')

      const found = await findSessionsByTag('prod')
      expect(found).toHaveLength(2)
      expect(found.map(m => m.id).sort()).toEqual([id1, id2].sort())
    })

    it('returns empty for no matches', async () => {
      await createSession('m', '/')
      const found = await findSessionsByTag('nonexistent')
      expect(found).toEqual([])
    })
  })

  describe('searchSessions', () => {
    it('finds session by preview match', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'TypeScript compiler options')
      const results = await searchSessions('typescript')
      expect(results).toHaveLength(1)
      expect(results[0].meta.id).toBe(id)
    })

    it('finds session by message content', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'hello')
      await saveMessage(id, 'assistant', 'The answer involves quantum mechanics')
      const results = await searchSessions('quantum')
      expect(results).toHaveLength(1)
      expect(results[0].matchedPreview).toContain('quantum')
    })

    it('returns empty for no matches', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'hello world')
      const results = await searchSessions('nonexistent-xyz-123')
      expect(results).toEqual([])
    })

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await createSession('m', '/')
        await saveMessage(id, 'user', `test query number ${i}`)
      }
      const results = await searchSessions('test query', 2)
      expect(results).toHaveLength(2)
    })

    it('search is case-insensitive', async () => {
      const id = await createSession('m', '/')
      await saveMessage(id, 'user', 'UPPERCASE CONTENT')
      const results = await searchSessions('uppercase')
      expect(results).toHaveLength(1)
    })
  })

  describe('branching', () => {
    it('creates a branch with parent reference', async () => {
      const srcId = await createSession('m', '/')
      await saveMessage(srcId, 'user', 'hello')
      await saveMessage(srcId, 'assistant', 'hi')

      const branchId = await branchSession(srcId, 'experiment-1')
      expect(branchId).not.toBe(srcId)

      const branch = await loadSession(branchId)
      expect(branch!.meta.parentId).toBe(srcId)
      expect(branch!.meta.branchName).toBe('experiment-1')
      expect(branch!.messages).toHaveLength(2)
    })

    it('deep-copies messages (mutations do not affect source)', async () => {
      const srcId = await createSession('m', '/')
      await saveMessage(srcId, 'user', 'original')

      const branchId = await branchSession(srcId)
      await saveMessage(branchId, 'user', 'branch-only')

      const source = await loadSession(srcId)
      expect(source!.messages).toHaveLength(1)
      const branch = await loadSession(branchId)
      expect(branch!.messages).toHaveLength(2)
    })

    it('throws for nonexistent source', async () => {
      await expect(branchSession('nope')).rejects.toThrow('not found')
    })
  })

  describe('listBranches', () => {
    it('lists branches of a session', async () => {
      const srcId = await createSession('m', '/')
      const b1 = await branchSession(srcId, 'b1')
      const b2 = await branchSession(srcId, 'b2')

      const branches = await listBranches(srcId)
      expect(branches).toHaveLength(2)
      expect(branches.map(b => b.id).sort()).toEqual([b1, b2].sort())
    })

    it('returns empty for session with no branches', async () => {
      const id = await createSession('m', '/')
      const branches = await listBranches(id)
      expect(branches).toEqual([])
    })
  })
})
