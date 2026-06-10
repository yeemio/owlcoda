#!/usr/bin/env node

/**
 * CLI entry point — thin shell that only calls main() when executed directly.
 * All logic lives in cli-core.ts (safe to import without side effects).
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MIN_SUPPORTED_NODE_VERSION = '20.19.0'

export function isDirectCliEntry(importMetaUrl: string, argv1?: string): boolean {
  if (!argv1) return false

  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1)
  } catch {
    // Fallback for environments where argv[1] cannot be resolved.
    return importMetaUrl === pathToFileURL(argv1).href
  }
}

export function isSupportedNodeVersion(version = process.versions.node): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  if (major > 20) return true
  if (major < 20) return false
  if (minor > 19) return true
  if (minor < 19) return false
  return patch >= 0
}

export function getUnsupportedNodeMessage(version = process.versions.node): string {
  return [
    `OwlCoda requires Node.js >= ${MIN_SUPPORTED_NODE_VERSION} (Node 22+ recommended).`,
    `Current Node.js is v${version}.`,
    'Upgrade Node.js, then reinstall or rebuild OwlCoda.',
  ].join('\n')
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) throw new Error(getUnsupportedNodeMessage(version))
}

// ESM entry guard: only run when this file is the direct entry point.
// Use realpath resolution so npm bin symlinks still execute main().
if (isDirectCliEntry(import.meta.url, process.argv[1])) {
  try {
    assertSupportedNodeRuntime()
    const { main } = await import('./cli-core.js')
    await main()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (process.env.OWLCODA_DEBUG && err instanceof Error && err.stack) console.error(err.stack)
    else console.error(message)
    process.exit(1)
  }
}
