/**
 * OwlCoda Native StructuredOutput Tool (SyntheticOutputTool)
 *
 * Returns structured JSON output for non-interactive sessions.
 * Validates input against a provided JSON schema.
 *
 * Upstream parity notes:
 * - Upstream uses Ajv validation, only enabled in non-interactive mode
 * - Our version: validates basic structure, returns formatted JSON
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface StructuredOutputInput {
  [key: string]: unknown
}

export function createStructuredOutputTool(): NativeToolDef<StructuredOutputInput> {
  return {
    name: 'StructuredOutput',
    description:
      'Return structured output in the requested format. ' +
      'Call this tool exactly once at the end of a response to provide structured JSON output.',
    maturity: 'beta' as const,

    async execute(input: StructuredOutputInput): Promise<ToolResult> {
      if (!input || typeof input !== 'object') {
        return { output: 'Error: input must be an object.', isError: true }
      }

      const json = JSON.stringify(input, null, 2)

      return {
        output: json,
        isError: false,
        metadata: { structuredOutput: input },
      }
    },
  }
}
