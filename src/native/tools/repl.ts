/**
 * OwlCoda Native REPL Tool
 *
 * Batch-executes multiple tool operations in a single call.
 * When REPL mode is on, primitive tools (read/write/edit/bash/glob/grep)
 * are hidden from direct use, forcing batch operation through this tool.
 *
 * Upstream parity notes:
 * - Upstream hides primitive tools in REPL mode, runs them inside a VM
 * - Our version: simplified dispatcher that runs tool calls sequentially
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface REPLInput {
  /** Array of tool calls to execute in batch */
  operations: Array<{
    tool: string
    input: Record<string, unknown>
  }>
}

interface REPLToolDeps {
  /** Execute a tool by name — delegates to the dispatcher */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
}

export function createREPLTool(deps: REPLToolDeps): NativeToolDef<REPLInput> {
  return {
    name: 'REPL',
    description:
      'Batch-execute multiple tool operations in one call. ' +
      'Runs operations sequentially and returns aggregated results.',

    async execute(input: REPLInput): Promise<ToolResult> {
      const { operations } = input

      if (!Array.isArray(operations) || operations.length === 0) {
        return { output: 'Error: operations array is required and must not be empty.', isError: true }
      }

      const results: Array<{ tool: string; output: string; isError: boolean }> = []
      let hasErrors = false

      for (const op of operations) {
        if (!op.tool || typeof op.tool !== 'string') {
          results.push({ tool: '(unknown)', output: 'Error: tool name is required', isError: true })
          hasErrors = true
          continue
        }

        try {
          const result = await deps.executeTool(op.tool, op.input ?? {})
          results.push({ tool: op.tool, output: result.output, isError: result.isError ?? false })
          if (result.isError) hasErrors = true
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          results.push({ tool: op.tool, output: `Error: ${msg}`, isError: true })
          hasErrors = true
        }
      }

      const outputLines = results.map((r, i) => {
        const status = r.isError ? '✗' : '✓'
        return `[${i + 1}/${results.length}] ${status} ${r.tool}:\n${r.output}`
      })

      return {
        output: outputLines.join('\n\n'),
        isError: hasErrors,
        metadata: {
          totalOperations: results.length,
          succeeded: results.filter(r => !r.isError).length,
          failed: results.filter(r => r.isError).length,
        },
      }
    },
  }
}
