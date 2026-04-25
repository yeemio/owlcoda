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
import type { BashInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB cap per stream
const PROGRESS_TAIL_LINES = 5 // Number of recent lines to include in progress events

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

      return runCommand(command, effectiveCwd, timeoutMs, context)
    },
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

      const stdout = truncateBuffer(stdoutChunks, stdoutTotal)
      const stderr = truncateBuffer(stderrChunks, stderrTotal)
      const exitCode = code ?? (signal ? 128 : 1)

      const parts: string[] = []
      if (stdout.length > 0) parts.push(stdout)
      if (stderr.length > 0) parts.push(`[stderr]\n${stderr}`)

      if (killed && !aborted) {
        parts.push(`[killed] Process timed out after ${timeoutMs}ms`)
      }

      const output =
        parts.length > 0 ? parts.join('\n') : '(no output)'

      resolve({
        output: aborted ? '[aborted] Process cancelled by user' : output,
        isError: aborted ? true : exitCode !== 0,
        metadata: { exitCode, killed, signal, aborted, forcedRelease },
      })
    })
  })
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
