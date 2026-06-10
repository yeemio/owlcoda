/**
 * In-memory per-endpoint health/latency cache.
 *
 * The Model Connection Layer probes endpoints when users add or test them in
 * Admin, and later wants to display "this endpoint was healthy 30 seconds ago,
 * latency 120ms" without re-probing on every render. This cache stores the
 * most recent sample per endpoint URL and expires entries after a TTL.
 *
 * Scope is intentionally narrow: single process, no persistence, no aggregation
 * across history. Persistence and trend metrics belong to a separate observer.
 */

export interface EndpointHealthSample {
  endpoint: string
  ok: boolean
  latencyMs: number
  status?: number
  detail: string
  credentialSource?: 'env' | 'config' | 'unset'
  observedAt: number
}

export interface EndpointHealthCacheOptions {
  ttlMs?: number
}

const DEFAULT_TTL_MS = 60_000

export class EndpointHealthCache {
  private readonly samples = new Map<string, EndpointHealthSample>()
  private readonly ttlMs: number

  constructor(options: EndpointHealthCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  record(sample: EndpointHealthSample): void {
    if (!sample.endpoint) return
    this.samples.set(sample.endpoint, sample)
  }

  get(endpoint: string, now: number = Date.now()): EndpointHealthSample | undefined {
    const sample = this.samples.get(endpoint)
    if (!sample) return undefined
    if (now - sample.observedAt > this.ttlMs) {
      this.samples.delete(endpoint)
      return undefined
    }
    return sample
  }

  list(now: number = Date.now()): EndpointHealthSample[] {
    const fresh: EndpointHealthSample[] = []
    for (const sample of this.samples.values()) {
      if (now - sample.observedAt <= this.ttlMs) fresh.push(sample)
    }
    return fresh
  }

  size(now: number = Date.now()): number {
    return this.list(now).length
  }

  clear(): void {
    this.samples.clear()
  }
}

/**
 * Build a cache sample from a ProviderProbeResult-shaped object. Probe callers
 * use this to push results into the cache without coupling to the cache type.
 */
export function sampleFromProbeResult(
  endpoint: string,
  result: {
    ok: boolean
    latencyMs: number
    status?: number
    detail: string
    credentialSource?: 'env' | 'config' | 'unset'
  },
  now: number = Date.now(),
): EndpointHealthSample {
  return {
    endpoint,
    ok: result.ok,
    latencyMs: result.latencyMs,
    status: result.status,
    detail: result.detail,
    credentialSource: result.credentialSource,
    observedAt: now,
  }
}
