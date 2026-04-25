/**
 * OwlCoda Native Brief Tool
 *
 * Provides brief, concise responses and manages file attachments.
 * In bridge mode, handles file upload/validation.
 *
 * Upstream parity notes:
 * - Upstream validates attachment paths, uploads to bridge
 * - Our version: validates local file attachments
 */

import { stat, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { NativeToolDef, ToolResult } from './types.js'

export interface BriefInput {
  message: string
  attachments?: string[]
}

export function createBriefTool(): NativeToolDef<BriefInput> {
  return {
    name: 'Brief',
    description:
      'Send a brief, concise response to the user. ' +
      'Optionally attach files by path.',

    async execute(input: BriefInput): Promise<ToolResult> {
      const { message, attachments } = input

      if (!message) return { output: 'Error: message is required.', isError: true }

      // Validate attachments if provided
      const validatedFiles: Array<{ path: string; size: number }> = []
      if (attachments && attachments.length > 0) {
        for (const rawPath of attachments) {
          const fullPath = resolve(rawPath)
          try {
            await access(fullPath)
            const s = await stat(fullPath)
            if (!s.isFile()) {
              return {
                output: `Attachment "${rawPath}" is not a regular file.`,
                isError: true,
              }
            }
            validatedFiles.push({ path: fullPath, size: s.size })
          } catch {
            return {
              output: `Attachment "${rawPath}" does not exist or is not accessible.`,
              isError: true,
            }
          }
        }
      }

      const parts = [message]
      if (validatedFiles.length > 0) {
        parts.push(`\nAttachments: ${validatedFiles.map(f => f.path).join(', ')}`)
      }

      return {
        output: parts.join(''),
        isError: false,
        metadata: {
          attachments: validatedFiles,
        },
      }
    },
  }
}
