import { randomUUID } from 'node:crypto'
import type { OwlCodaConfig } from '../config.js'
import { responseModelName } from '../config.js'
import type {
  OpenAIChatResponse,
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
} from '../types.js'

function mapStopReason(
  fr: string | null,
): AnthropicMessagesResponse['stop_reason'] {
  switch (fr) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

export function translateResponse(
  openaiResp: OpenAIChatResponse,
  requestModel: string,
  config: OwlCodaConfig,
): AnthropicMessagesResponse {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const choice = openaiResp.choices[0]!
  const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = []

  // text → text block
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  // tool_calls → tool_use blocks
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        // Malformed JSON from backend — preserve the raw argument string so the
        // compatibility client can still inspect the tool call.
        input = { _raw: tc.function.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  // Empty content fallback
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const usage = {
    input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
    output_tokens: openaiResp.usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  const model = responseModelName(config, requestModel)

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage,
  }
}
