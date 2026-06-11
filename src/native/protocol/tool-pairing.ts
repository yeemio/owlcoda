/**
 * Tool-pairing guard helpers (2026-06-11).
 *
 * Zero-dependency leaf on purpose: the daemon (src/endpoints/messages.ts)
 * imports these too, and protocol/request.ts is not a clean leaf for it.
 *
 * Background: a resumed/interrupted session sent /v1/messages bodies where
 * an assistant `tool_use` had no `tool_result` in the immediately-following
 * message. Anthropic-family providers 400 on that shape deterministically
 * ("messages.N: `tool_use` ids were found without `tool_result` blocks
 * immediately after"), and because the poison lives in the conversation
 * history the user's retries all fail identically. The request-build
 * sanitizer strips every turns-shape we could reconstruct, so whichever
 * path emitted the poison body bypassed it — these helpers provide:
 *  - a final guard at the loop's send chokepoint (find + strip), and
 *  - a content-free shape summary the daemon logs on tool-pairing 4xx so
 *    the next occurrence identifies the actual sender.
 *
 * Uses a structural message type so the daemon can pass parsed request
 * bodies without importing protocol/types.
 */

export interface WireMessageLike {
  role?: string
  content?: unknown
}

interface BlockLike {
  type?: string
  id?: string
  tool_use_id?: string
}

function blocksOf(message: WireMessageLike): BlockLike[] {
  return Array.isArray(message.content) ? (message.content as BlockLike[]) : []
}

/**
 * Find assistant `tool_use` blocks whose id has no matching `tool_result`
 * in the immediately-following message — the exact shape Anthropic-family
 * providers reject with a 400.
 */
export function findOrphanToolUseIds(
  messages: WireMessageLike[],
): Array<{ index: number; id: string }> {
  const orphans: Array<{ index: number; id: string }> = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const toolUseIds = blocksOf(message)
      .filter((b) => b.type === 'tool_use' && typeof b.id === 'string')
      .map((b) => b.id as string)
    if (toolUseIds.length === 0) continue
    const next = messages[i + 1]
    const resultIds = new Set(
      (next ? blocksOf(next) : [])
        .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
        .map((b) => b.tool_use_id as string),
    )
    for (const id of toolUseIds) {
      if (!resultIds.has(id)) orphans.push({ index: i, id })
    }
  }
  return orphans
}

/**
 * Remove orphan `tool_use` blocks from the message list (and drop any
 * message left without content). Returns the original array untouched when
 * pairing is already clean, so the no-orphan fast path allocates nothing.
 */
export function stripOrphanToolUseBlocks(messages: WireMessageLike[]): {
  messages: WireMessageLike[]
  strippedIds: string[]
} {
  const orphans = findOrphanToolUseIds(messages)
  if (orphans.length === 0) return { messages, strippedIds: [] }
  const orphanIds = new Set(orphans.map((o) => o.id))
  const out: WireMessageLike[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const kept = (message.content as BlockLike[]).filter(
      (b) => !(b.type === 'tool_use' && typeof b.id === 'string' && orphanIds.has(b.id)),
    )
    if (kept.length === 0) continue
    out.push(kept.length === message.content.length ? message : { ...message, content: kept })
  }
  return { messages: out, strippedIds: orphans.map((o) => o.id) }
}

/**
 * Content-free shape summary for diagnostics: total count plus the tail of
 * the message list as `[index]role: blockType(,blockType…)` lines, with
 * tool ids (never text) attached so pairing can be reconciled offline.
 */
export function summarizeMessagesShape(
  messages: WireMessageLike[],
  options: { tail?: number } = {},
): string {
  const tail = Math.max(1, options.tail ?? 12)
  const start = Math.max(0, messages.length - tail)
  const lines = [`total=${messages.length}`]
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]!
    const blocks = Array.isArray(message.content)
      ? blocksOf(message)
          .map((b) => {
            if (b.type === 'tool_use') return `tool_use(${b.id ?? '?'})`
            if (b.type === 'tool_result') return `tool_result(${b.tool_use_id ?? '?'})`
            return b.type ?? 'unknown'
          })
          .join(',')
      : typeof message.content === 'string'
        ? 'string'
        : 'none'
    lines.push(`  [${i}] ${message.role ?? '?'}: ${blocks}`)
  }
  return lines.join('\n')
}

/**
 * Does an upstream 4xx detail describe a tool_use/tool_result pairing
 * violation? Matches the Anthropic error family (also emitted verbatim by
 * anthropic-compatible providers such as DeepSeek).
 */
export function detailLooksLikeToolPairingError(detail: string): boolean {
  if (!detail) return false
  return /tool_use[\s\S]{0,120}tool_result|tool_result[\s\S]{0,120}tool_use/i.test(detail)
}
