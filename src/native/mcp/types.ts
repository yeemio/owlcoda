/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Follows JSON-RPC 2.0 over stdio transport.
 * Clean-room implementation based on public MCP specification.
 */

// ─── JSON-RPC 2.0 ──────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

// ─── MCP capabilities ───────────────────────────────────────────────

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: Record<string, unknown>
}

export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean }
  sampling?: Record<string, unknown>
}

export interface MCPInitializeResult {
  protocolVersion: string
  capabilities: MCPServerCapabilities
  serverInfo: { name: string; version: string }
}

// ─── MCP tool types ─────────────────────────────────────────────────

export interface MCPToolSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface MCPTool {
  name: string
  description?: string
  inputSchema: MCPToolSchema
}

export interface MCPToolCallResult {
  content: MCPContent[]
  isError?: boolean
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri: string; text?: string; blob?: string; mimeType?: string }
}

// ─── MCP resource types ─────────────────────────────────────────────

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPResourceContent {
  uri: string
  text?: string
  blob?: string
  mimeType?: string
}

// ─── Config types ───────────────────────────────────────────────────

export interface MCPServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>
}

// ─── Server state ───────────────────────────────────────────────────

export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPServerState {
  name: string
  config: MCPServerConfig
  status: MCPServerStatus
  error?: string
  capabilities?: MCPServerCapabilities
  serverInfo?: { name: string; version: string }
  tools: MCPTool[]
  resources: MCPResource[]
}
