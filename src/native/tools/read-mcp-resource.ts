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
      // Be charitable about near-miss param names. Weak models routinely
      // emit `server:` / `serverName:` instead of `server_name:` and then
      // retry the identical wrong shape after a bare "server_name is
      // required", burning a loop. Coerce the common aliases so the call
      // just works; only error when no recognizable key is present, and
      // then SAY what we received so the next attempt can self-correct.
      const raw = (input ?? {}) as unknown as Record<string, unknown>
      const str = (v: unknown): string => (typeof v === 'string' ? v : '')
      const server_name = str(raw['server_name']) || str(raw['serverName']) || str(raw['server'])
      const uri = str(raw['uri']) || str(raw['url']) || str(raw['resource'])

      if (!server_name) {
        const keys = Object.keys(raw)
        return {
          output:
            `Error: server_name is required (received key(s): ${keys.length ? keys.join(', ') : 'none'}). ` +
            `Pass {"server_name": "<connected MCP server>", "uri": "<resource uri>"}.`,
          isError: true,
          metadata: { failureCategory: 'mcp:bad-params' },
        }
      }
      if (!uri) return { output: 'Error: uri is required.', isError: true, metadata: { failureCategory: 'mcp:bad-params' } }

      // file:// is a local-filesystem path, not an MCP resource. Models reach
      // for ReadMcpResource here when they want a file; redirect to Read so
      // they stop retrying against a server that will never serve it.
      if (/^file:\/\//i.test(uri)) {
        return {
          output:
            `Error: "${uri}" is a local file path, not an MCP resource. ` +
            `Use the Read tool to read local files (Read accepts an absolute path).`,
          isError: true,
          metadata: { failureCategory: 'mcp:file-uri' },
        }
      }

      if (!provider.isConnected(server_name)) {
        return {
          output: `MCP server "${server_name}" is not connected.`,
          isError: true,
          metadata: { failureCategory: 'mcp:not-connected' },
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
        return { output: `Error reading resource: ${msg}`, isError: true, metadata: { failureCategory: 'mcp:read-error' } }
      }
    },
  }
}
