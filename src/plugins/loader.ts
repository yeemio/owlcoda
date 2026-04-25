/**
 * OwlCoda Plugin Loader — discovers and loads plugins from ~/.owlcoda/plugins/
 */

import { readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { OwlCodaPlugin, LoadedPlugin, RequestHookContext, ResponseHookContext, ToolCallHookContext, ErrorHookContext } from './types.js'

const HOOK_NAMES = ['onRequest', 'onResponse', 'onToolCall', 'onError'] as const

let loadedPlugins: LoadedPlugin[] = []

function getPluginDir(): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
  return path.join(owlcodaHome, 'plugins')
}

function validatePlugin(obj: unknown, pluginPath: string): OwlCodaPlugin | null {
  if (!obj || typeof obj !== 'object') return null
  const candidate = obj as Record<string, unknown>

  if (!candidate.metadata || typeof candidate.metadata !== 'object') {
    console.error(`[plugins] ${pluginPath}: missing metadata`)
    return null
  }
  const meta = candidate.metadata as Record<string, unknown>
  if (typeof meta.name !== 'string' || typeof meta.version !== 'string') {
    console.error(`[plugins] ${pluginPath}: metadata.name and metadata.version must be strings`)
    return null
  }

  return candidate as unknown as OwlCodaPlugin
}

function countHooks(plugin: OwlCodaPlugin): number {
  return HOOK_NAMES.filter(h => typeof plugin[h] === 'function').length
}

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const dir = getPluginDir()
  if (!existsSync(dir)) {
    loadedPlugins = []
    return loadedPlugins
  }

  const entries = readdirSync(dir).sort()
  const plugins: LoadedPlugin[] = []

  for (const entry of entries) {
    const pluginPath = path.join(dir, entry)
    if (!statSync(pluginPath).isDirectory()) continue

    const indexPath = path.join(pluginPath, 'index.js')
    if (!existsSync(indexPath)) {
      console.error(`[plugins] ${entry}: no index.js found, skipping`)
      continue
    }

    try {
      const mod = await import(`file://${indexPath}`)
      const exported = mod.default ?? mod
      const plugin = validatePlugin(exported, entry)
      if (!plugin) continue

      if (typeof plugin.onLoad === 'function') {
        await plugin.onLoad()
      }

      plugins.push({
        plugin,
        path: pluginPath,
        hookCount: countHooks(plugin),
      })
      console.error(`[plugins] Loaded: ${plugin.metadata.name} v${plugin.metadata.version} (${countHooks(plugin)} hooks)`)
    } catch (err) {
      console.error(`[plugins] Failed to load ${entry}: ${err}`)
    }
  }

  loadedPlugins = plugins
  return plugins
}

export function getLoadedPlugins(): LoadedPlugin[] {
  return loadedPlugins
}

export async function runRequestHooks(ctx: RequestHookContext): Promise<void> {
  for (const { plugin } of loadedPlugins) {
    if (typeof plugin.onRequest === 'function') {
      try {
        await plugin.onRequest(ctx)
      } catch (err) {
        console.error(`[plugins] ${plugin.metadata.name}.onRequest error: ${err}`)
      }
    }
  }
}

export async function runResponseHooks(ctx: ResponseHookContext): Promise<void> {
  for (const { plugin } of loadedPlugins) {
    if (typeof plugin.onResponse === 'function') {
      try {
        await plugin.onResponse(ctx)
      } catch (err) {
        console.error(`[plugins] ${plugin.metadata.name}.onResponse error: ${err}`)
      }
    }
  }
}

export async function runToolCallHooks(ctx: ToolCallHookContext): Promise<void> {
  for (const { plugin } of loadedPlugins) {
    if (typeof plugin.onToolCall === 'function') {
      try {
        await plugin.onToolCall(ctx)
      } catch (err) {
        console.error(`[plugins] ${plugin.metadata.name}.onToolCall error: ${err}`)
      }
    }
  }
}

export async function runErrorHooks(ctx: ErrorHookContext): Promise<void> {
  for (const { plugin } of loadedPlugins) {
    if (typeof plugin.onError === 'function') {
      try {
        await plugin.onError(ctx)
      } catch (err) {
        console.error(`[plugins] ${plugin.metadata.name}.onError error: ${err}`)
      }
    }
  }
}

export async function unloadPlugins(): Promise<void> {
  for (const { plugin } of loadedPlugins) {
    if (typeof plugin.onUnload === 'function') {
      try {
        await plugin.onUnload()
      } catch (err) {
        console.error(`[plugins] ${plugin.metadata.name}.onUnload error: ${err}`)
      }
    }
  }
  loadedPlugins = []
}
