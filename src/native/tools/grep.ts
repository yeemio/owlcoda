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
import type { TaskExecutionState } from '../protocol/types.js'

const MAX_RESULTS = 500
const MAX_FILE_SIZE = 1024 * 1024 // Skip files > 1 MiB
const MAX_MATCH_LINE_CHARS = 2_000
const MAX_GREP_OUTPUT_CHARS = 64 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const HEARTBEAT_MS = 500

/**
 * 0.13.71 execution_economics_v1 — evidence_ledger_v1 (grep arm).
 *
 * Same WeakMap-by-task pattern as 0.13.69 read_repeat_notice_v1, but
 * keyed on grep call signature instead of file path. When the model
 * runs the same grep (same pattern, path, include filter, case
 * sensitivity) twice within a task, the second result prepends a
 * notice; third+ upgrades to a warning. Re-running an identical
 * regex on the same path almost never yields new information within
 * one short-lived task.
 *
 * No mutation-reset semantics here (unlike read's mtime check).
 * Files in the search path may have changed between runs, but
 * tracking that would require expensive directory traversal. The
 * nudge is advisory — the model can ignore it if it has a reason.
 *
 * Storage scope: WeakMap by TaskExecutionState identity. Auto-resets
 * on task boundary via GC (same mechanic as the read ledger).
 */
interface GrepEntry {
  count: number
  lastResultMatchCount: number
}
const grepLedgers = new WeakMap<TaskExecutionState, Map<string, GrepEntry>>()

function makeGrepKey(input: GrepInput): string {
  return JSON.stringify({
    pattern: input.pattern,
    path: input.path ?? null,
    include: input.include ?? null,
    ignoreCase: !!input.ignoreCase,
  })
}

function ordinalSuffix(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return 'th'
  const last = n % 10
  if (last === 1) return 'st'
  if (last === 2) return 'nd'
  if (last === 3) return 'rd'
  return 'th'
}

interface NudgeResult {
  prefix: string | null
  count: number
}

export function recordGrepAndBuildNudge(
  taskState: TaskExecutionState | undefined,
  input: GrepInput,
  matchCount: number,
): NudgeResult {
  if (!taskState) return { prefix: null, count: 1 }
  let ledger = grepLedgers.get(taskState)
  if (!ledger) {
    ledger = new Map()
    grepLedgers.set(taskState, ledger)
  }
  const key = makeGrepKey(input)
  const existing = ledger.get(key)
  if (!existing) {
    ledger.set(key, { count: 1, lastResultMatchCount: matchCount })
    return { prefix: null, count: 1 }
  }
  existing.count += 1
  const prevMatchCount = existing.lastResultMatchCount
  existing.lastResultMatchCount = matchCount
  const includeNote = input.include ? `, include=${input.include}` : ''
  const pathNote = input.path ?? '(default cwd)'
  if (existing.count === 2) {
    return {
      prefix:
        `[Runtime grep-repeat notice]\n` +
        `You already ran this grep earlier in this task: pattern=${JSON.stringify(input.pattern)}, ` +
        `path=${pathNote}${includeNote}.\n` +
        `Previous run matched ${prevMatchCount} line${prevMatchCount === 1 ? '' : 's'}; this run matched ${matchCount}. ` +
        `Reuse the prior evidence — re-running the same regex on the same path rarely produces new information.`,
      count: existing.count,
    }
  }
  return {
    prefix:
      `[Runtime grep-repeat warning]\n` +
      `This is the ${existing.count}${ordinalSuffix(existing.count)} run of the same grep in this task: ` +
      `pattern=${JSON.stringify(input.pattern)}, path=${pathNote}.\n` +
      `Use the prior evidence, narrow the pattern/path, or switch tools (read for line-range context, glob for file listing).`,
    count: existing.count,
  }
}

/** Test-only: clear the grep ledger for a given task. */
export function __resetGrepLedgerForTask(taskState: TaskExecutionState): void {
  grepLedgers.delete(taskState)
}

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
        const partial = partialResult(matches, engine, reason, budget.elapsedMs())
        // Partial/timeout/aborted runs don't get a repeat nudge — the
        // model has a legitimate reason to retry with narrower scope.
        return partial
      }
      const result = successResult(matches, engine, input.pattern, searchPath)
      // 0.13.71 evidence_ledger_v1 — repeat-grep nudge on successful runs.
      if (!result.isError && context?.taskState) {
        const matchCount = matches.length
        const nudge = recordGrepAndBuildNudge(context.taskState, input, matchCount)
        if (nudge.prefix) {
          result.output = `${nudge.prefix}\n${result.output}`
          result.metadata = {
            ...(result.metadata ?? {}),
            grepRepeatCount: nudge.count,
          }
        }
      }
      return result
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

function successResult(
  matches: string[],
  engine: 'ripgrep' | 'native',
  pattern?: string,
  searchPath?: string,
): ToolResult {
  if (matches.length === 0) {
    // 0.13.60: explicit "[grep ok]" prefix + pattern + path so the
    // model can't misread "no matches" as "search failed". Pre-0.13.60
    // wording was just "No matches found", which long-context models
    // sometimes interpreted as a tool failure and retried with a
    // different (also-empty) pattern.
    const patternEcho = pattern ? ` for pattern ${JSON.stringify(pattern)}` : ''
    const pathEcho = searchPath ? ` in ${searchPath}` : ''
    return {
      output: `[grep ok] 0 matches${patternEcho}${pathEcho}. Search ran cleanly; the pattern simply does not occur. ` +
        `If you expected a match, broaden the pattern or check the path.`,
      isError: false,
      metadata: { matchLines: 0, engine, zeroMatches: true },
    }
  }
  const formatted = formatGrepMatchesForOutput(matches)
  return {
    output: formatted.output,
    isError: false,
    metadata: {
      matchLines: Math.min(matches.length, MAX_RESULTS),
      displayedMatchLines: formatted.displayedMatchLines,
      lineTruncatedCount: formatted.lineTruncatedCount,
      outputTruncated: formatted.outputTruncated,
      omittedMatchLines: formatted.omittedMatchLines,
      engine,
    },
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
  const formatted = formatGrepMatchesForOutput(matches)
  const body = matches.length > 0 ? formatted.output : 'No matches found before the run stopped.'
  return {
    output: `${prefix}\n${body}`,
    isError: false,
    metadata: {
      matchLines: Math.min(matches.length, MAX_RESULTS),
      displayedMatchLines: formatted.displayedMatchLines,
      lineTruncatedCount: formatted.lineTruncatedCount,
      outputTruncated: formatted.outputTruncated,
      omittedMatchLines: formatted.omittedMatchLines,
      engine,
      partial: true,
      reason,
      narrowedNeeded: true,
    },
  }
}

interface FormattedGrepMatches {
  output: string
  displayedMatchLines: number
  lineTruncatedCount: number
  outputTruncated: boolean
  omittedMatchLines: number
}

function formatGrepMatchesForOutput(matches: string[]): FormattedGrepMatches {
  const limited = matches.slice(0, MAX_RESULTS)
  const lines: string[] = []
  let lineTruncatedCount = 0
  let outputChars = 0
  let outputTruncated = false
  let omittedMatchLines = 0

  for (let index = 0; index < limited.length; index += 1) {
    const compact = compactGrepMatchLine(limited[index]!)
    if (compact.truncated) lineTruncatedCount += 1
    const extraChars = compact.text.length + (lines.length > 0 ? 1 : 0)
    if (outputChars + extraChars > MAX_GREP_OUTPUT_CHARS) {
      outputTruncated = true
      omittedMatchLines = limited.length - index
      break
    }
    lines.push(compact.text)
    outputChars += extraChars
  }

  if (outputTruncated) {
    lines.push(`[grep output truncated: ${omittedMatchLines} match line${omittedMatchLines === 1 ? '' : 's'} omitted. Narrow pattern/path or set a smaller maxResults to inspect more precisely.]`)
  }

  return {
    output: lines.join('\n'),
    displayedMatchLines: lines.length - (outputTruncated ? 1 : 0),
    lineTruncatedCount,
    outputTruncated,
    omittedMatchLines,
  }
}

function compactGrepMatchLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= MAX_MATCH_LINE_CHARS) return { text: line, truncated: false }
  const omitted = line.length - MAX_MATCH_LINE_CHARS
  return {
    text: `${line.slice(0, MAX_MATCH_LINE_CHARS)}...[line truncated, ${omitted} chars omitted]`,
    truncated: true,
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
