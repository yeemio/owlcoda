import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthzMatchesRuntimeMeta, waitForHealthzGone } from '../src/healthz-client.js'

const { waitForPortChecks } = vi.hoisted(() => {
  let calls = 0
  return {
    waitForPortChecks: vi.fn(async () => {
      calls += 1
      if (calls === 1) await new Promise(resolve => setTimeout(resolve, 100))
      return true
    }),
  }
})

vi.mock('../src/port-utils.js', () => ({
  isPortAvailable: waitForPortChecks,
}))

vi.mock('../src/service-launchd.js', () => ({
  isLaunchdServiceInstalled: () => false,
  kickstartLaunchdService: vi.fn(),
}))

const { ensureProxyRunning } = await import('../src/daemon.js')

const CLI_ENTRY = join(process.cwd(), 'src', 'cli.ts')

function readMatchingDaemonPids(configPath: string): number[] {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  const marker = `${CLI_ENTRY} server --config ${configPath}`
  return lines
    .filter(line => line.includes(marker))
    .map(line => Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}

async function stopMatchingDaemons(configPath: string, baseUrl: string): Promise<void> {
  const pids = readMatchingDaemonPids(configPath)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
  await waitForHealthzGone(baseUrl, 2000)
  await new Promise(resolve => setTimeout(resolve, 250))
  for (const pid of readMatchingDaemonPids(configPath)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

describe('ensureProxyRunning concurrent cold start', () => {
  it('starts one daemon and both callers receive the same verified identity', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'owlcoda-concurrent-start-'))
    const stateRoot = join(fixtureRoot, 'state')
    const configPath = join(fixtureRoot, 'config.json')
    const port = 32000 + Math.floor(Math.random() * 20000)
    const baseUrl = `http://127.0.0.1:${port}`
    const previousHome = process.env.HOME
    const previousOwlcodaHome = process.env.OWLCODA_HOME
    const previousArgv1 = process.argv[1]
    const previousExecArgv = [...process.execArgv]
    const config = {
      host: '127.0.0.1',
      port,
      routerUrl: 'http://127.0.0.1:9',
      models: [{ id: 'fixture', label: 'Fixture', backendModel: 'fixture', aliases: ['default'], tier: 'production', default: true }],
    } as unknown as import('../src/config.js').OwlCodaConfig

    writeFileSync(configPath, JSON.stringify(config, null, 2))
    process.env.HOME = fixtureRoot
    process.env.OWLCODA_HOME = stateRoot
    process.argv[1] = CLI_ENTRY
    process.execArgv = ['--import', 'tsx']
    try {
      const results = await Promise.allSettled([
        ensureProxyRunning(config, configPath, port, config.routerUrl),
        ensureProxyRunning(config, configPath, port, config.routerUrl),
      ])
      const safeResults = results.map(result => result.status === 'fulfilled'
        ? { status: result.status, value: result.value }
        : { status: result.status, reason: String(result.reason?.message ?? result.reason) })

      expect(safeResults, JSON.stringify(safeResults, null, 2)).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'fulfilled' }),
      ])
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ pid: number; reused: boolean }> => result.status === 'fulfilled')
      expect(new Set(fulfilled.map(result => result.value.pid))).toEqual(new Set([fulfilled[0]?.value.pid]))
      expect(fulfilled.map(result => result.value.reused).sort()).toEqual([false, true])

      const runtimePath = join(stateRoot, 'runtime.json')
      expect(existsSync(runtimePath)).toBe(true)
      const meta = JSON.parse(readFileSync(runtimePath, 'utf8'))
      expect(healthzMatchesRuntimeMeta(await (await import('../src/healthz-client.js')).fetchHealthz(baseUrl, 1000, meta.runtimeToken) as any, meta)).toBe(true)
    } finally {
      await stopMatchingDaemons(configPath, baseUrl)
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousOwlcodaHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = previousOwlcodaHome
      if (previousArgv1 === undefined) delete process.argv[1]
      else process.argv[1] = previousArgv1
      process.execArgv = previousExecArgv
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
