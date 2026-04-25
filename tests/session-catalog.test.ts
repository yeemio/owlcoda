import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('session catalog index', () => {
  const testHome = '/tmp/owlcoda-test-session-catalog'
  const sessionsDir = path.join(testHome, 'sessions')

  function writeSession(id: string, model: string, preview: string, tags?: string[]) {
    const session = {
      meta: {
        id,
        model,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        preview,
        cwd: '/tmp',
        tags,
      },
      messages: [{ role: 'user', content: preview, timestamp: new Date().toISOString() }],
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

  it('buildIndex creates index from session files', async () => {
    writeSession('idx-1', 'model-a', 'First session')
    writeSession('idx-2', 'model-b', 'Second session')
    const { buildIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    const index = await buildIndex()
    expect(Object.keys(index.entries).length).toBe(2)
    expect(index.entries['idx-1']?.model).toBe('model-a')
  })

  it('buildIndex persists index file to disk', async () => {
    writeSession('idx-3', 'model-a', 'Persist test')
    const { buildIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    await buildIndex()
    const indexPath = path.join(sessionsDir, '.index.json')
    expect(existsSync(indexPath)).toBe(true)
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
    expect(data.version).toBe(1)
  })

  it('searchIndex finds by preview text', async () => {
    writeSession('idx-4', 'model-a', 'React hooks tutorial')
    writeSession('idx-5', 'model-b', 'Python data analysis')
    const { buildIndex, searchIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    await buildIndex()
    const results = await searchIndex('react')
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('idx-4')
  })

  it('searchIndex finds by tag', async () => {
    writeSession('idx-6', 'model-a', 'Session A', ['debug', 'important'])
    writeSession('idx-7', 'model-b', 'Session B', ['production'])
    const { buildIndex, searchIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    await buildIndex()
    const results = await searchIndex('important')
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('idx-6')
  })

  it('updateIndexEntry adds new entry', async () => {
    writeSession('idx-8', 'model-a', 'Initial')
    const { buildIndex, updateIndexEntry, searchIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    await buildIndex()
    await updateIndexEntry('idx-9', {
      id: 'idx-9', model: 'model-c', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), messageCount: 5, preview: 'Added later', cwd: '/tmp',
    })
    const results = await searchIndex('idx-9')
    expect(results.length).toBe(1)
  })

  it('removeIndexEntry removes from index', async () => {
    writeSession('idx-10', 'model-a', 'To remove')
    const { buildIndex, removeIndexEntry, getIndexStats, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    await buildIndex()
    await removeIndexEntry('idx-10')
    const stats = await getIndexStats()
    expect(stats.count).toBe(0)
  })

  it('handles empty sessions directory', async () => {
    const { buildIndex, clearIndexCache } = await import('../src/history/catalog.js')
    clearIndexCache()
    const index = await buildIndex()
    expect(Object.keys(index.entries).length).toBe(0)
  })
})
