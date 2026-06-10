/**
 * OwlCoda Native PowerShell Tool
 *
 * Executes PowerShell commands (Windows-only, stub on macOS/Linux).
 *
 * Upstream parity notes:
 * - Upstream has full PowerShell security, path validation, mode checks
 * - Our version: stub on non-Windows, delegates to pwsh if available
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { platform } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

const execFileAsync = promisify(execFile)

export interface PowerShellInput {
  command: string
  cwd?: string
  timeoutMs?: number
}

export function createPowerShellTool(): NativeToolDef<PowerShellInput> {
  return {
    name: 'PowerShell',
    description:
      'Execute PowerShell commands. Available on Windows and macOS/Linux with pwsh installed.',

    async execute(input: PowerShellInput): Promise<ToolResult> {
      const { command, cwd, timeoutMs = 30000 } = input

      if (!command) return { output: 'Error: command is required.', isError: true }

      // Check for pwsh availability
      const shell = platform() === 'win32' ? 'powershell.exe' : 'pwsh'

      try {
        const result = await execFileAsync(shell, ['-NoProfile', '-Command', command], {
          cwd: cwd ?? process.cwd(),
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        })

        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
        return {
          output: output || '(no output)',
          isError: false,
          metadata: { shell },
        }
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          return {
            output: `PowerShell (${shell}) is not installed. On macOS: brew install powershell`,
            isError: true,
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `PowerShell error: ${msg}`, isError: true }
      }
    },
  }
}
