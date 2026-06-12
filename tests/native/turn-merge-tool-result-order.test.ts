/**
 * Regression for the tool_result-ordering bug (2026-06-12).
 *
 * Dogfood incident: after Ctrl+C / queued messages during an in-flight
 * tool, a request reached DeepSeek with a user turn shaped
 * `[text, tool_result, tool_result]` — text BEFORE the tool_results —
 * and the provider 400'd: "messages.N: tool_use ids were found without
 * tool_result blocks immediately after". The tool_results WERE present,
 * just not first.
 *
 * Root cause: prepareTurnsForRequest = compact(sanitize(turns)). sanitize
 * correctly emits tool_result-first user turns, but compactConsecutive-
 * SameRoleTurns → mergeContentBlocks `unshift`ed the merged text block to
 * the FRONT of the merged content. When a tool_result-bearing user turn
 * merged with a queued text-only user turn, text landed ahead of the
 * tool_results. The Anthropic content contract requires tool_result
 * blocks to lead the user message that answers a tool_use.
 */
import { describe, it, expect } from 'vitest'
import { prepareTurnsForRequest } from '../../src/native/protocol/request.js'
import type { ConversationTurn } from '../../src/native/protocol/types.js'

const toolUse = (id: string) => ({ type: 'tool_use' as const, id, name: 'bash', input: {} })
const toolResult = (id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })
const text = (t: string) => ({ type: 'text' as const, text: t })

function leadIsToolResult(turn: ConversationTurn): boolean {
  return turn.content[0]?.type === 'tool_result'
}

describe('prepareTurnsForRequest — tool_result ordering after same-role merge', () => {
  it('keeps tool_result blocks first when a queued user text merges into the result turn', () => {
    const turns: ConversationTurn[] = [
      { role: 'assistant', content: [toolUse('A'), toolUse('B')], timestamp: 1 },
      { role: 'user', content: [toolResult('A'), toolResult('B')], timestamp: 2 },
      // queued user message arriving as its own turn (interrupt/enqueue race)
      { role: 'user', content: [text('30 人并发扛得住吗')], timestamp: 3 },
    ]
    const out = prepareTurnsForRequest(turns)
    // the two user turns merge into one
    const merged = out[out.length - 1]!
    expect(merged.role).toBe('user')
    expect(leadIsToolResult(merged)).toBe(true)
    const types = merged.content.map((b) => b.type)
    expect(types.filter((t) => t === 'tool_result')).toHaveLength(2)
    // text is preserved, but only AFTER the tool_results
    const firstText = types.indexOf('text')
    const lastResult = types.lastIndexOf('tool_result')
    expect(firstText).toBeGreaterThan(lastResult)
  })

  it('keeps tool_result first even when the queued text turn is BEFORE-merged into the result turn', () => {
    // text already prepended into the same turn as the results (the exact
    // daemon-dumped shape: [text, tool_result, tool_result])
    const turns: ConversationTurn[] = [
      { role: 'assistant', content: [toolUse('A')], timestamp: 1 },
      { role: 'user', content: [text('queued'), toolResult('A')], timestamp: 2 },
    ]
    const out = prepareTurnsForRequest(turns)
    const userTurn = out.find((t) => t.role === 'user')!
    expect(userTurn.content[0]?.type).toBe('tool_result')
  })

  it('still merges plain consecutive user text turns with text leading (no tool_results involved)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [text('first')], timestamp: 1 },
      { role: 'user', content: [text('second')], timestamp: 2 },
    ]
    const out = prepareTurnsForRequest(turns)
    expect(out).toHaveLength(1)
    expect(out[0]!.content[0]?.type).toBe('text')
    expect((out[0]!.content[0] as { text: string }).text).toContain('first')
    expect((out[0]!.content[0] as { text: string }).text).toContain('second')
  })

  it('preserves assistant text-before-tool_use ordering on assistant merges', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [text('q')], timestamp: 1 },
      { role: 'assistant', content: [text('thinking out loud')], timestamp: 2 },
      { role: 'assistant', content: [toolUse('A')], timestamp: 3 },
      { role: 'user', content: [toolResult('A')], timestamp: 4 },
    ]
    const out = prepareTurnsForRequest(turns)
    const asst = out.find((t) => t.role === 'assistant')!
    // assistant convention: text leads, tool_use follows
    expect(asst.content[0]?.type).toBe('text')
    expect(asst.content.some((b) => b.type === 'tool_use')).toBe(true)
  })
})
