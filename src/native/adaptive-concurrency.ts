import { detailLooksLikeRateLimit, type ProviderRequestDiagnostic } from '../provider-error.js'

const DEFAULT_CAP = 1
const DEFAULT_INCREASE_AFTER_SUCCESS = 3
const DEFAULT_COOLDOWN_MS = 5_000
const DEFAULT_RETRY_BUDGET_WINDOW_MS = 60_000
const DEFAULT_RETRY_BUDGET_LIMIT = 12

export interface AdaptiveConcurrencySnapshot {
  key: string
  cap: number
  effectiveLimit: number
  consecutiveSuccesses: number
  cooldownUntil: number
}

interface AdaptiveState {
  effectiveLimit: number
  consecutiveSuccesses: number
  cooldownUntil: number
}

export interface AdaptiveControllerOptions {
  increaseAfterSuccess?: number
  cooldownMs?: number
  now?: () => number
}

export class AdaptiveConcurrencyController {
  private readonly states = new Map<string, AdaptiveState>()
  private readonly increaseAfterSuccess: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(opts: AdaptiveControllerOptions = {}) {
    this.increaseAfterSuccess = positiveInt(opts.increaseAfterSuccess, DEFAULT_INCREASE_AFTER_SUCCESS)
    this.cooldownMs = positiveInt(opts.cooldownMs, DEFAULT_COOLDOWN_MS)
    this.now = opts.now ?? (() => Date.now())
  }

  currentLimit(key: string, cap: number): number {
    const normalizedCap = normalizeCap(cap)
    const state = this.stateFor(key)
    state.effectiveLimit = clamp(state.effectiveLimit, 1, normalizedCap)
    return state.effectiveLimit
  }

  recordSuccess(key: string, cap: number): AdaptiveConcurrencySnapshot {
    const normalizedCap = normalizeCap(cap)
    const state = this.stateFor(key)
    state.effectiveLimit = clamp(state.effectiveLimit, 1, normalizedCap)
    if (this.now() < state.cooldownUntil) {
      return this.snapshot(key, normalizedCap, state)
    }
    state.consecutiveSuccesses += 1
    if (state.consecutiveSuccesses >= this.increaseAfterSuccess) {
      state.effectiveLimit = Math.min(normalizedCap, state.effectiveLimit + 1)
      state.consecutiveSuccesses = 0
    }
    return this.snapshot(key, normalizedCap, state)
  }

  recordRateLimit(key: string, cap: number): AdaptiveConcurrencySnapshot {
    const normalizedCap = normalizeCap(cap)
    const state = this.stateFor(key)
    state.effectiveLimit = Math.max(1, Math.floor(clamp(state.effectiveLimit, 1, normalizedCap) / 2))
    state.consecutiveSuccesses = 0
    state.cooldownUntil = this.now() + this.cooldownMs
    return this.snapshot(key, normalizedCap, state)
  }

  reset(): void {
    this.states.clear()
  }

  snapshotForTesting(key: string, cap: number): AdaptiveConcurrencySnapshot {
    const normalizedCap = normalizeCap(cap)
    return this.snapshot(key, normalizedCap, this.stateFor(key))
  }

  private stateFor(key: string): AdaptiveState {
    const existing = this.states.get(key)
    if (existing) return existing
    const created: AdaptiveState = {
      effectiveLimit: 1,
      consecutiveSuccesses: 0,
      cooldownUntil: 0,
    }
    this.states.set(key, created)
    return created
  }

  private snapshot(key: string, cap: number, state: AdaptiveState): AdaptiveConcurrencySnapshot {
    return {
      key,
      cap,
      effectiveLimit: clamp(state.effectiveLimit, 1, cap),
      consecutiveSuccesses: state.consecutiveSuccesses,
      cooldownUntil: state.cooldownUntil,
    }
  }
}

class RetryBudgetLedger {
  private readonly entries = new Map<string, number[]>()

  tryConsume(key: string, now: number, windowMs: number, limit: number): boolean {
    const normalizedLimit = positiveInt(limit, DEFAULT_RETRY_BUDGET_LIMIT)
    const normalizedWindow = positiveInt(windowMs, DEFAULT_RETRY_BUDGET_WINDOW_MS)
    const cutoff = now - normalizedWindow
    const retained = (this.entries.get(key) ?? []).filter((ts) => ts >= cutoff)
    if (retained.length >= normalizedLimit) {
      this.entries.set(key, retained)
      return false
    }
    retained.push(now)
    this.entries.set(key, retained)
    return true
  }

  reset(): void {
    this.entries.clear()
  }
}

const adaptiveController = new AdaptiveConcurrencyController()
const retryBudgetLedger = new RetryBudgetLedger()

export function isAdaptiveAgentConcurrencyEnabled(): boolean {
  return truthyEnv(process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'])
}

export function resolveAgentConcurrencyCap(): number {
  return positiveInt(process.env['OWLCODA_AGENT_MAX_CONCURRENCY'], DEFAULT_CAP)
}

export function resolveAdaptiveAgentLimit(key: string, cap = resolveAgentConcurrencyCap()): number {
  // Adaptive concurrency now adapts at the daemon (cross-process admission gate,
  // src/endpoints/admission.ts). The client semaphore is a STATIC per-process
  // ceiling so the two control loops don't fight — see the cross-process
  // coordinator spec §4.5. (`key` retained for signature/back-compat.)
  void key
  return normalizeCap(cap)
}

export function recordAdaptiveSuccess(key: string, cap = resolveAgentConcurrencyCap()): void {
  if (!isAdaptiveAgentConcurrencyEnabled()) return
  adaptiveController.recordSuccess(key, cap)
}

export function recordAdaptiveRateLimit(key: string, cap = resolveAgentConcurrencyCap()): void {
  if (!isAdaptiveAgentConcurrencyEnabled()) return
  adaptiveController.recordRateLimit(key, cap)
}

export function adaptiveConcurrencyKeyFromApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim()
  if (!trimmed) return 'unknown'
  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1\/messages$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\/v1\/messages$/, '')
  }
}

export function diagnosticLooksLikeRateLimit(diagnostic: ProviderRequestDiagnostic | null | undefined): boolean {
  if (!diagnostic) return false
  return diagnostic.status === 429 || detailLooksLikeRateLimit(diagnostic.detail)
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const seconds = Number.parseFloat(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now)
  }
  return null
}

export function computeRequestRetryDelayMs(opts: {
  attempt: number
  status?: number
  detail?: string
  retryAfterHeader?: string | null
  adaptive?: boolean
  now?: number
  random?: () => number
}): number {
  const isRateLimit = opts.status === 429 || detailLooksLikeRateLimit(opts.detail)
  const base = isRateLimit ? 5_000 : 1_000
  const raw = Math.min(base * Math.pow(2, opts.attempt), 30_000)
  let delay = raw
  if (isRateLimit) {
    const jitterWidth = opts.adaptive ? 1.0 : 0.5
    const min = 1 - jitterWidth / 2
    const factor = min + (opts.random ?? Math.random)() * jitterWidth
    delay = Math.round(raw * factor)
  }
  const retryAfterMs = parseRetryAfterMs(opts.retryAfterHeader, opts.now)
  if (retryAfterMs !== null) {
    delay = Math.max(delay, retryAfterMs)
  }
  return delay
}

export function requestAutoRetryLimit(retryable: boolean, kind: string | undefined): number {
  if (!retryable) return 0
  if (kind === 'timeout') return 0
  if (kind === 'stream_interrupted_before_first_token') return 0
  return isAdaptiveAgentConcurrencyEnabled() ? 3 : 1
}

export function tryConsumeAdaptiveRetryBudget(key: string): boolean {
  if (!isAdaptiveAgentConcurrencyEnabled()) return true
  return retryBudgetLedger.tryConsume(
    key,
    Date.now(),
    positiveInt(process.env['OWLCODA_AGENT_RETRY_BUDGET_WINDOW_MS'], DEFAULT_RETRY_BUDGET_WINDOW_MS),
    positiveInt(process.env['OWLCODA_AGENT_RETRY_BUDGET_PER_WINDOW'], DEFAULT_RETRY_BUDGET_LIMIT),
  )
}

export function __resetAdaptiveConcurrencyForTesting(): void {
  adaptiveController.reset()
  retryBudgetLedger.reset()
}

export function __getAdaptiveConcurrencySnapshotForTesting(key: string, cap = resolveAgentConcurrencyCap()): AdaptiveConcurrencySnapshot {
  return adaptiveController.snapshotForTesting(key, cap)
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function normalizeCap(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CAP
  return Math.floor(value)
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
