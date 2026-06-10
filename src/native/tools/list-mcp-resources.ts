/**
 * OwlCoda Native ListMcpResources Tool
 *
 * Lists resources available from a connected MCP server.
 *
 * Upstream parity notes:
 * - Upstream queries MCP server resources endpoint
 * - Our version: delegates to MCP client provider
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface ListMcpResourcesInput {
  server_name: string
}

export interface MCPResourceProvider {
  isConnected(serverName: string): boolean
  listResources(serverName: string): Promise<Array<{ uri: string; name: string; description?: string }>>
}

const defaultProvider: MCPResourceProvider = {
  isConnected: () => false,
  listResources: async () => [],
}

export function createListMcpResourcesTool(
  provider: MCPResourceProvider = defaultProvider,
): NativeToolDef<ListMcpResourcesInput> {
  return {
    name: 'ListMcpResources',
    description: 'List resources available from a connected MCP server.',

    async execute(input: ListMcpResourcesInput): Promise<ToolResult> {
      const { server_name } = input

      if (!server_name) return { output: 'Error: server_name is required.', isError: true }

      if (!provider.isConnected(server_name)) {
        return {
          output: `MCP server "${server_name}" is not connected.`,
          isError: true,
        }
      }

      try {
        const resources = await provider.listResources(server_name)
        if (resources.length === 0) {
          return {
            output: `No resources found on server "${server_name}".`,
            isError: false,
            metadata: { server_name, resources: [] },
          }
        }

        const lines = resources.map(r =>
          `  ${r.uri} — ${r.name}${r.description ? ` (${r.description})` : ''}`,
        )

        return {
          output: `Resources on "${server_name}" (${resources.length}):\n${lines.join('\n')}`,
          isError: false,
          metadata: { server_name, resources },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `Error listing resources: ${msg}`, isError: true }
      }
    },
  }
}
