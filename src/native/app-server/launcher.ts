import type { Server } from 'node:http'
import { createAppServer, listenAppServer } from './http-server.js'
import type { MethodRegistryOptions } from './methods.js'

export interface AppServerLauncherOptions {
  port?: number
  host?: string
  config?: MethodRegistryOptions['config']
  loopModelId?: MethodRegistryOptions['loopModelId']
}

export interface AppServerLauncherResult {
  url: string
  port: number
  server?: Server
  ownsProcess: boolean
  stop(): Promise<void>
}

const DEFAULT_PORT = 6199
const DEFAULT_HOST = '127.0.0.1'
const DISCOVERY_TIMEOUT_MS = 2000

export async function launchAppServer(options: AppServerLauncherOptions = {}): Promise<AppServerLauncherResult> {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  const url = `http://${host}:${port}`

  const existing = await discoverRunningAppServer(url)
  if (existing) {
    return {
      url: existing.url,
      port: existing.port,
      ownsProcess: false,
      stop: async () => { /* no-op: we did not start it */ },
    }
  }

  const server = createAppServer({
    config: options.config,
    loopModelId: options.loopModelId,
  })
  await listenAppServer(server, { host, port })
  const actualAddress = server.address()
  const actualPort = typeof actualAddress === 'object' && actualAddress ? actualAddress.port : port
  const actualUrl = `http://${host}:${actualPort}`

  return {
    url: actualUrl,
    port: actualPort,
    server,
    ownsProcess: true,
    stop: () => new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    }),
  }
}

async function discoverRunningAppServer(url: string): Promise<{ url: string; port: number } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)

  try {
    const response = await fetch(`${url}/healthz`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (response.ok) {
      return { url, port: Number(new URL(url).port) }
    }
    return null
  } catch {
    clearTimeout(timeout)
    return null
  }
}
