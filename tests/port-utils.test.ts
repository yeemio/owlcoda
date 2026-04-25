import { describe, it, expect } from 'vitest'
import { isPortAvailable, findAvailablePort, checkPorts } from '../src/port-utils.js'
import * as net from 'node:net'

describe('port-utils', () => {
  it('isPortAvailable returns true for unused port', async () => {
    // Use a high random port unlikely to be in use
    const port = 49152 + Math.floor(Math.random() * 10000)
    const available = await isPortAvailable(port)
    expect(available).toBe(true)
  })

  it('isPortAvailable returns false for occupied port', async () => {
    // Occupy a port
    const server = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('No address'))
      })
    })

    try {
      const available = await isPortAvailable(port)
      expect(available).toBe(false)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('findAvailablePort skips occupied ports', async () => {
    // Occupy a port
    const server = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('No address'))
      })
    })

    try {
      const found = await findAvailablePort(port)
      expect(found).toBeGreaterThan(port)
      expect(found).toBeLessThanOrEqual(port + 10)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('findAvailablePort returns preferred if available', async () => {
    const port = 49152 + Math.floor(Math.random() * 10000)
    const found = await findAvailablePort(port)
    expect(found).toBe(port)
  })

  it('checkPorts reports proxy and router status', async () => {
    const result = await checkPorts({
      port: 49999,
      routerUrl: 'http://127.0.0.1:49998',
    })
    expect(result.proxyPort).toBe(49999)
    expect(typeof result.proxyAvailable).toBe('boolean')
    expect(result.routerPort).toBe(49998)
    expect(typeof result.routerAvailable).toBe('boolean')
  })

  it('checkPorts handles invalid URL', async () => {
    const result = await checkPorts({
      port: 49999,
      routerUrl: 'not-a-url',
    })
    expect(result.routerPort).toBeNull()
    expect(result.routerAvailable).toBeNull()
  })
})
