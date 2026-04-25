/**
 * Port utilities — find available ports, detect conflicts.
 */

import * as net from 'node:net'

/**
 * Check if a port is available (not in use).
 */
export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/**
 * Find an available port starting from `preferred`, incrementing if busy.
 */
export async function findAvailablePort(preferred: number, host = '127.0.0.1', maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferred + i
    if (await isPortAvailable(port, host)) {
      return port
    }
  }
  throw new Error(`No available port found in range ${preferred}-${preferred + maxAttempts - 1}`)
}

/**
 * Get port usage info for diagnostics.
 */
export async function checkPorts(config: { port: number; routerUrl: string }): Promise<{
  proxyPort: number
  proxyAvailable: boolean
  routerPort: number | null
  routerAvailable: boolean | null
}> {
  const proxyAvailable = await isPortAvailable(config.port)

  let routerPort: number | null = null
  let routerAvailable: boolean | null = null
  try {
    const url = new URL(config.routerUrl)
    routerPort = parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80)
    // For the router, we check if something IS listening (we want it to be in use)
    routerAvailable = !(await isPortAvailable(routerPort))
  } catch {
    // Invalid URL
  }

  return { proxyPort: config.port, proxyAvailable, routerPort, routerAvailable }
}
