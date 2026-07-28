/**
 * Tests for launchd-aware daemon coordination (P2-b / W4b).
 *
 * When the launchd service is installed it owns the daemon lifecycle
 * (KeepAlive). ensureProxyRunning must NOT spawn a second detached daemon
 * racing the KeepAlive respawn for the port — it reuses a healthy+current
 * daemon and otherwise kickstarts via launchctl. The orchestration takes its
 * IO via injected deps so the decision flow is unit-testable without a real
 * daemon or launchctl (the default deps wire the real fetchHealthz / kickstart
 * / waitForVerifiedHealthz, smoke-verified in the launchd integration check).
 */
import { describe, it, expect, vi } from 'vitest'
import { ensureLaunchdProxyRunning } from '../src/daemon.js'
import { runtimeTokenFingerprint } from '../src/healthz-client.js'

const cfg = {
  host: '127.0.0.1',
  port: 8019,
  routerUrl: 'http://127.0.0.1:11434',
  models: [],
} as unknown as import('../src/config.js').OwlCodaConfig

const BASE = 'http://127.0.0.1:8019'

function healthz(over: Record<string, unknown> = {}): any {
  return {
    status: 'ok',
    pid: 4242,
    version: '0.14.55',
    host: '127.0.0.1',
    port: 8019,
    routerUrl: 'http://127.0.0.1:11434',
    runtimeTokenFingerprint: runtimeTokenFingerprint('tok'),
    ...over,
  }
}

function decision(over: Record<string, unknown> = {}): any {
  return { action: 'reuse_current', stale: false, cliVersion: '0.14.55', activeClientCount: 0, ...over }
}

function makeDeps(over: Record<string, unknown> = {}): any {
  return {
    fetchHealthz: vi.fn(async () => healthz()),
    matchesConfig: vi.fn(() => true),
    readMeta: vi.fn(() => ({ pid: 4242, runtimeToken: 'tok', host: '127.0.0.1', port: 8019, routerUrl: 'http://127.0.0.1:11434', version: '0.14.55', startedAt: '' })),
    activeClients: vi.fn(() => 0),
    decide: vi.fn(() => decision()),
    kickstart: vi.fn(),
    waitReady: vi.fn(async () => healthz()),
    ...over,
  }
}

describe('ensureLaunchdProxyRunning', () => {
  it('reuses a healthy, current launchd daemon without kickstarting', async () => {
    const deps = makeDeps()
    const r = await ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)
    expect(r).toEqual({ pid: 4242, reused: true })
    expect(deps.kickstart).not.toHaveBeenCalled()
  })

  it('kickstarts (not spawns) a stale idle daemon and returns the restarted one', async () => {
    const deps = makeDeps({
      decide: vi.fn(() => decision({ action: 'restart_idle_stale', stale: true, daemonVersion: '0.14.50' })),
      waitReady: vi.fn(async () => healthz({ pid: 5555 })),
    })
    const r = await ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)
    expect(deps.kickstart).toHaveBeenCalledOnce()
    expect(r).toEqual({ pid: 5555, reused: false })
  })

  it('kickstarts a legacy raw-token daemon instead of reusing it', async () => {
    const deps = makeDeps({
      fetchHealthz: vi.fn(async () => healthz({
        runtimeTokenFingerprint: undefined,
        runtimeToken: 'tok',
      })),
    })

    const r = await ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)

    expect(deps.kickstart).toHaveBeenCalledOnce()
    expect(r).toEqual({ pid: 4242, reused: false })
  })

  it('kickstarts when the daemon is not responding (crash window)', async () => {
    const deps = makeDeps({
      fetchHealthz: vi.fn(async () => null),
      waitReady: vi.fn(async () => healthz({ pid: 6000 })),
    })
    const r = await ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)
    expect(deps.kickstart).toHaveBeenCalledOnce()
    expect(r).toEqual({ pid: 6000, reused: false })
  })

  it('reuses a stale daemon with active clients (under the version-drift bypass)', async () => {
    // Version drift + active clients normally exits(2) to refuse a skewed start
    // (applyActiveStaleDaemonPolicy — same as the non-launchd path); the
    // documented OWLCODA_ALLOW_VERSION_DRIFT bypass lets it continue and surface
    // staleDaemon. Either way it must NOT kickstart/spawn a competing daemon.
    const prev = process.env['OWLCODA_ALLOW_VERSION_DRIFT']
    process.env['OWLCODA_ALLOW_VERSION_DRIFT'] = '1'
    try {
      const deps = makeDeps({
        activeClients: vi.fn(() => 2),
        decide: vi.fn(() => decision({ action: 'reuse_active_stale', stale: true, daemonVersion: '0.14.50', activeClientCount: 2 })),
      })
      const r = await ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)
      expect(deps.kickstart).not.toHaveBeenCalled()
      expect(r.reused).toBe(true)
      expect(r.staleDaemon?.activeClientCount).toBe(2)
    } finally {
      if (prev === undefined) delete process.env['OWLCODA_ALLOW_VERSION_DRIFT']
      else process.env['OWLCODA_ALLOW_VERSION_DRIFT'] = prev
    }
  })

  it('throws if the daemon never becomes ready after kickstart', async () => {
    const deps = makeDeps({
      fetchHealthz: vi.fn(async () => null),
      waitReady: vi.fn(async () => null),
    })
    await expect(ensureLaunchdProxyRunning(cfg, BASE, () => {}, deps)).rejects.toThrow(/failed to become ready/)
  })
})
