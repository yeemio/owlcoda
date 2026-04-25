import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

/**
 * Config root resolution for OwlCoda.
 *
 * Priority order:
 *   1. $OWLCODA_HOME env var (explicit override)
 *   2. ~/.owlcoda (canonical OwlCoda config root)
 *
 * The chosen directory must contain config.json to win.
 * If neither exists, returns ~/.owlcoda for first-time init.
 */
export function getOwlcodaDir(): string {
  if (process.env['OWLCODA_HOME']) {
    return process.env['OWLCODA_HOME']
  }

  const home = homedir()
  const canonical = join(home, '.owlcoda')

  // Prefer OwlCoda's canonical root when it already has a config.
  if (existsSync(join(canonical, 'config.json'))) {
    return canonical
  }

  // Neither exists — use OwlCoda's canonical path for new installs.
  return canonical
}

/**
 * Returns the resolved config directory name for display/logging.
 * Useful for telling the user which config root is active.
 */
export function getOwlcodaDirLabel(): string {
  const dir = getOwlcodaDir()
  const home = homedir()
  if (dir.startsWith(home)) {
    return '~' + dir.slice(home.length)
  }
  return dir
}

export function getOwlcodaConfigPath(): string {
  return join(getOwlcodaDir(), 'config.json')
}

export function getOwlcodaPidPath(): string {
  return join(getOwlcodaDir(), 'owlcoda.pid')
}

export function getOwlcodaRuntimeMetaPath(): string {
  return join(getOwlcodaDir(), 'runtime.json')
}

export function getOwlcodaLiveReplLeasePath(): string {
  return join(getOwlcodaDir(), 'live-repl.json')
}

export function getOwlcodaRuntimeProfileDir(): string {
  return join(getOwlcodaDir(), 'runtime-profile')
}
