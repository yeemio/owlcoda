import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

describe('trace module', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'owlcoda-trace-test-'))
    process.env.OWLCODA_HOME = tmpDir
  })

  afterEach(() => {
    delete process.env.OWLCODA_TRACE
    delete process.env.OWLCODA_HOME
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('traceRequest writes JSON file when enabled', async () => {
    // Dynamic import to get fresh module state
    const { traceRequest, setTraceEnabled } = await import('../src/trace.js')
    setTraceEnabled(true)

    const id = await traceRequest('POST', '/v1/messages', { 'content-type': 'application/json', 'authorization': 'Bearer secret' }, { test: true })
    expect(id).toBeTruthy()

    const traceDir = path.join(tmpDir, 'trace')
    expect(existsSync(traceDir)).toBe(true)

    const files = require('fs').readdirSync(traceDir)
    expect(files.length).toBe(1)
    expect(files[0]).toContain('-req.json')

    const entry = JSON.parse(readFileSync(path.join(traceDir, files[0]), 'utf8'))
    expect(entry.direction).toBe('request')
    expect(entry.method).toBe('POST')
    expect(entry.endpoint).toBe('/v1/messages')
    expect(entry.headers.authorization).toBe('[REDACTED]')
    expect(entry.headers['content-type']).toBe('application/json')
  })

  it('traceRequest returns null when disabled', async () => {
    const { traceRequest, setTraceEnabled } = await import('../src/trace.js')
    setTraceEnabled(false)

    const id = await traceRequest('GET', '/healthz', {}, null)
    expect(id).toBeNull()
  })

  it('token usage accumulates correctly', async () => {
    const { addTokenUsage, getTokenUsage, resetTokenUsage } = await import('../src/trace.js')
    resetTokenUsage()

    addTokenUsage(100, 50, 10, 5)
    addTokenUsage(200, 100, 20, 10)

    const usage = getTokenUsage()
    expect(usage.inputTokens).toBe(300)
    expect(usage.outputTokens).toBe(150)
    expect(usage.cacheReadTokens).toBe(30)
    expect(usage.cacheWriteTokens).toBe(15)
    expect(usage.requestCount).toBe(2)
  })

  it('resetTokenUsage clears all counters', async () => {
    const { addTokenUsage, getTokenUsage, resetTokenUsage } = await import('../src/trace.js')
    addTokenUsage(500, 250)
    resetTokenUsage()

    const usage = getTokenUsage()
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.requestCount).toBe(0)
  })
})
