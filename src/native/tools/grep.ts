/**
 * OwlCoda Native Grep Tool
 *
 * Search file contents with a shared runtime contract across ripgrep and the
 * native walker: ignore pruning, heartbeat, timeout, and partial results.
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { IGNORE_DIR_NAMES, IGNORE_GLOB_PATTERNS } from './ignore.js'
import { detectRipgrep } from './rg-detect.js'
import type { GrepInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

const MAX_RESULTS = 500
const MAX_FILE_SIZE = 1024 * 1024 // Skip files > 1 MiB
const DEFAULT_TIMEOUT_MS = 60_000
const HEARTBEAT_MS = 500

export function createGrepTool(): NativeToolDef<GrepInput> {
  return {
    name: 'grep',
    description:
      'Search file contents for a regex pattern. Uses ripgrep if available.',

    async execute(input: GrepInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const searchPath = resolve(input.path ?? process.cwd())
      const ignorePatterns = [...IGNORE_GLOB_PATTERNS]
      const matches: string[] = []
      const resultLimit = input.maxResults ?? MAX_RESULTS
      let engine: 'ripgrep' | 'native' = 'native'

      const budget = createExecutionBudget('grep', context, DEFAULT_TIMEOUT_MS, `Scanning ${searchPath}`)
      try {
        throwIfAborted(budget.signal, 'grep')
        const usedRipgrep = await tryRipgrep(input, searchPath, ignorePatterns, matches, budget)
        engine = usedRipgrep ? 'ripgrep' : 'native'
        if (!usedRipgrep) {
          await nativeSearch(input, searchPath, matches, budget)
        }
      } catch (err: unknown) {
        const reason = budget.reason()
        budget.finish()
        if (matches.length > resultLimit) {
          matches.length = resultLimit
        }
        if (reason) {
          return partialResult(matches, engine, reason, budget.elapsedMs())
        }
        if (err instanceof Error && err.message.startsWith('Invalid regular expression')) {
          return { output: `Error: invalid regex — ${err.message}`, isError: true }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${msg}`, isError: true }
      }

      const reason = budget.reason()
      budget.finish()
      if (matches.length > resultLimit) {
        matches.length = resultLimit
      }
      if (reason) {
        return partialResult(matches, engine, reason, budget.elapsedMs())
      }
      return successResult(matches, engine)
    },
  }
}

async function tryRipgrep(
  input: GrepInput,
  searchPath: string,
  ignorePatterns: string[],
  matches: string[],
  budget: ExecutionBudget,
): Promise<boolean> {
  const rg = await detectRipgrep()
  if (!rg) return false

  let usable = true
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const args = ['--line-number', '--with-filename', '--no-heading', '--color=never', '--hidden']
    if (input.ignoreCase) args.push('-i')
    if (input.maxResults) args.push('--max-count', String(input.maxResults))
    if (input.include) args.push('-g', input.include)
    args.push('--max-filesize', '1M')
    args.push(...ignorePatterns.flatMap((pattern) => ['-g', `!${pattern}`]))
    args.push(input.pattern, searchPath)

    const child = spawn(rg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
      for (const line of lines) {
        const trimmed = line.trimEnd()
        if (!trimmed) continue
        matches.push(trimmed)
        budget.update(trimmed, matches.length)
        if (matches.length >= (input.maxResults ?? MAX_RESULTS)) {
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
        const trimmed = stdoutBuf.trimEnd()
        if (trimmed) {
          matches.push(trimmed)
          budget.update(trimmed, matches.length)
        }
      }
      if (budget.reason()) {
        settle()
        return
      }
      if (signal === 'SIGTERM' && matches.length >= (input.maxResults ?? MAX_RESULTS)) {
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

async function nativeSearch(
  input: GrepInput,
  searchPath: string,
  matches: string[],
  budget: ExecutionBudget,
): Promise<void> {
  const flags = input.ignoreCase ? 'i' : ''
  const regex = new RegExp(input.pattern, flags)
  const maxResults = input.maxResults ?? MAX_RESULTS
  const includeGlob = input.include
    ? simpleGlobToRegex(input.include)
    : null

  const info = await stat(searchPath)
  throwIfAborted(budget.signal, 'grep')
  if (info.isFile()) {
    await searchFile(searchPath, searchPath, regex, matches, maxResults, budget)
    return
  }
  await walkAndSearch(searchPath, searchPath, regex, matches, maxResults, includeGlob, budget)
}

async function walkAndSearch(
  dir: string,
  basePath: string,
  regex: RegExp,
  matches: string[],
  maxResults: number,
  includeGlob: RegExp | null,
  budget: ExecutionBudget,
): Promise<void> {
  throwIfAborted(budget.signal, 'grep')
  if (matches.length >= maxResults) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (matches.length >= maxResults) return
    throwIfAborted(budget.signal, 'grep')

    if (entry.isDirectory()) {
      if (IGNORE_DIR_NAMES.has(entry.name)) continue
      const nextDir = join(dir, entry.name)
      const relDir = normalizePath(relative(basePath, nextDir))
      budget.update(`Scanning ${relDir}/`, matches.length)
      await walkAndSearch(nextDir, basePath, regex, matches, maxResults, includeGlob, budget)
      continue
    }

    if (!entry.isFile()) continue
    if (includeGlob && !includeGlob.test(entry.name)) continue
    await searchFile(join(dir, entry.name), basePath, regex, matches, maxResults, budget)
  }
}

async function searchFile(
  filePath: string,
  basePath: string,
  regex: RegExp,
  matches: string[],
  maxResults: number,
  budget: ExecutionBudget,
): Promise<void> {
  try {
    throwIfAborted(budget.signal, 'grep')
    const info = await stat(filePath)
    if (info.size > MAX_FILE_SIZE) return

    const content = await readFile(filePath, 'utf-8')
    throwIfAborted(budget.signal, 'grep')
    const lines = content.split('\n')
    const relPath = relative(basePath, filePath) || filePath

    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
      throwIfAborted(budget.signal, 'grep')
      if (!regex.test(lines[i]!)) continue
      const displayPath = filePath.startsWith('/') ? filePath : relPath
      const matchLine = `${displayPath}:${i + 1}:${lines[i]}`
      matches.push(matchLine)
      budget.update(matchLine, matches.length)
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err
    }
    // Skip unreadable files.
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
  if (matches.length === 0) {
    return { output: 'No matches found', isError: false, metadata: { matchLines: 0, engine } }
  }
  return {
    output: matches.slice(0, MAX_RESULTS).join('\n'),
    isError: false,
    metadata: { matchLines: Math.min(matches.length, MAX_RESULTS), engine },
  }
}

function partialResult(
  matches: string[],
  engine: 'ripgrep' | 'native',
  reason: 'timeout' | 'aborted',
  elapsedMs: number,
): ToolResult {
  const reasonText = reason === 'timeout'
    ? `timed out after ${Math.max(1, Math.round(elapsedMs / 1000))}s`
    : 'was aborted'
  const prefix = `[partial ${reason}] Returned ${matches.length} match line${matches.length === 1 ? '' : 's'} before grep ${reasonText}. Narrow the pattern or path to continue.`
  const body = matches.length > 0 ? matches.slice(0, MAX_RESULTS).join('\n') : 'No matches found before the run stopped.'
  return {
    output: `${prefix}\n${body}`,
    isError: false,
    metadata: {
      matchLines: Math.min(matches.length, MAX_RESULTS),
      engine,
      partial: true,
      reason,
      narrowedNeeded: true,
    },
  }
}

function simpleGlobToRegex(glob: string): RegExp {
  const re = normalizePath(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^' + re + '$')
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function throwIfAborted(signal: AbortSignal, toolName: string): void {
  if (!signal.aborted) return
  const err = new Error(`${toolName} aborted`)
  err.name = 'AbortError'
  throw err
}
