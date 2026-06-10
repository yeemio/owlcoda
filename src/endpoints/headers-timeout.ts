/**
 * Streaming headers-timeout budget.
 *
 * The streaming upstream fetch arms a fail-fast timer that aborts only while
 * waiting for the response *headers* (it is cleared the moment a Response
 * arrives — the body stream's deadline then belongs to the first-token
 * watchdog + per-chunk idle guard in handleMessagesStream). A flat 30s budget
 * is correct for cloud (catch a stuck connect quickly) but too tight for a
 * loopback runtime: a small local model fed a large agent tool payload can
 * spend 30–60s on CPU prefill before emitting the first byte, so the guard
 * fires spuriously and the fallback chain escalates to a heavier model
 * (Issue #2 dogfood). Loopback endpoints therefore get a longer budget,
 * capped by the request's own timeout; everything else keeps the 30s default.
 */

/** Fail-fast budget for cloud / non-loopback upstreams. */
export const CLOUD_HEADERS_TIMEOUT_MS = 30_000

/** Opt-in env override for the cloud headers budget. */
export const CLOUD_HEADERS_TIMEOUT_ENV = 'OWLCODA_CLOUD_HEADERS_TIMEOUT_MS'

/** Headers budget for loopback runtimes — room for slow local CPU prefill. */
export const LOCAL_HEADERS_TIMEOUT_MS = 120_000

/**
 * Resolve the cloud headers budget from the environment.
 *
 * The 30s default is a fail-fast for a stuck connect and is right for the
 * common case (most cloud models stream headers in <5s). But a slow cloud
 * *reasoning* model (kimi-code / mimo on a non-streaming REPL turn) can take
 * 30–210s to produce its first byte; the 30s guard then fires spuriously and
 * the fallback chain churns through other models (observed: "kimi headers
 * timeout after 30000ms, trying next model"). A maintainer running a known-slow
 * cloud model raises this; unset/empty/invalid keeps the 30s default unchanged.
 */
export function readCloudHeadersTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[CLOUD_HEADERS_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return CLOUD_HEADERS_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return CLOUD_HEADERS_TIMEOUT_MS
  return Math.floor(parsed)
}

/** True when the endpoint host is a loopback address (a local runtime). */
export function isLoopbackEndpoint(endpointUrl: string): boolean {
  try {
    const { hostname } = new URL(endpointUrl)
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

/**
 * Resolve the headers-phase timeout for a streaming upstream fetch.
 *
 * - Loopback endpoint → min(LOCAL_HEADERS_TIMEOUT_MS, routeTimeoutMs): a longer
 *   budget for slow local prefill, but never beyond the request's own timeout.
 *   The cloud override does not apply — loopback already has its own budget.
 * - Otherwise → cloudHeadersTimeoutMs if supplied (the opt-in override from
 *   readCloudHeadersTimeoutMsFromEnv), else CLOUD_HEADERS_TIMEOUT_MS (the
 *   unchanged 30s fail-fast). The outer request signal still bounds the wait,
 *   so an override longer than the route timeout can never overrun the request.
 */
export function resolveHeadersTimeoutMs(opts: {
  endpointUrl: string
  routeTimeoutMs: number
  cloudHeadersTimeoutMs?: number
}): number {
  if (isLoopbackEndpoint(opts.endpointUrl)) {
    return Math.min(LOCAL_HEADERS_TIMEOUT_MS, Math.max(0, opts.routeTimeoutMs))
  }
  return opts.cloudHeadersTimeoutMs ?? CLOUD_HEADERS_TIMEOUT_MS
}
