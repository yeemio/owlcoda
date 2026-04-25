/**
 * OwlCoda Native Protocol Types
 *
 * Conversation-level types built on existing Anthropic protocol types.
 * These power the native conversation loop.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolDef,
  AnthropicToolUseBlock,
} from '../../types.js'

// Re-export for convenience
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolDef,
  AnthropicToolUseBlock,
}

/** A turn in the conversation (user or assistant). */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
  /** Timestamp when this turn was added */
  timestamp: number
}

/** Minimal persisted retry hint: enough to treat "继续" as retry on resume
 * without carrying the full runtime failure payload across restarts. */
export interface PendingRetryState {
  attemptCount: number
}

export type TaskPathScopeKind = 'file' | 'directory'
export type TaskPathScopeOrigin = 'explicit' | 'parent_directory' | 'derived_test' | 'touched' | 'user_approved'
export type TaskRunStatus = 'open' | 'blocked' | 'waiting_user' | 'drifted' | 'completed'

export interface TaskPathScope {
  path: string
  kind: TaskPathScopeKind
  origin: TaskPathScopeOrigin
}

export interface TaskContract {
  version: 1
  sourceTurnHash: string
  sourceText: string
  objective: string
  dominantGap: string | null
  cwd: string
  scopeMode: 'workspace' | 'explicit_paths'
  explicitWriteTargets: string[]
  allowedWritePaths: TaskPathScope[]
  touchedPaths: string[]
  createdAt: number
  updatedAt: number
}

export interface TaskRunState {
  status: TaskRunStatus
  iterations: number
  currentFocus: string | null
  lastProgressAt: number
  lastGuardReason: string | null
  pendingWriteApproval?: {
    attemptedPaths: string[]
    requestedAt: number
  } | null
  lastUpdatedAt: number
}

export interface TaskExecutionState {
  contract: TaskContract
  run: TaskRunState
}

/** Runtime options for conversation behavior. */
export interface ConversationOptions {
  /** Enable extended thinking mode. */
  thinking?: boolean
  /** Session title (user-assigned). */
  title?: string
  /** Per-tool approval list (tool names always approved). */
  alwaysApprove?: Set<string>
  /** Brief response mode — ask the model to be concise. */
  brief?: boolean
  /** Fast mode — prioritize speed over depth. */
  fast?: boolean
  /** Effort level: low, medium, high. */
  effort?: string
  /** Vim keybinding mode. */
  vimMode?: boolean
  /** Additional working directories. */
  additionalDirs?: string[]
  /** Persisted retry flag — set whenever the last assistant response failed
   *  pre-first-token, cleared on any other outcome. When present on a resumed
   *  session, "继续 / continue" is treated as "retry last request". */
  pendingRetry?: PendingRetryState
  /** Persistent task contract + runtime state for long-running execution. */
  taskState?: TaskExecutionState
}

/** Full conversation state. */
export interface Conversation {
  /** Unique conversation ID */
  id: string
  /** System prompt */
  system: string
  /** Conversation history */
  turns: ConversationTurn[]
  /** Tool definitions available to the model */
  tools: AnthropicToolDef[]
  /** Model to use */
  model: string
  /** Max tokens per response */
  maxTokens: number
  /** Temperature (0-1) */
  temperature?: number
  /** Runtime options (thinking, title, per-tool approval). */
  options?: ConversationOptions
}

/** Result of sending a message (may include tool calls). */
export interface AssistantResponse {
  /** Thinking blocks from the response (extended thinking / chain-of-thought).
   *  Must be stored on the assistant turn so thinking-model providers (e.g.
   *  kimi-for-coding) find reasoning_content on prior tool_call messages when
   *  the history is replayed. Dropping these causes kimi to 400 on the next
   *  continuation with "reasoning_content is missing". */
  thinkingBlocks: import('../../types.js').AnthropicThinkingBlock[]
  /** Text blocks from the response */
  textBlocks: AnthropicTextBlock[]
  /** Tool use blocks from the response */
  toolUseBlocks: AnthropicToolUseBlock[]
  /** Stop reason */
  stopReason: string | null
  /** Token usage */
  usage: { inputTokens: number; outputTokens: number }
  /** Whether the model wants to use tools */
  hasToolUse: boolean
  /** Combined text content */
  text: string
}

/** SSE event from the streaming API */
export interface StreamEvent {
  event: string
  data: string
}

/** Accumulated state during streaming. */
export interface StreamAccumulator {
  /** Concatenated thinking text fragments from every content_block_delta
   *  whose delta.type === 'thinking_delta'. Finalized into a single
   *  AnthropicThinkingBlock so the assistant turn carries reasoning content
   *  forward to future continuations. */
  thinkingParts: string[]
  /** Optional signature from content_block_delta type === 'signature_delta' —
   *  Anthropic models emit this to sign their thinking blocks. Kimi thinking
   *  models don't, so it's optional and may be undefined for cloud paths. */
  thinkingSignature?: string
  textParts: string[]
  toolUseBlocks: Array<{
    id: string
    name: string
    inputJson: string
  }>
  currentToolIndex: number
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  /** True while inside a thinking content block. */
  inThinkingBlock?: boolean
}
