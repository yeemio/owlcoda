/**
 * OwlCoda Native Glob Tool
 *
 * Uses ripgrep's fast file listing when available, otherwise falls back to a
 * pruned native walker. Both paths share timeout, heartbeat, and partial
 * result semantics so large-repo discovery stays responsive instead of sitting
 * at a silent "Running..." spinner.
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { IGNORE_DIR_NAMES, IGNORE_GLOB_PATTERNS } from './ignore.js'
import { detectRipgrep } from './rg-detect.js'
import type { GlobInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

const MAX_RESULTS = 10_000
const HARD_RESULT_CAP = MAX_RESULTS * 2
const DEFAULT_TIMEOUT_MS = 30_000
const HEARTBEAT_MS = 500

export function createGlobTool(): NativeToolDef<GlobInput> {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern.',

    async execute(input: GlobInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const cwd = resolve(input.cwd ?? process.cwd())
      const ignorePatterns = [...IGNORE_GLOB_PATTERNS, ...(input.ignore ?? [])]
      const ignoreRegexes = ignorePatterns.map(globToRegex)
      const patternRegex = globToRegex(input.pattern)
      const matches: string[] = []
      let engine: 'ripgrep' | 'native' = 'native'

      const budget = createExecutionBudget('glob', context, DEFAULT_TIMEOUT_MS, `Scanning ${cwd}`)
      try {
        throwIfAborted(budget.signal, 'glob')
        const usedRipgrep = await tryRipgrepGlob(
          cwd,
          patternRegex,
          ignorePatterns,
          ignoreRegexes,
          matches,
          budget,
        )
        engine = usedRipgrep ? 'ripgrep' : 'native'
        if (!usedRipgrep) {
          await nativeGlob(
            cwd,
            patternRegex,
            ignoreRegexes,
            matches,
            budget,
          )
        }
      } catch (err: unknown) {
        const reason = budget.reason()
        budget.finish()
        if (reason) {
          return partialResult(matches, engine, reason, budget.elapsedMs())
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${msg}`, isError: true }
      }

      const reason = budget.reason()
      budget.finish()
      if (reason) {
        return partialResult(matches, engine, reason, budget.elapsedMs())
      }
      return successResult(matches, engine)
    },
  }
}

async function tryRipgrepGlob(
  cwd: string,
  patternRegex: RegExp,
  ignorePatterns: string[],
  ignoreRegexes: RegExp[],
  matches: string[],
  budget: ExecutionBudget,
): Promise<boolean> {
  const rg = await detectRipgrep()
  if (!rg) return false

  let usable = true
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const args = [
      '--files',
      '--hidden',
      '--no-messages',
      ...ignorePatterns.flatMap((pattern) => ['-g', `!${pattern}`]),
      '.',
    ]
    const child = spawn(rg.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderr = ''
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      budget.signal.removeEventListener('abort', onAbort)
      if (err) rejectPromise(err)
      else resolvePromise()
    }

    const onAbort = (): void => {
      try { child.kill('SIGTERM') } catch { /* noop */ }
    }

    budget.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const rawLine of lines) {
        const rel = normalizePath(rawLine.trim().replace(/^\.\//, ''))
        if (!rel) continue
        if (ignoreRegexes.some((re) => re.test(rel))) continue
        if (!patternRegex.test(rel)) continue
        matches.push(join(cwd, rel))
        budget.update(`Matched ${rel}`, matches.length)
        if (matches.length >= HARD_RESULT_CAP) {
          try { child.kill('SIGTERM') } catch { /* noop */ }
          return
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk
    })

    child.once('error', () => {
      usable = false
      settle()
    })
    child.once('close', (code, signal) => {
      if (stdoutBuf.trim()) {
        const rel = normalizePath(stdoutBuf.trim().replace(/^\.\//, ''))
        if (rel && !ignoreRegexes.some((re) => re.test(rel)) && patternRegex.test(rel)) {
          matches.push(join(cwd, rel))
          budget.update(`Matched ${rel}`, matches.length)
        }
      }
      if (budget.reason()) {
        settle()
        return
      }
      if (signal === 'SIGTERM' && matches.length >= HARD_RESULT_CAP) {
        settle()
        return
      }
      if (code === 0 || code === 1) {
        settle()
        return
      }
      if (stderr.trim()) {
        settle(new Error(stderr.trim()))
        return
      }
      usable = false
      settle()
    })
  })

  if (!usable) {
    matches.length = 0
  }
  return usable
}

async function nativeGlob(
  cwd: string,
  patternRegex: RegExp,
  ignoreRegexes: RegExp[],
  matches: string[],
  budget: ExecutionBudget,
): Promise<void> {
  const stack = [cwd]
  while (stack.length > 0) {
    throwIfAborted(budget.signal, 'glob')
    if (matches.length >= HARD_RESULT_CAP) return

    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      throwIfAborted(budget.signal, 'glob')
      const fullPath = join(dir, entry.name)
      const relPath = normalizePath(relative(cwd, fullPath))
      if (!relPath) continue

      if (entry.isDirectory()) {
        if (IGNORE_DIR_NAMES.has(entry.name)) continue
        if (ignoreRegexes.some((re) => re.test(relPath) || re.test(`${relPath}/placeholder`))) continue
        stack.push(fullPath)
        budget.update(`Scanning ${relPath}/`, matches.length)
        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (ignoreRegexes.some((re) => re.test(relPath))) continue
      if (!patternRegex.test(relPath)) continue

      matches.push(fullPath)
      budget.update(`Matched ${relPath}`, matches.length)
      if (matches.length >= HARD_RESULT_CAP) return
    }
  }
}

interface ExecutionBudget {
  signal: AbortSignal
  update: (sample: string, totalLines: number, totalBytes?: number) => void
  finish: () => void
  reason: () => 'timeout' | 'aborted' | null
  elapsedMs: () => number
}

function createExecutionBudget(
  toolName: string,
  context: ToolExecutionContext | undefined,
  timeoutMs: number,
  initialSample: string,
): ExecutionBudget {
  const timeoutController = new AbortController()
  const startedAt = Date.now()
  let timedOut = false
  let sample = initialSample
  let totalLines = 0
  let totalBytes = 0

  const emit = (): void => {
    context?.onProgress?.({
      lines: [sample],
      totalLines,
      totalBytes,
      elapsedMs: Date.now() - startedAt,
    })
  }

  const heartbeat = context?.onProgress
    ? setInterval(emit, HEARTBEAT_MS)
    : null
  heartbeat?.unref?.()
  emit()

  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort(new Error(`${toolName} timed out`))
  }, timeoutMs)
  timeout.unref?.()

  const signal = context?.signal
    ? AbortSignal.any([context.signal, timeoutController.signal])
    : timeoutController.signal

  return {
    signal,
    update(nextSample: string, nextTotalLines: number, nextTotalBytes?: number) {
      sample = nextSample
      totalLines = nextTotalLines
      totalBytes = nextTotalBytes ?? totalBytes
    },
    finish() {
      clearTimeout(timeout)
      if (heartbeat) clearInterval(heartbeat)
    },
    reason() {
      if (timedOut) return 'timeout'
      if (context?.signal?.aborted) return 'aborted'
      return null
    },
    elapsedMs() {
      return Date.now() - startedAt
    },
  }
}

function successResult(matches: string[], engine: 'ripgrep' | 'native'): ToolResult {
  const sorted = [...matches].sort()
  if (sorted.length === 0) {
    return { output: 'No files matched', isError: false, metadata: { count: 0, engine } }
  }
  return {
    output: displayMatches(sorted),
    isError: false,
    metadata: { count: sorted.length, engine },
  }
}

function partialResult(
  matches: string[],
  engine: 'ripgrep' | 'native',
  reason: 'timeout' | 'aborted',
  elapsedMs: number,
): ToolResult {
  const sorted = [...matches].sort()
  const reasonText = reason === 'timeout'
    ? `timed out after ${Math.max(1, Math.round(elapsedMs / 1000))}s`
    : 'was aborted'
  const prefix = `[partial ${reason}] Returned ${sorted.length} match${sorted.length === 1 ? '' : 'es'} before glob ${reasonText}. Narrow the pattern or cwd to continue.`
  const body = sorted.length > 0 ? displayMatches(sorted) : 'No files matched before the run stopped.'
  return {
    output: `${prefix}\n${body}`,
    isError: false,
    metadata: {
      count: sorted.length,
      engine,
      partial: true,
      reason,
      narrowedNeeded: true,
    },
  }
}

function displayMatches(matches: string[]): string {
  if (matches.length <= MAX_RESULTS) {
    return matches.join('\n')
  }
  return [...matches.slice(0, MAX_RESULTS), `... and ${matches.length - MAX_RESULTS} more`].join('\n')
}

/** Convert a glob pattern to a RegExp. */
function globToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  const normalized = normalizePath(pattern)

  while (i < normalized.length) {
    const ch = normalized[i]!

    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          re += '(?:.+/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      re += '[^/]'
      i++
    } else if (ch === '{') {
      const close = normalized.indexOf('}', i)
      if (close === -1) {
        re += '\\{'
        i++
      } else {
        const alts = normalized.slice(i + 1, close).split(',')
        re += '(?:' + alts.map(escapeRegex).join('|') + ')'
        i = close + 1
      }
    } else if ('.+^$|()[]\\'.includes(ch)) {
      re += '\\' + ch
      i++
    } else {
      re += ch
      i++
    }
  }

  return new RegExp('^' + re + '$')
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function throwIfAborted(signal: AbortSignal, toolName: string): void {
  if (!signal.aborted) return
  const err = new Error(`${toolName} aborted`)
  err.name = 'AbortError'
  throw err
}
