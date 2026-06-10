/**
 * OwlCoda Plugin System — Type definitions
 *
 * Plugins are directories in ~/.owlcoda/plugins/ with an index.js that exports
 * an OwlCodaPlugin object. Each hook is optional.
 */

export interface PluginMetadata {
  name: string
  version: string
  description?: string
}

export interface RequestHookContext {
  method: string
  endpoint: string
  model: string
  messageCount: number
  body: unknown
}

export interface ResponseHookContext {
  method: string
  endpoint: string
  model: string
  statusCode: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  body: unknown
}

export interface ToolCallHookContext {
  toolName: string
  input: unknown
  sessionId?: string
}

export interface ErrorHookContext {
  endpoint: string
  errorType: string
  message: string
}

export interface OwlCodaPlugin {
  metadata: PluginMetadata
  onRequest?: (ctx: RequestHookContext) => Promise<void> | void
  onResponse?: (ctx: ResponseHookContext) => Promise<void> | void
  onToolCall?: (ctx: ToolCallHookContext) => Promise<void> | void
  onError?: (ctx: ErrorHookContext) => Promise<void> | void
  onLoad?: () => Promise<void> | void
  onUnload?: () => Promise<void> | void
}

export interface LoadedPlugin {
  plugin: OwlCodaPlugin
  path: string
  hookCount: number
}
