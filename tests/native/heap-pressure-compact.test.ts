/**
 * Tests for the 0.13.62 (A) heap-pressure emergency compact helpers.
 *
 * These pin the standalone helpers exported from conversation.ts:
 *   - getHeapPressureRatio() with stubbed memoryUsage / heapLimit
 *   - emergencyHeapCompact() trims to last 20% when ratio crosses
 *     the 0.75 threshold; no-op otherwise; preserves invariants
 *
 * The full integration through runConversationLoop is harder to
 * stub deterministically (V8 heap state is global) — these
 * helper-level tests are enough to lock the contract that the loop
 * relies on.
 */
import { describe, it, expect } from 'vitest'
import {
  addUserMessage,
  createConversation,
  createHeapCompactGovernor,
  emergencyHeapCompact,
  estimateConversationBytes,
  getHeapPressureRatio,
} from '../../src/native/conversation.js'

describe('getHeapPressureRatio (0.13.62)', () => {
  it('returns heapUsed / heapLimit', () => {
    const ratio = getHeapPressureRatio(
      () => ({ heapUsed: 750, heapTotal: 1000, external: 0, arrayBuffers: 0, rss: 0 }),
      () => 1000,
    )
    expect(ratio).toBe(0.75)
  })

  it('returns 0 when limit is 0 or negative (defensive)', () => {
    const ratio = getHeapPressureRatio(
      () => ({ heapUsed: 100, heapTotal: 1000, external: 0, arrayBuffers: 0, rss: 0 }),
      () => 0,
    )
    expect(ratio).toBe(0)
  })

  it('reads real values when no stubs provided', () => {
    const ratio = getHeapPressureRatio()
    expect(ratio).toBeGreaterThan(0)
    expect(ratio).toBeLessThan(1)
  })
})

describe('emergencyHeapCompact (0.13.62)', () => {
  function makeConv(turnCount: number) {
    const conv = createConversation({ system: 'test', model: 'm' })
    for (let i = 0; i < turnCount; i++) {
      addUserMessage(conv, `turn ${i}: ${'x'.repeat(100)}`)
    }
    return conv
  }

  it('returns null when ratio is below threshold', () => {
    const conv = makeConv(20)
    expect(emergencyHeapCompact(conv, 0.5)).toBeNull()
    expect(conv.turns).toHaveLength(20)
  })

  it('returns null when conversation is too small (≤4 turns)', () => {
    const conv = makeConv(4)
    expect(emergencyHeapCompact(conv, 0.95)).toBeNull()
    expect(conv.turns).toHaveLength(4)
  })

  it('compacts to ~20% plus the pinned task anchor when ratio crosses 0.75', () => {
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.8)
    expect(result).not.toBeNull()
    expect(result!.before).toBe(20)
    // floor(20 * 0.2) = 4 tail turns + 1 pinned anchor (turn 0)
    expect(result!.after).toBe(5)
    expect(conv.turns).toHaveLength(5)
  })

  it('keeps the most recent turns plus the first user turn (task anchor)', () => {
    const conv = makeConv(10)
    emergencyHeapCompact(conv, 0.9)
    // floor(10 * 0.2) = 2 tail turns + anchor
    expect(conv.turns).toHaveLength(3)
    const firstText = conv.turns[0]?.content[0]
    expect(firstText && firstText.type === 'text' ? firstText.text : '').toContain('turn 0')
    const lastTurn = conv.turns[conv.turns.length - 1]
    const text = lastTurn?.content[0]
    expect(text && text.type === 'text' ? text.text : '').toContain('turn 9')
  })

  it('enforces minimum-of-2 tail turns even on very small conversations', () => {
    const conv = makeConv(5)
    const result = emergencyHeapCompact(conv, 0.95)
    // floor(5 * 0.2) = 1, but minimum 2 tail turns + anchor
    expect(result?.after).toBe(3)
  })

  it('keeps exactly one anchor across repeated compactions (no duplication)', () => {
    const conv = makeConv(20)
    emergencyHeapCompact(conv, 0.9)
    emergencyHeapCompact(conv, 0.9)
    const anchorCopies = conv.turns.filter((t) => {
      const block = t.content[0]
      return block?.type === 'text' && block.text.startsWith('turn 0:')
    })
    expect(anchorCopies).toHaveLength(1)
    expect(conv.turns[0]).toBe(anchorCopies[0])
  })

  it('falls back to plain tail slice when no text-bearing user turn exists', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    for (let i = 0; i < 10; i++) {
      conv.turns.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'r'.repeat(50) } as never],
        timestamp: Date.now(),
      })
    }
    const result = emergencyHeapCompact(conv, 0.9)
    expect(result).not.toBeNull()
    // no anchor to pin; sanitize drops orphan tool_results, but the call must not throw
    expect(result!.after).toBeLessThanOrEqual(2)
  })

  it('exactly at threshold (0.75) triggers compact', () => {
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.75)
    expect(result).not.toBeNull()
  })

  it('just below threshold (0.74) does NOT trigger', () => {
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.74)
    expect(result).toBeNull()
  })
})

describe('estimateConversationBytes (2026-06-11 significance gate)', () => {
  it('scales with the text held in turns', () => {
    const small = createConversation({ system: 'test', model: 'm' })
    addUserMessage(small, 'hi')
    const big = createConversation({ system: 'test', model: 'm' })
    addUserMessage(big, 'x'.repeat(100_000))
    expect(estimateConversationBytes(big)).toBeGreaterThan(estimateConversationBytes(small) + 100_000)
  })

  it('returns 0 for an empty conversation', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(estimateConversationBytes(conv)).toBe(0)
  })
})

describe('emergencyHeapCompact heap-significance gate (2026-06-11)', () => {
  function makeConv(turnCount: number) {
    const conv = createConversation({ system: 'test', model: 'm' })
    for (let i = 0; i < turnCount; i++) {
      addUserMessage(conv, `turn ${i}: ${'x'.repeat(100)}`)
    }
    return conv
  }

  it('skips the cut when the conversation is an insignificant share of heapUsed', () => {
    // ~20 turns × ~110 chars ≈ a few KB; heapUsed 1 GB → cutting cannot relieve pressure
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.9, 1024 * 1024 * 1024)
    expect(result).toBeNull()
    expect(conv.turns).toHaveLength(20)
  })

  it('cuts when the conversation IS a significant share of heapUsed', () => {
    const conv = makeConv(20)
    const convBytes = estimateConversationBytes(conv)
    // pretend heapUsed is only 2× the conversation: history is the heap hog
    const result = emergencyHeapCompact(conv, 0.9, convBytes * 2)
    expect(result).not.toBeNull()
    expect(conv.turns.length).toBeLessThan(20)
  })

  it('omitting heapUsedBytes preserves legacy always-cut behavior', () => {
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.9)
    expect(result).not.toBeNull()
  })
})

describe('createHeapCompactGovernor (2026-06-11 amnesia fix)', () => {
  it('allows compaction on the first high-pressure reading', () => {
    const gov = createHeapCompactGovernor()
    const verdict = gov.evaluate(0.8)
    expect(verdict.allowCompact).toBe(true)
    expect(verdict.justTripped).toBe(false)
  })

  it('does not allow (and does not trip) below the threshold', () => {
    const gov = createHeapCompactGovernor()
    const verdict = gov.evaluate(0.5)
    expect(verdict.allowCompact).toBe(false)
    expect(verdict.justTripped).toBe(false)
  })

  it('trips after two consecutive ineffective cuts and reports justTripped exactly once', () => {
    const gov = createHeapCompactGovernor()
    // cut 1: pressure high, compact runs
    expect(gov.evaluate(0.8).allowCompact).toBe(true)
    gov.recordCompacted()
    // next reading still high → cut 1 was ineffective; one more cut allowed
    expect(gov.evaluate(0.82).allowCompact).toBe(true)
    gov.recordCompacted()
    // still high → cut 2 also ineffective: history is not the heap hog. Trip.
    const tripped = gov.evaluate(0.84)
    expect(tripped.allowCompact).toBe(false)
    expect(tripped.justTripped).toBe(true)
    // subsequent readings stay denied without re-announcing
    const after = gov.evaluate(0.9)
    expect(after.allowCompact).toBe(false)
    expect(after.justTripped).toBe(false)
  })

  it('resets the ineffective counter when pressure drops below threshold', () => {
    const gov = createHeapCompactGovernor()
    expect(gov.evaluate(0.8).allowCompact).toBe(true)
    gov.recordCompacted()
    // pressure relieved — the cut worked
    expect(gov.evaluate(0.4).allowCompact).toBe(false)
    // pressure returns later: full budget again, no trip on the next ineffective cut
    expect(gov.evaluate(0.8).allowCompact).toBe(true)
    gov.recordCompacted()
    const verdict = gov.evaluate(0.8)
    expect(verdict.allowCompact).toBe(true)
    expect(verdict.justTripped).toBe(false)
  })

  it('stays tripped even if pressure later drops and rises again (sticky per run)', () => {
    const gov = createHeapCompactGovernor()
    gov.evaluate(0.8); gov.recordCompacted()
    gov.evaluate(0.8); gov.recordCompacted()
    expect(gov.evaluate(0.8).justTripped).toBe(true)
    expect(gov.evaluate(0.4).allowCompact).toBe(false)
    const back = gov.evaluate(0.9)
    expect(back.allowCompact).toBe(false)
    expect(back.justTripped).toBe(false)
  })
})
