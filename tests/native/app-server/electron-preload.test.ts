import { describe, expect, it } from 'vitest'
import {
  installOwlCodaAppServerPreload,
  type OwlCodaAppServerPreloadAPI,
} from '../../../src/native/app-server/electron-preload.js'

describe('electron-preload contract', () => {
  it('defines the expected preload API shape', () => {
    // Compile-time type check: the interface should have getUrl returning Promise<string>
    const api: OwlCodaAppServerPreloadAPI = {
      getUrl: async () => 'http://127.0.0.1:6199',
    }
    expect(api).toBeDefined()
    expect(typeof api.getUrl).toBe('function')
  })

  it('accepts a mock global window.owlcodaAppServer', async () => {
    const mockApi: OwlCodaAppServerPreloadAPI = {
      getUrl: async () => 'http://127.0.0.1:6199',
    }

    const url = await mockApi.getUrl()
    expect(url).toBe('http://127.0.0.1:6199')
  })

  it('installs the preload API through Electron contextBridge and ipcRenderer', async () => {
    const exposed: Record<string, OwlCodaAppServerPreloadAPI> = {}
    const contextBridge = {
      exposeInMainWorld(name: string, api: OwlCodaAppServerPreloadAPI) {
        exposed[name] = api
      },
    }
    const ipcRenderer = {
      invoke: async (channel: string) => {
        expect(channel).toBe('owlcoda-app-server:get-url')
        return 'http://127.0.0.1:6199'
      },
    }

    installOwlCodaAppServerPreload(contextBridge, ipcRenderer)

    expect(Object.keys(exposed)).toEqual(['owlcodaAppServer'])
    await expect(exposed['owlcodaAppServer']!.getUrl()).resolves.toBe('http://127.0.0.1:6199')
  })
})
