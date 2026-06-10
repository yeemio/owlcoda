import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initLogFile, writeLogLine, closeLogFile } from '../src/log-file.js'

describe('Log file output', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owlcoda-logtest-'))
    logPath = join(tmpDir, 'owlcoda.log')
  })

  afterEach(() => {
    closeLogFile()
    // Clean up
    for (const suffix of ['', '.1', '.2', '.3']) {
      try { unlinkSync(logPath + suffix) } catch { /* ignore */ }
    }
  })

  it('writes log lines to file', () => {
    initLogFile(logPath)
    writeLogLine('{"msg":"hello"}\n')
    closeLogFile()
    const content = readFileSync(logPath, 'utf-8')
    expect(content).toContain('hello')
  })

  it('appends to existing file', () => {
    writeFileSync(logPath, 'existing\n')
    initLogFile(logPath)
    writeLogLine('new line\n')
    closeLogFile()
    const content = readFileSync(logPath, 'utf-8')
    expect(content).toContain('existing')
    expect(content).toContain('new line')
  })

  it('rotates when exceeding maxBytes', () => {
    initLogFile(logPath, 100, 2) // 100 bytes max, keep 2
    // Write enough to trigger rotation
    for (let i = 0; i < 10; i++) {
      writeLogLine('a'.repeat(20) + '\n')
    }
    closeLogFile()
    expect(existsSync(logPath + '.1')).toBe(true)
  })

  it('respects keep limit', () => {
    initLogFile(logPath, 50, 1) // keep only 1 rotated file
    for (let i = 0; i < 20; i++) {
      writeLogLine('x'.repeat(30) + '\n')
    }
    closeLogFile()
    // .1 should exist, .2 should not (only keep 1)
    expect(existsSync(logPath + '.1')).toBe(true)
  })

  it('no-ops when not initialized', () => {
    closeLogFile() // ensure closed
    writeLogLine('should not crash') // should not throw
  })
})
