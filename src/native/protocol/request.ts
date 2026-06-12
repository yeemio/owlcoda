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
import { isProjectMapEnabled } from '../project-map.js'

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
  addHistoryCacheBreakpoint(messages)

  const req: AnthropicMessagesRequest = {
    model: conversation.model,
    messages,
    max_tokens: conversation.maxTokens,
    stream,
  }

  // System prompt — use structured format with cache_control for prompt caching
  const system = buildEffectiveSystemPrompt(conversation)
  if (system) {
    req.system = [
      {
        type: 'text' as const,
        text: system,
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

function buildEffectiveSystemPrompt(conversation: Conversation): string {
  const base = conversation.system
  const projectMapSummary = conversation.options?.projectMapPromptSummary
  if (!projectMapSummary || !isProjectMapEnabled()) return base
  return [base, projectMapSummary].filter((part) => part.trim().length > 0).join('\n\n')
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

/**
 * Tag the last content block of the last message with cache_control so the
 * growing conversation prefix is cached across turns. The system prompt and the
 * last tool already carry breakpoints (2); this adds a 3rd, within Anthropic's
 * limit of 4. In a multi-turn coding session the message history is the largest
 * resent payload, so this is where caching saves the most tokens.
 *
 * Clones rather than mutates: conversationToMessages shares each turn's content
 * array by reference, so we slice the array and shallow-copy the block before
 * adding cache_control — otherwise we'd pollute conversation.turns.
 *
 * Only text / image / tool_result blocks accept cache_control (tool_use and
 * thinking blocks do not). A well-formed request ends on a user turn (text or
 * tool_result), but we guard defensively and skip otherwise.
 */
function addHistoryCacheBreakpoint(messages: AnthropicMessage[]): void {
  if (messages.length === 0) return
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]!
  const content = last.content
  if (!Array.isArray(content) || content.length === 0) return
  const blockIdx = content.length - 1
  const block = content[blockIdx]!
  if (block.type !== 'text' && block.type !== 'image' && block.type !== 'tool_result') return
  const newContent = content.slice()
  newContent[blockIdx] = { ...block, cache_control: { type: 'ephemeral' } }
  messages[lastIdx] = { ...last, content: newContent }
}

/** Convert conversation turns into Anthropic message array. */
function conversationToMessages(conversation: Conversation): AnthropicMessage[] {
  return prepareTurnsForRequest(conversation.turns).map((turn) => ({
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
 * A turn is "API-meaningful" when it has at least one content block that
 * the chat-completion API treats as a real message: text, tool_use,
 * tool_result, or image. A turn whose only blocks are `thinking` (or
 * future internal-only block types) is body-less from the API's
 * perspective and most providers will 400 on it.
 *
 * Background: hostile-QA against 0.13.40 surfaced a session whose turn
 * 88 contained only a `thinking` block — the model started reasoning,
 * the stream got interrupted before any text/tool_use was emitted, and
 * the saved turn became a zombie body-less assistant message that
 * caused every subsequent resume to 400.
 */
function isApiMeaningfulTurn(turn: ConversationTurn): boolean {
  return turn.content.some(
    block =>
      block.type === 'text'
      || block.type === 'tool_use'
      || block.type === 'tool_result'
      || block.type === 'image',
  )
}

/**
 * Collapse consecutive same-role turns into one. After tool-call
 * sanitization, the user can be left with several user turns in a row
 * (typing "继续" three times when each prior assistant turn 400'd
 * without saving) — the API rejects consecutive same-role messages on
 * most providers. Concatenating preserves intent: each follow-up was
 * the user re-asserting the same instruction, so joining them with a
 * blank line is a faithful merge. Tool_result blocks aren't text so
 * they aren't joined; if both sides carry them, the second's blocks
 * are appended.
 */
function compactConsecutiveSameRoleTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = []
  for (const turn of turns) {
    const last = out[out.length - 1]
    if (last && last.role === turn.role) {
      out[out.length - 1] = {
        ...last,
        content: mergeContentBlocks(last.content, turn.content),
      }
    } else {
      out.push(turn)
    }
  }
  return out
}

function mergeContentBlocks(
  a: AnthropicContentBlock[],
  b: AnthropicContentBlock[],
): AnthropicContentBlock[] {
  // Merge adjacent text blocks with a blank-line separator; everything
  // else (tool_use / tool_result / image / thinking) appends as-is.
  const aText = a.filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
  const aOther = a.filter(block => block.type !== 'text')
  const bText = b.filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
  const bOther = b.filter(block => block.type !== 'text')

  const combinedTextParts = [...aText.map(t => t.text), ...bText.map(t => t.text)].filter(s => s.length > 0)
  const merged: AnthropicContentBlock[] = [...aOther, ...bOther]
  if (combinedTextParts.length > 0) {
    const textBlock: AnthropicContentBlock = { type: 'text', text: combinedTextParts.join('\n\n') }
    // The Anthropic content contract requires tool_result blocks to LEAD the
    // user message that answers a tool_use. When the merged non-text content
    // carries any tool_result (a queued/appended user text merging into a
    // tool_result turn — the 2026-06-12 deterministic-400 incident), the
    // text must follow the results, not unshift to the front. For every other
    // case (assistant text-before-tool_use, pure-text merges) keep text
    // leading.
    if (merged.some(block => block.type === 'tool_result')) {
      merged.push(textBlock)
    } else {
      merged.unshift(textBlock)
    }
  }
  return merged
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

  // Drop turns that are body-less (thinking-only or completely empty).
  // The chat-completion API rejects assistant messages whose only
  // content is `thinking`; left alone, a stream-interrupted-before-
  // first-token poison turn permanently bricks resume. This filter is
  // safe to run during storage round-trips because a body-less turn
  // carries no observational value either.
  return sanitized.filter(isApiMeaningfulTurn)
}

/**
 * Prepare turns for sending to the provider. Runs the full storage-safe
 * sanitizer plus consecutive-same-role compaction. The compaction is
 * deliberately NOT in the storage path: synthetic test data and benign
 * inspection workflows can keep their literal turn count, and only the
 * provider request — where the API actually rejects consecutive-role
 * messages — pays the merge cost.
 */
export function prepareTurnsForRequest(turns: ConversationTurn[]): ConversationTurn[] {
  return compactConsecutiveSameRoleTurns(sanitizeConversationTurns(turns))
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
  // The repair surface uses the request-bound pipeline (storage sanitize +
  // consecutive-role compaction) because callers ask for repair when they
  // are about to send the conversation, not when they're inspecting it.
  // Storage uses `sanitizeConversationTurns` directly to keep test
  // synthetic-data round-trip semantics; the public repair entrypoint
  // is the API-shape one.
  const repairedTurns = prepareTurnsForRequest(turns)
  const after = JSON.stringify(repairedTurns)
  const repaired = before !== after
  const warnings: string[] = []
  if (repaired) {
    warnings.push('Conversation repair: normalized saved history (orphan tool calls, body-less assistant turns, or consecutive same-role messages)')
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
