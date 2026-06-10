/**
 * Tests for daemon pid self-registration (P2-b / W4a).
 *
 * launchd execs `owlcoda server` directly — there is no spawnDaemon parent to
 * write the pid-file / runtime-meta, so without self-registration the
 * launchd-managed daemon is invisible to clients. The plist sets OWLCODA_LAUNCHD=1
 * AND a stable OWLCODA_RUNTIME_TOKEN; the daemon serves that env token via
 * /healthz (server.ts), so the self-registered runtime-meta MUST carry the same
 * token or healthzMatchesRuntimeMeta rejects it and clients would restart it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldSelfRegisterDaemon, selfRegisterDaemon } from '../src/daemon.js'

const cfg = {
  host: '127.0.0.1',
  port: 8019,
  routerUrl: 'http://127.0.0.1:11434',
  models: [],
} as unknown as import('../src/config.js').OwlCodaConfig

describe('shouldSelfRegisterDaemon', () => {
  it('is true only when launched by launchd (OWLCODA_LAUNCHD=1)', () => {
    expect(shouldSelfRegisterDaemon({ OWLCODA_LAUNCHD: '1' })).toBe(true)
    expect(shouldSelfRegisterDaemon({})).toBe(false)
    // spawnDaemon child carries a runtime token but no launchd marker → parent owns registration
    expect(shouldSelfRegisterDaemon({ OWLCODA_RUNTIME_TOKEN: 'abc' })).toBe(false)
    expect(shouldSelfRegisterDaemon({ OWLCODA_LAUNCHD: '0' })).toBe(false)
  })
})

describe('selfRegisterDaemon', () => {
  let tmp: string
  const prevHome = process.env['OWLCODA_HOME']
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owlcoda-selfreg-'))
    process.env['OWLCODA_HOME'] = tmp
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = prevHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes pid + runtime-meta carrying the env token when launchd-launched', () => {
    const ok = selfRegisterDaemon(cfg, 4242, { OWLCODA_LAUNCHD: '1', OWLCODA_RUNTIME_TOKEN: 'tok-123' })
    expect(ok).toBe(true)
    expect(readFileSync(join(tmp, 'owlcoda.pid'), 'utf-8').trim()).toBe('4242')
    const meta = JSON.parse(readFileSync(join(tmp, 'runtime.json'), 'utf-8'))
    expect(meta.pid).toBe(4242)
    expect(meta.runtimeToken).toBe('tok-123') // must equal what /healthz serves from env
    expect(meta.port).toBe(8019)
    expect(meta.routerUrl).toBe('http://127.0.0.1:11434')
  })

  it('does nothing for a spawnDaemon child (no launchd marker)', () => {
    const ok = selfRegisterDaemon(cfg, 4242, { OWLCODA_RUNTIME_TOKEN: 'child-tok' })
    expect(ok).toBe(false)
    expect(existsSync(join(tmp, 'owlcoda.pid'))).toBe(false)
    expect(existsSync(join(tmp, 'runtime.json'))).toBe(false)
  })

  it('skips (writes no mismatched meta) when launchd but the token is missing', () => {
    const ok = selfRegisterDaemon(cfg, 4242, { OWLCODA_LAUNCHD: '1' })
    expect(ok).toBe(false)
    expect(existsSync(join(tmp, 'runtime.json'))).toBe(false)
  })
})
