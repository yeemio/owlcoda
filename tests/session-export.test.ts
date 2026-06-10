import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('session export', () => {
  const testHome = '/tmp/owlcoda-test-export'

  afterEach(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true })
    }
    vi.unstubAllEnvs()
  })

  it('exports session as JSON', async () => {
    vi.stubEnv('OWLCODA_HOME', testHome)
    const { exportSession } = await import('../src/session-export.js')

    const filePath = await exportSession('test-session-001', 'test-model', 5, 'json')
    expect(filePath).toContain('.json')
    expect(existsSync(filePath)).toBe(true)

    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(content.sessionId).toBe('test-session-001')
    expect(content.model).toBe('test-model')
    expect(content.messageCount).toBe(5)
    expect(content.tokenUsage).toHaveProperty('inputTokens')
    expect(content.tokenUsage).toHaveProperty('outputTokens')
    expect(content.tokenUsage).toHaveProperty('totalTokens')
    expect(content.exportedAt).toBeTruthy()
  })

  it('exports session as markdown', async () => {
    vi.stubEnv('OWLCODA_HOME', testHome)
    const { exportSession } = await import('../src/session-export.js')

    const filePath = await exportSession('test-session-002', 'test-model', 3, 'markdown')
    expect(filePath).toContain('.md')
    expect(existsSync(filePath)).toBe(true)

    const content = readFileSync(filePath, 'utf8')
    expect(content).toContain('# OwlCoda Session Export')
    expect(content).toContain('test-session-002')
    expect(content).toContain('test-model')
  })

  it('creates export directory if missing', async () => {
    vi.stubEnv('OWLCODA_HOME', testHome)
    const exportDir = path.join(testHome, 'exports')
    expect(existsSync(exportDir)).toBe(false)

    const { exportSession } = await import('../src/session-export.js')
    await exportSession('test-session-003', 'test-model', 1, 'json')

    expect(existsSync(exportDir)).toBe(true)
  })
})
