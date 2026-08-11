import { describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProxyRunning } from '../src/daemon.js'
import { fetchHealthz, healthzMatchesRuntimeMeta, waitForHealthzGone } from '../src/healthz-client.js'

const CLI_ENTRY = join(process.cwd(), 'src', 'cli.ts')

type Fixture = {
  root: string
  state: string
  configPath: string
  port: number
  baseUrl: string
  config: import('../src/config.js').OwlCodaConfig
}

async function getFreePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  if (!address || typeof address === 'string') {
    reservation.close()
    throw new Error('failed to allocate an ephemeral daemon fixture port')
  }
  await new Promise<void>((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve())
  })
  return address.port
}

async function fixture(routerUrl = 'http://127.0.0.1:9'): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-identity-boundary-'))
  const state = join(root, '.owlcoda')
  const configPath = join(root, 'config.json')
  const port = await getFreePort()
  const config = {
    host: '127.0.0.1',
    port,
    routerUrl,
    models: [{ id: 'fixture', label: 'Fixture', backendModel: 'fixture', aliases: ['default'], tier: 'production', default: true }],
  } as unknown as import('../src/config.js').OwlCodaConfig
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  return { root, state, configPath, port, baseUrl: `http://127.0.0.1:${port}`, config }
}

function installFixtureEnv(f: Fixture): () => void {
  const previousHome = process.env.HOME
  const previousOwlcodaHome = process.env.OWLCODA_HOME
  const previousArgv1 = process.argv[1]
  const previousExecArgv = [...process.execArgv]
  process.env.HOME = f.root
  process.env.OWLCODA_HOME = f.state
  process.argv[1] = CLI_ENTRY
  process.execArgv = ['--import', 'tsx']
  return () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousOwlcodaHome === undefined) delete process.env.OWLCODA_HOME
    else process.env.OWLCODA_HOME = previousOwlcodaHome
    if (previousArgv1 === undefined) delete process.argv[1]
    else process.argv[1] = previousArgv1
    process.execArgv = previousExecArgv
  }
}

function matchingDaemonPids(configPath: string): number[] {
  const marker = `${CLI_ENTRY} server --config ${configPath}`
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line: string) => line.includes(marker))
    .map((line: string) => Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10))
    .filter((pid: number) => Number.isInteger(pid) && pid > 0)
}

async function stopFixtureDaemons(f: Fixture): Promise<void> {
  for (const pid of matchingDaemonPids(f.configPath)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
  await waitForHealthzGone(f.baseUrl, 2000)
  for (const pid of matchingDaemonPids(f.configPath)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

async function waitForForeignServer(url: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      await response.arrayBuffer()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error(`foreign fixture did not listen at ${url}`)
}

describe('daemon cold-start identity boundaries', () => {
  it('clears a stale live PID without signaling that process, then starts one verified daemon', async () => {
    const f = await fixture()
    const restore = installFixtureEnv(f)
    try {
      mkdirSync(f.state, { recursive: true })
      writeFileSync(join(f.state, 'owlcoda.pid'), String(process.pid))
      const result = await ensureProxyRunning(f.config, f.configPath, f.port, f.config.routerUrl)
      expect(result.reused).toBe(false)
      expect(() => process.kill(process.pid, 0)).not.toThrow()
      const meta = JSON.parse(readFileSync(join(f.state, 'runtime.json'), 'utf8'))
      expect(healthzMatchesRuntimeMeta(await fetchHealthz(f.baseUrl, 1000, meta.runtimeToken) as any, meta)).toBe(true)
    } finally {
      await stopFixtureDaemons(f)
      restore()
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 15000)

  it('does not signal or claim a live daemon when runtime metadata has the wrong token', async () => {
    const f = await fixture()
    const restore = installFixtureEnv(f)
    try {
      await ensureProxyRunning(f.config, f.configPath, f.port, f.config.routerUrl)
      const metaPath = join(f.state, 'runtime.json')
      const original = JSON.parse(readFileSync(metaPath, 'utf8'))
      writeFileSync(metaPath, JSON.stringify({ ...original, runtimeToken: 'wrong-token' }))

      await expect(ensureProxyRunning(f.config, f.configPath, f.port, f.config.routerUrl)).rejects.toThrow(/already in use/)
      expect(() => process.kill(original.pid, 0)).not.toThrow()
      const healthz = await fetchHealthz(f.baseUrl, 1000, original.runtimeToken)
      expect(healthz && healthzMatchesRuntimeMeta(healthz, original)).toBe(true)
    } finally {
      await stopFixtureDaemons(f)
      restore()
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 15000)

  it('restarts a matching daemon after config identity drift and verifies the replacement', async () => {
    const f = await fixture()
    const restore = installFixtureEnv(f)
    try {
      await ensureProxyRunning(f.config, f.configPath, f.port, f.config.routerUrl)
      const first = JSON.parse(readFileSync(join(f.state, 'runtime.json'), 'utf8'))
      const next = { ...f.config, routerUrl: 'http://127.0.0.1:10' } as import('../src/config.js').OwlCodaConfig
      const result = await ensureProxyRunning(next, f.configPath, f.port, next.routerUrl)
      const second = JSON.parse(readFileSync(join(f.state, 'runtime.json'), 'utf8'))

      expect(result.reused).toBe(false)
      expect(second.pid).not.toBe(first.pid)
      expect(second.routerUrl).toBe(next.routerUrl)
      expect(healthzMatchesRuntimeMeta(await fetchHealthz(f.baseUrl, 1000, second.runtimeToken) as any, second)).toBe(true)
    } finally {
      await stopFixtureDaemons(f)
      restore()
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 20000)

  it('refuses a random port holder without signaling the foreign process', async () => {
    const f = await fixture()
    const restore = installFixtureEnv(f)
    let foreign: ChildProcess | undefined
    try {
      foreign = spawn(process.execPath, ['-e', `require('node:http').createServer((_req,res)=>res.end('foreign')).listen(${f.port}, '127.0.0.1')`], {
        stdio: 'ignore',
      })
      await waitForForeignServer(f.baseUrl)
      await expect(ensureProxyRunning(f.config, f.configPath, f.port, f.config.routerUrl)).rejects.toThrow(/non-OwlCoda process/)
      expect(foreign.exitCode).toBeNull()
      expect(existsSync(join(f.state, 'owlcoda.pid'))).toBe(false)
    } finally {
      if (foreign && foreign.exitCode === null) {
        foreign.kill('SIGTERM')
        await new Promise<void>(resolve => foreign?.once('close', () => resolve()))
      }
      restore()
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 10000)
})
