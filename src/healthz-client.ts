/**
 * Healthz client — types and functions for probing OwlCoda daemon health.
 * Extracted from cli-core.ts for modularity.
 */

import { get as httpGet } from 'node:http'

// ─── Types ───

export interface HealthzResponse {
  status: string
  version: string
  pid: number
  runtimeToken: string | null
  host: string
  port: number
  routerUrl: string
}

// ─── Host resolution ───

export function resolveClientHost(bindHost: string): string {
  const wildcards = ['0.0.0.0', '::', ':::', '']
  if (wildcards.includes(bindHost)) return '127.0.0.1'
  return bindHost
}

// ─── Health matching ───

export function healthzMatchesConfig(healthz: HealthzResponse, config: { port: number; routerUrl: string; host: string }): boolean {
  if (healthz.port !== config.port) return false
  if (healthz.routerUrl !== config.routerUrl) return false
  const healthzClient = resolveClientHost(healthz.host)
  const configClient = resolveClientHost(config.host)
  if (healthzClient !== configClient) return false
  return true
}

export interface RuntimeMetaLike {
  pid: number
  runtimeToken: string
  host: string
  port: number
  routerUrl: string
}

export function healthzMatchesRuntimeMeta(healthz: HealthzResponse, meta: RuntimeMetaLike): boolean {
  // Status check is about identity, not health — accept any valid status
  const validStatuses = ['ok', 'healthy', 'degraded', 'unhealthy']
  if (!validStatuses.includes(healthz.status)) return false
  if (healthz.pid !== meta.pid) return false
  if (healthz.runtimeToken !== meta.runtimeToken) return false
  if (healthz.port !== meta.port) return false
  if (healthz.routerUrl !== meta.routerUrl) return false
  return resolveClientHost(healthz.host) === resolveClientHost(meta.host)
}

// ─── Healthz HTTP client ───

export function fetchHealthz(baseUrl: string, timeoutMs: number = 2000): Promise<HealthzResponse | null> {
  return new Promise(resolve => {
    const url = `${baseUrl}/healthz`
    let req: ReturnType<typeof httpGet>
    try {
      req = httpGet(url, res => {
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
): Promise<HealthzResponse | null> {
  const start = Date.now()
  while (Date.now() - start <= timeoutMs) {
    const healthz = await fetchHealthz(baseUrl, 500)
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
