/**
 * OwlCoda Native ReadMcpResource Tool
 *
 * Reads a specific resource from a connected MCP server by URI.
 *
 * Upstream parity notes:
 * - Upstream reads resource content via MCP protocol
 * - Our version: delegates to MCP client provider
 */

import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import { createReadTool } from './read.js'

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
    description:
      'Read a resource from a connected MCP server by URI. Local file:// URIs and absolute local paths are routed through the native read tool.',

    async execute(input: ReadMcpResourceInput, context?: ToolExecutionContext): Promise<ToolResult> {
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

      const placeholder = findPlaceholderParam(server_name, uri)
      if (placeholder) {
        return {
          output:
            `Error: placeholder ${placeholder.field} value "${placeholder.value}" was passed to ReadMcpResource. ` +
            'Replace the template value with a real connected MCP server name and resource URI.',
          isError: true,
          metadata: {
            failureCategory: 'mcp:placeholder-params',
            placeholderParam: placeholder.field,
            server_name,
            uri,
          },
        }
      }

      if (/^file:\/\//i.test(uri)) {
        return await readLocalFileUri(uri, context)
      }
      if (isLocalAbsolutePath(uri)) {
        return await readLocalPath(uri, uri, context)
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

async function readLocalFileUri(uri: string, context?: ToolExecutionContext): Promise<ToolResult> {
  let normalizedPath: string
  try {
    normalizedPath = fileURLToPath(uri)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      output: `Error: "${uri}" is not a valid local file URI: ${message}`,
      isError: true,
      metadata: {
        failureCategory: 'mcp:file-uri-invalid',
        routedFrom: 'ReadMcpResource',
        routedTo: 'read',
        uri,
      },
    }
  }

  return await readLocalPath(normalizedPath, uri, context, result => ({
    ...(result.isError && !result.metadata?.['failureCategory'] ? { failureCategory: 'read:file-uri' } : {}),
  }))
}

async function readLocalPath(
  path: string,
  originalUri: string,
  context?: ToolExecutionContext,
  extraMetadata?: (result: ToolResult) => Record<string, unknown>,
): Promise<ToolResult> {
  const result = await createReadTool().execute({ path }, context)
  const readPath = typeof result.metadata?.['path'] === 'string'
    ? result.metadata['path']
    : path
  const routedMetadata = extraMetadata ? extraMetadata(result) : {}
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      ...routedMetadata,
      ...(result.isError && !result.metadata?.['failureCategory'] && !routedMetadata['failureCategory'] ? { failureCategory: 'read:local-path' } : {}),
      routedFrom: 'ReadMcpResource',
      routedTo: 'read',
      uri: originalUri,
      normalizedPath: readPath,
    },
  }
}

function isLocalAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
}

function findPlaceholderParam(serverName: string, uri: string): { field: 'server_name' | 'uri'; value: string } | null {
  if (isPlaceholderValue(serverName, ['server_name', 'server', 'servername', 'mcp_server', 'server-name'])) {
    return { field: 'server_name', value: serverName }
  }
  if (isPlaceholderValue(uri, ['uri', 'url', 'resource', 'resource_uri', 'resource-uri'])) {
    return { field: 'uri', value: uri }
  }
  return null
}

function isPlaceholderValue(value: string, tokens: string[]): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  if (normalized === '...' || normalized === '…') return true
  const stripped = normalized.replace(/^<+|>+$/g, '')
  if (stripped === '...' || stripped === '…') return true
  if (tokens.includes(stripped)) return true
  if (/^(?:your|example|sample)[_-]/.test(stripped)) {
    const suffix = stripped.replace(/^(?:your|example|sample)[_-]/, '')
    return tokens.includes(suffix)
  }
  return false
}
