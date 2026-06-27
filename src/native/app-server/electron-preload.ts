import { OWLCODA_APP_SERVER_URL_CHANNEL } from './electron-ipc.js'

/** Preload IPC contract for OwlCoda App Server URL.
 *  Electron preload should expose this shape on `window.owlcodaAppServer`. */
export interface OwlCodaAppServerPreloadAPI {
  /** Returns the resolved App Server URL (e.g. `http://127.0.0.1:6199`). */
  getUrl(): Promise<string>
}

export interface ElectronContextBridgeLike {
  exposeInMainWorld(name: 'owlcodaAppServer', api: OwlCodaAppServerPreloadAPI): void
}

export interface ElectronIpcRendererLike {
  invoke(channel: typeof OWLCODA_APP_SERVER_URL_CHANNEL): Promise<string>
}

export function installOwlCodaAppServerPreload(
  contextBridge: ElectronContextBridgeLike,
  ipcRenderer: ElectronIpcRendererLike,
): void {
  contextBridge.exposeInMainWorld('owlcodaAppServer', {
    getUrl: () => ipcRenderer.invoke(OWLCODA_APP_SERVER_URL_CHANNEL),
  })
}

/** Expected global type augmentation for renderer code. */
declare global {
  interface Window {
    owlcodaAppServer?: OwlCodaAppServerPreloadAPI
  }
}
