/**
 * Healthz client — types and functions for probing OwlCoda daemon health.
 * Extracted from cli-core.ts for modularity.
 */

import { createHash } from 'node:crypto'
import { get as httpGet } from 'node:http'

// ─── Types ───

export interface HealthzResponse {
  status: string
  version: string
  pid?: number
  /**
   * Legacy daemons echoed the raw runtime token. New daemons never do; the
   * optional field remains client-side only so an upgraded CLI can retire a
   * stale pre-fix daemon safely.
   */
  runtimeToken?: string | null
  runtimeTokenFingerprint?: string
  host?: string
  port?: number
  routerUrl?: string
  configFingerprint?: string
}

// ─── Host resolution ───

export function resolveClientHost(bindHost: string): string {
  const wildcards = ['0.0.0.0', '::', ':::', '']
  if (wildcards.includes(bindHost)) return '127.0.0.1'
  return bindHost
}

// ─── Health matching ───

export interface HealthzConfigIdentity {
  port: number
  routerUrl: string
  host: string
  localRuntimeProtocol?: string
  responseModelStyle?: string
  models?: Array<{
    id?: string
    backendModel?: string
    endpoint?: string
    apiKey?: unknown
    apiKeyEnv?: string
    default?: boolean
    aliases?: string[]
  }>
}

export function configIdentityFingerprint(config: HealthzConfigIdentity): string {
  const identity = {
    host: resolveClientHost(config.host),
    port: config.port,
    routerUrl: config.routerUrl,
    localRuntimeProtocol: config.localRuntimeProtocol ?? 'auto',
    responseModelStyle: config.responseModelStyle ?? 'platform',
    models: (config.models ?? []).map(model => ({
      id: model.id ?? '',
      backendModel: model.backendModel ?? '',
      endpoint: model.endpoint ?? '',
      apiKeySet: Boolean(model.apiKey),
      apiKeyEnv: model.apiKeyEnv ?? '',
      default: model.default === true,
      aliases: [...(model.aliases ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)
}

export function runtimeTokenFingerprint(runtimeToken: string): string {
  return `sha256:${createHash('sha256').update(runtimeToken).digest('hex')}`
}

export function healthzMatchesConfig(
  healthz: HealthzResponse,
  config: HealthzConfigIdentity,
  options: { requireConfigFingerprint?: boolean } = {},
): boolean {
  if (typeof healthz.port !== 'number' || typeof healthz.routerUrl !== 'string' || typeof healthz.host !== 'string') {
    return false
  }
  if (healthz.port !== config.port) return false
  if (healthz.routerUrl !== config.routerUrl) return false
  const healthzClient = resolveClientHost(healthz.host)
  const configClient = resolveClientHost(config.host)
  if (healthzClient !== configClient) return false
  if (options.requireConfigFingerprint) {
    return healthz.configFingerprint === configIdentityFingerprint(config)
  }
  return true
}

export interface RuntimeMetaLike {
  pid: number
  runtimeToken: string
  host: string
  port: number
  routerUrl: string
}

export type HealthzRuntimeIdentityMatch = 'fingerprint' | 'legacy_raw' | 'mismatch'

export function classifyHealthzRuntimeIdentity(
  healthz: HealthzResponse,
  meta: RuntimeMetaLike,
): HealthzRuntimeIdentityMatch {
  // Status check is about identity, not health — accept any valid status
  const validStatuses = ['ok', 'healthy', 'degraded', 'unhealthy']
  if (!validStatuses.includes(healthz.status)) return 'mismatch'
  if (
    typeof healthz.pid !== 'number'
    || typeof healthz.port !== 'number'
    || typeof healthz.routerUrl !== 'string'
    || typeof healthz.host !== 'string'
  ) return 'mismatch'
  if (healthz.pid !== meta.pid) return 'mismatch'
  if (healthz.port !== meta.port) return 'mismatch'
  if (healthz.routerUrl !== meta.routerUrl) return 'mismatch'
  if (resolveClientHost(healthz.host) !== resolveClientHost(meta.host)) return 'mismatch'
  if (
    healthz.runtimeToken === undefined
    && healthz.runtimeTokenFingerprint === runtimeTokenFingerprint(meta.runtimeToken)
  ) {
    return 'fingerprint'
  }
  if (healthz.runtimeTokenFingerprint === undefined && healthz.runtimeToken === meta.runtimeToken) {
    return 'legacy_raw'
  }
  return 'mismatch'
}

export function healthzMatchesRuntimeMeta(healthz: HealthzResponse, meta: RuntimeMetaLike): boolean {
  return classifyHealthzRuntimeIdentity(healthz, meta) === 'fingerprint'
}

export function healthzIdentifiesRuntimeMetaForRetirement(
  healthz: HealthzResponse,
  meta: RuntimeMetaLike,
): boolean {
  return classifyHealthzRuntimeIdentity(healthz, meta) !== 'mismatch'
}

// ─── Healthz HTTP client ───

export function fetchHealthz(
  baseUrl: string,
  timeoutMs: number = 2000,
  runtimeToken?: string,
): Promise<HealthzResponse | null> {
  return new Promise(resolve => {
    const url = `${baseUrl}/healthz`
    let req: ReturnType<typeof httpGet>
    try {
      req = httpGet(url, runtimeToken
        ? { headers: { Authorization: `Bearer ${runtimeToken}` } }
        : {}, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            resolve(body as HealthzResponse)
          } catch {
            resolve(null)
          }
        })
      })
    } catch {
      resolve(null)
      return
    }
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

// ─── Healthz waiters ───

export async function waitForVerifiedHealthz(
  baseUrl: string,
  matcher: (healthz: HealthzResponse) => boolean,
  timeoutMs: number = 5000,
  runtimeToken?: string | (() => string | undefined),
): Promise<HealthzResponse | null> {
  const start = Date.now()
  while (Date.now() - start <= timeoutMs) {
    const token = typeof runtimeToken === 'function' ? runtimeToken() : runtimeToken
    const healthz = await fetchHealthz(baseUrl, 500, token)
    if (healthz && matcher(healthz)) return healthz
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return null
}

export function waitForHealthzGone(baseUrl: string, timeoutMs: number = 3000): Promise<boolean> {
  const start = Date.now()
  return new Promise(resolve => {
    const check = () => {
      let req: ReturnType<typeof httpGet>
      try {
        req = httpGet(`${baseUrl}/healthz`, _res => {
          _res.resume()
          if (Date.now() - start > timeoutMs) {
            resolve(false)
          } else {
            setTimeout(check, 150)
          }
        })
      } catch {
        resolve(true)
        return
      }
      req.on('error', () => {
        resolve(true)
      })
      req.setTimeout(500, () => { req.destroy() })
    }
    check()
  })
}
