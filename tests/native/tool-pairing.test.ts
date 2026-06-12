/**
 * Tests for the tool-pairing guard (2026-06-11).
 *
 * Incident: a resumed/interrupted session sent /v1/messages bodies where an
 * assistant `tool_use` had no `tool_result` in the immediately-following
 * message — DeepSeek's anthropic endpoint 400s deterministically and the
 * user saw 7 identical failures. The request-build sanitizer provably
 * strips every reconstructable turns-shape, so the poison body came from a
 * path we could not identify statically. These helpers give (a) a final
 * pre-wire guard at the loop's send chokepoint and (b) a content-free
 * shape summary the daemon logs on tool-pairing 4xx so the next
 * occurrence identifies the sender.
 */
import { describe, it, expect } from 'vitest'
import {
  detailLooksLikeToolPairingError,
  findOrphanToolUseIds,
  reorderToolResultsFirst,
  stripOrphanToolUseBlocks,
  summarizeMessagesShape,
} from '../../src/native/protocol/tool-pairing.js'

const text = (t: string) => ({ type: 'text', text: t })
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'bash', input: {} })
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

describe('findOrphanToolUseIds', () => {
  it('returns [] for a cleanly paired conversation', () => {
    const messages = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [text('a'), toolUse('tu_1')] },
      { role: 'user', content: [toolResult('tu_1'), text('next')] },
      { role: 'assistant', content: [text('done')] },
    ]
    expect(findOrphanToolUseIds(messages)).toEqual([])
  })

  it('flags a tool_use whose next message has no matching tool_result', () => {
    const messages = [
      { role: 'assistant', content: [text('a'), toolUse('tu_X')] },
      { role: 'user', content: [text('new question')] },
    ]
    expect(findOrphanToolUseIds(messages)).toEqual([{ index: 0, id: 'tu_X' }])
  })

  it('flags a tool_use at the very end of the message list', () => {
    const messages = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [toolUse('tu_END')] },
    ]
    expect(findOrphanToolUseIds(messages)).toEqual([{ index: 1, id: 'tu_END' }])
  })

  it('flags only the unmatched ids when results are partial', () => {
    const messages = [
      { role: 'assistant', content: [toolUse('tu_A'), toolUse('tu_B')] },
      { role: 'user', content: [toolResult('tu_A')] },
    ]
    expect(findOrphanToolUseIds(messages)).toEqual([{ index: 0, id: 'tu_B' }])
  })

  it('tolerates string-content messages and missing content arrays', () => {
    const messages = [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: [toolUse('tu_1')] },
      { role: 'user', content: [toolResult('tu_1')] },
    ]
    expect(findOrphanToolUseIds(messages as never)).toEqual([])
  })
})

describe('stripOrphanToolUseBlocks', () => {
  it('removes only the orphan tool_use blocks and keeps the rest', () => {
    const messages = [
      { role: 'assistant', content: [text('a'), toolUse('tu_X')] },
      { role: 'user', content: [text('new question')] },
    ]
    const { messages: out, strippedIds } = stripOrphanToolUseBlocks(messages)
    expect(strippedIds).toEqual(['tu_X'])
    expect(out[0]!.content).toEqual([text('a')])
    expect(out[1]).toEqual(messages[1])
  })

  it('drops a message left with no content after stripping', () => {
    const messages = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [toolUse('tu_ONLY')] },
      { role: 'user', content: [text('new question')] },
    ]
    const { messages: out, strippedIds } = stripOrphanToolUseBlocks(messages)
    expect(strippedIds).toEqual(['tu_ONLY'])
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('is a no-op (same array back, no ids) when pairing is clean', () => {
    const messages = [
      { role: 'assistant', content: [toolUse('tu_1')] },
      { role: 'user', content: [toolResult('tu_1')] },
    ]
    const { messages: out, strippedIds } = stripOrphanToolUseBlocks(messages)
    expect(strippedIds).toEqual([])
    expect(out).toBe(messages)
  })
})

describe('reorderToolResultsFirst', () => {
  it('moves leading text behind tool_results in a user turn', () => {
    const messages = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [text('queued'), toolResult('A')] },
    ]
    const { messages: out, reorderedCount } = reorderToolResultsFirst(messages)
    expect(reorderedCount).toBe(1)
    expect(out[1]!.content).toEqual([toolResult('A'), text('queued')])
  })

  it('is a zero-alloc no-op when results already lead (or no results present)', () => {
    const messages = [
      { role: 'user', content: [toolResult('A'), text('after')] },
      { role: 'assistant', content: [text('a'), toolUse('B')] },
      { role: 'user', content: [text('plain')] },
    ]
    const { messages: out, reorderedCount } = reorderToolResultsFirst(messages)
    expect(reorderedCount).toBe(0)
    expect(out).toBe(messages)
  })

  it('does not touch assistant turns that lead with text before tool_use', () => {
    const messages = [{ role: 'assistant', content: [text('think'), toolUse('A')] }]
    const { reorderedCount } = reorderToolResultsFirst(messages)
    expect(reorderedCount).toBe(0)
  })

  it('handles multiple results with interleaved text', () => {
    const messages = [
      { role: 'user', content: [text('x'), toolResult('A'), text('y'), toolResult('B')] },
    ]
    const { messages: out } = reorderToolResultsFirst(messages)
    expect(out[0]!.content).toEqual([toolResult('A'), toolResult('B'), text('x'), text('y')])
  })
})

describe('summarizeMessagesShape', () => {
  it('emits a content-free shape with roles, block types and tool ids', () => {
    const messages = [
      { role: 'user', content: [text('SECRET question')] },
      { role: 'assistant', content: [text('SECRET answer'), toolUse('tu_9')] },
      { role: 'user', content: [toolResult('tu_9')] },
    ]
    const shape = summarizeMessagesShape(messages)
    expect(shape).toContain('total=3')
    expect(shape).toContain('assistant')
    expect(shape).toContain('tool_use(tu_9)')
    expect(shape).toContain('tool_result(tu_9)')
    expect(shape).not.toContain('SECRET')
  })

  it('caps the dump to the tail but keeps the total count', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: [text(`m${i}`)],
    }))
    const shape = summarizeMessagesShape(messages, { tail: 5 })
    expect(shape).toContain('total=50')
    expect(shape.split('\n').filter((l) => /^\s*\[\d+\]/.test(l))).toHaveLength(5)
  })
})

describe('detailLooksLikeToolPairingError', () => {
  it('matches the DeepSeek/Anthropic orphan tool_use detail', () => {
    expect(detailLooksLikeToolPairingError(
      'messages.412: `tool_use` ids were found without `tool_result` blocks immediately after: call_00_x',
    )).toBe(true)
  })

  it('matches tool_result-without-tool_use variants', () => {
    expect(detailLooksLikeToolPairingError(
      'messages.3: unexpected `tool_result` block: no matching `tool_use`',
    )).toBe(true)
  })

  it('does not match unrelated 400 details', () => {
    expect(detailLooksLikeToolPairingError('max_tokens: must be positive')).toBe(false)
    expect(detailLooksLikeToolPairingError('')).toBe(false)
  })
})
