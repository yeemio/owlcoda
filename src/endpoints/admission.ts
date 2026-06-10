/**
 * Cross-process admission gate (daemon-side).
 *
 * The daemon's /v1/messages proxy is the single chokepoint every client process
 * routes through. Bounding the number of concurrent in-flight requests per
 * upstream key here prevents multiple client processes (REPLs / windows /
 * parallel `owlcoda run`) from collectively bursting a shared upstream — the
 * cross-process gap the single-process adaptive controller can't close.
 *
 * v1 enforces a STATIC per-key bound (= OWLCODA_AGENT_MAX_CONCURRENCY). Making
 * the daemon bound adaptive (AIMD from first-hand rate-limit signal) is a
 * documented follow-up; client-side AIMD continues to run unchanged, so the
 * daemon adds a hard cross-process ceiling on top of per-client adaptation.
 *
 * Default-off contract: when OWLCODA_AGENT_ADAPTIVE_CONCURRENCY is unset,
 * admitRequest() is a zero-overhead no-op and the proxy path is unchanged.
 *
 * See docs/superpowers/specs/2026-05-29-cross-process-concurrency-coordinator-design.md
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import {
  AdaptiveConcurrencyController,
  isAdaptiveAgentConcurrencyEnabled,
  resolveAgentConcurrencyCap,
} from '../native/adaptive-concurrency.js'

const DEFAULT_QUEUE_MAX = 64
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_BACKPRESSURE_RETRY_MS = 2_000

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function abortError(): Error {
  const err = new Error('Admission aborted')
  err.name = 'AbortError'
  return err
}

/** Thrown when a request can't be admitted (queue full or wait exceeded). */
export class AdmissionBackpressureError extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number, message: string) {
    super(message)
    this.name = 'AdmissionBackpressureError'
    this.retryAfterMs = retryAfterMs
  }
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

interface KeyState {
  inFlight: number
  queue: Waiter[]
  cap: number
  admitted: number
  rejected: number
}

export interface AdmissionGateOptions {
  /** Concurrency limit for a key (default: the static cap). */
  limitFor?: (key: string, cap: number) => number
  queueMax?: () => number
  waitMs?: () => number
  backpressureRetryMs?: () => number
}

export class AdmissionGate {
  private readonly states = new Map<string, KeyState>()
  private readonly limitFor: (key: string, cap: number) => number
  private readonly queueMax: () => number
  private readonly waitMs: () => number
  private readonly backpressureRetryMs: () => number

  constructor(opts: AdmissionGateOptions = {}) {
    this.limitFor = opts.limitFor ?? ((_key, cap) => cap)
    this.queueMax = opts.queueMax ?? (() => envInt('OWLCODA_DAEMON_ADMIT_QUEUE_MAX', DEFAULT_QUEUE_MAX))
    this.waitMs = opts.waitMs ?? (() => envInt('OWLCODA_DAEMON_ADMIT_WAIT_MS', DEFAULT_WAIT_MS))
    this.backpressureRetryMs = opts.backpressureRetryMs ?? (() => DEFAULT_BACKPRESSURE_RETRY_MS)
  }

  /**
   * Acquire a slot for `key`. Resolves with a release() callback when admitted;
   * rejects with AdmissionBackpressureError (queue full / wait exceeded) or an
   * AbortError (signal aborted, e.g. client disconnect).
   */
  async admit(key: string, cap: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError()
    const st = this.stateFor(key, cap)
    if (st.inFlight < this.limitFor(key, cap)) {
      st.inFlight += 1
      st.admitted += 1
      return this.makeRelease(key)
    }
    if (st.queue.length >= this.queueMax()) {
      st.rejected += 1
      throw new AdmissionBackpressureError(this.backpressureRetryMs(), 'admission queue full')
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(st, waiter)
          st.rejected += 1
          reject(new AdmissionBackpressureError(this.backpressureRetryMs(), 'admission wait timeout'))
        }, this.waitMs()),
        cleanup: () => {},
      }
      if (signal) {
        const onAbort = () => {
          this.removeWaiter(st, waiter)
          reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      st.queue.push(waiter)
    })
    // pump() already incremented inFlight before resolving this waiter.
    return this.makeRelease(key)
  }

  private makeRelease(key: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const st = this.states.get(key)
      if (!st) return
      st.inFlight = Math.max(0, st.inFlight - 1)
      this.pump(key)
    }
  }

  private pump(key: string): void {
    const st = this.states.get(key)
    if (!st) return
    while (st.queue.length > 0 && st.inFlight < this.limitFor(key, st.cap)) {
      const waiter = st.queue.shift()!
      clearTimeout(waiter.timer)
      waiter.cleanup()
      st.inFlight += 1
      st.admitted += 1
      waiter.resolve()
    }
  }

  private removeWaiter(st: KeyState, waiter: Waiter): void {
    const idx = st.queue.indexOf(waiter)
    if (idx !== -1) st.queue.splice(idx, 1)
    clearTimeout(waiter.timer)
    waiter.cleanup()
  }

  private stateFor(key: string, cap: number): KeyState {
    const existing = this.states.get(key)
    if (existing) {
      existing.cap = cap
      return existing
    }
    const created: KeyState = { inFlight: 0, queue: [], cap, admitted: 0, rejected: 0 }
    this.states.set(key, created)
    return created
  }

  /** Per-key observability snapshot (current state + lifetime counters). */
  snapshot(): Array<{ key: string; inFlight: number; queued: number; limit: number; admitted: number; rejected: number }> {
    const out: Array<{ key: string; inFlight: number; queued: number; limit: number; admitted: number; rejected: number }> = []
    for (const [key, st] of this.states) {
      out.push({
        key,
        inFlight: st.inFlight,
        queued: st.queue.length,
        limit: this.limitFor(key, st.cap),
        admitted: st.admitted,
        rejected: st.rejected,
      })
    }
    return out
  }

  /** Re-run admission for a key after its limit may have increased. */
  notifyLimitChanged(key: string): void {
    this.pump(key)
  }

  reset(): void {
    for (const st of this.states.values()) {
      for (const w of st.queue) {
        clearTimeout(w.timer)
        w.cleanup()
      }
    }
    this.states.clear()
  }

  inFlightForTesting(key: string): number {
    return this.states.get(key)?.inFlight ?? 0
  }

  queueDepthForTesting(key: string): number {
    return this.states.get(key)?.queue.length ?? 0
  }
}

// Daemon-side AIMD: the admission limit per key adapts (slow-start from 1, +1
// after sustained success, halve on a rate-limit signal) up to the cap. This is
// the cross-process adaptive authority; clients delegate to it (their semaphore
// is a static ceiling when the flag is on).
const controller = new AdaptiveConcurrencyController()
const gate = new AdmissionGate({ limitFor: (key, cap) => controller.currentLimit(key, cap) })

/** Stable per-upstream key: the real backend endpoint + model, not the proxy base. */
export function admissionKeyFromUpstream(endpointUrl: string, backendModel: string): string {
  const base = (endpointUrl ?? '').trim() || 'unknown'
  const model = (backendModel ?? '').trim()
  return `${base}::${model}`
}

/**
 * Acquire a cross-process admission slot. No-op (zero overhead) when the
 * adaptive-concurrency flag is off.
 */
export async function admitRequest(key: string, signal?: AbortSignal): Promise<() => void> {
  if (!isAdaptiveAgentConcurrencyEnabled()) return () => {}
  return gate.admit(key, resolveAgentConcurrencyCap(), signal)
}

// Lifetime AIMD-signal counters per key (observability for dogfood).
const successCounts = new Map<string, number>()
const rateLimitCounts = new Map<string, number>()

/** Record a successful upstream request: AIMD may raise the limit → admit waiters. */
export function recordAdmissionSuccess(key: string): void {
  if (!isAdaptiveAgentConcurrencyEnabled()) return
  controller.recordSuccess(key, resolveAgentConcurrencyCap())
  successCounts.set(key, (successCounts.get(key) ?? 0) + 1)
  gate.notifyLimitChanged(key)
}

/** Record a rate-limit signal: AIMD halves the limit (no pump — fewer slots). */
export function recordAdmissionRateLimit(key: string): void {
  if (!isAdaptiveAgentConcurrencyEnabled()) return
  controller.recordRateLimit(key, resolveAgentConcurrencyCap())
  rateLimitCounts.set(key, (rateLimitCounts.get(key) ?? 0) + 1)
}

/** Observability snapshot of the admission gate (config + per-key live state + counters). */
export function admissionStatus(): {
  enabled: boolean
  cap: number
  queueMax: number
  waitMs: number
  keys: Array<{
    key: string
    limit: number
    inFlight: number
    queued: number
    admitted: number
    rejected: number
    success: number
    rateLimit: number
  }>
} {
  const cap = resolveAgentConcurrencyCap()
  const byKey = new Map<string, { key: string; limit: number; inFlight: number; queued: number; admitted: number; rejected: number; success: number; rateLimit: number }>()
  for (const s of gate.snapshot()) {
    byKey.set(s.key, { ...s, success: successCounts.get(s.key) ?? 0, rateLimit: rateLimitCounts.get(s.key) ?? 0 })
  }
  // Union in keys that have only signal counters (no live gate state yet).
  for (const key of new Set([...successCounts.keys(), ...rateLimitCounts.keys()])) {
    if (byKey.has(key)) continue
    byKey.set(key, {
      key,
      limit: controller.currentLimit(key, cap),
      inFlight: 0,
      queued: 0,
      admitted: 0,
      rejected: 0,
      success: successCounts.get(key) ?? 0,
      rateLimit: rateLimitCounts.get(key) ?? 0,
    })
  }
  return {
    enabled: isAdaptiveAgentConcurrencyEnabled(),
    cap,
    queueMax: envInt('OWLCODA_DAEMON_ADMIT_QUEUE_MAX', DEFAULT_QUEUE_MAX),
    waitMs: envInt('OWLCODA_DAEMON_ADMIT_WAIT_MS', DEFAULT_WAIT_MS),
    keys: [...byKey.values()],
  }
}

/** GET /v1/admission — cross-process admission gate observability. */
export function handleAdmissionStatus(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(admissionStatus()))
}

export function __resetAdmissionForTesting(): void {
  gate.reset()
  controller.reset()
  successCounts.clear()
  rateLimitCounts.clear()
}

export function __admissionLimitForTesting(key: string, cap = resolveAgentConcurrencyCap()): number {
  return controller.currentLimit(key, cap)
}

export function __admissionGateForTesting(): AdmissionGate {
  return gate
}
