/**
 * OwlCoda Native Write Tool
 *
 * Atomic file write using temp + rename pattern.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { NativeToolDef, ToolResult, WriteInput } from './types.js'
import { checkWritePathAllowed } from './fs-policy.js'

export function createWriteTool(): NativeToolDef<WriteInput> {
  return {
    name: 'write',
    description: 'Write content to a file atomically (temp + rename).',

    async execute(input: WriteInput): Promise<ToolResult> {
      // Defense-in-depth: validate the target path BEFORE any mutation,
      // independent of any upstream task-scope/approval gate. Issue #3.
      const policy = checkWritePathAllowed(input.path)
      if (!policy.allowed) {
        return {
          output: `Error: ${policy.reason}`,
          isError: true,
          metadata: { fsPolicyDenied: true, attemptedPath: policy.attemptedPath },
        }
      }
      const filePath = policy.resolvedPath
      const createDirs = input.createDirs ?? true

      // Capture pre-existing content so the transcript can render a change
      // block against the real before-state for overwrites. ENOENT → create.
      let oldContent: string | null = null
      try {
        oldContent = await readFile(filePath, 'utf-8')
      } catch {
        oldContent = null
      }

      try {
        if (createDirs) {
          await mkdir(dirname(filePath), { recursive: true })
        }

        // Atomic write: write to temp file, then rename
        const tmpPath = `${filePath}.owlcoda-tmp-${randomBytes(4).toString('hex')}`
        await writeFile(tmpPath, input.content, 'utf-8')
        await rename(tmpPath, filePath)

        const bytes = Buffer.byteLength(input.content, 'utf-8')
        const lineCount = input.content.split('\n').length
        const created = oldContent === null
        return {
          output: `Wrote ${bytes} bytes to ${filePath}`,
          isError: false,
          metadata: {
            bytes,
            path: filePath,
            lineCount,
            created,
            oldContent,
            newContent: input.content,
            changeKind: created ? 'create' : 'overwrite',
          },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${msg}`, isError: true }
      }
    },
  }
}
