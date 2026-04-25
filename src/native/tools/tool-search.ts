/**
 * OwlCoda Native ToolSearch Tool
 *
 * Searches available tools by name or keyword and returns their schemas.
 * Enables deferred tool loading — only fetch schemas when needed.
 *
 * Upstream parity notes:
 * - Upstream implements deferred tool loading via system-reminder attachments
 * - Supports "select:Read,Edit,Grep" exact match and keyword search
 * - Our version: searches NATIVE_TOOL_SCHEMAS by name/keyword
 */

import type { NativeToolDef, ToolResult } from './types.js'
import { NATIVE_TOOL_SCHEMAS } from '../tool-defs.js'

export interface ToolSearchInput {
  query: string
  max_results?: number
}

export function createToolSearchTool(): NativeToolDef<ToolSearchInput> {
  return {
    name: 'ToolSearch',
    description:
      'Search available tools by name or keyword and return their schemas. ' +
      'Supports "select:Read,Edit" for exact matches or keyword search.',
    maturity: 'beta' as const,

    async execute(input: ToolSearchInput): Promise<ToolResult> {
      const { query, max_results = 10 } = input

      if (!query || typeof query !== 'string') {
        return { output: 'Error: query is required.', isError: true }
      }

      const allTools = Object.keys(NATIVE_TOOL_SCHEMAS)

      let matches: string[]

      // "select:Tool1,Tool2" — exact name selection
      if (query.startsWith('select:')) {
        const names = query.slice(7).split(',').map(s => s.trim())
        matches = names.filter(n => allTools.includes(n))
      } else {
        // Keyword search — score by name match
        const lower = query.toLowerCase()
        const keywords = lower.split(/\s+/)

        const scored = allTools.map(name => {
          const nameLower = name.toLowerCase()
          let score = 0
          for (const kw of keywords) {
            if (nameLower.includes(kw)) score += 10
            if (nameLower === kw) score += 20
          }
          return { name, score }
        })

        matches = scored
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, max_results)
          .map(s => s.name)
      }

      if (matches.length === 0) {
        return {
          output: `No tools matched query "${query}". Available: ${allTools.join(', ')}`,
          isError: false,
          metadata: { matched: 0 },
        }
      }

      // Build the XML-like function block consumed by the native runtime.
      const lines = matches.map(name => {
        const schema = NATIVE_TOOL_SCHEMAS[name]
        return `<function>{"description": "Native ${name} tool", "name": "${name}", "parameters": ${JSON.stringify(schema)}}</function>`
      })

      return {
        output: `<functions>\n${lines.join('\n')}\n</functions>`,
        isError: false,
        metadata: { matched: matches.length, tools: matches },
      }
    },
  }
}
