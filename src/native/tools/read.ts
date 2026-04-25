/**
 * OwlCoda Native Read Tool
 *
 * Reads file contents with optional line range and byte offset/limit.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { NativeToolDef, ReadInput, ToolExecutionContext, ToolResult } from './types.js'

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2 MiB default limit

export function createReadTool(): NativeToolDef<ReadInput> {
  return {
    name: 'read',
    description:
      'Read file contents, optionally restricted to a line range or byte range.',

    async execute(input: ReadInput, context?: ToolExecutionContext): Promise<ToolResult> {
      try {
        throwIfAborted(context?.signal)
        const filePath = await resolveReadablePath(input.path)
        throwIfAborted(context?.signal)

        const info = await stat(filePath)
        if (info.isDirectory()) {
          return {
            output: `Error: ${filePath} is a directory, not a file`,
            isError: true,
          }
        }
        throwIfAborted(context?.signal)

        // Byte-range read
        if (input.offset !== undefined || input.limit !== undefined) {
          return readByteRange(filePath, input.offset ?? 0, input.limit ?? MAX_READ_BYTES, context?.signal)
        }

        // Full or line-range read
        return readLines(filePath, input.startLine, input.endLine, context?.signal)
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
    return {
      output: content,
      isError: false,
      metadata: { bytesRead, offset, truncated: bytesRead === clampedLimit },
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

    const allLines = raw.split('\n')

    // No line range → return with line numbers
    if (startLine === undefined && endLine === undefined) {
      const numbered = allLines.map((line, i) => `${i + 1}\t${line}`)
      return { output: numbered.join('\n'), isError: false, metadata: { totalLines: allLines.length } }
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
    return {
      output: numbered.join('\n'),
      isError: false,
      metadata: { totalLines: allLines.length, startLine: start, endLine: end },
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error('read aborted by user')
  err.name = 'AbortError'
  throw err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
