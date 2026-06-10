import { describe, it, expect, afterEach } from 'vitest'
import {
  AdmissionGate,
  AdmissionBackpressureError,
  admissionKeyFromUpstream,
  admitRequest,
  recordAdmissionSuccess,
  recordAdmissionRateLimit,
  admissionStatus,
  handleAdmissionStatus,
  __admissionLimitForTesting,
  __resetAdmissionForTesting,
} from '../src/endpoints/admission.js'
import type { ServerResponse } from 'node:http'

const KEY = 'http://up::m'

describe('AdmissionGate', () => {
  it('admits immediately while under the limit', async () => {
    const gate = new AdmissionGate({ limitFor: () => 2 })
    const r1 = await gate.admit(KEY, 2)
    const r2 = await gate.admit(KEY, 2)
    expect(gate.inFlightForTesting(KEY)).toBe(2)
    r1(); r2()
    expect(gate.inFlightForTesting(KEY)).toBe(0)
  })

  it('queues at the limit and admits a waiter when a slot frees (FIFO)', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1, waitMs: () => 1000 })
    const r1 = await gate.admit(KEY, 1)
    let secondAdmitted = false
    const p2 = gate.admit(KEY, 1).then((rel) => { secondAdmitted = true; return rel })
    // Let microtasks flush — the second admit should still be queued.
    await Promise.resolve()
    expect(secondAdmitted).toBe(false)
    expect(gate.queueDepthForTesting(KEY)).toBe(1)
    r1() // free the slot → wakes the waiter
    const r2 = await p2
    expect(secondAdmitted).toBe(true)
    expect(gate.inFlightForTesting(KEY)).toBe(1)
    r2()
  })

  it('rejects with backpressure when the queue is full', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1, queueMax: () => 1, waitMs: () => 1000 })
    const r1 = await gate.admit(KEY, 1)
    const queued = gate.admit(KEY, 1).catch(() => 'rejected') // fills the single queue slot
    await Promise.resolve()
    await expect(gate.admit(KEY, 1)).rejects.toBeInstanceOf(AdmissionBackpressureError)
    r1()
    await queued
  })

  it('rejects with backpressure when the wait exceeds the max', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1, waitMs: () => 20 })
    const r1 = await gate.admit(KEY, 1)
    await expect(gate.admit(KEY, 1)).rejects.toBeInstanceOf(AdmissionBackpressureError)
    r1()
  })

  it('aborts a queued waiter via signal and removes it from the queue', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1, waitMs: () => 1000 })
    const r1 = await gate.admit(KEY, 1)
    const ac = new AbortController()
    const p = gate.admit(KEY, 1, ac.signal)
    await Promise.resolve()
    expect(gate.queueDepthForTesting(KEY)).toBe(1)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(gate.queueDepthForTesting(KEY)).toBe(0)
    r1()
  })

  it('throws immediately when admit is called with an already-aborted signal', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1 })
    const ac = new AbortController()
    ac.abort()
    await expect(gate.admit(KEY, 1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(gate.inFlightForTesting(KEY)).toBe(0)
  })

  it('release is idempotent (double release does not over-decrement)', async () => {
    const gate = new AdmissionGate({ limitFor: () => 2 })
    const r1 = await gate.admit(KEY, 2)
    await gate.admit(KEY, 2)
    r1(); r1()
    expect(gate.inFlightForTesting(KEY)).toBe(1)
  })

  it('builds a stable per-upstream key from endpoint + model', () => {
    expect(admissionKeyFromUpstream('https://api.x/v1', 'gpt-4')).toBe('https://api.x/v1::gpt-4')
    expect(admissionKeyFromUpstream('', '')).toBe('unknown::')
  })
})

describe('admitRequest (module gate, env-gated)', () => {
  afterEach(() => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    delete process.env.OWLCODA_AGENT_MAX_CONCURRENCY
    __resetAdmissionForTesting()
  })

  it('is a no-op when the adaptive flag is off (zero gating)', async () => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    const release = await admitRequest(KEY)
    expect(typeof release).toBe('function')
    release() // must not throw
  })

  it('gates when the flag is on, honoring OWLCODA_AGENT_MAX_CONCURRENCY as the bound', async () => {
    process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY = '1'
    process.env.OWLCODA_AGENT_MAX_CONCURRENCY = '1'
    process.env.OWLCODA_DAEMON_ADMIT_WAIT_MS = '20'
    const r1 = await admitRequest(KEY)
    await expect(admitRequest(KEY)).rejects.toBeInstanceOf(AdmissionBackpressureError)
    r1()
    delete process.env.OWLCODA_DAEMON_ADMIT_WAIT_MS
  })
})

describe('admission AIMD (daemon-side adaptive limit)', () => {
  afterEach(() => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    delete process.env.OWLCODA_AGENT_MAX_CONCURRENCY
    __resetAdmissionForTesting()
  })

  it('slow-starts from 1 and raises the limit after sustained success', () => {
    process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY = '1'
    process.env.OWLCODA_AGENT_MAX_CONCURRENCY = '4'
    __resetAdmissionForTesting()
    expect(__admissionLimitForTesting(KEY, 4)).toBe(1)
    recordAdmissionSuccess(KEY)
    recordAdmissionSuccess(KEY)
    recordAdmissionSuccess(KEY) // 3 consecutive → +1
    expect(__admissionLimitForTesting(KEY, 4)).toBe(2)
  })

  it('halves the limit on a rate-limit signal', () => {
    process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY = '1'
    process.env.OWLCODA_AGENT_MAX_CONCURRENCY = '8'
    __resetAdmissionForTesting()
    for (let i = 0; i < 9; i++) recordAdmissionSuccess(KEY) // +3 → limit 4
    expect(__admissionLimitForTesting(KEY, 8)).toBe(4)
    recordAdmissionRateLimit(KEY)
    expect(__admissionLimitForTesting(KEY, 8)).toBe(2)
  })

  it('record* are no-ops when the flag is off', () => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    __resetAdmissionForTesting()
    recordAdmissionSuccess(KEY)
    recordAdmissionRateLimit(KEY)
    // No throw; limit query falls back to cap default (1).
    expect(__admissionLimitForTesting(KEY, 1)).toBe(1)
  })
})

describe('AdmissionGate snapshot + counters', () => {
  it('tracks admitted and rejected counters and exposes a per-key snapshot', async () => {
    const gate = new AdmissionGate({ limitFor: () => 1, queueMax: () => 1, waitMs: () => 1000 })
    const r1 = await gate.admit(KEY, 1)              // admitted #1
    const queued = gate.admit(KEY, 1).catch(() => {}) // fills the single queue slot
    await Promise.resolve()
    await gate.admit(KEY, 1).catch(() => {})         // queue full → rejected #1

    const snap = gate.snapshot().find((s) => s.key === KEY)!
    expect(snap.inFlight).toBe(1)
    expect(snap.queued).toBe(1)
    expect(snap.limit).toBe(1)
    expect(snap.admitted).toBe(1)
    expect(snap.rejected).toBe(1)

    r1()
    await queued
  })
})

describe('admissionStatus + handleAdmissionStatus', () => {
  afterEach(() => {
    delete process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY
    delete process.env.OWLCODA_AGENT_MAX_CONCURRENCY
    __resetAdmissionForTesting()
  })

  it('reports config + per-key signal counters', () => {
    process.env.OWLCODA_AGENT_ADAPTIVE_CONCURRENCY = '1'
    process.env.OWLCODA_AGENT_MAX_CONCURRENCY = '4'
    __resetAdmissionForTesting()
    recordAdmissionSuccess(KEY)
    recordAdmissionSuccess(KEY)
    recordAdmissionRateLimit(KEY)

    const status = admissionStatus()
    expect(status.enabled).toBe(true)
    expect(status.cap).toBe(4)
    expect(status.queueMax).toBeGreaterThan(0)
    const k = status.keys.find((x) => x.key === KEY)!
    expect(k.success).toBe(2)
    expect(k.rateLimit).toBe(1)
  })

  it('handleAdmissionStatus writes a 200 JSON body', () => {
    let statusCode = 0
    let payload = ''
    const res = {
      writeHead: (s: number) => { statusCode = s },
      end: (b: string) => { payload = b },
    } as unknown as ServerResponse
    handleAdmissionStatus({} as never, res)
    expect(statusCode).toBe(200)
    const parsed = JSON.parse(payload)
    expect(parsed).toHaveProperty('enabled')
    expect(parsed).toHaveProperty('keys')
    expect(Array.isArray(parsed.keys)).toBe(true)
  })
})
