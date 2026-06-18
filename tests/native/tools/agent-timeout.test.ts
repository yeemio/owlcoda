/**
 * Tests for agent_timeout_policy_v1 (0.13.57).
 *
 * Pin: env-var parsing, watchdog idle abort, watchdog max-runtime
 * abort, progress signal resets idle clock, external signal forwards
 * without recording a timeout firing, dispose cleanup, message
 * formatting includes last-progress evidence.
 *
 * Strategy: inject `now` and `setIntervalImpl` so tests are
 * deterministic and don't actually wait wallclock seconds.
 */
import { describe, expect, it } from 'vitest'
import {
  createAgentWatchdog,
  formatAgentTimeoutMessage,
  parseAgentTimeoutMs,
  resolveAgentTimeoutPolicy,
} from '../../../src/native/tools/agent-timeout.js'

/** Minimal manual clock + tick orchestrator. Tests advance `clock`
 *  and call `runTicks()` to fire any scheduled checks. */
function makeFakeTime(): {
  now: () => number
  advance: (ms: number) => void
  setIntervalImpl: (cb: () => void, ms: number) => unknown
  clearIntervalImpl: (handle: unknown) => void
  runTicks: () => void
} {
  let clock = 1_000_000
  const cbs: Array<{ id: number; cb: () => void; periodMs: number; lastFiredAt: number; cleared: boolean }> = []
  let nextId = 1
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    setIntervalImpl: (cb: () => void, ms: number) => {
      const entry = { id: nextId++, cb, periodMs: ms, lastFiredAt: clock, cleared: false }
      cbs.push(entry)
      return entry.id
    },
    clearIntervalImpl: (h: unknown) => {
      const entry = cbs.find((c) => c.id === h)
      if (entry) entry.cleared = true
    },
    runTicks: () => {
      // Fire each non-cleared callback once. Tests can call advance
      // and runTicks repeatedly to simulate the passage of time.
      for (const c of cbs) {
        if (c.cleared) continue
        if (clock - c.lastFiredAt >= c.periodMs) {
          c.lastFiredAt = clock
          c.cb()
        }
      }
    },
  }
}

describe('parseAgentTimeoutMs', () => {
  it('returns default when raw is undefined', () => {
    expect(parseAgentTimeoutMs(undefined, 5000)).toBe(5000)
  })

  it('returns default when raw is empty string', () => {
    expect(parseAgentTimeoutMs('', 5000)).toBe(5000)
  })

  it('returns default when raw is non-numeric', () => {
    expect(parseAgentTimeoutMs('abc', 5000)).toBe(5000)
  })

  it('returns 0 for literal "0" so callers can disable', () => {
    expect(parseAgentTimeoutMs('0', 5000)).toBe(0)
  })

  it('returns parsed integer for valid ms', () => {
    expect(parseAgentTimeoutMs('120000', 5000)).toBe(120000)
  })

  it('floors fractional ms to integer', () => {
    expect(parseAgentTimeoutMs('120000.7', 5000)).toBe(120000)
  })

  it('returns default for negative values (fail safe)', () => {
    expect(parseAgentTimeoutMs('-100', 5000)).toBe(5000)
  })
})

describe('resolveAgentTimeoutPolicy', () => {
  it('uses defaults when env unset', () => {
    const p = resolveAgentTimeoutPolicy({})
    expect(p.idleTimeoutMs).toBe(300_000)
    expect(p.maxRuntimeMs).toBe(1_800_000)
  })

  it('reads env overrides', () => {
    const p = resolveAgentTimeoutPolicy({
      OWLCODA_AGENT_IDLE_TIMEOUT_MS: '10000',
      OWLCODA_AGENT_MAX_RUNTIME_MS: '60000',
    })
    expect(p.idleTimeoutMs).toBe(10_000)
    expect(p.maxRuntimeMs).toBe(60_000)
  })

  it('honors 0 to disable each axis independently', () => {
    const p = resolveAgentTimeoutPolicy({
      OWLCODA_AGENT_IDLE_TIMEOUT_MS: '0',
      OWLCODA_AGENT_MAX_RUNTIME_MS: '60000',
    })
    expect(p.idleTimeoutMs).toBe(0)
    expect(p.maxRuntimeMs).toBe(60_000)
  })

  it('uses positive per-call overrides over env defaults', () => {
    const p = resolveAgentTimeoutPolicy({
      OWLCODA_AGENT_IDLE_TIMEOUT_MS: '0',
      OWLCODA_AGENT_MAX_RUNTIME_MS: '0',
    }, {
      idleTimeoutMs: 15_000,
      maxRuntimeMs: 120_000,
    })
    expect(p.idleTimeoutMs).toBe(15_000)
    expect(p.maxRuntimeMs).toBe(120_000)
  })

  it('ignores zero or invalid per-call overrides so calls cannot disable watchdog axes', () => {
    const p = resolveAgentTimeoutPolicy({
      OWLCODA_AGENT_IDLE_TIMEOUT_MS: '10',
      OWLCODA_AGENT_MAX_RUNTIME_MS: '20',
    }, {
      idleTimeoutMs: 0,
      maxRuntimeMs: -5,
    })
    expect(p.idleTimeoutMs).toBe(10)
    expect(p.maxRuntimeMs).toBe(20)
  })
})

describe('createAgentWatchdog — idle timeout', () => {
  it('does not fire when there is recent progress', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    // Advance 500ms then record progress; advance another 600ms
    // (cumulative idle ~600ms, below 1000 threshold).
    t.advance(500); t.runTicks()
    expect(wd.getFiring()).toBeNull()
    wd.recordProgress('tool_progress', 'bash')
    t.advance(600); t.runTicks()
    expect(wd.getFiring()).toBeNull()
    expect(wd.signal.aborted).toBe(false)
    wd.dispose()
  })

  it('fires when idle exceeds threshold and aborts the signal', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    t.advance(1100); t.runTicks()
    const firing = wd.getFiring()
    expect(firing).not.toBeNull()
    expect(firing!.kind).toBe('idle')
    expect(wd.signal.aborted).toBe(true)
    expect(firing!.lastProgress.type).toBe('agent_start')
    wd.dispose()
  })

  it('progress recordings reset the idle clock so a steady tool stream stays alive', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    // 5 cycles of: 800ms wait → progress mark. Cumulative 4000ms but
    // idle never exceeds 800ms.
    for (let i = 0; i < 5; i++) {
      t.advance(800); t.runTicks()
      expect(wd.getFiring()).toBeNull()
      wd.recordProgress('tool_start', 'read')
    }
    expect(wd.signal.aborted).toBe(false)
    wd.dispose()
  })

  it('records the most recent progress detail in lastProgress', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    wd.recordProgress('tool_start', 'bash')
    wd.recordProgress('tool_end', 'bash')
    wd.recordProgress('assistant_text')
    t.advance(1100); t.runTicks()
    const firing = wd.getFiring()
    expect(firing).not.toBeNull()
    expect(firing!.lastProgress.type).toBe('assistant_text')
    wd.dispose()
  })
})

describe('createAgentWatchdog — max runtime', () => {
  it('fires the absolute ceiling regardless of progress', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 60_000,  // huge; idle never fires
      maxRuntimeMs: 1500,     // ceiling
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    // Drip progress every 200ms — idle would never trip.
    for (let i = 0; i < 8; i++) {
      t.advance(200); t.runTicks()
      wd.recordProgress('tool_start')
    }
    const firing = wd.getFiring()
    expect(firing).not.toBeNull()
    expect(firing!.kind).toBe('max')
    expect(wd.signal.aborted).toBe(true)
    wd.dispose()
  })
})

describe('createAgentWatchdog — disabled axes', () => {
  it('does not fire idle when idleTimeoutMs=0', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 0,
      maxRuntimeMs: 5000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    t.advance(4000); t.runTicks()  // far past any idle threshold
    expect(wd.getFiring()).toBeNull()
    wd.dispose()
  })

  it('does not fire max when maxRuntimeMs=0', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 0,
      maxRuntimeMs: 0,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    t.advance(60_000); t.runTicks()
    expect(wd.getFiring()).toBeNull()
    wd.dispose()
  })

  it('does not even schedule a tick when both axes are disabled', () => {
    let scheduledCalls = 0
    const t = makeFakeTime()
    const setIntervalSpy = (cb: () => void, ms: number): unknown => {
      scheduledCalls += 1
      return t.setIntervalImpl(cb, ms)
    }
    const wd = createAgentWatchdog({
      idleTimeoutMs: 0,
      maxRuntimeMs: 0,
      now: t.now,
      setIntervalImpl: setIntervalSpy,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    expect(scheduledCalls).toBe(0)
    wd.dispose()
  })
})

describe('createAgentWatchdog — external signal', () => {
  it('forwards an external abort but does NOT record a firing', () => {
    const t = makeFakeTime()
    const ext = new AbortController()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 60_000,
      maxRuntimeMs: 60_000,
      externalSignal: ext.signal,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    ext.abort()
    expect(wd.signal.aborted).toBe(true)
    expect(wd.getFiring()).toBeNull()  // user cancel, not timeout
    wd.dispose()
  })

  it('handles externalSignal already aborted at construction', () => {
    const t = makeFakeTime()
    const ext = new AbortController()
    ext.abort()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 60_000,
      maxRuntimeMs: 60_000,
      externalSignal: ext.signal,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    expect(wd.signal.aborted).toBe(true)
    expect(wd.getFiring()).toBeNull()
    wd.dispose()
  })
})

describe('createAgentWatchdog — dispose', () => {
  it('clears the interval and detaches external listener', () => {
    let cleared = 0
    const t = makeFakeTime()
    const clearSpy = (h: unknown): void => {
      cleared += 1
      t.clearIntervalImpl(h)
    }
    const ext = new AbortController()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      externalSignal: ext.signal,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: clearSpy,
      tickMs: 100,
    })
    wd.dispose()
    expect(cleared).toBe(1)
    // dispose is idempotent
    wd.dispose()
    expect(cleared).toBe(1)
  })

  it('progress recording is a no-op after dispose', () => {
    const t = makeFakeTime()
    const wd = createAgentWatchdog({
      idleTimeoutMs: 1000,
      maxRuntimeMs: 60_000,
      now: t.now,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
      tickMs: 100,
    })
    const before = wd.getLastProgress()
    wd.dispose()
    t.advance(500)
    wd.recordProgress('tool_start', 'should not change')
    const after = wd.getLastProgress()
    expect(after.at).toBe(before.at)
  })
})

describe('formatAgentTimeoutMessage', () => {
  it('formats idle timeout with last progress evidence', () => {
    const msg = formatAgentTimeoutMessage({
      kind: 'idle',
      at: 6000,
      startTime: 0,
      idleTimeoutMs: 5000,
      maxRuntimeMs: 60000,
      lastProgress: { type: 'tool_start', detail: 'bash', at: 500 },
    })
    expect(msg).toMatch(/Agent timeout — idle/)
    expect(msg).toMatch(/no progress for 5\.5s/)
    expect(msg).toMatch(/idle timeout = 5s/)
    expect(msg).toMatch(/Last progress event: tool_start \(bash\) 5\.5s ago/)
    expect(msg).toMatch(/OWLCODA_AGENT_IDLE_TIMEOUT_MS/)
    expect(msg).toMatch(/OWLCODA_AGENT_MAX_RUNTIME_MS/)
    expect(msg).toMatch(/set 0 to disable hard ceiling, not recommended/)
  })

  it('formats max-runtime timeout with last progress evidence', () => {
    const msg = formatAgentTimeoutMessage({
      kind: 'max',
      at: 60000,
      startTime: 0,
      idleTimeoutMs: 5000,
      maxRuntimeMs: 30000,
      lastProgress: { type: 'tool_progress', detail: 'read', at: 59800 },
    })
    expect(msg).toMatch(/Agent timeout — max runtime/)
    expect(msg).toMatch(/exceeded the maximum runtime/)
    expect(msg).toMatch(/60\.0s > 30s ceiling/)
    expect(msg).toMatch(/Last progress event: tool_progress \(read\) 0\.2s ago/)
    expect(msg).toMatch(/OWLCODA_AGENT_MAX_RUNTIME_MS/)
  })

  it('handles last progress without detail field gracefully', () => {
    const msg = formatAgentTimeoutMessage({
      kind: 'idle',
      at: 5000,
      startTime: 0,
      idleTimeoutMs: 4000,
      maxRuntimeMs: 60000,
      lastProgress: { type: 'agent_start', at: 0 },
    })
    expect(msg).toMatch(/Last progress event: agent_start 5\.0s ago/)
    expect(msg).not.toMatch(/agent_start \(/)
  })
})
