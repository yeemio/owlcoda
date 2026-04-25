/**
 * OwlCoda Native Request Builder
 *
 * Builds Anthropic Messages API requests from conversation state.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolDef,
  Conversation,
  ConversationTurn,
} from './types.js'

export interface RequestOptions {
  model: string
  system: string
  messages: AnthropicMessage[]
  maxTokens: number
  temperature?: number
  tools?: AnthropicToolDef[]
  stream?: boolean
}

/** Build an Anthropic Messages API request from conversation state. */
export function buildRequest(conversation: Conversation, stream = true): AnthropicMessagesRequest {
  const messages = conversationToMessages(conversation)

  const req: AnthropicMessagesRequest = {
    model: conversation.model,
    messages,
    max_tokens: conversation.maxTokens,
    stream,
  }

  // System prompt — use structured format with cache_control for prompt caching
  if (conversation.system) {
    req.system = [
      {
        type: 'text' as const,
        text: conversation.system,
        cache_control: { type: 'ephemeral' },
      },
    ]
  }

  if (conversation.temperature !== undefined) {
    req.temperature = conversation.temperature
  }

  // Tool definitions with cache_control on last tool for prompt caching
  if (conversation.tools.length > 0) {
    const tools = conversation.tools.map((t, i) => {
      if (i === conversation.tools.length - 1) {
        return { ...t, cache_control: { type: 'ephemeral' } }
      }
      return t
    })
    req.tools = tools
  }

  // Extended thinking mode (enabled via /thinking on|verbose)
  if (conversation.options?.thinking) {
    req.thinking = {
      type: 'enabled',
      budget_tokens: Math.min(conversation.maxTokens, 16384),
    }
  }

  return req
}

/** Build a request from explicit options (lower-level). */
export function buildRequestFromOptions(opts: RequestOptions): AnthropicMessagesRequest {
  const req: AnthropicMessagesRequest = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    stream: opts.stream ?? true,
  }

  if (opts.system) {
    req.system = opts.system
  }

  if (opts.temperature !== undefined) {
    req.temperature = opts.temperature
  }

  if (opts.tools && opts.tools.length > 0) {
    req.tools = opts.tools
  }

  return req
}

/** Convert conversation turns into Anthropic message array. */
function conversationToMessages(conversation: Conversation): AnthropicMessage[] {
  return sanitizeConversationTurns(conversation.turns).map((turn) => ({
    role: turn.role,
    content: turn.content as AnthropicContentBlock[],
  }))
}

function cloneBlock(block: AnthropicContentBlock): AnthropicContentBlock {
  return { ...block } as AnthropicContentBlock
}

function stripToolUseBlocks(turn: ConversationTurn): ConversationTurn | null {
  const content = turn.content
    .filter(block => block.type !== 'tool_use')
    .map(cloneBlock)

  if (content.length === 0) return null
  return { ...turn, content }
}

/**
 * Repair invalid tool call/result sequencing in persisted conversation history.
 *
 * Rules:
 * - assistant tool_use turns must be followed immediately by a user tool_result turn
 * - if that link is broken, strip the dangling tool_use blocks and keep any assistant text
 * - orphan tool_result user turns are dropped
 */
export function sanitizeConversationTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const sanitized: ConversationTurn[] = []
  let pendingAssistantIndex: number | null = null
  let pendingToolUseIds: Set<string> | null = null

  const finalizePendingAssistant = () => {
    if (pendingAssistantIndex === null) return
    const pendingTurn = sanitized[pendingAssistantIndex]
    const repaired = stripToolUseBlocks(pendingTurn)
    if (repaired) {
      sanitized[pendingAssistantIndex] = repaired
    } else {
      sanitized.splice(pendingAssistantIndex, 1)
    }
    pendingAssistantIndex = null
    pendingToolUseIds = null
  }

  for (const turn of turns) {
    const content = turn.content.map(cloneBlock)

    if (turn.role === 'assistant') {
      finalizePendingAssistant()

      const toolUseIds = content
        .filter((block): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map(block => block.id)

      sanitized.push({ ...turn, content })
      if (toolUseIds.length > 0) {
        pendingAssistantIndex = sanitized.length - 1
        pendingToolUseIds = new Set(toolUseIds)
      }
      continue
    }

    const toolResults = content.filter(
      (block): block is Extract<AnthropicContentBlock, { type: 'tool_result' }> => block.type === 'tool_result',
    )
    const nonToolResultContent = content.filter(block => block.type !== 'tool_result')

    if (pendingToolUseIds && toolResults.length > 0) {
      const matchedResults = toolResults.filter(block => pendingToolUseIds!.has(block.tool_use_id))
      // Pair is valid when every pending tool_use_id has a matching tool_result.
      // Extra text/image content alongside the results is acceptable and preserved.
      // Unmatched tool_results (orphans mixed in from stale history) are dropped.
      const allPendingResolved = matchedResults.length === pendingToolUseIds.size

      if (allPendingResolved) {
        sanitized.push({ ...turn, content: [...matchedResults, ...nonToolResultContent] })
        pendingAssistantIndex = null
        pendingToolUseIds = null
        continue
      }
    }

    if (pendingToolUseIds) {
      finalizePendingAssistant()
    }

    if (nonToolResultContent.length > 0) {
      sanitized.push({ ...turn, content: nonToolResultContent })
    }
  }

  finalizePendingAssistant()
  return sanitized
}

export interface ConversationRepairResult {
  turns: ConversationTurn[]
  repaired: boolean
  warnings: string[]
}

/**
 * Validate conversation history and auto-repair any invalid tool_use/tool_result sequences.
 * Safe to call before every conversation turn — cheap when history is clean.
 */
export function validateAndRepairConversation(turns: ConversationTurn[]): ConversationRepairResult {
  if (turns.length === 0) {
    return { turns: [], repaired: false, warnings: [] }
  }
  const before = JSON.stringify(turns)
  const repairedTurns = sanitizeConversationTurns(turns)
  const after = JSON.stringify(repairedTurns)
  const repaired = before !== after
  const warnings: string[] = []
  if (repaired) {
    warnings.push('Conversation repair: cleaned orphaned tool calls from saved history')
  }
  return { turns: repairedTurns, repaired, warnings }
}

/** Create a user message with text content. */
export function userMessage(text: string): AnthropicMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  }
}

/** Create a tool result message. */
export function toolResultMessage(
  toolUseId: string,
  content: string,
  isError = false,
): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      is_error: isError,
    },
  ]
  return { role: 'user', content: blocks }
}

/** Build tool definitions from native tool metadata. */
export function buildToolDef(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): AnthropicToolDef {
  return { name, description, input_schema: inputSchema }
}
