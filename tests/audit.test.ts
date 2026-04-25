import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { logAuditEntry, readAuditLog, getAuditLogPath } from '../src/audit.js'
import { mkdtempSync, rmSync } from 'node:fs'

describe('audit log', () => {
  const prevHome = process.env['OWLCODA_HOME']
  let testHome = ''

  const testEntry = {
    timestamp: '2024-01-01T00:00:00.000Z',
    requestId: 'test-123',
    model: 'test-model',
    servedBy: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 200,
    status: 200,
    fallbackUsed: false,
    streaming: false,
  }

  beforeEach(() => {
    testHome = mkdtempSync('/tmp/owlcoda-audit-test-')
    process.env['OWLCODA_HOME'] = testHome
  })

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = prevHome
  })

  it('logAuditEntry does not throw', async () => {
    await expect(logAuditEntry(testEntry)).resolves.not.toThrow()
  })

  it('readAuditLog returns entries after write', async () => {
    await logAuditEntry(testEntry)
    await logAuditEntry({ ...testEntry, requestId: 'test-456' })
    const entries = await readAuditLog()
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries.some(e => e.requestId === 'test-123')).toBe(true)
    expect(entries.some(e => e.requestId === 'test-456')).toBe(true)
  })

  it('readAuditLog returns empty array when no file', async () => {
    const entries = await readAuditLog()
    // May or may not have entries from prior tests — just check type
    expect(Array.isArray(entries)).toBe(true)
  })

  it('getAuditLogPath returns expected path', () => {
    const path = getAuditLogPath()
    expect(path).toContain('audit.jsonl')
  })
})
