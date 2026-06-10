/**
 * Minimal session state for admin writes.
 *
 * Phase γ: browser arrives at /admin/?token=<ots>.
 * On boot we exchange the one-shot token for an httpOnly session cookie and
 * receive a CSRF token in the response body. We keep the CSRF token in memory
 * (never localStorage — avoids XSS-exfiltration surface) and include it on
 * every write via the X-OwlCoda-Token header.
 *
 * If there's no ?token= in the URL (dev with Bearer proxy, or the user
 * reloaded after first handoff), bootstrap is a no-op; writes still work when
 * the dev proxy injects a Bearer auth header.
 */

import { ADMIN_API_SCHEMA_VERSION } from '../api/types'

const EXCHANGE_PATH = '/admin/api/auth/exchange'

let csrfToken: string | null = null

export function getCsrfToken(): string | null {
  return csrfToken
}

/** Test-only setter — production code uses bootstrapAuth(). */
export function __setCsrfTokenForTests(value: string | null): void {
  csrfToken = value
}

export function __resetAuthForTests(): void {
  csrfToken = null
}

export interface BootstrapOptions {
  /** Override location.search for tests (e.g. "?token=ots1.abc"). */
  search?: string
  /** Override the URL-clearing side effect for tests. */
  onClearUrl?: () => void
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
}

export async function bootstrapAuth(opts: BootstrapOptions = {}): Promise<{ ok: boolean; reason?: string }> {
  const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const params = new URLSearchParams(search)
  const oneShot = params.get('token')
  if (!oneShot) {
    return { ok: false, reason: 'no one-shot token in URL' }
  }

  const fetchImpl = opts.fetchImpl ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch)

  try {
    const res = await fetchImpl(EXCHANGE_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: oneShot }),
    })
    const bodyText = await res.text()
    const body = bodyText ? JSON.parse(bodyText) : null
    if (!res.ok || !body || body.ok !== true || typeof body.csrfToken !== 'string') {
      return { ok: false, reason: body?.error?.message ?? `HTTP ${res.status}` }
    }
    if (typeof body.schemaVersion === 'number' && body.schemaVersion !== ADMIN_API_SCHEMA_VERSION) {
      return { ok: false, reason: `schemaVersion mismatch: ${body.schemaVersion}` }
    }
    csrfToken = body.csrfToken

    // Clear the one-shot token from the URL so a copy/paste or refresh doesn't
    // leak it. Preserve the hash so the user stays on the same view.
    if (opts.onClearUrl) {
      opts.onClearUrl()
    } else if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      const hash = window.location.hash
      const clean = window.location.pathname + hash
      window.history.replaceState({}, '', clean)
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
