/**
 * OwlCoda Native Edit Tool
 *
 * Precise string replacement in files.
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { EditInput, NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { checkWritePathAllowed } from './fs-policy.js'
import { checkProtectedWrite, formatProtectedRefusal } from './protected-source-policy.js'
import { buildSchemaError, checkEditRequiredFields } from './tool-schema-error.js'
import { buildOldStrNotFoundError, detectLineEnding } from './edit-helpers.js'
import { extractUserDeclaredExternalRoots } from '../task-state.js'

export function createEditTool(): NativeToolDef<EditInput> {
  return {
    name: 'edit',
    description:
      'Replace oldStr with newStr in a file. Default: must match exactly once. ' +
      'Pass replaceAll: true to replace every occurrence (renames, mass refactors).',

    async execute(input: EditInput, context?: ToolExecutionContext): Promise<ToolResult> {
      // 0.13.59 schema check — surface missing required fields with a
      // self-recoverable error before falling through to fs-policy.
      const missing = checkEditRequiredFields(input)
      if (missing.length > 0) {
        return buildSchemaError(
          'edit',
          missing,
          input,
          'path: string, oldStr: string (non-empty), newStr: string (may be empty for deletion)',
        )
      }

      // Defense-in-depth: validate the target path BEFORE any mutation.
      // Issue #3.
      const externalScopes = extractUserDeclaredExternalRoots(context?.taskState)
      const policy = checkWritePathAllowed(input.path, { externalScopes })
      if (!policy.allowed) {
        return {
          output: `Error: ${policy.reason}`,
          isError: true,
          metadata: { fsPolicyDenied: true, attemptedPath: policy.attemptedPath },
        }
      }
      const filePath = policy.resolvedPath

      try {
        const content = await readFile(filePath, 'utf-8')
        const { oldStr, newStr } = input

        if (!oldStr) {
          return { output: 'Error: oldStr must not be empty', isError: true }
        }

        // Count occurrences
        const occurrences = countOccurrences(content, oldStr)

        if (occurrences === 0) {
          // 0.13.59: enrich error with line-ending diagnostic + fuzzy-
          // match suggestions. The CRLF-vs-LF case is what bit us in
          // the sieracMes-AI dogfood (admin_routes.py was CRLF, model
          // oldStr was LF, every edit silently missed).
          return {
            output: buildOldStrNotFoundError(filePath, content, oldStr),
            isError: true,
            metadata: {
              oldStrNotFound: true,
              fileLineEnding: detectLineEnding(content),
              oldStrLineEnding: detectLineEnding(oldStr),
            },
          }
        }

        if (occurrences > 1 && !input.replaceAll) {
          return {
            output: `Error: oldStr found ${occurrences} times in ${filePath} (must be unique). ` +
              `Either: (a) add 1-3 lines of surrounding context to oldStr (and matching context in ` +
              `newStr) so the match is unambiguous; (b) re-read the file and pick the specific ` +
              `occurrence; or (c) pass \`replaceAll: true\` if you intentionally want all ` +
              `${occurrences} occurrences replaced (renames, mass refactors).`,
            isError: true,
            metadata: { occurrencesFound: occurrences, replaceAllAvailable: true },
          }
        }

        // 0.13.60: replaceAll=true → replace every occurrence using
        // String.prototype.replaceAll (literal, not regex). Default
        // single-occurrence path is unchanged.
        const replacedCount = input.replaceAll ? occurrences : 1
        const updated = input.replaceAll
          ? content.replaceAll(oldStr, newStr)
          : content.replace(oldStr, newStr)

        // Protected source-of-truth policy: even targeted edits can
        // delete entire sections (e.g. oldStr = the Suggested Commands
        // block, newStr = ''). Run the same check as write.ts so the
        // operator must pass replaceProtected: true to confirm.
        const protection = checkProtectedWrite(filePath, updated, content)
        if (protection.protected && protection.destructive && !input.replaceProtected) {
          return {
            output: formatProtectedRefusal(filePath, protection),
            isError: true,
            metadata: {
              protectedSourceDenied: true,
              attemptedPath: filePath,
              removedSections: protection.removedSections,
              oldLineCount: protection.oldLineCount,
              newLineCount: protection.newLineCount,
              removedLineCount: protection.removedLineCount,
            },
          }
        }

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
          output: `Edited ${filePath}: replaced ${replacedCount} occurrence${replacedCount === 1 ? '' : 's'}`,
          isError: false,
          metadata: {
            path: filePath,
            occurrencesReplaced: replacedCount,
            replaceAllUsed: input.replaceAll === true,
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
