import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatWithOptions } from 'node:util'

// Minimal debug.ts — only exports logForDebugging for ink/
let cachedLogPath: string | null | undefined

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  )
}

function isFalseLike(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized === '' ||
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  )
}

function resolveDebugLogPath(): string | null {
  if (cachedLogPath !== undefined) return cachedLogPath

  const explicit = process.env['OWLCODA_DEBUG_LOG']?.trim()
  if (explicit && !isFalseLike(explicit)) {
    cachedLogPath = explicit
    return cachedLogPath
  }

  if (!isTruthy(process.env['OWLCODA_DEBUG'])) {
    cachedLogPath = null
    return cachedLogPath
  }

  const root =
    process.env['OWLCODA_HOME']?.trim() ||
    join(process.env['HOME']?.trim() || homedir(), '.owlcoda')
  cachedLogPath = join(root, 'debug.log')
  return cachedLogPath
}

export function resetDebugLoggingForTests(): void {
  cachedLogPath = undefined
}

export function logForDebugging(..._args: unknown[]): void {
  const logPath = resolveDebugLogPath()
  if (!logPath) return

  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const message = formatWithOptions(
      { colors: false, depth: 6, breakLength: 120 },
      ..._args,
    )
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Debug logging must never affect rendering or startup.
  }
}
