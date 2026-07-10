import type { Conversation } from './protocol/types.js'

const MIN_ITERATION = 8
const RECENT_TURN_COUNT = 4
const MAX_TOOL_RESULT_CHARS = 1200
const EDGE_CHARS = 240

export interface ContextCompactionResult {
  compactedResults: number
  omittedChars: number
}

export function compactOlderToolResults(
  conversation: Conversation,
  options: { iteration: number },
): ContextCompactionResult {
  if (options.iteration < MIN_ITERATION) return { compactedResults: 0, omittedChars: 0 }
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
      block.content = `${block.content.slice(0, EDGE_CHARS)}\n[OwlCoda context compacted: ${omitted} chars omitted; full raw output retained in runtime artifacts]\n${block.content.slice(-EDGE_CHARS)}`
      compactedResults += 1
      omittedChars += omitted
    }
  }
  return { compactedResults, omittedChars }
}
