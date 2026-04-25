/**
 * OwlCoda native modules.
 *
 * These modules define the self-hosted runtime surface:
 *   1. CLI entry + arg parsing
 *   2. Tool layer (Bash, Read, Edit, Write, Glob, Grep)
 *   3. Frontend REPL
 *   4. TUI
 */

export const NATIVE_VERSION = '0.5.0'

// Phase 1: Tool layer
export {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from './tools/index.js'
export type { BashInput, NativeToolDef, ToolResult } from './tools/index.js'

// Phase 2: Protocol layer
export {
  buildRequest,
  buildRequestFromOptions,
  userMessage,
  toolResultMessage,
  parseResponse,
  parseResponseBody,
  isErrorResult,
  createAccumulator,
  parseSSE,
  processEvent,
  finalizeStream,
  consumeStream,
} from './protocol/index.js'
export type { Conversation, AssistantResponse, StreamEvent } from './protocol/index.js'

// Phase 3: Frontend layer
export { ToolDispatcher } from './dispatch.js'
export { createConversation, addUserMessage, runConversationLoop } from './conversation.js'
export { startRepl } from './repl.js'
export { runHeadless } from './headless.js'
export { buildNativeToolDefs, NATIVE_TOOL_SCHEMAS } from './tool-defs.js'
export { buildSystemPrompt } from './system-prompt.js'
export {
  ansi,
  formatToolStart,
  formatToolEnd,
  formatError,
  formatIterations,
  formatBanner,
  formatUsage,
  formatStopReason,
  truncateOutput,
  Spinner,
} from './display.js'
export type { BannerOptions } from './display.js'
export { UsageTracker, estimateTokens, estimateConversationTokens, formatBudget } from './usage.js'
export {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  restoreConversation,
} from './session.js'
export type { SessionFile } from './session.js'
export { renderMarkdown, renderInline, StreamingMarkdownRenderer } from './markdown.js'
