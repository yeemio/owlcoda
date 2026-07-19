import type { Conversation } from './protocol/types.js'

const MIN_ITERATION = 8
const RECENT_TURN_COUNT = 6
const MAX_TOOL_RESULT_CHARS = 1200
const EDGE_CHARS = 240
const MIN_SAVINGS_CHARS = 4000
const HIGH_WATERMARK = 0.9
const LOW_WATERMARK = 0.75

export interface ContextCompactionResult {
  compactedResults: number
  omittedChars: number
}

export function compactOlderToolResults(
  conversation: Conversation,
  options: { iteration: number; contextUsageRatio?: number },
): ContextCompactionResult {
  if (options.iteration < MIN_ITERATION) return { compactedResults: 0, omittedChars: 0 }
  if (!conversation.options) conversation.options = {}
  const usageRatio = options.contextUsageRatio ?? 0
  if (usageRatio >= HIGH_WATERMARK) {
    conversation.options.contextHygieneActive = true
  } else if (usageRatio <= LOW_WATERMARK) {
    conversation.options.contextHygieneActive = false
  }
  const pressureActive = conversation.options.contextHygieneActive === true
  const toolCalls = collectToolCalls(conversation)
  let compactedResults = 0
  let omittedChars = 0
  const protectedFrom = Math.max(0, conversation.turns.length - RECENT_TURN_COUNT)

  for (let turnIndex = 0; turnIndex < protectedFrom; turnIndex += 1) {
    const turn = conversation.turns[turnIndex]
    if (!turn || !Array.isArray(turn.content)) continue
    for (const block of turn.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue
      if (block.content.length <= MAX_TOOL_RESULT_CHARS || block.content.includes('[OwlCoda context compacted:')) continue
      const omitted = block.content.length - (EDGE_CHARS * 2)
      if (omitted < MIN_SAVINGS_CHARS && !pressureActive) continue
      const recoveryHint = formatRecoveryHint(toolCalls.get(block.tool_use_id))
      block.content = `${block.content.slice(0, EDGE_CHARS)}\n[OwlCoda context compacted: ${omitted} chars omitted; ${recoveryHint}]\n${block.content.slice(-EDGE_CHARS)}`
      compactedResults += 1
      omittedChars += omitted
    }
  }
  return { compactedResults, omittedChars }
}

type ToolCall = { name: string; input: Record<string, unknown> }

function collectToolCalls(conversation: Conversation): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>()
  for (const turn of conversation.turns) {
    for (const block of turn.content) {
      if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input })
    }
  }
  return calls
}

function formatRecoveryHint(call: ToolCall | undefined): string {
  if (!call) return 're-run the original tool with a narrower request if this evidence is needed again'
  const path = call.input['path'] ?? call.input['file_path']
  if (typeof path === 'string' && /^read$/i.test(call.name)) {
    const args = [`path=${JSON.stringify(path)}`]
    if (typeof call.input['offset'] === 'number') args.push(`offset=${call.input['offset']}`)
    if (typeof call.input['limit'] === 'number') args.push(`limit=${call.input['limit']}`)
    return `recover with Read(${args.join(', ')}) if needed`
  }
  return `re-run ${call.name} with a narrower request if this evidence is needed again`
}
