import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  enrichLiveReplClientForAdmin,
  formatLiveReplClientAge,
  formatLiveReplClientDetail,
  LIVE_REPL_CLIENT_ADMIN_SCHEMA_VERSION,
  listActiveLiveReplClients,
  readLiveReplRegistry,
  resolveLiveReplResumeTarget,
  writeLiveReplRegistry,
} from '../src/repl-lease.js'
import type { LiveReplClientLease } from '../src/repl-lease.js'

let testHome = ''
let previousHome: string | undefined
const REPO_ROOT = join(import.meta.dirname, '..')
const holderChildren = new Set<ChildProcess>()

function writeSession(
  runtimeDir: string,
  id: string,
  updatedAt: number,
): void {
  const sessionsDir = join(runtimeDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({
    version: 1,
    id,
    model: 'test-model',
    system: 'test-system',
    maxTokens: 4096,
    turns: [
      { role: 'user', content: [{ type: 'text', text: `prompt for ${id}` }], timestamp: updatedAt - 1 },
      { role: 'assistant', content: [{ type: 'text', text: `answer for ${id}` }], timestamp: updatedAt },
    ],
    createdAt: updatedAt - 10,
    updatedAt,
    title: id,
  }, null, 2))
}

beforeEach(() => {
  previousHome = process.env['OWLCODA_HOME']
  testHome = mkdtempSync(join(tmpdir(), 'owlcoda-repl-lease-'))
  process.env['OWLCODA_HOME'] = testHome
})

afterEach(() => {
  for (const child of holderChildren) {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  holderChildren.clear()
  if (previousHome === undefined) delete process.env['OWLCODA_HOME']
  else process.env['OWLCODA_HOME'] = previousHome
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true })
  }
})

async function spawnPidHolder(): Promise<ChildProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      holderChildren.add(child)
      resolve(child)
    })
  })
}

async function runLeaseWorker(env: Record<string, string>): Promise<void> {
  const script = `
    (async () => {
      const mod = await import('./src/repl-lease.ts')
      const delayMs = Number(process.env.TEST_DELAY_MS || '0')
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      if (process.env.TEST_OP === 'upsert') {
        mod.upsertLiveReplClient({
          clientId: String(process.env.TEST_CLIENT_ID),
          clientPid: Number(process.env.TEST_CLIENT_PID),
          daemonPid: Number(process.env.TEST_DAEMON_PID),
          runtimeToken: String(process.env.TEST_RUNTIME_TOKEN),
          host: '127.0.0.1',
          port: Number(process.env.TEST_PORT),
          routerUrl: String(process.env.TEST_ROUTER_URL),
          startedAt: String(process.env.TEST_STARTED_AT),
          sessionId: process.env.TEST_SESSION_ID || undefined,
        })
        return
      }
      if (process.env.TEST_OP === 'update-session') {
        mod.updateLiveReplClientSession(String(process.env.TEST_CLIENT_ID), process.env.TEST_SESSION_ID || undefined)
        return
      }
      throw new Error('Unknown TEST_OP')
    })().catch(err => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err))
      process.exit(1)
    })
  `
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OWLCODA_HOME: testHome,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr || `lease worker exited with code ${code}`))
    })
  })
}

describe('live REPL registry', () => {
  it('migrates a legacy single-client lease file into registry shape', () => {
    const leasePath = join(testHome, 'live-repl.json')
    writeFileSync(leasePath, JSON.stringify({
      clientPid: process.pid,
      daemonPid: 4321,
      runtimeToken: 'legacy-token',
      host: '127.0.0.1',
      port: 9999,
      routerUrl: 'http://127.0.0.1:8009',
      startedAt: '2026-04-18T00:00:00.000Z',
      sessionId: 'legacy-session',
    }, null, 2))

    const registry = readLiveReplRegistry()
    expect(registry).not.toBeNull()
    expect(registry!.version).toBe(2)
    expect(registry!.clients).toHaveLength(1)
    expect(registry!.clients[0]!.clientId).toMatch(/^legacy-/)
    expect(registry!.clients[0]!.sessionId).toBe('legacy-session')
  })

  it('prunes stale clients and keeps active clients in the registry file', () => {
    const leasePath = join(testHome, 'live-repl.json')
    writeFileSync(leasePath, JSON.stringify({
      version: 2,
      clients: [
        {
          clientId: 'active-client',
          clientPid: process.pid,
          daemonPid: 101,
          runtimeToken: 'token-a',
          host: '127.0.0.1',
          port: 9999,
          routerUrl: 'http://127.0.0.1:8009',
          startedAt: '2026-04-18T00:00:00.000Z',
          sessionId: 'active-session',
        },
        {
          clientId: 'stale-client',
          clientPid: 999999,
          daemonPid: 101,
          runtimeToken: 'token-a',
          host: '127.0.0.1',
          port: 9999,
          routerUrl: 'http://127.0.0.1:8009',
          startedAt: '2026-04-18T00:01:00.000Z',
          sessionId: 'stale-session',
        },
      ],
    }, null, 2))

    const clients = listActiveLiveReplClients()
    expect(clients).toHaveLength(1)
    expect(clients[0]!.clientId).toBe('active-client')

    const persisted = JSON.parse(readFileSync(leasePath, 'utf-8')) as { clients: Array<{ clientId: string }> }
    expect(persisted.clients).toHaveLength(1)
    expect(persisted.clients[0]!.clientId).toBe('active-client')
  })

  it('skips live-owned sessions for resume last and blocks explicit takeover', () => {
    writeSession(testHome, 'live-owned', 2000)
    writeSession(testHome, 'free-session', 1000)

    const leasePath = join(testHome, 'live-repl.json')
    writeFileSync(leasePath, JSON.stringify({
      version: 2,
      clients: [
        {
          clientId: 'client-a',
          clientPid: process.pid,
          daemonPid: 101,
          runtimeToken: 'token-a',
          host: '127.0.0.1',
          port: 9999,
          routerUrl: 'http://127.0.0.1:8009',
          startedAt: '2026-04-18T00:00:00.000Z',
          sessionId: 'live-owned',
        },
      ],
    }, null, 2))

    const lastResolution = resolveLiveReplResumeTarget('last', {
      runtime: {
        host: '127.0.0.1',
        port: 9999,
        routerUrl: 'http://127.0.0.1:8009',
        runtimeToken: 'token-a',
      },
    })
    expect(lastResolution.reason).toBe('ok')
    expect(lastResolution.resolvedTarget).toBe('free-session')
    expect(lastResolution.skippedLiveSessionIds).toEqual(['live-owned'])

    const blockedResolution = resolveLiveReplResumeTarget('live-owned', {
      runtime: {
        host: '127.0.0.1',
        port: 9999,
        routerUrl: 'http://127.0.0.1:8009',
        runtimeToken: 'token-a',
      },
    })
    expect(blockedResolution.reason).toBe('owned_by_live_client')
    expect(blockedResolution.blockedBy?.clientId).toBe('client-a')
  })

  it('serializes concurrent client registrations across subprocesses', async () => {
    const holders = await Promise.all([
      spawnPidHolder(),
      spawnPidHolder(),
      spawnPidHolder(),
      spawnPidHolder(),
    ])

    await Promise.all(holders.map((holder, index) => runLeaseWorker({
      TEST_OP: 'upsert',
      TEST_CLIENT_ID: `client-${index + 1}`,
      TEST_CLIENT_PID: String(holder.pid ?? 0),
      TEST_DAEMON_PID: String(process.pid),
      TEST_RUNTIME_TOKEN: 'token-a',
      TEST_PORT: '9999',
      TEST_ROUTER_URL: 'http://127.0.0.1:8009',
      TEST_STARTED_AT: `2026-04-18T00:00:0${index}.000Z`,
      TEST_DELAY_MS: String(index % 2 === 0 ? 10 : 0),
    })))

    const registry = readLiveReplRegistry()
    expect(registry).not.toBeNull()
    expect(registry!.clients.map(client => client.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
    ])
  })
  it('serializes concurrent session updates without losing sibling changes', async () => {
    const holderA = await spawnPidHolder()
    const holderB = await spawnPidHolder()

    writeLiveReplRegistry({
      version: 2,
      clients: [
        {
          clientId: 'client-a',
          clientPid: holderA.pid ?? 0,
          daemonPid: process.pid,
          runtimeToken: 'token-a',
          host: '127.0.0.1',
          port: 9999,
          routerUrl: 'http://127.0.0.1:8009',
          startedAt: '2026-04-18T00:00:00.000Z',
        },
        {
          clientId: 'client-b',
          clientPid: holderB.pid ?? 0,
          daemonPid: process.pid,
          runtimeToken: 'token-a',
          host: '127.0.0.1',
          port: 9999,
          routerUrl: 'http://127.0.0.1:8009',
          startedAt: '2026-04-18T00:00:01.000Z',
        },
      ],
    })

    await Promise.all([
      runLeaseWorker({
        TEST_OP: 'update-session',
        TEST_CLIENT_ID: 'client-a',
        TEST_SESSION_ID: 'session-a',
        TEST_DELAY_MS: '10',
      }),
      runLeaseWorker({
        TEST_OP: 'update-session',
        TEST_CLIENT_ID: 'client-b',
        TEST_SESSION_ID: 'session-b',
        TEST_DELAY_MS: '0',
      }),
    ])

    const registry = readLiveReplRegistry()
    expect(registry).not.toBeNull()
    expect(registry!.clients).toHaveLength(2)
    expect(registry!.clients.find(client => client.clientId === 'client-a')?.sessionId).toBe('session-a')
    expect(registry!.clients.find(client => client.clientId === 'client-b')?.sessionId).toBe('session-b')
  })
})

// ─── Admin view ────────────────────────────────────────────────────
//
// The admin surface (`owlcoda clients` list/detach output) is built
// on top of three helpers: `enrichLiveReplClientForAdmin`,
// `formatLiveReplClientAge`, and `formatLiveReplClientDetail`. These
// tests lock their contracts so the CLI's output shape can't drift
// silently. JSON consumers in particular rely on the schemaVersion
// + field set staying stable.

describe('admin view helpers', () => {
  function baseClient(overrides: Partial<LiveReplClientLease> = {}): LiveReplClientLease {
    return {
      clientId: 'client-42',
      clientPid: 99999999, // guaranteed non-existent PID → alive=false
      daemonPid: 12345,
      runtimeToken: 'tok',
      host: '127.0.0.1',
      port: 19920,
      routerUrl: 'http://127.0.0.1:11434',
      startedAt: '2026-04-18T00:00:00.000Z',
      ...overrides,
    }
  }

  it('schemaVersion is exported and stable (bump requires conscious commit)', () => {
    expect(LIVE_REPL_CLIENT_ADMIN_SCHEMA_VERSION).toBe(2)
  })

  it('formatLiveReplClientAge covers sub-minute, minute, hour, day ranges', () => {
    expect(formatLiveReplClientAge(0)).toBe('0s')
    expect(formatLiveReplClientAge(42)).toBe('42s')
    expect(formatLiveReplClientAge(60)).toBe('1m')
    expect(formatLiveReplClientAge(125)).toBe('2m 5s')
    expect(formatLiveReplClientAge(3600)).toBe('1h')
    expect(formatLiveReplClientAge(3_665)).toBe('1h 1m')
    expect(formatLiveReplClientAge(86_400)).toBe('1d')
    expect(formatLiveReplClientAge(-1)).toBe('unknown')
  })

  it('enrichLiveReplClientForAdmin computes alive=false for dead PIDs', () => {
    const view = enrichLiveReplClientForAdmin(baseClient(), Date.parse('2026-04-18T00:01:00.000Z'))
    expect(view.alive).toBe(false)
    expect(view.target).toBe('http://127.0.0.1:19920')
    expect(view.ageSeconds).toBe(60)
    // No sessionId → no sessionTitle enrichment, but object still complete
    expect(view.sessionTitle).toBeUndefined()
  })

  it('enrichLiveReplClientForAdmin computes alive=true for a live PID', () => {
    const view = enrichLiveReplClientForAdmin(
      baseClient({ clientPid: process.pid }),
      Date.parse('2026-04-18T00:00:30.000Z'),
    )
    expect(view.alive).toBe(true)
    expect(view.ageSeconds).toBe(30)
  })

  it('enrichLiveReplClientForAdmin enriches sessionTitle when session file is readable', () => {
    writeSession(testHome, 'live-admin-session', 1_700_000_000_000)
    const view = enrichLiveReplClientForAdmin(
      baseClient({ sessionId: 'live-admin-session' }),
      Date.parse('2026-04-18T00:00:00.000Z'),
    )
    expect(view.sessionTitle).toBe('live-admin-session')
    expect(view.sessionUpdatedAt).toBeDefined()
  })

  it('enrichLiveReplClientForAdmin is tolerant of a missing session file', () => {
    // sessionId refers to a session that was deleted. Enrichment
    // should NOT throw and should leave sessionTitle undefined.
    const view = enrichLiveReplClientForAdmin(
      baseClient({ sessionId: 'never-existed' }),
      Date.parse('2026-04-18T00:00:00.000Z'),
    )
    expect(view.sessionTitle).toBeUndefined()
    expect(view.sessionUpdatedAt).toBeUndefined()
  })

  it('enrichLiveReplClientForAdmin ageSeconds=-1 when startedAt is unparseable', () => {
    const view = enrichLiveReplClientForAdmin(
      baseClient({ startedAt: 'not-a-date' }),
      Date.now(),
    )
    expect(view.ageSeconds).toBe(-1)
    // Details should still render via formatLiveReplClientAge('unknown')
    const detail = formatLiveReplClientDetail(view)
    expect(detail).toContain('started unknown ago')
  })

  it('formatLiveReplClientDetail renders alive marker, target, daemon, session', () => {
    writeSession(testHome, 'detail-session', 1_700_000_000_000)
    const view = enrichLiveReplClientForAdmin(
      baseClient({ clientPid: process.pid, sessionId: 'detail-session' }),
      Date.parse('2026-04-18T00:00:05.000Z'),
    )
    const detail = formatLiveReplClientDetail(view, 1)
    expect(detail).toContain('[1] client client-42')
    expect(detail).toContain('alive')
    expect(detail).toContain(`PID ${process.pid}`)
    expect(detail).toContain('daemon 12345')
    expect(detail).toContain('target http://127.0.0.1:19920')
    expect(detail).toContain('router http://127.0.0.1:11434')
    expect(detail).toContain('session detail-session')
    expect(detail).toContain('"detail-session"')
  })

  it('formatLiveReplClientDetail shows "stale" for dead PIDs and "session none" when absent', () => {
    const view = enrichLiveReplClientForAdmin(baseClient(), Date.parse('2026-04-18T00:00:00.000Z'))
    const detail = formatLiveReplClientDetail(view)
    expect(detail).toContain('stale')
    expect(detail).toContain('session none')
    // No index prefix when omitted
    expect(detail.startsWith('client client-42')).toBe(true)
  })
})
