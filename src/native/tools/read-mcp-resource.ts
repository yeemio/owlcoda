/**
 * OwlCoda Native ReadMcpResource Tool
 *
 * Reads a specific resource from a connected MCP server by URI.
 *
 * Upstream parity notes:
 * - Upstream reads resource content via MCP protocol
 * - Our version: delegates to MCP client provider
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface ReadMcpResourceInput {
  server_name: string
  uri: string
}

export interface MCPReadResourceProvider {
  isConnected(serverName: string): boolean
  readResource(serverName: string, uri: string): Promise<{ content: string; mimeType?: string }>
}

const defaultProvider: MCPReadResourceProvider = {
  isConnected: () => false,
  readResource: async () => ({ content: '' }),
}

export function createReadMcpResourceTool(
  provider: MCPReadResourceProvider = defaultProvider,
): NativeToolDef<ReadMcpResourceInput> {
  return {
    name: 'ReadMcpResource',
    description: 'Read a resource from a connected MCP server by URI.',

    async execute(input: ReadMcpResourceInput): Promise<ToolResult> {
      const { server_name, uri } = input

      if (!server_name) return { output: 'Error: server_name is required.', isError: true }
      if (!uri) return { output: 'Error: uri is required.', isError: true }

      if (!provider.isConnected(server_name)) {
        return {
          output: `MCP server "${server_name}" is not connected.`,
          isError: true,
        }
      }

      try {
        const result = await provider.readResource(server_name, uri)
        return {
          output: result.content,
          isError: false,
          metadata: { server_name, uri, mimeType: result.mimeType },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error reading resource: ${msg}`, isError: true }
      }
    },
  }
}
