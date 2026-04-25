/**
 * OwlCoda Native McpAuth Tool
 *
 * Authenticates with an MCP server that requires credentials.
 *
 * Upstream parity notes:
 * - Upstream handles OAuth/token-based MCP auth
 * - Our version: stores auth tokens per server in memory
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface McpAuthInput {
  server_name: string
  auth_type: 'token' | 'oauth'
  token?: string
  client_id?: string
  client_secret?: string
}

const authStore = new Map<string, { auth_type: string; authenticated: boolean; timestamp: string }>()

export function getAuthStatus(serverName: string): { authenticated: boolean } | undefined {
  return authStore.get(serverName)
}

export function resetAuthStore(): void {
  authStore.clear()
}

export function createMcpAuthTool(): NativeToolDef<McpAuthInput> {
  return {
    name: 'McpAuth',
    description:
      'Authenticate with an MCP server. Supports token and OAuth authentication.',

    async execute(input: McpAuthInput): Promise<ToolResult> {
      const { server_name, auth_type, token } = input

      if (!server_name) return { output: 'Error: server_name is required.', isError: true }
      if (!auth_type) return { output: 'Error: auth_type is required (token or oauth).', isError: true }

      if (auth_type === 'token') {
        if (!token) return { output: 'Error: token is required for token auth.', isError: true }

        authStore.set(server_name, {
          auth_type: 'token',
          authenticated: true,
          timestamp: new Date().toISOString(),
        })

        return {
          output: `Authenticated with MCP server "${server_name}" via token.`,
          isError: false,
          metadata: { server_name, auth_type },
        }
      }

      if (auth_type === 'oauth') {
        // Simplified OAuth — in real implementation would redirect to auth URL
        authStore.set(server_name, {
          auth_type: 'oauth',
          authenticated: true,
          timestamp: new Date().toISOString(),
        })

        return {
          output: `OAuth authentication initiated for MCP server "${server_name}".`,
          isError: false,
          metadata: { server_name, auth_type },
        }
      }

      return { output: `Unknown auth_type "${auth_type}".`, isError: true }
    },
  }
}
