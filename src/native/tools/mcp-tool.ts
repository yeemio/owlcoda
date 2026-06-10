/**
 * OwlCoda Native MCP Tool
 *
 * Invokes a tool provided by an MCP (Model Context Protocol) server.
 * Requires an active MCP connection.
 *
 * Upstream parity notes:
 * - Upstream connects to MCP servers via stdio/SSE transports
 * - Our version: delegates to MCP client when available
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface MCPToolInput {
  server_name: string
  tool_name: string
  arguments?: Record<string, unknown>
}

export interface MCPClientProvider {
  isConnected(serverName: string): boolean
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>
}

/** Default provider returns not-connected */
const defaultProvider: MCPClientProvider = {
  isConnected: () => false,
  callTool: async () => ({ content: 'MCP not available', isError: true }),
}

export function createMCPTool(provider: MCPClientProvider = defaultProvider): NativeToolDef<MCPToolInput> {
  return {
    name: 'MCPTool',
    description:
      'Invoke a tool from an MCP (Model Context Protocol) server. ' +
      'Requires an active MCP server connection.',

    async execute(input: MCPToolInput): Promise<ToolResult> {
      const { server_name, tool_name, arguments: args = {} } = input

      if (!server_name) return { output: 'Error: server_name is required.', isError: true }
      if (!tool_name) return { output: 'Error: tool_name is required.', isError: true }

      if (!provider.isConnected(server_name)) {
        return {
          output: `MCP server "${server_name}" is not connected. Use /mcp to manage connections.`,
          isError: true,
        }
      }

      try {
        const result = await provider.callTool(server_name, tool_name, args)
        return {
          output: result.content,
          isError: result.isError ?? false,
          metadata: { server_name, tool_name },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `MCP error: ${msg}`, isError: true }
      }
    },
  }
}
