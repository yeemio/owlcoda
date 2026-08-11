import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProxyRunning } from '../src/daemon.js'

describe('daemon cold-start failure cleanup', () => {
  it('clears pid/meta/start-lock when the child exits before readiness', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'owlcoda-start-failure-'))
    const stateRoot = join(fixtureRoot, 'state')
    const configPath = join(fixtureRoot, 'invalid-config.json')
    const port = 32000 + Math.floor(Math.random() * 20000)
    const previousHome = process.env.HOME
    const previousOwlcodaHome = process.env.OWLCODA_HOME
    const previousArgv1 = process.argv[1]
    const previousExecArgv = [...process.execArgv]
    writeFileSync(configPath, '{ invalid json')
    const config = {
      host: '127.0.0.1',
      port,
      routerUrl: 'http://127.0.0.1:9',
      models: [{ id: 'fixture', label: 'Fixture', backendModel: 'fixture', aliases: ['default'], tier: 'production', default: true }],
    } as unknown as import('../src/config.js').OwlCodaConfig
    process.env.HOME = fixtureRoot
    process.env.OWLCODA_HOME = stateRoot
    process.argv[1] = join(process.cwd(), 'src', 'cli.ts')
    process.execArgv = ['--import', 'tsx']
    try {
      const staleLockPath = join(stateRoot, 'daemon-start.lock')
      mkdirSync(staleLockPath, { recursive: true })
      writeFileSync(join(staleLockPath, 'owner.json'), JSON.stringify({
        pid: 2_147_483_647,
        token: 'dead-owner',
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }))
      const staleAt = new Date(Date.now() - 60_000)
      utimesSync(staleLockPath, staleAt, staleAt)
      await expect(ensureProxyRunning(config, configPath, port, config.routerUrl)).rejects.toThrow(/exited before becoming ready/)
      expect(existsSync(join(stateRoot, 'owlcoda.pid'))).toBe(false)
      expect(existsSync(join(stateRoot, 'runtime.json'))).toBe(false)
      expect(existsSync(join(stateRoot, 'daemon-start.lock'))).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousOwlcodaHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = previousOwlcodaHome
      if (previousArgv1 === undefined) delete process.argv[1]
      else process.argv[1] = previousArgv1
      process.execArgv = previousExecArgv
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }, 15000)
})
