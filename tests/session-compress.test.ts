import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('session compress', () => {
  const testHome = '/tmp/owlcoda-test-compress'
  const sessionsDir = path.join(testHome, 'sessions')

  function writeSession(id: string, messageCount: number) {
    const messages = Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1} content about topic ${i}`,
      timestamp: new Date().toISOString(),
    }))
    const session = {
      meta: {
        id,
        model: 'test-model',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount,
        preview: 'test preview',
        cwd: '/tmp',
      },
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

  it('trimSession keeps last N messages', async () => {
    writeSession('trim-test-1', 20)
    const { trimSession } = await import('../src/session-compress.js')
    const result = await trimSession('trim-test-1', 5)
    expect(result.originalMessages).toBe(20)
    expect(result.compressedMessages).toBe(5)
    expect(result.method).toBe('trim')

    const raw = JSON.parse(readFileSync(path.join(sessionsDir, 'trim-test-1.json'), 'utf-8'))
    expect(raw.messages.length).toBe(5)
  })

  it('trimSession creates backup', async () => {
    writeSession('trim-test-2', 15)
    const { trimSession } = await import('../src/session-compress.js')
    const result = await trimSession('trim-test-2', 5)

    expect(existsSync(result.backupPath)).toBe(true)
    const backup = JSON.parse(readFileSync(result.backupPath, 'utf-8'))
    expect(backup.messages.length).toBe(15)
  })

  it('trimSession is no-op when messages <= keepLast', async () => {
    writeSession('trim-test-3', 3)
    const { trimSession } = await import('../src/session-compress.js')
    const result = await trimSession('trim-test-3', 10)
    expect(result.originalMessages).toBe(3)
    expect(result.compressedMessages).toBe(3)
  })

  it('trimSession throws for non-existent session', async () => {
    const { trimSession } = await import('../src/session-compress.js')
    await expect(trimSession('nonexistent', 5)).rejects.toThrow('not found')
  })
})
