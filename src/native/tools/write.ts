/**
 * OwlCoda Native Write Tool
 *
 * Atomic file write using temp + rename pattern.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { NativeToolDef, ToolExecutionContext, ToolResult, WriteInput } from './types.js'
import { checkWritePathAllowed } from './fs-policy.js'
import { checkProtectedWrite, formatProtectedRefusal } from './protected-source-policy.js'
import { buildSchemaError, checkWriteRequiredFields } from './tool-schema-error.js'
import { extractUserDeclaredExternalRoots } from '../task-state.js'
import { assessDestructiveReplacement, createRawRecoverySnapshot } from './destructive-write-policy.js'
import { checkNewScriptModuleMismatch } from './script-module-policy.js'

export function createWriteTool(): NativeToolDef<WriteInput> {
  return {
    name: 'write',
    description: 'Write content to a file atomically (temp + rename).',

    async execute(input: WriteInput, context?: ToolExecutionContext): Promise<ToolResult> {
      // 0.13.59 schema check — surface missing required fields with a
      // self-recoverable error before falling through to fs-policy.
      // Closes the long-context "tool_use streamed with empty input"
      // failure mode (kimi/deepseek at 700K+ tokens reproducibly drop
      // tool_use input fields).
      const missing = checkWriteRequiredFields(input)
      if (missing.length > 0) {
        return buildSchemaError(
          'write',
          missing,
          input,
          'path: string (absolute path), content: string',
        )
      }

      // Defense-in-depth: validate the target path BEFORE any mutation,
      // independent of any upstream task-scope/approval gate. Issue #3.
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
      const createDirs = input.createDirs ?? true

      // Capture pre-existing content so the transcript can render a change
      // block against the real before-state for overwrites. ENOENT → create.
      let oldContent: string | null = null
      let oldBytes = 0
      try {
        oldContent = await readFile(filePath, 'utf-8')
        oldBytes = (await stat(filePath)).size
      } catch {
        oldContent = null
      }

      const destructive = oldContent === null
        ? null
        : assessDestructiveReplacement(oldContent, input.content, oldBytes)
      if (oldContent === null) {
        const mismatch = await checkNewScriptModuleMismatch(filePath, input.content)
        if (mismatch) {
          return {
            output: `Refusing incompatible script ${filePath}: ${mismatch.reason}. Use ESM syntax or a .cjs extension.`,
            isError: true,
            metadata: { scriptModuleMismatch: true, attemptedPath: filePath, packageJsonPath: mismatch.packageJsonPath },
          }
        }
      }
      if (destructive?.destructive && input.allowDestructiveOverwrite !== true) {
        return {
          output: `Refusing destructive overwrite of ${filePath}. Re-run with allowDestructiveOverwrite=true to create a raw-byte recovery snapshot first.`,
          isError: true,
          metadata: { destructiveOverwriteDenied: true, attemptedPath: filePath, ...destructive },
        }
      }

      // Protected source-of-truth policy: refuse destructive overwrites
      // of handoff / GOAL_CONTRACT / CHANGELOG-style files unless the
      // operator explicitly opts in via replaceProtected: true.
      // See protected-source-policy.ts (issue #6).
      const protection = checkProtectedWrite(filePath, input.content, oldContent)
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

      try {
        const recoverySnapshotPath = destructive?.destructive
          ? await createRawRecoverySnapshot(filePath)
          : undefined
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
            ...(recoverySnapshotPath ? { recoverySnapshotPath } : {}),
          },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${msg}`, isError: true }
      }
    },
  }
}
