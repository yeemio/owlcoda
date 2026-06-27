import { describe, expect, it } from 'vitest'
import {
  createOwlCodaDesktopWindow,
  launchOrAttachAppServer,
} from '../../../src/native/app-server/electron-main.js'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'

describe('electron-main adapter', () => {
  it('attaches to a running App Server and returns it without owning the process', async () => {
    const existing = createAppServer()
    await listenAppServer(existing, { host: '127.0.0.1', port: 0 })
    const address = existing.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const result = await launchOrAttachAppServer({ port })

    expect(result.url).toBe(`http://127.0.0.1:${port}`)
    expect(result.desktopUrl).toBe(`http://127.0.0.1:${port}/desktop`)
    expect(result.port).toBe(port)
    expect(result.ownsProcess).toBe(false)
    await expect(result.stop()).resolves.toBeUndefined()

    existing.close()
  })

  it('launches a new App Server when none is running and owns the process', async () => {
    const result = await launchOrAttachAppServer({ port: 0 })

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.desktopUrl).toBe(`${result.url}/desktop`)
    expect(result.port).toBeGreaterThan(0)
    expect(result.ownsProcess).toBe(true)

    const health = await fetch(`${result.url}/healthz`)
    expect(health.ok).toBe(true)

    await result.stop()
  })

  it('stop closes a self-launched server', async () => {
    const result = await launchOrAttachAppServer({ port: 0 })
    expect(result.ownsProcess).toBe(true)

    await result.stop()

    await expect(
      fetch(`${result.url}/healthz`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow()
  })

  it('creates a desktop shell window that loads the App Server renderer', async () => {
    const loadedUrls: string[] = []
    const handledChannels: string[] = []
    const fakeElectron = {
      BrowserWindow: class {
        readonly options: unknown

        constructor(options: unknown) {
          this.options = options
        }

        async loadURL(url: string): Promise<void> {
          loadedUrls.push(url)
        }
      },
      ipcMain: {
        handle(channel: string, handler: () => string) {
          handledChannels.push(channel)
          expect(handler()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        },
      },
    }

    const result = await createOwlCodaDesktopWindow(fakeElectron, { port: 0 })

    expect(result.desktopUrl).toBe(`${result.appServer.url}/desktop`)
    expect(loadedUrls).toEqual([result.desktopUrl])
    expect(handledChannels).toContain('owlcoda-app-server:get-url')
    expect(result.window).toBeDefined()

    await result.stop()
  })
})
