/**
 * OwlCoda Native Edit Tool
 *
 * Precise string replacement in files.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { EditInput, NativeToolDef, ToolResult } from './types.js'

export function createEditTool(): NativeToolDef<EditInput> {
  return {
    name: 'edit',
    description:
      'Replace exactly one occurrence of oldStr with newStr in a file.',

    async execute(input: EditInput): Promise<ToolResult> {
      const filePath = resolve(input.path)

      try {
        const content = await readFile(filePath, 'utf-8')
        const { oldStr, newStr } = input

        if (!oldStr) {
          return { output: 'Error: oldStr must not be empty', isError: true }
        }

        // Count occurrences
        const occurrences = countOccurrences(content, oldStr)

        if (occurrences === 0) {
          return {
            output: `Error: oldStr not found in ${filePath}`,
            isError: true,
          }
        }

        if (occurrences > 1) {
          return {
            output: `Error: oldStr found ${occurrences} times in ${filePath} (must be unique)`,
            isError: true,
          }
        }

        // Exactly one occurrence — replace it
        const updated = content.replace(oldStr, newStr)
        await writeFile(filePath, updated, 'utf-8')

        // Build context diff: a few lines around the change for display
        const contextLines = 3
        const lines = content.split('\n')
        const changeStart = content.slice(0, content.indexOf(oldStr)).split('\n').length - 1
        const oldLineCount = oldStr.split('\n').length
        const start = Math.max(0, changeStart - contextLines)
        const end = Math.min(lines.length, changeStart + oldLineCount + contextLines)
        const contextOld = lines.slice(start, end).join('\n')
        const updatedLines = updated.split('\n')
        const newLineCount = newStr.split('\n').length
        const endNew = Math.min(updatedLines.length, changeStart + newLineCount + contextLines)
        const contextNew = updatedLines.slice(start, endNew).join('\n')

        return {
          output: `Edited ${filePath}: replaced 1 occurrence`,
          isError: false,
          metadata: {
            path: filePath,
            oldContext: contextOld,
            newContext: contextNew,
            // 1-based line number of the first line in the captured context,
            // so the change block can label hunk lines with real file positions.
            contextStartLine: start + 1,
            changeKind: 'update',
          },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${msg}`, isError: true }
      }
    },
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count++
    pos = idx + needle.length
  }
  return count
}
