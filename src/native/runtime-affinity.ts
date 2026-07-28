import type { HealthzResponse, RuntimeMetaLike } from '../healthz-client.js'
import { healthzMatchesRuntimeMeta, resolveClientHost } from '../healthz-client.js'

export type RuntimeBindingStatusKind =
  | 'healthy'
  | 'proxy_changed'
  | 'daemon_unavailable'

export interface RuntimeBindingAssessment {
  kind: RuntimeBindingStatusKind
  summary: string
  detail: string
}

function formatBaseUrl(binding: Pick<RuntimeMetaLike, 'host' | 'port'>): string {
  return `http://${resolveClientHost(binding.host)}:${binding.port}`
}

export function classifyRuntimeBinding(
  expected: RuntimeMetaLike,
  observedHealthz: HealthzResponse | null,
  runtimeMeta: RuntimeMetaLike | null,
): RuntimeBindingAssessment {
  if (observedHealthz && healthzMatchesRuntimeMeta(observedHealthz, expected)) {
    return {
      kind: 'healthy',
      summary: 'Proxy healthy',
      detail: `Bound to ${formatBaseUrl(expected)} (PID ${expected.pid}).`,
    }
  }

  if (observedHealthz) {
    const observedLocation = typeof observedHealthz.host === 'string' && typeof observedHealthz.port === 'number'
      ? formatBaseUrl({ host: observedHealthz.host, port: observedHealthz.port })
      : 'the public health endpoint'
    const observedPid = typeof observedHealthz.pid === 'number' ? String(observedHealthz.pid) : 'unavailable'
    return {
      kind: 'proxy_changed',
      summary: 'Proxy changed',
      detail: `Expected ${formatBaseUrl(expected)} PID ${expected.pid}, found PID ${observedPid} at ${observedLocation}.`,
    }
  }

  if (
    runtimeMeta
    && (
      runtimeMeta.pid !== expected.pid
      || runtimeMeta.runtimeToken !== expected.runtimeToken
      || runtimeMeta.port !== expected.port
      || runtimeMeta.routerUrl !== expected.routerUrl
      || resolveClientHost(runtimeMeta.host) !== resolveClientHost(expected.host)
    )
  ) {
    return {
      kind: 'proxy_changed',
      summary: 'Proxy changed',
      detail: `Session state now points to ${formatBaseUrl(runtimeMeta)} (PID ${runtimeMeta.pid}) instead of ${formatBaseUrl(expected)}.`,
    }
  }

  return {
    kind: 'daemon_unavailable',
    summary: 'Daemon unavailable',
    detail: `Proxy at ${formatBaseUrl(expected)} is unreachable.`,
  }
}
