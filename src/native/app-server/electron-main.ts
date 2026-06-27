import { launchAppServer, type AppServerLauncherResult } from './launcher.js'
import { OWLCODA_APP_SERVER_URL_CHANNEL } from './electron-ipc.js'

export interface ElectronMainAdapterOptions {
  /** OwlCoda config for loop options resolution. */
  config?: import('./methods.js').MethodRegistryOptions['config']
  /** Preferred port; 0 for any available port. */
  port?: number
  /** Preferred host. */
  host?: string
}

export interface ElectronMainAdapterResult {
  url: string
  desktopUrl: string
  port: number
  ownsProcess: boolean
  stop(): Promise<void>
}

export interface ElectronDesktopShell {
  BrowserWindow: new (options: ElectronBrowserWindowOptions) => ElectronBrowserWindowLike
  ipcMain: ElectronIpcMainLike
}

export interface ElectronBrowserWindowLike {
  loadURL(url: string): Promise<void> | void
}

export interface ElectronIpcMainLike {
  handle(channel: typeof OWLCODA_APP_SERVER_URL_CHANNEL, handler: () => string): void
}

export interface ElectronBrowserWindowOptions {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  show?: boolean
  webPreferences?: Record<string, unknown>
  [key: string]: unknown
}

export interface OwlCodaDesktopWindowOptions extends ElectronMainAdapterOptions {
  windowOptions?: ElectronBrowserWindowOptions
}

export interface OwlCodaDesktopWindowResult {
  appServer: ElectronMainAdapterResult
  desktopUrl: string
  window: ElectronBrowserWindowLike
  stop(): Promise<void>
}

/** Launch or attach to an OwlCoda App Server from an Electron main process.
 *  Returns a resolved URL and cleanup function. */
export async function launchOrAttachAppServer(options: ElectronMainAdapterOptions = {}): Promise<ElectronMainAdapterResult> {
  const result = await launchAppServer({
    config: options.config,
    port: options.port,
    host: options.host,
  })
  return {
    url: result.url,
    desktopUrl: desktopUrlForAppServer(result.url),
    port: result.port,
    ownsProcess: result.ownsProcess,
    stop: result.stop,
  }
}

export async function createOwlCodaDesktopWindow(
  electron: ElectronDesktopShell,
  options: OwlCodaDesktopWindowOptions = {},
): Promise<OwlCodaDesktopWindowResult> {
  const appServer = await launchOrAttachAppServer(options)
  electron.ipcMain.handle(OWLCODA_APP_SERVER_URL_CHANNEL, () => appServer.url)
  const window = new electron.BrowserWindow(desktopWindowOptions(options.windowOptions))
  await window.loadURL(appServer.desktopUrl)
  return {
    appServer,
    desktopUrl: appServer.desktopUrl,
    window,
    stop: appServer.stop,
  }
}

function desktopUrlForAppServer(url: string): string {
  return `${url.replace(/\/+$/, '')}/desktop`
}

function desktopWindowOptions(overrides: ElectronBrowserWindowOptions = {}): ElectronBrowserWindowOptions {
  return {
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'OwlCoda Desktop',
    show: true,
    ...overrides,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      ...(overrides.webPreferences ?? {}),
    },
  }
}
