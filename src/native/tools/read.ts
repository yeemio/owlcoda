/**
 * OwlCoda Native Read Tool
 *
 * Reads file contents with optional line range and byte offset/limit.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { NativeToolDef, ReadInput, ToolExecutionContext, ToolResult } from './types.js'
import type { TaskExecutionState } from '../protocol/types.js'
import { checkReadPathAllowed } from './fs-policy.js'
import { detectLineEnding, type LineEndingKind } from './edit-helpers.js'

/**
 * 0.13.69 read_repetition_nudge_v1.
 *
 * The 2026-05-07 deepseek/kimi engineering-contract dogfood logged 7+
 * successful reads of the same `mionyee-mobile/src/services/api.ts`
 * within one task — each read returned the same bytes (mtime/size
 * unchanged), each iteration burned ~120s, the loop guards never
 * fired (read is "investigation," not error). This is the named
 * "endless file reading" failure mode (SWE-Bench Pro 2025: 17.0% of
 * Sonnet 4 failures).
 *
 * Industry consensus from the survey:
 *   - SWE-agent abandoned runtime detectors here ("false positives
 *     too high; cost cap fires anyway") — arxiv 2405.15793.
 *   - Cursor ships hard-stop, gets disable-this complaints.
 *   - Anthropic explicitly declined to ship loop detection (closed
 *     not-planned, external-coding-assistant#4277).
 *   - The technique with the most cited evidence is *tool-result
 *     side-channel signaling*: enrich the tool output with a runtime
 *     nudge so the model sees "you already read this" in-context,
 *     rather than blocking the call. Behavioral economics, not
 *     enforcement.
 *
 * This module is the v1: don't block, don't substitute cached
 * content, every call still does a real stat+read. But when the same
 * `(realpath, range, mtime, size)` is read a second time within the
 * same TaskExecutionState identity, prepend a notice. Third+ read
 * upgrades to a stronger warning. File mutation (mtime or size
 * changes) resets the counter — the read is no longer "the same
 * file."
 *
 * v2 (range suggestion for oversized full reads) and v3 (cached
 * return) are deliberately deferred. The first-version target is
 * behavioral correction, not IO savings.
 *
 * Storage: a module-level WeakMap keyed by TaskExecutionState
 * identity. `ensureTaskExecutionState` reuses the same object across
 * tool-use iterations within one task (it only rebuilds when
 * `sourceTurnHash` changes, which happens on a new user message), so
 * the ledger accumulates correctly within a task and resets
 * automatically on task boundaries via WeakMap GC.
 */
interface ReadEntry {
  realpath: string
  rangeKey: string
  mtimeMs: number
  size: number
  count: number
}
interface ReadRepetitionLedger {
  entries: Map<string, ReadEntry>
}
const readRepetitionLedgers = new WeakMap<TaskExecutionState, ReadRepetitionLedger>()

function getLedger(taskState: TaskExecutionState): ReadRepetitionLedger {
  let ledger = readRepetitionLedgers.get(taskState)
  if (!ledger) {
    ledger = { entries: new Map() }
    readRepetitionLedgers.set(taskState, ledger)
  }
  return ledger
}

function makeRangeKey(input: { offset?: number; limit?: number; startLine?: number; endLine?: number }): string {
  if (input.offset !== undefined || input.limit !== undefined) {
    return `byte:${input.offset ?? 0}:${input.limit ?? 'full'}`
  }
  if (input.startLine !== undefined || input.endLine !== undefined) {
    return `lines:${input.startLine ?? 1}:${input.endLine ?? 'end'}`
  }
  return 'full'
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

export function recordReadAndBuildNudge(
  taskState: TaskExecutionState | undefined,
  realpath: string,
  rangeKey: string,
  mtimeMs: number,
  size: number,
): NudgeResult {
  if (!taskState) return { prefix: null, count: 1 }
  const ledger = getLedger(taskState)
  const key = `${realpath}|${rangeKey}`
  const existing = ledger.entries.get(key)
  if (!existing) {
    ledger.entries.set(key, { realpath, rangeKey, mtimeMs, size, count: 1 })
    return { prefix: null, count: 1 }
  }
  if (existing.mtimeMs !== mtimeMs || existing.size !== size) {
    // File mutated since the prior read (an Edit/Write landed, or an
    // external process changed it). Reset the counter and stay
    // silent — the model genuinely needs the new bytes.
    ledger.entries.set(key, { realpath, rangeKey, mtimeMs, size, count: 1 })
    return { prefix: null, count: 1 }
  }
  existing.count += 1
  if (existing.count === 2) {
    return {
      prefix:
        `[Runtime read-repeat notice]\n` +
        `You already read this file earlier in this task: ${realpath}\n` +
        `same mtime, same size, same range. Re-reading is unlikely to add new information.\n` +
        `If your next goal is synthesis or writing, stop reading and produce the draft/write tool.`,
      count: existing.count,
    }
  }
  return {
    prefix:
      `[Runtime read-repeat warning]\n` +
      `This is the ${existing.count}${ordinalSuffix(existing.count)} read of the same unchanged file in this task: ${realpath}\n` +
      `Use the existing evidence, narrow to a line range, grep a specific symbol, or write the deliverable.`,
    count: existing.count,
  }
}

/** Test-only: clear the ledger for a given task. Production callers must not use this. */
export function __resetReadRepetitionLedgerForTask(taskState: TaskExecutionState): void {
  readRepetitionLedgers.delete(taskState)
}

/**
 * 0.13.70 execution_economics_v1 — production_gate_v1.
 *
 * Aggregate stats over the read-repetition ledger so the
 * conversation loop can decide whether the model has done enough
 * investigation to warrant a production-gate nudge. `distinctFiles`
 * counts unique realpaths regardless of range. `totalReads` sums
 * the per-entry `count` (one entry per `(realpath, rangeKey)`).
 *
 * Returns zeros when no ledger exists for this task — calling
 * before the first read is safe. Does not allocate a ledger as a
 * side effect.
 */
export function getReadLedgerStats(
  taskState: TaskExecutionState | undefined,
): { distinctFiles: number; totalReads: number } {
  if (!taskState) return { distinctFiles: 0, totalReads: 0 }
  const ledger = readRepetitionLedgers.get(taskState)
  if (!ledger) return { distinctFiles: 0, totalReads: 0 }
  const realpaths = new Set<string>()
  let totalReads = 0
  for (const entry of ledger.entries.values()) {
    realpaths.add(entry.realpath)
    totalReads += entry.count
  }
  return { distinctFiles: realpaths.size, totalReads }
}

/**
 * 0.13.59: when a file uses CRLF or mixed line endings, prefix the
 * read output with a small bracketed header so the model knows.
 * Edit failures on CRLF files were a recurring long-context confusion
 * — the model copied an LF block as oldStr and silently missed every
 * time. Surfacing the line-ending kind in the read output lets the
 * model preempt the issue. LF (the common case) stays silent.
 */
function buildLineEndingHeader(kind: LineEndingKind): string | null {
  if (kind === 'CRLF') return '[file uses CRLF line endings — copy oldStr exactly when editing]'
  if (kind === 'mixed') return '[file has MIXED line endings — be careful when editing across line boundaries]'
  return null
}

/**
 * 0.13.60: prepend a `[file: <abs-path>]` header so the model can
 * unambiguously associate this read's content with its source path.
 * Long-context sessions reading 5+ files in parallel previously had
 * tool_results that all looked like `1\tline1\n2\tline2\n…` — the
 * model could lose track of which output went with which path.
 *
 * Combined with the line-ending header (when applicable):
 *   [file: /abs/path/to/file.py]
 *   [file uses CRLF line endings — copy oldStr exactly when editing]
 *   1\tline content
 *   2\tline content
 */
function buildHeader(filePath: string, lineEndingKind: LineEndingKind): string {
  const lines: string[] = [`[file: ${filePath}]`]
  const lineEndingHeader = buildLineEndingHeader(lineEndingKind)
  if (lineEndingHeader) lines.push(lineEndingHeader)
  return lines.join('\n')
}

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2 MiB default limit
const MAX_READ_OUTPUT_CHARS = 128 * 1024

export function createReadTool(): NativeToolDef<ReadInput> {
  return {
    name: 'read',
    description:
      'Read file contents, optionally restricted to a line range or byte range.',

    async execute(input: ReadInput, context?: ToolExecutionContext): Promise<ToolResult> {
      try {
        throwIfAborted(context?.signal)
        const policy = checkReadPathAllowed(input.path)
        if (!policy.allowed) {
          return {
            output: `Error: ${policy.reason}`,
            isError: true,
            metadata: { fsPolicyDenied: true, attemptedPath: policy.attemptedPath },
          }
        }
        const filePath = await resolveReadablePath(policy.resolvedPath)
        throwIfAborted(context?.signal)

        const info = await stat(filePath)
        if (info.isDirectory()) {
          return {
            output: `Error: ${filePath} is a directory, not a file`,
            isError: true,
          }
        }
        throwIfAborted(context?.signal)

        const result = (input.offset !== undefined || input.limit !== undefined)
          ? await readByteRange(filePath, input.offset ?? 0, input.limit ?? MAX_READ_BYTES, context?.signal)
          : await readLines(filePath, input.startLine, input.endLine, context?.signal)

        // 0.13.69 read-repeat nudge — prepend a runtime notice when the
        // model is reading the same (path, range) on an unchanged file
        // for the second+ time within this task. Errors are not
        // counted (we don't want a failed read to make the next
        // legitimate retry look like a repeat).
        if (!result.isError && context?.taskState) {
          const rangeKey = makeRangeKey(input)
          const nudge = recordReadAndBuildNudge(
            context.taskState,
            filePath,
            rangeKey,
            info.mtimeMs,
            info.size,
          )
          if (nudge.prefix) {
            result.output = `${nudge.prefix}\n${result.output}`
            result.metadata = {
              ...(result.metadata ?? {}),
              readRepeatCount: nudge.count,
            }
          }
        }
        return result
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Error: ${msg}`,
          isError: true,
          metadata: isAbortError(err) ? { aborted: true } : undefined,
        }
      }
    },
  }
}

/**
 * Accept grep/search-style paths such as /abs/file.ts:12 or file.ts:12:3 and
 * strip trailing line/column suffixes before resolving the real file path.
 */
function normalizeReadPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  const match = trimmed.match(/^(.*?):(\d+)(?::(\d+))?$/)
  if (!match) return trimmed
  return match[1] || trimmed
}

/**
 * Resolve a user/model-provided path into a concrete readable file path.
 * Accepts grep-style suffixes and also repairs wrapped/truncated filename
 * prefixes when a unique sibling match exists in the target directory.
 */
async function resolveReadablePath(rawPath: string): Promise<string> {
  const normalized = normalizeReadPath(rawPath)
  const resolved = resolve(normalized)

  try {
    await stat(resolved)
    return resolved
  } catch {
    // Fall through to prefix recovery.
  }

  const dir = dirname(resolved)
  const filePrefix = basename(resolved)
  if (!filePrefix || filePrefix.length < 3) return resolved

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(filePrefix))
      .map((entry) => resolve(dir, entry.name))

    if (matches.length === 1) return matches[0]!
  } catch {
    // Ignore directory-read failures and return the original resolved path.
  }

  return resolved
}

/** Read a byte range from a file. */
async function readByteRange(
  filePath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const clampedLimit = Math.min(limit, MAX_READ_BYTES)
  let fh
  try {
    throwIfAborted(signal)
    fh = await open(filePath, 'r')
    const buf = Buffer.alloc(clampedLimit)
    const { bytesRead } = await fh.read(buf, 0, clampedLimit, offset)
    throwIfAborted(signal)
    const content = buf.subarray(0, bytesRead).toString('utf-8')
    // 0.13.60: byte-range reads also get a path header so the model
    // can associate this chunk with its source. Line-ending detection
    // is unreliable on a partial buffer, so we skip that label here.
    const header = `[file: ${filePath}] [byte range: offset=${offset}, length=${bytesRead}]`
    const limited = limitReadOutput(`${header}\n${content}`, filePath)
    return {
      output: limited.output,
      isError: false,
      metadata: {
        bytesRead,
        offset,
        truncated: bytesRead === clampedLimit,
        path: filePath,
        ...(limited.truncated
          ? { outputTruncated: true, displayedChars: limited.displayedChars, omittedChars: limited.omittedChars }
          : {}),
      },
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `Error: ${msg}`, isError: true }
  } finally {
    await fh?.close()
  }
}

/** Read file and optionally extract a line range. Lines are 1-based. */
async function readLines(
  filePath: string,
  startLine?: number,
  endLine?: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let fh
  try {
    throwIfAborted(signal)
    fh = await open(filePath, 'r')
    const info = await fh.stat()

    if (info.size > MAX_READ_BYTES && startLine === undefined) {
      await fh.close()
      // Fall back to byte-range read for oversized files
      return readByteRange(filePath, 0, MAX_READ_BYTES)
    }

    const raw = await fh.readFile('utf-8')
    throwIfAborted(signal)
    await fh.close()

    // 0.13.59: detect line endings on the raw bytes BEFORE the split,
    // so we can warn the model about CRLF or mixed files.
    const lineEndingKind = detectLineEnding(raw)
    // 0.13.60: combined header: file path + line-ending kind.
    const header = buildHeader(filePath, lineEndingKind)

    // Split on either CRLF or LF so line numbering is correct
    // regardless of the file's encoding choice.
    const allLines = raw.split(/\r?\n/)

    // No line range → return with line numbers
    if (startLine === undefined && endLine === undefined) {
      const numbered = allLines.map((line, i) => `${i + 1}\t${line}`)
      const body = numbered.join('\n')
      const limited = limitReadOutput(`${header}\n${body}`, filePath)
      return {
        output: limited.output,
        isError: false,
        metadata: {
          totalLines: allLines.length,
          lineEndingKind,
          path: filePath,
          ...(limited.truncated
            ? { outputTruncated: true, displayedChars: limited.displayedChars, omittedChars: limited.omittedChars }
            : {}),
        },
      }
    }

    // Clamp to valid range
    const start = Math.max(1, startLine ?? 1)
    const end = Math.min(allLines.length, endLine ?? allLines.length)

    if (start > allLines.length) {
      return {
        output: `Error: startLine ${start} exceeds file length (${allLines.length} lines)`,
        isError: true,
      }
    }

    const slice = allLines.slice(start - 1, end)
    const numbered = slice.map((line, i) => `${start + i}\t${line}`)
    const body = numbered.join('\n')
    const limited = limitReadOutput(`${header}\n${body}`, filePath)
    return {
      output: limited.output,
      isError: false,
      metadata: {
        totalLines: allLines.length,
        startLine: start,
        endLine: end,
        lineEndingKind,
        path: filePath,
        ...(limited.truncated
          ? { outputTruncated: true, displayedChars: limited.displayedChars, omittedChars: limited.omittedChars }
          : {}),
      },
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `Error: ${msg}`, isError: true }
  } finally {
    // Close error path used to be silent. In a long session with many
    // reads (and some edge cases like NFS, stale FDs, tmpfs unmount),
    // silently-swallowed close failures can leak file descriptors. Log
    // so the operator can see the leak rather than waiting for EMFILE.
    await fh?.close().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[read] filehandle close failed: ${msg}`)
    })
  }
}

function limitReadOutput(output: string, filePath: string): {
  output: string
  truncated: boolean
  displayedChars: number
  omittedChars: number
} {
  if (output.length <= MAX_READ_OUTPUT_CHARS) {
    return { output, truncated: false, displayedChars: output.length, omittedChars: 0 }
  }
  const omittedChars = output.length - MAX_READ_OUTPUT_CHARS
  return {
    output:
      `${output.slice(0, MAX_READ_OUTPUT_CHARS)}\n` +
      `[read output truncated: ${omittedChars} chars omitted from ${filePath}. Use startLine/endLine or offset/limit to inspect the omitted section.]`,
    truncated: true,
    displayedChars: MAX_READ_OUTPUT_CHARS,
    omittedChars,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error('read aborted by user')
  err.name = 'AbortError'
  throw err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
