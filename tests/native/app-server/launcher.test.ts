import { describe, expect, it } from 'vitest'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'
import { launchAppServer } from '../../../src/native/app-server/launcher.js'

describe('app-server launcher', () => {
  it('discovers a running App Server and returns it without owning the process', async () => {
    const existing = createAppServer()
    await listenAppServer(existing, { host: '127.0.0.1', port: 0 })
    const address = existing.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const result = await launchAppServer({ port })

    expect(result.url).toBe(`http://127.0.0.1:${port}`)
    expect(result.port).toBe(port)
    expect(result.ownsProcess).toBe(false)
    expect(result.server).toBeUndefined()

    // stop should be a no-op because we didn't start it
    await expect(result.stop()).resolves.toBeUndefined()

    existing.close()
  })

  it('starts a new App Server when none is running and owns the process', async () => {
    const result = await launchAppServer({ port: 0 })

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.port).toBeGreaterThan(0)
    expect(result.ownsProcess).toBe(true)
    expect(result.server).toBeDefined()

    // Verify it's actually reachable
    const health = await fetch(`${result.url}/healthz`)
    expect(health.ok).toBe(true)

    await result.stop()
  })

  it('stop closes a self-started server', async () => {
    const result = await launchAppServer({ port: 0 })
    expect(result.ownsProcess).toBe(true)

    await result.stop()

    // After stop, healthz should fail
    await expect(
      fetch(`${result.url}/healthz`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow()
  })
})
