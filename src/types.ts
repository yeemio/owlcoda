import type { ProviderRequestDiagnostic } from './provider-error.js'

// ─── Anthropic Request Types ───

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: string }
}

export interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
  cache_control?: { type: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | AnthropicTextBlock[]
  is_error?: boolean
  cache_control?: { type: string }
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  cache_control?: { type: string }
}

export interface AnthropicToolChoiceAuto { type: 'auto' }
export interface AnthropicToolChoiceAny { type: 'any' }
export interface AnthropicToolChoiceTool { type: 'tool'; name: string }
export interface AnthropicToolChoiceNone { type: 'none' }
export type AnthropicToolChoice =
  | AnthropicToolChoiceAuto
  | AnthropicToolChoiceAny
  | AnthropicToolChoiceTool
  | AnthropicToolChoiceNone

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicTextBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicToolDef[]
  tool_choice?: AnthropicToolChoice
  thinking?: unknown
  metadata?: unknown
  betas?: string[]
}

// ─── Anthropic Response Types ───

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface AnthropicMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: (AnthropicTextBlock | AnthropicToolUseBlock)[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

export interface AnthropicErrorResponse {
  type: 'error'
  error: {
    type: 'invalid_request_error' | 'api_error' | 'overloaded_error' | 'rate_limit_error' | 'not_found_error'
    message: string
    diagnostic?: ProviderRequestDiagnostic
  }
}

// ─── OpenAI Request Types ───

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIMultimodalContent[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  /**
   * Extension used by Moonshot/Kimi thinking models (e.g. kimi-for-coding).
   * When the model generated reasoning_content on an earlier assistant turn,
   * kimi requires it to be echoed back on the history entry — otherwise the
   * API returns HTTP 400 "thinking is enabled but reasoning_content is
   * missing in assistant tool call message at index N" on the next turn.
   * Non-thinking OpenAI-compatible providers silently ignore the field.
   */
  reasoning_content?: string | null
}

export interface OpenAIMultimodalContent {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  stream?: boolean
  tools?: OpenAIToolDef[]
  tool_choice?: string | { type: string; function?: { name: string } }
}

// ─── OpenAI Response Types ───

export interface OpenAIChatResponse {
  id: string
  object: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
