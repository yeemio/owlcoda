/**
 * MCP Server Manager.
 *
 * Manages lifecycle of multiple MCP server connections:
 *   - Auto-connect on startup from config
 *   - Tool/resource aggregation across servers
 *   - Clean shutdown on exit
 *   - Provider interface for MCPTool
 */

import { MCPClient } from './client.js'
import { loadMCPConfig } from './config.js'
import type {
  MCPServerConfig,
  MCPServerState,
  MCPServerStatus,
  MCPTool,
  MCPResource,
  MCPToolCallResult,
  MCPContent,
} from './types.js'
import type { MCPClientProvider } from '../tools/mcp-tool.js'
import type { MCPResourceProvider } from '../tools/list-mcp-resources.js'
import type { MCPReadResourceProvider } from '../tools/read-mcp-resource.js'

export class MCPManager implements MCPClientProvider, MCPResourceProvider, MCPReadResourceProvider {
  private clients = new Map<string, MCPClient>()
  private states = new Map<string, MCPServerState>()

  /** Connect to all configured MCP servers. Returns summary of results. */
  async connectAll(cwd?: string): Promise<MCPServerState[]> {
    const configs = loadMCPConfig(cwd)
    if (configs.size === 0) return []

    const results: MCPServerState[] = []
    const promises: Promise<void>[] = []

    for (const [name, config] of configs) {
      promises.push(this.connectOne(name, config).then((state) => { results.push(state) }))
    }

    await Promise.allSettled(promises)
    return results
  }

  /** Connect to a single MCP server by name and config. */
  async connectOne(name: string, config: MCPServerConfig): Promise<MCPServerState> {
    // Disconnect existing if reconnecting
    await this.disconnectOne(name)

    const state: MCPServerState = {
      name,
      config,
      status: 'connecting',
      tools: [],
      resources: [],
    }
    this.states.set(name, state)

    const client = new MCPClient(name, config)
    this.clients.set(name, client)

    // Capture stderr for diagnostics
    client.on('stderr', (data: string) => {
      const trimmed = data.trim()
      if (trimmed) state.error = (state.error ?? '') + trimmed + '\n'
    })

    client.on('exit', () => {
      state.status = 'disconnected'
    })

    try {
      const initResult = await client.connect()
      state.status = 'connected'
      state.capabilities = initResult.capabilities
      state.serverInfo = initResult.serverInfo

      // Pre-fetch tools and resources
      if (initResult.capabilities.tools) {
        try {
          state.tools = await client.listTools()
        } catch {
          // Server may not support listing
        }
      }

      if (initResult.capabilities.resources) {
        try {
          state.resources = await client.listResources()
        } catch {
          // Server may not support listing
        }
      }
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
    }

    return state
  }

  /** Disconnect a single server. */
  async disconnectOne(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      await client.disconnect()
      this.clients.delete(name)
    }
    this.states.delete(name)
  }

  /** Disconnect all servers. Call on app exit. */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.keys()).map((n) => this.disconnectOne(n))
    await Promise.allSettled(promises)
  }

  // ─── MCPClientProvider interface ──────────────────────────────────

  isConnected(serverName: string): boolean {
    return this.states.get(serverName)?.status === 'connected'
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }> {
    const client = this.clients.get(serverName)
    if (!client?.connected) {
      return { content: `MCP server "${serverName}" not connected.`, isError: true }
    }

    const result: MCPToolCallResult = await client.callTool(toolName, args)

    // Flatten content to text
    const text = result.content
      .map((c: MCPContent) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'resource' && c.resource?.text) return c.resource.text
        return `[${c.type} content]`
      })
      .join('\n')

    return { content: text, isError: result.isError }
  }

  // ─── MCPResourceProvider interface ──────────────────────────────

  async listResources(serverName: string): Promise<Array<{ uri: string; name: string; description?: string }>> {
    const state = this.states.get(serverName)
    if (state?.status !== 'connected') return []
    return state.resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description }))
  }

  // ─── MCPReadResourceProvider interface (readResource below) ────

  // ─── Query methods ────────────────────────────────────────────────

  /** Get state of all servers. */
  getServers(): MCPServerState[] {
    return Array.from(this.states.values())
  }

  /** Get state of a specific server. */
  getServer(name: string): MCPServerState | undefined {
    return this.states.get(name)
  }

  /** Get all tools across all connected servers, prefixed with server name. */
  getAllTools(): Array<{ server: string; tool: MCPTool }> {
    const result: Array<{ server: string; tool: MCPTool }> = []
    for (const state of this.states.values()) {
      if (state.status !== 'connected') continue
      for (const tool of state.tools) {
        result.push({ server: state.name, tool })
      }
    }
    return result
  }

  /** Get all resources across all connected servers. */
  getAllResources(): Array<{ server: string; resource: MCPResource }> {
    const result: Array<{ server: string; resource: MCPResource }> = []
    for (const state of this.states.values()) {
      if (state.status !== 'connected') continue
      for (const resource of state.resources) {
        result.push({ server: state.name, resource })
      }
    }
    return result
  }

  /** Read a resource from a specific server. */
  async readResource(serverName: string, uri: string): Promise<{ content: string; mimeType?: string }> {
    const client = this.clients.get(serverName)
    if (!client?.connected) throw new Error(`MCP server "${serverName}" not connected`)

    const contents = await client.readResource(uri)
    const text = contents.map((c) => c.text ?? '[binary]').join('\n')
    const mimeType = contents[0]?.mimeType
    return { content: text, mimeType }
  }

  /** Get server count by status. */
  summary(): { total: number; connected: number; error: number } {
    let connected = 0
    let error = 0
    for (const state of this.states.values()) {
      if (state.status === 'connected') connected++
      else if (state.status === 'error') error++
    }
    return { total: this.states.size, connected, error }
  }
}
