/**
 * OwlCoda Native Tungsten Tool (stub)
 *
 * Placeholder for Tungsten integration — not available in local-LLM mode.
 * Upstream has this as a disabled stub as well.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface TungstenInput {
  [key: string]: unknown
}

export function createTungstenTool(): NativeToolDef<TungstenInput> {
  return {
    name: 'Tungsten',
    description: 'Tungsten integration (not available in local mode).',
    maturity: 'experimental' as const,

    async execute(_input: TungstenInput): Promise<ToolResult> {
      return {
        output: 'Tungsten is not available in local-LLM mode.',
        isError: true,
      }
    },
  }
}
