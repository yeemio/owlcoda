#!/usr/bin/env node

/**
 * CLI entry point — thin shell that only calls main() when executed directly.
 * All logic lives in cli-core.ts (safe to import without side effects).
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main } from './cli-core.js'

export function isDirectCliEntry(importMetaUrl: string, argv1?: string): boolean {
  if (!argv1) return false

  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1)
  } catch {
    // Fallback for environments where argv[1] cannot be resolved.
    return importMetaUrl === pathToFileURL(argv1).href
  }
}

// ESM entry guard: only run when this file is the direct entry point.
// Use realpath resolution so npm bin symlinks still execute main().
if (isDirectCliEntry(import.meta.url, process.argv[1])) {
  main().catch(err => {
    const message = err instanceof Error ? err.message : String(err)
    if (process.env.OWLCODA_DEBUG && err instanceof Error && err.stack) console.error(err.stack)
    else console.error(message)
    process.exit(1)
  })
}
