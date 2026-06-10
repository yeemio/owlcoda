// Minimal bootstrap/state for Ink fork scroll support.
// Only exports what ScrollBox.tsx and ink.tsx actually call.

let _lastScrollActivity = 0

export function markScrollActivity(): void {
  _lastScrollActivity = Date.now()
}

export function getLastScrollActivity(): number {
  return _lastScrollActivity
}

export function flushInteractionTime(): void {
  // No-op in OwlCoda — upstream uses this for telemetry
}

export function updateLastInteractionTime(): void {
  // No-op in OwlCoda
}
