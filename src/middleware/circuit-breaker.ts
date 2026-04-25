/**
 * Circuit breaker — auto-disable models that fail repeatedly.
 * States: closed (normal), open (blocked), half-open (allow one probe).
 */

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitStatus {
  state: CircuitState
  failures: number
  lastFailure: number
  openedAt: number
}

const circuits = new Map<string, CircuitStatus>()

let threshold = 5
let cooldownMs = 60_000

export function configureCircuitBreaker(opts: { threshold?: number; cooldownMs?: number }): void {
  if (opts.threshold !== undefined) threshold = opts.threshold
  if (opts.cooldownMs !== undefined) cooldownMs = opts.cooldownMs
}

function getOrCreate(model: string): CircuitStatus {
  let s = circuits.get(model)
  if (!s) {
    s = { state: 'closed', failures: 0, lastFailure: 0, openedAt: 0 }
    circuits.set(model, s)
  }
  return s
}

export function recordSuccess(model: string): void {
  const s = getOrCreate(model)
  s.failures = 0
  s.state = 'closed'
}

export function recordFailure(model: string): void {
  const s = getOrCreate(model)
  s.failures++
  s.lastFailure = Date.now()

  if (s.failures >= threshold && s.state === 'closed') {
    s.state = 'open'
    s.openedAt = Date.now()
    console.error(`[circuit] ${model} circuit OPENED after ${s.failures} failures`)
  }
}

export function isCircuitOpen(model: string): boolean {
  const s = circuits.get(model)
  if (!s) return false

  if (s.state === 'open') {
    // Check if cooldown has elapsed → transition to half-open
    if (Date.now() - s.openedAt >= cooldownMs) {
      s.state = 'half-open'
      console.error(`[circuit] ${model} circuit HALF-OPEN — allowing probe request`)
      return false // Allow one request through
    }
    return true
  }

  return false
}

export function getCircuitState(model: string): CircuitStatus {
  return circuits.get(model) ?? { state: 'closed', failures: 0, lastFailure: 0, openedAt: 0 }
}

export function getAllCircuitStates(): Record<string, CircuitStatus> {
  return Object.fromEntries(circuits)
}

export function resetCircuitBreaker(): void {
  circuits.clear()
  threshold = 5
  cooldownMs = 60_000
}
