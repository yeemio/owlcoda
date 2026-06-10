/**
 * OwlCoda Native LSP Tool
 *
 * Language Server Protocol integration for code intelligence operations.
 * Supports: diagnostics, hover, definition, references, symbols.
 *
 * Upstream parity notes:
 * - Upstream has full LSP client with formatters, symbol context
 * - Our version: delegates to running LSP server if available
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface LSPInput {
  action: 'diagnostics' | 'hover' | 'definition' | 'references' | 'symbols' | 'completion'
  file_path: string
  line?: number
  character?: number
  query?: string
}

export interface LSPProvider {
  isAvailable(): boolean
  execute(action: string, params: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>
}

const defaultProvider: LSPProvider = {
  isAvailable: () => false,
  execute: async () => ({ content: 'LSP not available. Start a language server first.', isError: true }),
}

export function createLSPTool(provider: LSPProvider = defaultProvider): NativeToolDef<LSPInput> {
  return {
    name: 'LSP',
    description:
      'Language Server Protocol operations: diagnostics, hover, definition, ' +
      'references, symbols, completion. Requires a running language server.',

    async execute(input: LSPInput): Promise<ToolResult> {
      const { action, file_path, line, character, query } = input

      if (!action) return { output: 'Error: action is required.', isError: true }
      if (!file_path) return { output: 'Error: file_path is required.', isError: true }

      if (!provider.isAvailable()) {
        return {
          output: 'LSP not available. No language server is running.\n' +
                  'Tip: Start a language server with your project\'s tooling.',
          isError: true,
        }
      }

      try {
        const result = await provider.execute(action, {
          file_path,
          line,
          character,
          query,
        })
        return {
          output: result.content,
          isError: result.isError ?? false,
          metadata: { action, file_path },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `LSP error: ${msg}`, isError: true }
      }
    },
  }
}
