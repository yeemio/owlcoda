import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('session branching', () => {
  const testHome = '/tmp/owlcoda-test-branch'
  const sessionsDir = path.join(testHome, 'sessions')

  function writeSession(id: string, messages: Array<{ role: string; content: string }>, extra: Record<string, unknown> = {}) {
    const session = {
      meta: {
        id,
        model: 'test-model',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        preview: messages[0]?.content?.slice(0, 80) ?? '',
        cwd: '/tmp',
        ...extra,
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

  it('branchSession creates a deep copy with new ID', async () => {
    writeSession('source-1', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ])
    const { branchSession, loadSession } = await import('../src/history/sessions.js')
    const newId = await branchSession('source-1')
    expect(newId).not.toBe('source-1')

    const branch = await loadSession(newId)
    expect(branch).not.toBeNull()
    expect(branch!.messages.length).toBe(2)
    expect(branch!.meta.parentId).toBe('source-1')
  })

  it('branchSession preserves branch name', async () => {
    writeSession('source-2', [{ role: 'user', content: 'Test' }])
    const { branchSession, loadSession } = await import('../src/history/sessions.js')
    const newId = await branchSession('source-2', 'experiment-a')

    const branch = await loadSession(newId)
    expect(branch!.meta.branchName).toBe('experiment-a')
  })

  it('branchSession does not modify original', async () => {
    writeSession('source-3', [
      { role: 'user', content: 'Original message' },
    ])
    const { branchSession, loadSession } = await import('../src/history/sessions.js')
    const newId = await branchSession('source-3')

    const original = await loadSession('source-3')
    expect(original!.messages.length).toBe(1)
    expect(original!.meta.parentId).toBeUndefined()
  })

  it('listBranches finds children of a session', async () => {
    writeSession('parent-1', [{ role: 'user', content: 'Root' }])
    writeSession('child-1', [{ role: 'user', content: 'Branch 1' }], { parentId: 'parent-1', branchName: 'branch-a' })
    writeSession('child-2', [{ role: 'user', content: 'Branch 2' }], { parentId: 'parent-1', branchName: 'branch-b' })
    writeSession('unrelated', [{ role: 'user', content: 'Other' }])

    const { listBranches } = await import('../src/history/sessions.js')
    const branches = await listBranches('parent-1')
    expect(branches.length).toBe(2)
    expect(branches.map(b => b.branchName).sort()).toEqual(['branch-a', 'branch-b'])
  })

  it('branchSession throws for non-existent source', async () => {
    const { branchSession } = await import('../src/history/sessions.js')
    await expect(branchSession('nonexistent')).rejects.toThrow('not found')
  })
})
