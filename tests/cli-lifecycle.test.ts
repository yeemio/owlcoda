import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { getOwlcodaLiveReplLeasePath, getOwlcodaPidPath, getOwlcodaRuntimeMetaPath } from '../src/paths.js'

const REPO_ROOT = join(import.meta.dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')
const CLI_SUBPROCESS_TEST_TIMEOUT_MS = 15000

const runtimeDirs = new Set<string>()
const heldServers = new Set<Server>()
const sleeperPids = new Set<number>()

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-cli-'))
  runtimeDirs.add(dir)
  return dir
}

function makeConfig(runtimeDir: string, port: number, routerUrl: string): string {
  mkdirSync(runtimeDir, { recursive: true })
  const configPath = join(runtimeDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    routerUrl,
    models: [
      {
        id: 'test-backend',
        label: 'Test Backend',
        backendModel: 'test-backend',
        aliases: ['default'],
        tier: 'production',
        default: true,
      },
    ],
  }, null, 2))
  return configPath
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to allocate ephemeral port'))
        return
      }
      const { port } = addr
      server.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

async function runCli(
  args: string[],
  runtimeDir: string,
  envOverrides: Record<string, string> = {},
  timeoutMs: number = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OWLCODA_HOME: runtimeDir,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI command timed out: ${args.join(' ')}`))
    }, timeoutMs)

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function fetchHealthz(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/healthz`)
}

async function waitForHealthzGone(port: number, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start <= timeoutMs) {
    try {
      await fetchHealthz(port)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Healthz still responding on port ${port}`)
}

function runtimePaths(runtimeDir: string): { pidPath: string; metaPath: string; leasePath: string } {
  const previous = process.env['OWLCODA_HOME']
  process.env['OWLCODA_HOME'] = runtimeDir
  try {
    return {
      pidPath: getOwlcodaPidPath(),
      metaPath: getOwlcodaRuntimeMetaPath(),
      leasePath: getOwlcodaLiveReplLeasePath(),
    }
  } finally {
    if (previous === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = previous
  }
}

function writeLiveReplRegistry(
  leasePath: string,
  clients: Array<{
    clientId: string
    clientPid: number
    daemonPid: number
    runtimeToken: string
    host: string
    port: number
    routerUrl: string
    startedAt: string
    sessionId?: string
  }>,
): void {
  writeFileSync(leasePath, JSON.stringify({
    version: 2,
    clients,
  }, null, 2))
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const server of heldServers) {
    await new Promise(resolve => server.close(() => resolve(null)))
  }
  heldServers.clear()

  for (const pid of sleeperPids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  sleeperPids.clear()

  for (const runtimeDir of runtimeDirs) {
    const { pidPath } = runtimePaths(runtimeDir)
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf-8').trim())
      try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
    }
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  runtimeDirs.clear()

})

describe('CLI lifecycle integration', () => {
  it('start/status/stop works against an isolated OWLCODA_HOME', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65531')
    const { pidPath, metaPath } = runtimePaths(runtimeDir)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)
    expect(startResult.stderr).toContain('started in background')
    expect(existsSync(pidPath)).toBe(true)
    expect(existsSync(metaPath)).toBe(true)

    const healthz = await fetchHealthz(port).then(res => res.json())
    expect(['healthy', 'degraded', 'unhealthy']).toContain(healthz.status)

    const statusResult = await runCli(['status'], runtimeDir)
    expect(statusResult.code).toBe(0)
    expect(statusResult.stderr).toContain('owlcoda is running')
    expect(statusResult.stderr).toContain(`Listening: http://127.0.0.1:${port}`)

    const stopResult = await runCli(['stop'], runtimeDir)
    expect(stopResult.code).toBe(0)
    expect(stopResult.stderr).toContain('owlcoda stopped')
    await waitForHealthzGone(port)
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(metaPath)).toBe(false)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('reuses an existing matching daemon on repeated start', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65530')
    const { pidPath } = runtimePaths(runtimeDir)

    const first = await runCli(['start', '--config', configPath], runtimeDir)
    expect(first.code).toBe(0)
    const firstPid = Number(readFileSync(pidPath, 'utf-8').trim())

    const second = await runCli(['start', '--config', configPath], runtimeDir)
    expect(second.code).toBe(0)
    expect(second.stderr).toContain('already running with matching config')
    const secondPid = Number(readFileSync(pidPath, 'utf-8').trim())
    expect(secondPid).toBe(firstPid)

    await runCli(['stop'], runtimeDir)
  })

  it('--daemon-only ensures the daemon without opening the REPL', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65529')

    const result = await runCli(['--daemon-only', '--config', configPath], runtimeDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('started in background')

    const healthz = await fetchHealthz(port).then(res => res.json())
    expect(['healthy', 'degraded', 'unhealthy']).toContain(healthz.status)

    await runCli(['stop'], runtimeDir)
  })

  it('status shows active live client count and session details', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65528')
    const { leasePath, pidPath, metaPath } = runtimePaths(runtimeDir)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)

    const daemonPid = Number(readFileSync(pidPath, 'utf-8').trim())
    const runtimeMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { runtimeToken: string }
    writeLiveReplRegistry(leasePath, [
      {
        clientId: 'client-a',
        clientPid: process.pid,
        daemonPid,
        runtimeToken: runtimeMeta.runtimeToken,
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65528',
        startedAt: new Date().toISOString(),
        sessionId: 'session-a',
      },
      {
        clientId: 'client-b',
        clientPid: daemonPid,
        daemonPid,
        runtimeToken: runtimeMeta.runtimeToken,
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65528',
        startedAt: new Date(Date.now() + 1_000).toISOString(),
        sessionId: 'session-b',
      },
    ])

    const statusResult = await runCli(['status'], runtimeDir)
    expect(statusResult.code).toBe(0)
    expect(statusResult.stderr).toContain('Live REPL clients: 2 active')
    expect(statusResult.stderr).toContain('session-a')
    expect(statusResult.stderr).toContain('session-b')

    rmSync(leasePath, { force: true })
    await runCli(['stop'], runtimeDir)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('clients lists active live clients and requires force to detach a live one', async () => {
    const runtimeDir = makeRuntimeDir()
    const { leasePath } = runtimePaths(runtimeDir)

    writeLiveReplRegistry(leasePath, [
      {
        clientId: 'client-a',
        clientPid: process.pid,
        daemonPid: 101,
        runtimeToken: 'token-a',
        host: '127.0.0.1',
        port: 43123,
        routerUrl: 'http://127.0.0.1:65518',
        startedAt: new Date().toISOString(),
        sessionId: 'session-a',
      },
    ])

    const listResult = await runCli(['clients'], runtimeDir)
    expect(listResult.code).toBe(0)
    expect(listResult.stderr).toContain('Active live REPL clients: 1')
    expect(listResult.stderr).toContain('client-a')
    expect(listResult.stderr).toContain('session-a')

    const detachResult = await runCli(['clients', 'detach', 'client-a'], runtimeDir)
    expect(detachResult.code).toBe(1)
    // New productized output: surfaces actionable "detach --force" guidance plus kill hint
    expect(detachResult.stderr).toContain('detach requires --force')
    expect(detachResult.stderr).toContain('owlcoda clients detach client-a --force')
    expect(detachResult.stderr).toContain(`kill ${process.pid}`)

    const forceDetachResult = await runCli(['clients', 'detach', 'client-a', '--force'], runtimeDir)
    expect(forceDetachResult.code).toBe(0)
    expect(forceDetachResult.stderr).toContain('Force-detached client client-a')
    // Force path surfaces that the process may still be running — verifies the UX nudge
    expect(forceDetachResult.stderr).toContain('may still be running')
    expect(existsSync(leasePath)).toBe(false)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('does not kill an unrelated live process when PID state is stale', async () => {
    const runtimeDir = makeRuntimeDir()
    const { pidPath, metaPath } = runtimePaths(runtimeDir)

    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      detached: true,
    })
    if (sleeper.pid === undefined) throw new Error('Failed to spawn sleeper')
    sleeper.unref()
    sleeperPids.add(sleeper.pid)

    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(pidPath, `${sleeper.pid}\n`)
    writeFileSync(metaPath, JSON.stringify({
      pid: sleeper.pid,
      runtimeToken: 'fake-token',
      host: '127.0.0.1',
      port: await getFreePort(),
      routerUrl: 'http://127.0.0.1:65528',
      version: '0.3.3',
      startedAt: new Date().toISOString(),
    }, null, 2))

    const stopResult = await runCli(['stop'], runtimeDir)
    expect(stopResult.code).toBe(1)
    expect(stopResult.stderr).toContain('cannot verify')
    expect(isPidAlive(sleeper.pid)).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(metaPath)).toBe(false)
  })

  it('fails cleanly when the target port is occupied and leaves no OwlCoda state behind', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65527')
    const { pidPath, metaPath } = runtimePaths(runtimeDir)

    const blocker = createServer((_req, res) => {
      res.writeHead(404)
      res.end('blocked')
    })
    heldServers.add(blocker)
    await new Promise<void>((resolve, reject) => {
      blocker.listen(port, '127.0.0.1', err => {
        if (err) reject(err)
        else resolve()
      })
    })

    const result = await runCli(['start', '--config', configPath], runtimeDir, 20000)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('already in use by a non-OwlCoda process')
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(metaPath)).toBe(false)
  }, 15000)

  it('refuses to stop a daemon while a matching live REPL lease is active', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65526')
    const { leasePath, pidPath, metaPath } = runtimePaths(runtimeDir)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)
    const pid = Number(readFileSync(pidPath, 'utf-8').trim())
    const runtimeMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { runtimeToken: string }

    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      detached: true,
    })
    if (sleeper.pid === undefined) throw new Error('Failed to spawn live client stub')
    sleeper.unref()
    sleeperPids.add(sleeper.pid)

    writeLiveReplRegistry(leasePath, [
      {
        clientId: 'client-a',
        clientPid: process.pid,
        daemonPid: pid,
        runtimeToken: runtimeMeta.runtimeToken,
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65526',
        startedAt: new Date().toISOString(),
        sessionId: 'session-a',
      },
      {
        clientId: 'client-b',
        clientPid: sleeper.pid,
        daemonPid: pid,
        runtimeToken: runtimeMeta.runtimeToken,
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65526',
        startedAt: new Date(Date.now() + 1000).toISOString(),
        sessionId: 'session-b',
      },
    ])

    const stopResult = await runCli(['stop'], runtimeDir)
    expect(stopResult.code).toBe(1)
    expect(stopResult.stderr).toContain('2 active live REPL clients')
    expect(stopResult.stderr).toContain('session-a')
    expect(stopResult.stderr).toContain('session-b')
    expect(isPidAlive(pid)).toBe(true)

    rmSync(leasePath, { force: true })
    const finalStop = await runCli(['stop'], runtimeDir)
    expect(finalStop.code).toBe(0)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('stop --force detaches only clients for the managed runtime before shutdown', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65524')
    const { leasePath, pidPath, metaPath } = runtimePaths(runtimeDir)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)
    const daemonPid = Number(readFileSync(pidPath, 'utf-8').trim())
    const runtimeMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { runtimeToken: string }

    writeLiveReplRegistry(leasePath, [
      {
        clientId: 'matching-runtime',
        clientPid: process.pid,
        daemonPid,
        runtimeToken: runtimeMeta.runtimeToken,
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65524',
        startedAt: new Date().toISOString(),
        sessionId: 'session-a',
      },
      {
        clientId: 'other-runtime',
        clientPid: process.pid,
        daemonPid: daemonPid + 1,
        runtimeToken: 'other-runtime-token',
        host: '127.0.0.1',
        port: port + 1,
        routerUrl: 'http://127.0.0.1:65523',
        startedAt: new Date(Date.now() + 1_000).toISOString(),
        sessionId: 'session-b',
      },
    ])

    const stopResult = await runCli(['stop', '--force'], runtimeDir)
    expect(stopResult.code).toBe(0)
    expect(stopResult.stderr).toContain('Force-detached 1 live REPL client')
    await waitForHealthzGone(port)

    const persisted = JSON.parse(readFileSync(leasePath, 'utf-8')) as { clients: Array<{ clientId: string }> }
    expect(persisted.clients).toHaveLength(1)
    expect(persisted.clients[0]!.clientId).toBe('other-runtime')
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)

  it('clears a stale live REPL lease before stopping', async () => {
    const runtimeDir = makeRuntimeDir()
    const port = await getFreePort()
    const configPath = makeConfig(runtimeDir, port, 'http://127.0.0.1:65525')
    const { leasePath, pidPath } = runtimePaths(runtimeDir)

    const startResult = await runCli(['start', '--config', configPath], runtimeDir)
    expect(startResult.code).toBe(0)
    const pid = Number(readFileSync(pidPath, 'utf-8').trim())
    writeLiveReplRegistry(leasePath, [
      {
        clientId: 'stale-client',
        clientPid: 999999,
        daemonPid: pid,
        runtimeToken: 'stale-lease',
        host: '127.0.0.1',
        port,
        routerUrl: 'http://127.0.0.1:65525',
        startedAt: new Date().toISOString(),
        sessionId: 'stale-session',
      },
    ])

    const stopResult = await runCli(['stop'], runtimeDir)
    expect(stopResult.code).toBe(0)
    expect(existsSync(leasePath)).toBe(false)
  }, CLI_SUBPROCESS_TEST_TIMEOUT_MS)
})
