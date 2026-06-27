/**
 * OwlCoda Native Bash Tool
 *
 * Spawns a child shell process, captures stdout/stderr, returns exit code.
 * The implementation stays local-first and keeps the execution surface minimal.
 *
 * Cancellation semantics (P0 — Ctrl+C must halt within bounded time):
 *
 *   - `spawn` runs with `detached: true` so the bash we launch becomes the
 *     leader of its own process group. All descendants (sub-shells,
 *     backgrounded jobs, grandchildren that inherit stdio) live in the
 *     same group.
 *   - On abort or timeout we kill the GROUP (`process.kill(-pid, sig)`),
 *     not just the immediate child. Without this, a command like
 *     `sleep 60 &` would leave a backgrounded grandchild holding the
 *     stdout pipe open; Node's `close` event waits for stdio EOF and
 *     would never fire — the Promise would hang indefinitely.
 *   - A hard deadline ensures the Promise resolves even if `close` is
 *     never delivered by the OS (stdio fd still referenced, zombie
 *     state, etc.). We prefer a bounded, forcibly-released result over
 *     a hung conversation loop.
 */

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import type { BashInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { extractWriteTargets } from '../write-provenance.js'
import type { ExtractedWriteTarget } from '../protocol/write-provenance-types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB cap per stream
const PROGRESS_TAIL_LINES = 5 // Number of recent lines to include in progress events
const MAX_SOURCE_CAPTURE_BYTES = 1024 * 1024

/**
 * Grace windows on the cancellation path (user Ctrl+C).
 *
 *   t+0      → SIGTERM to the process group
 *   t+1s     → SIGKILL to the process group (escalation)
 *   t+3s     → force-resolve the Promise even if `close` never fires
 *
 * 3s is enough for a cooperative SIGTERM handler to flush and for SIGKILL
 * to actually free stdio in the common case; long enough to avoid false
 * forced-releases, short enough that the UI isn't left staring at
 * "Already cancelling…" for minutes.
 */
const ABORT_SIGKILL_MS = 1000
const ABORT_HARD_DEADLINE_MS = 3000

/**
 * Grace windows on the timeout path (command exceeded timeoutMs).
 * Larger than the abort grace — cooperative cleanup is fine; we only
 * force-resolve if the OS genuinely can't release stdio.
 */
const TIMEOUT_SIGKILL_MS = 5000
const TIMEOUT_HARD_DEADLINE_MS = 8000

export function createBashTool(): NativeToolDef<BashInput> {
  return {
    name: 'bash',
    description:
      'Execute a bash command and return stdout, stderr, and exit code.',

    async execute(input: BashInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const { command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = input

      if (!command || command.trim().length === 0) {
        return { output: 'Error: empty command', isError: true }
      }

      // Resolve + sanity-check cwd. Spawn will throw or run with a stale
      // cwd if the path doesn't exist / isn't a directory; surfacing that
      // explicitly is kinder than an opaque ENOENT mid-execution. path is
      // resolved against process.cwd() so a relative `cwd: '../other-repo'`
      // still works the way users expect.
      let effectiveCwd = process.cwd()
      if (typeof cwd === 'string' && cwd.length > 0) {
        const { resolve: resolvePath } = await import('node:path')
        const { statSync } = await import('node:fs')
        const resolved = resolvePath(process.cwd(), cwd)
        try {
          if (!statSync(resolved).isDirectory()) {
            return { output: `Error: cwd is not a directory: ${resolved}`, isError: true }
          }
          effectiveCwd = resolved
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { output: `Error: cwd does not exist or is inaccessible: ${resolved} (${msg})`, isError: true }
        }
      }

      const captureSeeds = await prepareBashWriteCaptures(command, effectiveCwd)
      const result = await runCommand(command, effectiveCwd, timeoutMs, context)
      const writeCaptures = await completeBashWriteCaptures(captureSeeds)
      if (writeCaptures.length > 0) {
        result.metadata = {
          ...(result.metadata ?? {}),
          writeCaptures,
        }
      }
      return result
    },
  }
}

interface BashWriteCaptureSeed {
  target: ExtractedWriteTarget
  before: TextFileReadResult
}

interface BashWriteCapture {
  path: string
  kind: ExtractedWriteTarget['kind']
  oldContent: string | null
  newContent: string
}

type TextFileReadResult =
  | { ok: true; content: string }
  | { ok: false; missing: true; reason: 'missing' }
  | { ok: false; missing: false; reason: 'not_file' | 'too_large' | 'unreadable' }

async function prepareBashWriteCaptures(command: string, cwd: string): Promise<BashWriteCaptureSeed[]> {
  const targets = extractWriteTargets('bash', { command }, cwd)
  const seeds: BashWriteCaptureSeed[] = []
  for (const target of targets) {
    const before = await readUtf8FileForCapture(target.path)
    if (before.ok || before.missing) {
      seeds.push({ target, before })
    }
  }
  return seeds
}

async function completeBashWriteCaptures(seeds: BashWriteCaptureSeed[]): Promise<BashWriteCapture[]> {
  const captures: BashWriteCapture[] = []
  for (const seed of seeds) {
    const after = await readUtf8FileForCapture(seed.target.path)
    if (!after.ok) continue
    captures.push({
      path: seed.target.path,
      kind: seed.target.kind,
      oldContent: seed.before.ok ? seed.before.content : null,
      newContent: after.content,
    })
  }
  return captures
}

async function readUtf8FileForCapture(path: string): Promise<TextFileReadResult> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { ok: false, missing: false, reason: 'not_file' }
    if (info.size > MAX_SOURCE_CAPTURE_BYTES) return { ok: false, missing: false, reason: 'too_large' }
    return { ok: true, content: await readFile(path, 'utf8') }
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return { ok: false, missing: true, reason: 'missing' }
    return { ok: false, missing: false, reason: 'unreadable' }
  }
}

/** Core execution: spawn bash -c, collect output, enforce timeout, emit progress. */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutCollected = 0
    let stderrCollected = 0
    let stdoutTotal = 0
    let stderrTotal = 0
    let killed = false
    let settled = false
    let aborted = false
    let forcedRelease = false

    // Progress tracking
    const startTime = Date.now()
    const recentLines: string[] = []
    let totalLines = 0
    let progressTimer: ReturnType<typeof setInterval> | null = null

    let abortEscalation: ReturnType<typeof setTimeout> | null = null
    let abortHardDeadline: ReturnType<typeof setTimeout> | null = null
    let timeoutEscalation: ReturnType<typeof setTimeout> | null = null
    let timeoutHardDeadline: ReturnType<typeof setTimeout> | null = null

    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: the spawned bash becomes the leader of a new process
      // group. Lets us kill the whole group on abort so backgrounded
      // grandchildren (which would otherwise hold stdio open and block
      // the `close` event) die with their parent.
      detached: true,
    })

    /**
     * Kill the entire process group that `child` leads. Falls back to a
     * single-process kill if group-kill fails (e.g. child already exited
     * and pid recycled, or detached setup didn't take).
     */
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // already gone — ignore
        }
      }
    }

    const clearAllTimers = (): void => {
      clearTimeout(timer)
      if (abortEscalation) clearTimeout(abortEscalation)
      if (abortHardDeadline) clearTimeout(abortHardDeadline)
      if (timeoutEscalation) clearTimeout(timeoutEscalation)
      if (timeoutHardDeadline) clearTimeout(timeoutHardDeadline)
      if (progressTimer) clearInterval(progressTimer)
    }

    const detachSignalListener = (): void => {
      if (context?.signal) {
        context.signal.removeEventListener('abort', abortHandler)
      }
    }

    /**
     * Hard fallback — resolve the Promise ourselves when SIGKILL wasn't
     * enough to free the stdio pipes (typical case: backgrounded
     * grandchild still holds an fd; `close` waits for EOF that never
     * comes). Without this, the conversation loop in runConversationLoop
     * would hang forever awaiting dispatcher.executeTool.
     */
    const forceSettle = (reason: 'aborted' | 'timeout'): void => {
      if (settled) return
      settled = true
      forcedRelease = true
      clearAllTimers()
      detachSignalListener()
      const output = reason === 'aborted'
        ? '[aborted] Process cancelled by user (stdio forcibly released)'
        : `[killed] Process timed out after ${timeoutMs}ms (stdio forcibly released)`
      resolve({
        output,
        isError: true,
        metadata: {
          exitCode: null,
          killed: true,
          signal: 'SIGKILL',
          aborted: reason === 'aborted',
          forcedRelease: true,
        },
      })
    }

    const abortHandler = (): void => {
      if (settled || aborted) return
      aborted = true
      killed = true
      killGroup('SIGTERM')
      abortEscalation = setTimeout(() => {
        if (!settled) killGroup('SIGKILL')
      }, ABORT_SIGKILL_MS)
      abortHardDeadline = setTimeout(() => {
        forceSettle('aborted')
      }, ABORT_HARD_DEADLINE_MS)
    }

    if (context?.signal) {
      if (context.signal.aborted) {
        abortHandler()
      } else {
        context.signal.addEventListener('abort', abortHandler, { once: true })
      }
    }

    // Emit progress updates every 250ms during execution
    if (context?.onProgress) {
      progressTimer = setInterval(() => {
        context.onProgress!({
          lines: [...recentLines],
          totalLines,
          totalBytes: stdoutTotal + stderrTotal,
          elapsedMs: Date.now() - startTime,
        })
      }, 250)
    }

    const timer = setTimeout(() => {
      if (settled) return
      killed = true
      killGroup('SIGTERM')
      timeoutEscalation = setTimeout(() => {
        if (!settled) killGroup('SIGKILL')
      }, TIMEOUT_SIGKILL_MS)
      // Timeout path mirrors the abort safety net — bound the total wait
      // so a stuck child (stdio held open by grandchildren) can't hang
      // the conversation loop past timeoutMs + hard deadline.
      timeoutHardDeadline = setTimeout(() => {
        forceSettle('timeout')
      }, TIMEOUT_HARD_DEADLINE_MS)
    }, timeoutMs)

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutTotal += chunk.length
      if (stdoutCollected < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk)
        stdoutCollected += chunk.length
      }
      // Track recent lines for progress display
      if (context?.onProgress) {
        const text = chunk.toString('utf-8')
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.length > 0) {
            recentLines.push(line.length > 120 ? line.slice(0, 120) + '…' : line)
            if (recentLines.length > PROGRESS_TAIL_LINES) recentLines.shift()
            totalLines++
          }
        }
      }
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTotal += chunk.length
      if (stderrCollected < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk)
        stderrCollected += chunk.length
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearAllTimers()
      detachSignalListener()
      resolve({
        output: `Error spawning process: ${err.message}`,
        isError: true,
      })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearAllTimers()
      detachSignalListener()

      const stdout = sanitizeBashOutput(truncateBuffer(stdoutChunks, stdoutTotal))
      const stderr = sanitizeBashOutput(truncateBuffer(stderrChunks, stderrTotal))
      const exitCode = code ?? (signal ? 128 : 1)

      // 0.13.60: smart bash output formatter. Always emits an
      // `[exit code: N]` trailer line; preserves the full stderr
      // section preferentially over stdout middle. The 60/20
      // truncator in conversation.ts is generic — without this,
      // long stdout could push stderr + exit code out of the tail
      // window. Pre-formatting at the bash layer keeps the
      // load-bearing parts intact.
      const formatted = aborted
        ? '[aborted] Process cancelled by user'
        : formatBashOutput({
            stdout,
            stderr,
            exitCode,
            killed,
            timeoutMs,
          })

      resolve({
        output: formatted,
        isError: aborted ? true : exitCode !== 0,
        metadata: { exitCode, killed, signal, aborted, forcedRelease },
      })
    })
  })
}

/**
 * Compose the bash tool_result text. Sections (in order, each one
 * omitted when empty):
 *   1. `[stdout]\n<stdout>`
 *   2. `[stderr]\n<stderr>`
 *   3. `[killed] Process timed out after Xms` (when killed by timeout)
 *   4. `[exit code: N]` (always)
 *
 * The full output is then capped at MAX_BASH_OUTPUT_CHARS. Allocation
 * priority when the cap is exceeded:
 *   - exit code line: always preserved (≤30 chars)
 *   - stderr block: capped at STDERR_BUDGET, kept in full up to that
 *   - stdout block: gets the rest, head 60% + tail 20% on overflow
 *
 * The conversation-loop truncator (TOOL_RETENTION_LIMITS.bash = 15K)
 * still applies on top, but with the above structure already in
 * place, the load-bearing exit-code + stderr survive any second-pass
 * truncation too.
 */
const MAX_BASH_OUTPUT_CHARS = 14_000
const STDERR_BUDGET = 4_000

interface BashFormatInput {
  stdout: string
  stderr: string
  exitCode: number
  killed: boolean
  timeoutMs: number
}

/**
 * Strip terminal control sequences that mangle layout when bash output is
 * embedded in static transcript/scrollback. Preserves SGR (color/bold) so
 * `--color=always` output (grep, ls, git diff, jq -C) still renders.
 *
 * Stripped:
 *   - CSI escapes with non-SGR final byte (cursor move A/B/C/D/H, erase K/J,
 *     mode set/reset h/l, save/restore s/u, device status n, etc.)
 *   - OSC sequences (terminal title, hyperlinks): `ESC ] ... BEL` / `ESC \`
 *   - Bare CR (progress-bar redraw) → LF, so each redraw shows on its own
 *     line instead of concatenating into one mangled string. CRLF (Windows
 *     newlines) collapses to LF first to avoid `\n\n`.
 */
function sanitizeBashOutput(text: string): string {
  let out = text.replace(/\r\n/g, '\n')
  out = out.replace(/\r/g, '\n')
  // CSI: ESC [ <params 0x30-0x3f> <intermediates 0x20-0x2f> <final 0x40-0x7e>.
  // Final byte 0x6d ('m') is SGR — leave alone. Match all other CSI finals.
  out = out.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x6c\x6e-\x7e]/g, '')
  // OSC: ESC ] <body> (BEL | ESC \). Strip — title-set, hyperlinks, etc.
  out = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  return out
}

function formatBashOutput(input: BashFormatInput): string {
  const exitLine = `[exit code: ${input.exitCode}]`
  const killedLine = input.killed
    ? `[killed] Process timed out after ${input.timeoutMs}ms`
    : ''

  const trailerParts: string[] = []
  if (killedLine) trailerParts.push(killedLine)
  trailerParts.push(exitLine)
  const trailer = trailerParts.join('\n')

  const stderrTruncated = input.stderr.length > STDERR_BUDGET
    ? input.stderr.slice(0, STDERR_BUDGET) +
      `\n[… stderr truncated, ${input.stderr.length - STDERR_BUDGET} more chars …]`
    : input.stderr
  const stderrBlock = stderrTruncated.length > 0
    ? `[stderr]\n${stderrTruncated}`
    : ''

  // Budget remaining for stdout = total - trailer - stderr - separator
  // newlines. Use Math.max with 0 so deeply pathological cases (huge
  // exit-code line, etc.) still produce something.
  const overhead = trailer.length + stderrBlock.length + 4 // separators
  const stdoutBudget = Math.max(0, MAX_BASH_OUTPUT_CHARS - overhead)
  const stdoutTruncated = input.stdout.length > stdoutBudget && stdoutBudget > 200
    ? smartHeadTailTruncate(input.stdout, stdoutBudget)
    : input.stdout.length > stdoutBudget
      ? input.stdout.slice(0, stdoutBudget) + '\n[… stdout truncated …]'
      : input.stdout
  const stdoutBlock = stdoutTruncated.length > 0
    ? `[stdout]\n${stdoutTruncated}`
    : ''

  const sections: string[] = []
  if (stdoutBlock) sections.push(stdoutBlock)
  if (stderrBlock) sections.push(stderrBlock)
  sections.push(trailer)

  const result = sections.join('\n\n')
  // Edge case: command produced literally nothing AND succeeded.
  // Still emit the exit-code trailer so the model knows it ran clean.
  if (!stdoutBlock && !stderrBlock) {
    return `(no output)\n\n${trailer}`
  }
  return result
}

/** Keep head 60% + tail 20%, with a clear marker between them. */
function smartHeadTailTruncate(text: string, maxChars: number): string {
  const headLen = Math.floor(maxChars * 0.6)
  const tailLen = Math.floor(maxChars * 0.2)
  const head = text.slice(0, headLen)
  const tail = text.slice(-tailLen)
  const omitted = text.length - head.length - tail.length
  return `${head}\n[… ${omitted} chars of stdout truncated; full stderr + exit code preserved below …]\n${tail}`
}

/** Concatenate buffers and truncate to MAX_OUTPUT_BYTES, appending a notice. */
function truncateBuffer(chunks: Buffer[], totalLen: number): string {
  const buf = Buffer.concat(chunks)
  if (totalLen <= MAX_OUTPUT_BYTES) {
    return buf.toString('utf-8').trimEnd()
  }
  const truncated = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8')
  return `${truncated}\n[truncated — output exceeded ${MAX_OUTPUT_BYTES} bytes]`
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}
