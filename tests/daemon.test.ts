/**
 * Tests for src/daemon.ts — daemon lifecycle, PID management, buildDaemonArgs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyActiveStaleDaemonPolicy,
  buildDaemonArgs,
  buildPortInUseMessage,
  decideDaemonVersionPolicy,
  forceStopOrphanDaemon,
  getBaseUrl,
  getMetaBaseUrl,
} from '../src/daemon.js'

describe('buildPortInUseMessage (Windows orphan-daemon misreport fix)', () => {
  it('reports a stale OwlCoda daemon with PID + stop hint when /healthz identifies the holder', () => {
    const msg = buildPortInUseMessage(8019, 'http://127.0.0.1:8019', 4242)
    expect(msg).toContain('stale OwlCoda daemon (PID 4242)')
    expect(msg).toContain('owlcoda stop --force')
    expect(msg).toContain('owlcoda service status')
    expect(msg).toContain('Logs:')
    expect(msg).not.toContain('non-OwlCoda')
  })
  it('falls back to "non-OwlCoda process" (still hinting stop --force) when the holder is unidentified', () => {
    const msg = buildPortInUseMessage(8019, 'http://127.0.0.1:8019', null)
    expect(msg).toContain('non-OwlCoda process')
    expect(msg).toContain('owlcoda stop --force')
    expect(msg).toContain('owlcoda service status')
  })
})

describe('forceStopOrphanDaemon (stop --force without a PID file)', () => {
  it('recovers the orphan PID from /healthz and SIGTERMs it', async () => {
    const signals: Array<[number, string]> = []
    const pid = await forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => ({ pid: 9001 }),
      signal: (p, s) => { signals.push([p, s]); return true },
      waitGone: async () => true,
      isAlive: () => false,
    })
    expect(pid).toBe(9001)
    expect(signals).toEqual([[9001, 'SIGTERM']])
  })
  it('escalates to SIGKILL when the daemon survives SIGTERM', async () => {
    const signals: Array<[number, string]> = []
    let waitCount = 0
    const pid = await forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => ({ pid: 9002 }),
      signal: (p, s) => { signals.push([p, s]); return true },
      waitGone: async () => {
        waitCount += 1
        return waitCount >= 2
      },
      isAlive: () => true,
    })
    expect(pid).toBe(9002)
    expect(signals).toEqual([[9002, 'SIGTERM'], [9002, 'SIGKILL']])
  })
  it('returns null without signaling when no OwlCoda daemon answers /healthz', async () => {
    const signals: number[] = []
    const pid = await forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => null,
      signal: (p) => { signals.push(p); return true },
      waitGone: async () => true,
      isAlive: () => false,
    })
    expect(pid).toBeNull()
    expect(signals).toEqual([])
  })
  it('throws instead of reporting success when SIGTERM cannot be sent', async () => {
    await expect(forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => ({ pid: 9003 }),
      signal: () => false,
      waitGone: async () => false,
      isAlive: () => true,
    })).rejects.toThrow(/failed to send SIGTERM/)
  })
  it('throws instead of reporting success when SIGKILL cannot clear a survivor', async () => {
    const signals: string[] = []
    await expect(forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => ({ pid: 9004 }),
      signal: (_p, s) => {
        signals.push(s)
        return s === 'SIGTERM'
      },
      waitGone: async () => false,
      isAlive: () => true,
    })).rejects.toThrow(/failed to send SIGKILL/)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

// ─── buildDaemonArgs ───

describe('buildDaemonArgs', () => {
  it('produces minimal args when no overrides', () => {
    const args = buildDaemonArgs()
    expect(args).toContain('server')
    expect(args.length).toBeGreaterThanOrEqual(2)
  })

  it('includes --config when configPath provided', () => {
    const args = buildDaemonArgs('/tmp/test.toml')
    expect(args).toContain('--config')
    expect(args).toContain('/tmp/test.toml')
  })

  it('includes --port when port provided', () => {
    const args = buildDaemonArgs(undefined, 9999)
    expect(args).toContain('--port')
    expect(args).toContain('9999')
  })

  it('includes --router when routerUrl provided', () => {
    const args = buildDaemonArgs(undefined, undefined, 'http://localhost:11435/v1')
    expect(args).toContain('--router')
    expect(args).toContain('http://localhost:11435/v1')
  })

  it('includes all flags together', () => {
    const args = buildDaemonArgs('/tmp/c.toml', 8888, 'http://r:1234/v1')
    expect(args).toContain('--config')
    expect(args).toContain('/tmp/c.toml')
    expect(args).toContain('--port')
    expect(args).toContain('8888')
    expect(args).toContain('--router')
    expect(args).toContain('http://r:1234/v1')
  })
})

// ─── getBaseUrl / getMetaBaseUrl ───

describe('getBaseUrl', () => {
  it('builds URL from config host and port', () => {
    const config = { host: '127.0.0.1', port: 8019, routerUrl: 'x', models: new Map() }
    expect(getBaseUrl(config as any)).toBe('http://127.0.0.1:8019')
  })

  it('resolves wildcard host to 127.0.0.1', () => {
    const config = { host: '0.0.0.0', port: 8019, routerUrl: 'x', models: new Map() }
    expect(getBaseUrl(config as any)).toBe('http://127.0.0.1:8019')
  })
})

describe('getMetaBaseUrl', () => {
  it('builds URL from meta host and port', () => {
    expect(getMetaBaseUrl({ host: '127.0.0.1', port: 8019 })).toBe('http://127.0.0.1:8019')
  })

  it('resolves wildcard meta host', () => {
    expect(getMetaBaseUrl({ host: '::', port: 8019 })).toBe('http://127.0.0.1:8019')
  })
})

// ─── Module exports completeness ───

describe('daemon module exports', () => {
  it('exports all expected functions', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf-8')
    const expectedExports = [
      'writeRuntimeMeta', 'readRuntimeMeta', 'removeRuntimeMeta',
      'isPidAlive', 'readPid', 'writePid', 'removePid',
      'getMetaBaseUrl',
      'decideDaemonVersionPolicy',
      'safeSendSignal',
      'buildDaemonArgs', 'spawnDaemon', 'getBaseUrl',
    ]
    const expectedAsyncExports = [
      'verifyManagedDaemon', 'stopAndWait', 'ensureProxyRunning',
    ]
    for (const fn of expectedExports) {
      expect(src).toContain(`export function ${fn}`)
    }
    for (const fn of expectedAsyncExports) {
      expect(src).toContain(`export async function ${fn}`)
    }
  })

  it('exports RuntimeMeta interface', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf-8')
    expect(src).toContain('export interface RuntimeMeta')
  })
})

// ─── Daemon version policy ───

describe('decideDaemonVersionPolicy', () => {
  it('reuses daemon when versions match', () => {
    expect(decideDaemonVersionPolicy('0.13.81', 0, '0.13.81')).toMatchObject({
      action: 'reuse_current',
      stale: false,
      activeClientCount: 0,
    })
  })

  it('restarts stale daemon when no live REPL client is attached', () => {
    expect(decideDaemonVersionPolicy('0.13.36', 0, '0.13.81')).toMatchObject({
      action: 'restart_idle_stale',
      stale: true,
      daemonVersion: '0.13.36',
      cliVersion: '0.13.81',
      activeClientCount: 0,
    })
  })

  it('reuses stale daemon when active live REPL clients are attached', () => {
    expect(decideDaemonVersionPolicy('0.13.36', 2, '0.13.81')).toMatchObject({
      action: 'reuse_active_stale',
      stale: true,
      daemonVersion: '0.13.36',
      cliVersion: '0.13.81',
      activeClientCount: 2,
    })
  })
})

// ─── SSE metrics endpoint declaration ───

describe('server SSE metrics endpoint', () => {
  it('server.ts declares /events/metrics SSE route', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
    expect(src).toContain("'/events/metrics'")
    expect(src).toContain('text/event-stream')
  })

  it('server.ts includes pricingNote in /v1/usage', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
    expect(src).toContain('pricingNote')
    expect(src).toContain('estimated_cloud_rates')
  })
})

// ─── applyActiveStaleDaemonPolicy ───

describe('applyActiveStaleDaemonPolicy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  let originalAllow: string | undefined

  beforeEach(() => {
    originalAllow = process.env.OWLCODA_ALLOW_VERSION_DRIFT
    delete process.env.OWLCODA_ALLOW_VERSION_DRIFT
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__test_exit_${code}__`)
    }) as never
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as never
  })

  afterEach(() => {
    exitSpy.mockRestore()
    errSpy.mockRestore()
    if (originalAllow === undefined) {
      delete process.env.OWLCODA_ALLOW_VERSION_DRIFT
    } else {
      process.env.OWLCODA_ALLOW_VERSION_DRIFT = originalAllow
    }
  })

  const makeStaleDecision = (
    overrides: Partial<{ daemonVersion: string; cliVersion: string; activeClientCount: number }> = {},
  ) => ({
    action: 'reuse_active_stale' as const,
    stale: true,
    daemonVersion: overrides.daemonVersion ?? '0.14.36',
    cliVersion: overrides.cliVersion ?? '0.14.40',
    activeClientCount: overrides.activeClientCount ?? 1,
  })

  it('hard-exits with code 2 when daemon version drifts and bypass is not set', () => {
    expect(() =>
      applyActiveStaleDaemonPolicy(12345, 'http://127.0.0.1:9999', makeStaleDecision()),
    ).toThrow('__test_exit_2__')
    expect(exitSpy).toHaveBeenCalledWith(2)
    // Both the original warning AND the new "refusing to start" message
    // must be visible so the user knows why startup aborted.
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('PID 12345'))).toBe(true)
    expect(messages.some((m) => m.includes('Refusing to start with version-drifted daemon'))).toBe(true)
    expect(messages.some((m) => m.includes('OWLCODA_ALLOW_VERSION_DRIFT'))).toBe(true)
  })

  it('returns normally when OWLCODA_ALLOW_VERSION_DRIFT=1 is set (escape hatch)', () => {
    process.env.OWLCODA_ALLOW_VERSION_DRIFT = '1'
    expect(() =>
      applyActiveStaleDaemonPolicy(12345, 'http://127.0.0.1:9999', makeStaleDecision()),
    ).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('OWLCODA_ALLOW_VERSION_DRIFT=1 set'))).toBe(true)
    expect(messages.some((m) => m.includes('proceed at your own risk'))).toBe(true)
  })

  it('exits even with a single active client (the original drift scenario)', () => {
    expect(() =>
      applyActiveStaleDaemonPolicy(72984, 'http://127.0.0.1:9999', makeStaleDecision({
        daemonVersion: '0.14.36',
        cliVersion: '0.14.39',
        activeClientCount: 1,
      })),
    ).toThrow('__test_exit_2__')
    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})
