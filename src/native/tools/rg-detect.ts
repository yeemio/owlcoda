/**
 * ripgrep binary detection.
 *
 * Tries PATH first (a real binary, not a shell alias), then a short list of
 * fixed fallback paths, then an optional user-supplied path via the
 * OWLCODA_VENDORED_RG env var. Result is cached for the process lifetime
 * so we don't eat spawn latency on every exploratory call.
 */

import { spawn } from 'node:child_process'
import { access, constants as fsc, stat } from 'node:fs/promises'

export interface RipgrepBinary {
  bin: string
}

let cached: Promise<RipgrepBinary | null> | null = null

/** Reset the cached detection. Test-only. */
export function _resetRipgrepCacheForTests(): void {
  cached = null
}

export function detectRipgrep(): Promise<RipgrepBinary | null> {
  if (!cached) cached = runDetection()
  return cached
}

async function runDetection(): Promise<RipgrepBinary | null> {
  // 1. Real binary in PATH. Shell aliases are not visible to spawn, so this
  //    naturally rejects `rg: aliased to ...`.
  const viaPath = await probeSpawn('rg')
  if (viaPath) return { bin: 'rg' }

  // 2. Fixed, well-known install locations.
  for (const candidate of FIXED_PATHS) {
    if (await isExecutable(candidate)) return { bin: candidate }
  }

  // 3. Optional: user-supplied vendored rg path.
  const vendored = process.env['OWLCODA_VENDORED_RG']
  if (vendored && await isExecutable(vendored)) return { bin: vendored }

  return null
}

const FIXED_PATHS = [
  '/opt/homebrew/bin/rg',
  '/usr/local/bin/rg',
  '/usr/bin/rg',
]

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, fsc.X_OK)
    return true
  } catch {
    return false
  }
}

function probeSpawn(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      resolve(ok)
    }
    const child = spawn(bin, ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    // Hard cap so we don't hang the detector itself.
    setTimeout(() => {
      if (!done) {
        try { child.kill() } catch { /* noop */ }
        finish(false)
      }
    }, 2000)
  })
}
