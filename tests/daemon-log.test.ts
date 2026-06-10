/**
 * Tests for daemon stdio capture (P0 — daemon forensics).
 *
 * Today spawnDaemon uses stdio:'ignore', so the daemon's console.error
 * (uncaughtException, [shutdown] …) goes to /dev/null and a crash leaves
 * no trail. These cover the pure pieces that route daemon stdout/stderr
 * to ~/.owlcoda/daemon.log, with bounded growth and safe degradation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOwlcodaDaemonLogPath } from '../src/paths.js'
import { rotateDaemonLogIfOversized, openDaemonLogStdio } from '../src/daemon.js'

const prevHome = process.env['OWLCODA_HOME']
function restoreHome(): void {
  if (prevHome === undefined) delete process.env['OWLCODA_HOME']
  else process.env['OWLCODA_HOME'] = prevHome
}

describe('getOwlcodaDaemonLogPath', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owlcoda-log-'))
    process.env['OWLCODA_HOME'] = tmp
  })
  afterEach(() => {
    restoreHome()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('resolves to <OWLCODA_HOME>/daemon.log', () => {
    expect(getOwlcodaDaemonLogPath()).toBe(join(tmp, 'daemon.log'))
  })
})

describe('rotateDaemonLogIfOversized', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'owlcoda-rot-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('rotates an oversized log to .1 and clears the live path for a fresh start', () => {
    const logPath = join(tmp, 'daemon.log')
    writeFileSync(logPath, 'x'.repeat(2048))
    rotateDaemonLogIfOversized(logPath, 1024)
    expect(existsSync(logPath + '.1')).toBe(true)
    expect(statSync(logPath + '.1').size).toBe(2048)
    expect(existsSync(logPath)).toBe(false) // moved aside; next open('a') recreates it
  })

  it('leaves a log under the cap untouched', () => {
    const logPath = join(tmp, 'daemon.log')
    writeFileSync(logPath, 'small')
    rotateDaemonLogIfOversized(logPath, 1024)
    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(logPath + '.1')).toBe(false)
  })

  it('overwrites a prior .1 (single-generation rotation)', () => {
    const logPath = join(tmp, 'daemon.log')
    writeFileSync(logPath + '.1', 'old-backup')
    writeFileSync(logPath, 'y'.repeat(2048))
    rotateDaemonLogIfOversized(logPath, 1024)
    expect(statSync(logPath + '.1').size).toBe(2048) // replaced, not appended
  })

  it('no-ops (no throw) when the log does not exist', () => {
    const logPath = join(tmp, 'daemon.log')
    expect(() => rotateDaemonLogIfOversized(logPath, 1024)).not.toThrow()
    expect(existsSync(logPath)).toBe(false)
  })
})

describe('openDaemonLogStdio', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owlcoda-stdio-'))
    process.env['OWLCODA_HOME'] = tmp
  })
  afterEach(() => {
    restoreHome()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns an inherit-to-fd stdio triple and creates daemon.log', () => {
    const { stdio, logFd } = openDaemonLogStdio()
    try {
      expect(typeof logFd).toBe('number')
      expect(stdio).toEqual(['ignore', logFd, logFd])
      expect(existsSync(join(tmp, 'daemon.log'))).toBe(true)
    } finally {
      if (typeof logFd === 'number') closeSync(logFd)
    }
  })

  it('degrades to stdio:ignore when the log path cannot be opened', () => {
    // Point OWLCODA_HOME at a regular file so join(home, 'daemon.log')
    // has a non-directory parent → openSync throws ENOTDIR → degrade.
    const asFile = join(tmp, 'home-as-file')
    writeFileSync(asFile, 'not a dir')
    process.env['OWLCODA_HOME'] = asFile
    const { stdio, logFd } = openDaemonLogStdio()
    expect(stdio).toBe('ignore')
    expect(logFd).toBeUndefined()
  })
})
