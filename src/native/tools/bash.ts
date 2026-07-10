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
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, stat, unlink } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type { BashInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { extractWriteTargets } from '../write-provenance.js'
import type { ExtractedWriteTarget } from '../protocol/write-provenance-types.js'
import { evaluateCommandResult } from '../command-result-semantics.js'
import { createRawRecoverySnapshot, existingFileNeedsOverwriteApproval } from './destructive-write-policy.js'
import { checkNewScriptModuleMismatch } from './script-module-policy.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB cap per stream
const PROGRESS_TAIL_LINES = 5 // Number of recent lines to include in progress events
const MAX_SOURCE_CAPTURE_BYTES = 1024 * 1024
const DEFAULT_BUNDLED_TOOL_DIRS = [
  '/Applications/Codex.app/Contents/Resources',
]

export function buildBashExecutionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  bundledToolDirs: string[] = DEFAULT_BUNDLED_TOOL_DIRS,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  const pathEntries = splitPath(env.PATH)
  for (const dir of bundledToolDirs) {
    if (!dir || !existsSync(dir)) continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!pathEntries.includes(dir)) pathEntries.push(dir)
  }
  env.PATH = pathEntries.join(delimiter)
  return env
}

function splitPath(value: string | undefined): string[] {
  if (!value) return []
  return value.split(delimiter).filter(Boolean)
}

export function resolveInterpreterFallback(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; fallback?: { requested: 'python'; applied: 'python3' } } {
  const match = /^(\s*)python(?=\s|$)/.exec(command)
  if (!match || findExecutableOnPath('python', env) || !findExecutableOnPath('python3', env)) {
    return { command }
  }
  return {
    command: `${match[1] ?? ''}python3${command.slice(match[0].length)}`,
    fallback: { requested: 'python', applied: 'python3' },
  }
}

function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of splitPath(env.PATH)) {
    const candidate = resolvePath(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH.
    }
  }
  return null
}

function canonicalizeCwd(cwd: string): string {
  const resolved = resolvePath(process.cwd(), cwd)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

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
      let effectiveCwd = canonicalizeCwd(process.cwd())
      if (typeof cwd === 'string' && cwd.length > 0) {
        const resolved = resolvePath(process.cwd(), cwd)
        try {
          if (!statSync(resolved).isDirectory()) {
            return { output: `Error: cwd is not a directory: ${resolved}`, isError: true }
          }
          effectiveCwd = realpathSync(resolved)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { output: `Error: cwd does not exist or is inaccessible: ${resolved} (${msg})`, isError: true }
        }
      }

      const symlinkViolation = detectCrossWorkspaceSymlinkCommand(command, effectiveCwd)
      if (symlinkViolation) {
        return {
          output:
            `Error: refusing cross-workspace symlink from ${symlinkViolation.targetPath} ` +
            `to ${symlinkViolation.sourcePath}. Create dependencies inside the current workspace instead.`,
          isError: true,
          metadata: {
            symlinkPolicyDenied: true,
            failureCategory: 'bash:cross_workspace_symlink',
            sourcePath: symlinkViolation.sourcePath,
            targetPath: symlinkViolation.targetPath,
            cwd: effectiveCwd,
          },
        }
      }

      const executionEnv = buildBashExecutionEnv()
      const interpreterResolution = resolveInterpreterFallback(command, executionEnv)
      const effectiveCommand = interpreterResolution.command
      let destructivePreflight: Awaited<ReturnType<typeof prepareDestructiveBashWrites>>
      try {
        destructivePreflight = await prepareDestructiveBashWrites(
          effectiveCommand,
          effectiveCwd,
          input.allowDestructiveOverwrite === true,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `Cannot prepare destructive-write recovery snapshot: ${message}`,
          isError: true,
          metadata: { recoverySnapshotFailed: true },
        }
      }
      if (destructivePreflight.deniedPath) {
        return {
          output: `Refusing destructive Bash overwrite of ${destructivePreflight.deniedPath}. Re-run with allowDestructiveOverwrite=true to create a raw-byte recovery snapshot first.`,
          isError: true,
          metadata: {
            destructiveOverwriteDenied: true,
            attemptedPath: destructivePreflight.deniedPath,
          },
        }
      }

      const captureSeeds = await prepareBashWriteCaptures(effectiveCommand, effectiveCwd)
      const result = await runCommand(effectiveCommand, effectiveCwd, timeoutMs, context, executionEnv)
      const writeCaptures = await completeBashWriteCaptures(captureSeeds)
      if (writeCaptures.length > 0) {
        result.metadata = {
          ...(result.metadata ?? {}),
          writeCaptures,
        }
      }
      if (destructivePreflight.snapshots.length > 0) {
        result.metadata = {
          ...(result.metadata ?? {}),
          recoverySnapshots: destructivePreflight.snapshots,
        }
      }
      const scriptModuleMismatches: Array<{
        attemptedPath: string
        packageJsonPath: string
        quarantinePath?: string
        quarantineError?: string
      }> = []
      for (const capture of writeCaptures) {
        if (capture.oldContent !== null) continue
        const mismatch = await checkNewScriptModuleMismatch(capture.path, capture.newContent)
        if (!mismatch) continue
        try {
          const quarantinePath = await createRawRecoverySnapshot(capture.path)
          await unlink(capture.path)
          scriptModuleMismatches.push({
            attemptedPath: capture.path,
            packageJsonPath: mismatch.packageJsonPath,
            quarantinePath,
          })
          result.output += `\nRefusing incompatible generated script ${capture.path}: ${mismatch.reason}. Preserved at ${quarantinePath}; use ESM syntax or .cjs.`
        } catch (error) {
          const quarantineError = error instanceof Error ? error.message : String(error)
          scriptModuleMismatches.push({
            attemptedPath: capture.path,
            packageJsonPath: mismatch.packageJsonPath,
            quarantineError,
          })
          result.output += `\nIncompatible generated script ${capture.path} was detected, but quarantine failed: ${quarantineError}. The file was left in place to avoid unbacked deletion.`
        }
      }
      if (scriptModuleMismatches.length > 0) {
        result.isError = true
        result.metadata = {
          ...(result.metadata ?? {}),
          scriptModuleMismatch: true,
          scriptModuleMismatches,
        }
      }
      if (interpreterResolution.fallback) {
        result.metadata = {
          ...(result.metadata ?? {}),
          interpreterFallback: interpreterResolution.fallback,
          requestedCommand: command,
          appliedCommand: effectiveCommand,
        }
      }
      return result
    },
  }
}

interface SymlinkPolicyViolation {
  sourcePath: string
  targetPath: string
}

function detectCrossWorkspaceSymlinkCommand(command: string, cwd: string, depth = 0): SymlinkPolicyViolation | null {
  for (const segment of splitShellCommandStages(command)) {
    const args = splitShellWords(segment.trim())
    const nestedScript = nestedShellScript(args)
    if (nestedScript && depth < 4) {
      const nestedViolation = detectCrossWorkspaceSymlinkCommand(nestedScript, cwd, depth + 1)
      if (nestedViolation) return nestedViolation
    }
    const operands = symbolicLinkOperands(args)
    if (!operands) continue
    if (operands.length < 1) continue
    if (operands.some(hasShellPathExpansion)) {
      return {
        sourcePath: operands[0]!,
        targetPath: operands[1] ?? basename(operands[0]!),
      }
    }
    const sourcePath = canonicalizePathWithinCwd(operands[0]!, cwd)
    const targetOperand = operands[1] ?? basename(operands[0]!)
    const targetPath = canonicalizePathWithinCwd(targetOperand, cwd)
    if (!isPathWithinRoot(sourcePath, cwd) || !isPathWithinRoot(targetPath, cwd)) {
      return { sourcePath, targetPath }
    }
  }
  return null
}

function splitShellCommandStages(command: string): string[] {
  const stages: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      current += ch
      quote = ch
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      stages.push(current)
      current = ''
      if (ch === '|' && command[i + 1] === '|') i++
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      stages.push(current)
      current = ''
      i++
      continue
    }
    current += ch
  }
  stages.push(current)
  return stages
}

function symbolicLinkOperands(args: string[]): string[] | null {
  const executableIndex = wrappedExecutableIndex(args)
  const executable = args[executableIndex]
  if (!executable || (executable !== 'ln' && !executable.endsWith('/ln'))) return null

  const commandArgs = args.slice(executableIndex + 1)
  const isSymbolic = commandArgs.some((arg) => (
    arg === '--symbolic' || /^--symbolic=/.test(arg) || (/^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes('s'))
  ))
  if (!isSymbolic) return null
  return commandArgs.filter((arg) => arg !== '--' && !arg.startsWith('-'))
}

function wrappedExecutableIndex(args: string[]): number {
  let executableIndex = 0
  while (executableIndex < args.length) {
    const token = args[executableIndex]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      executableIndex++
      continue
    }
    if (token === 'command') {
      executableIndex++
      while (args[executableIndex] === '--' || /^-[A-Za-z]+$/.test(args[executableIndex] ?? '')) {
        executableIndex++
      }
      continue
    }
    if (token === 'env') {
      executableIndex++
      while (executableIndex < args.length) {
        const envArg = args[executableIndex]!
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(envArg)) {
          executableIndex++
          continue
        }
        if (envArg === '-u' || envArg === '--unset' || envArg === '-C' || envArg === '--chdir') {
          executableIndex += 2
          continue
        }
        if (envArg.startsWith('--unset=') || envArg.startsWith('--chdir=')) {
          executableIndex++
          continue
        }
        if (envArg === '-i' || envArg === '--ignore-environment' || envArg === '-0' || envArg === '--null') {
          executableIndex++
          continue
        }
        if (envArg === '--') {
          executableIndex++
          break
        }
        if (envArg.startsWith('-')) {
          executableIndex++
          continue
        }
        break
      }
      continue
    }
    break
  }
  return executableIndex
}

function nestedShellScript(args: string[]): string | null {
  const executableIndex = wrappedExecutableIndex(args)
  const executable = args[executableIndex]
  if (!executable || !['bash', 'sh', 'zsh'].includes(basename(executable))) return null
  const shellArgs = args.slice(executableIndex + 1)
  const commandFlagIndex = shellArgs.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
  if (commandFlagIndex < 0) return null
  return shellArgs[commandFlagIndex + 1] ?? null
}

function hasShellPathExpansion(value: string): boolean {
  return value.startsWith('~') || /[$`]/.test(value)
}

function splitShellWords(input: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) words.push(current)
  return words
}

function canonicalizePathWithinCwd(value: string, cwd: string): string {
  const resolved = isAbsolute(value) ? resolvePath(value) : resolvePath(cwd, value)
  try {
    return realpathSync(resolved)
  } catch {
    const parent = resolvePath(resolved, '..')
    try {
      return resolvePath(realpathSync(parent), basename(resolved))
    } catch {
      return resolved
    }
  }
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = canonicalizePathWithinCwd(root, root)
  const normalizedCandidate = canonicalizePathWithinCwd(candidate, root)
  if (normalizedCandidate === normalizedRoot) return true
  const rel = relative(normalizedRoot, normalizedCandidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function prepareDestructiveBashWrites(
  command: string,
  cwd: string,
  allowed: boolean,
): Promise<{ deniedPath?: string; snapshots: Array<{ path: string; snapshotPath: string }> }> {
  const targets = extractWriteTargets('bash', { command }, cwd)
  const paths = [...new Set(targets.filter((target) => target.destructive).map((target) => target.path))]
  const snapshots: Array<{ path: string; snapshotPath: string }> = []
  for (const path of paths) {
    if (!await existingFileNeedsOverwriteApproval(path)) continue
    if (!allowed) return { deniedPath: path, snapshots }
    snapshots.push({ path, snapshotPath: await createRawRecoverySnapshot(path) })
  }
  return { snapshots }
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
  executionEnv: NodeJS.ProcessEnv = buildBashExecutionEnv(),
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
    let timeoutExceeded = false

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
      env: executionEnv,
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
          cwd,
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
      timeoutExceeded = true
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
      const missingCommand = detectMissingCommand(stderr, exitCode)
      const backgroundLikely = timeoutExceeded
        && !aborted
        && exitCode === 0
        && signal === null
        && isBackgroundShapedCommand(command)
      const killedForResult = killed && !backgroundLikely
      const commandResult = evaluateCommandResult({ command, exitCode, stdout, stderr })

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
            killed: killedForResult,
            timeoutMs,
            timeoutExceeded,
            backgroundLikely,
          })
      const semanticOutput = commandResult.semanticSuccess
        ? `${formatted}\n[semantic success: ${commandResult.successDetail}]`
        : formatted
      const output = missingCommand
        ? [
            semanticOutput,
            '',
            `[command not found] Missing executable "${missingCommand}". Use an installed fallback or install the command; do not treat this as missing project data.`,
          ].join('\n')
        : semanticOutput

      resolve({
        output,
        isError: aborted ? true : !commandResult.success,
        metadata: {
          exitCode,
          killed: killedForResult,
          signal,
          aborted,
          forcedRelease,
          ...(timeoutExceeded ? { timeoutExceeded: true } : {}),
          ...(backgroundLikely ? { backgroundLikely: true } : {}),
          ...(missingCommand ? { commandNotFound: true, missingCommand } : {}),
          ...(commandResult.semanticSuccess ? {
            semanticSuccess: true,
            commandResultSemantics: commandResult.commandResultSemantics,
          } : {}),
          cwd,
          path: executionEnv.PATH ?? '',
        },
      })
    })
  })
}

function detectMissingCommand(stderr: string, exitCode: number): string | null {
  if (exitCode !== 127 || !stderr) return null
  const match = stderr.match(/(?:^|\n)(?:bash:\s*)?(?:line\s+\d+:\s*)?([A-Za-z0-9._+-]+):\s+command not found\b/i)
  return match?.[1] ?? null
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
  timeoutExceeded?: boolean
  backgroundLikely?: boolean
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
  const timeoutExceededLine = input.timeoutExceeded && input.backgroundLikely && !input.killed
    ? `[timeout exceeded] Command exited 0 after timeout signal; background work may still be running.`
    : ''

  const trailerParts: string[] = []
  if (killedLine) trailerParts.push(killedLine)
  if (timeoutExceededLine) trailerParts.push(timeoutExceededLine)
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

function isBackgroundShapedCommand(command: string): boolean {
  return /(^|[^&])&(?!&)/.test(command)
    || /\b(?:nohup|setsid|disown)\b/.test(command)
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
