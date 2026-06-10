import type {
  AnthropicMessagesRequest,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicImageBlock,
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIMultimodalContent,
} from '../types.js'
import { translateTools, translateToolChoice } from './tools.js'

function extractToolResultContent(block: AnthropicToolResultBlock): string {
  let text = ''
  if (typeof block.content === 'string') {
    text = block.content
  } else if (Array.isArray(block.content)) {
    text = block.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
  }
  if (block.is_error) {
    text = `[ERROR] ${text}`
  }
  return text
}

function translateSystemPrompt(
  system: string | AnthropicTextBlock[] | undefined,
): OpenAIMessage | null {
  if (system === undefined) return null
  if (typeof system === 'string') {
    return { role: 'system', content: system }
  }
  const text = system
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
  return { role: 'system', content: text }
}

function toolResultFallbackText(blocks: AnthropicToolResultBlock[]): string {
  return blocks
    .map((tr) => {
      const prefix = tr.is_error ? '[tool error]' : '[tool result]'
      const body = extractToolResultContent(tr)
      return `${prefix} ${body}`.trim()
    })
    .join('\n')
}

function translateUserBlocks(
  blocks: AnthropicContentBlock[],
  prevAssistantHadToolCalls: boolean,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []

  // 1. Collect tool_result blocks → tool messages
  const toolResults = blocks.filter(
    (b): b is AnthropicToolResultBlock => b.type === 'tool_result',
  )
  if (toolResults.length > 0) {
    if (prevAssistantHadToolCalls) {
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          content: extractToolResultContent(tr),
          tool_call_id: tr.tool_use_id,
        })
      }
    } else {
      // Defensive fallback: if tool_result blocks appear without an immediately
      // preceding assistant tool call, downgrade them to plain user text
      // instead of emitting an invalid OpenAI tool message sequence.
      messages.push({
        role: 'user',
        content: toolResultFallbackText(toolResults),
      })
    }
  }

  // 2. Collect remaining blocks (text + image)
  const textBlocks = blocks.filter(
    (b): b is AnthropicTextBlock => b.type === 'text',
  )
  const imageBlocks = blocks.filter(
    (b): b is AnthropicImageBlock => b.type === 'image',
  )

  if (textBlocks.length > 0 || imageBlocks.length > 0) {
    if (imageBlocks.length > 0) {
      // Multimodal
      const parts: OpenAIMultimodalContent[] = []
      for (const tb of textBlocks) {
        parts.push({ type: 'text', text: tb.text })
      }
      for (const ib of imageBlocks) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${ib.source.media_type};base64,${ib.source.data}`,
          },
        })
      }
      messages.push({ role: 'user', content: parts })
    } else {
      // Text only
      const merged = textBlocks.map(b => b.text).join('')
      messages.push({ role: 'user', content: merged })
    }
  }

  return messages
}

function translateAssistantBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage {
  const thinkingParts: string[] = []
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        // Preserve thinking content as Moonshot/Kimi's `reasoning_content`
        // extension. kimi-for-coding validates history on every turn: if a
        // prior assistant tool_call message lacks reasoning_content, it
        // returns HTTP 400 "thinking is enabled but reasoning_content is
        // missing in assistant tool call message at index N". Providers
        // that don't support the field silently ignore it.
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
          thinkingParts.push(block.thinking)
        }
        break
      case 'text':
        textParts.push(block.text)
        break
      case 'tool_use':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
        break
    }
  }

  const content = textParts.length > 0 ? textParts.join('') : null
  const reasoning = thinkingParts.length > 0 ? thinkingParts.join('') : undefined
  return {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoning !== undefined && { reasoning_content: reasoning }),
  }
}

export function translateRequest(
  body: AnthropicMessagesRequest,
  localModel: string,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = []
  let prevAssistantHadToolCalls = false

  // System prompt
  const systemMsg = translateSystemPrompt(body.system)
  if (systemMsg) messages.push(systemMsg)

  // Translate messages
  for (const msg of body.messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content })
      } else {
        messages.push(...translateUserBlocks(msg.content, prevAssistantHadToolCalls))
      }
      prevAssistantHadToolCalls = false
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content })
        prevAssistantHadToolCalls = false
      } else {
        const translated = translateAssistantBlocks(msg.content)
        messages.push(translated)
        prevAssistantHadToolCalls = Array.isArray(translated.tool_calls) && translated.tool_calls.length > 0
      }
    }
  }

  // Tools
  const translatedTools = body.tools ? translateTools(body.tools) : []
  const translatedToolChoice = body.tool_choice
    ? translateToolChoice(body.tool_choice)
    : undefined

  return {
    model: localModel,
    messages,
    max_tokens: body.max_tokens,
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { top_p: body.top_p }),
    ...(body.stop_sequences && { stop: body.stop_sequences }),
    ...(body.stream && { stream: true }),
    ...(translatedTools.length > 0 && { tools: translatedTools }),
    ...(translatedToolChoice !== undefined && { tool_choice: translatedToolChoice }),
  }
}
