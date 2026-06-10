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
  emergencyHeapCompact,
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

  it('compacts to ~20% when ratio crosses 0.75', () => {
    const conv = makeConv(20)
    const result = emergencyHeapCompact(conv, 0.8)
    expect(result).not.toBeNull()
    expect(result!.before).toBe(20)
    // floor(20 * 0.2) = 4, but minimum is 2; for 20 turns we expect 4
    expect(result!.after).toBe(4)
    expect(conv.turns).toHaveLength(4)
  })

  it('keeps the most recent turns (not the oldest)', () => {
    const conv = makeConv(10)
    emergencyHeapCompact(conv, 0.9)
    // floor(10 * 0.2) = 2 turns kept, last 2
    expect(conv.turns).toHaveLength(2)
    const lastTurn = conv.turns[conv.turns.length - 1]
    const text = lastTurn?.content[0]
    expect(text && text.type === 'text' ? text.text : '').toContain('turn 9')
  })

  it('enforces minimum-of-2 turns even on very small conversations', () => {
    const conv = makeConv(5)
    const result = emergencyHeapCompact(conv, 0.95)
    // floor(5 * 0.2) = 1, but minimum 2
    expect(result?.after).toBe(2)
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
