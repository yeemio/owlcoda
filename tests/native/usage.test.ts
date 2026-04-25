import { describe, it, expect, beforeEach } from 'vitest'
import {
  UsageTracker,
  estimateTokens,
  estimateConversationTokens,
  formatBudget,
} from '../../src/native/usage.js'

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 4 characters', () => {
    expect(estimateTokens('hello world')).toBe(3) // ceil(11/4)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('rounds up', () => {
    expect(estimateTokens('a')).toBe(1) // ceil(1/4)
    expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
  })
})

describe('UsageTracker', () => {
  let tracker: UsageTracker

  beforeEach(() => {
    tracker = new UsageTracker()
  })

  it('starts with zero usage', () => {
    const snap = tracker.getSnapshot()
    expect(snap.totalInputTokens).toBe(0)
    expect(snap.totalOutputTokens).toBe(0)
    expect(snap.requestCount).toBe(0)
    expect(snap.totalTokens).toBe(0)
    expect(snap.startedAt).toBeNull()
  })

  it('records usage from explicit token counts', () => {
    tracker.recordUsage({ inputTokens: 100, outputTokens: 200 })
    const snap = tracker.getSnapshot()
    expect(snap.totalInputTokens).toBe(100)
    expect(snap.totalOutputTokens).toBe(200)
    expect(snap.totalTokens).toBe(300)
    expect(snap.requestCount).toBe(1)
    expect(snap.startedAt).not.toBeNull()
  })

  it('accumulates across multiple calls', () => {
    tracker.recordUsage({ inputTokens: 50, outputTokens: 100 })
    tracker.recordUsage({ inputTokens: 30, outputTokens: 70 })
    const snap = tracker.getSnapshot()
    expect(snap.totalInputTokens).toBe(80)
    expect(snap.totalOutputTokens).toBe(170)
    expect(snap.requestCount).toBe(2)
  })

  it('records estimated usage from text', () => {
    tracker.recordEstimated('hello world', 'this is the response text')
    const snap = tracker.getSnapshot()
    expect(snap.totalInputTokens).toBe(estimateTokens('hello world'))
    expect(snap.totalOutputTokens).toBe(estimateTokens('this is the response text'))
  })

  it('calculates estimated cost', () => {
    tracker.recordUsage({ inputTokens: 1000, outputTokens: 1000 })
    const snap = tracker.getSnapshot()
    // $0.003/1K input + $0.015/1K output = $0.003 + $0.015 = $0.018
    expect(snap.estimatedCostUsd).toBeCloseTo(0.018, 4)
  })

  it('resets all counters', () => {
    tracker.recordUsage({ inputTokens: 100, outputTokens: 200 })
    tracker.reset()
    const snap = tracker.getSnapshot()
    expect(snap.totalInputTokens).toBe(0)
    expect(snap.totalOutputTokens).toBe(0)
    expect(snap.requestCount).toBe(0)
    expect(snap.startedAt).toBeNull()
  })

  it('formats usage as readable string', () => {
    tracker.recordUsage({ inputTokens: 1500, outputTokens: 3000 })
    const formatted = tracker.formatUsage()
    expect(formatted).toContain('1,500 in')
    expect(formatted).toContain('3,000 out')
    expect(formatted).toContain('4,500 total')
    expect(formatted).toContain('Requests: 1')
    expect(formatted).toContain('fictional')
  })

  it('tracks elapsed time', async () => {
    tracker.recordUsage({ inputTokens: 10, outputTokens: 20 })
    // Wait a tiny bit
    await new Promise((r) => setTimeout(r, 50))
    const snap = tracker.getSnapshot()
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(40)
  })
})

describe('estimateConversationTokens', () => {
  it('estimates tokens for system + text turns', () => {
    const conv = {
      system: 'Be helpful.',
      turns: [
        { content: [{ type: 'text', text: 'Hello' }] },
        { content: [{ type: 'text', text: 'Hi there, how can I help?' }] },
      ],
    }
    const est = estimateConversationTokens(conv)
    expect(est.systemTokens).toBe(estimateTokens('Be helpful.'))
    expect(est.turnTokens).toBeGreaterThan(0)
    expect(est.totalTokens).toBe(est.systemTokens + est.turnTokens)
  })

  it('counts tool_result content', () => {
    const conv = {
      system: '',
      turns: [
        { content: [{ type: 'tool_result', content: 'file contents here' }] },
      ],
    }
    const est = estimateConversationTokens(conv)
    expect(est.turnTokens).toBe(estimateTokens('file contents here'))
  })

  it('counts tool_use input', () => {
    const conv = {
      system: '',
      turns: [
        { content: [{ type: 'tool_use', input: { command: 'ls -la' } }] },
      ],
    }
    const est = estimateConversationTokens(conv)
    expect(est.turnTokens).toBeGreaterThan(0)
  })

  it('returns zero for empty conversation', () => {
    const est = estimateConversationTokens({ system: '', turns: [] })
    expect(est.totalTokens).toBe(0)
  })
})

describe('formatBudget', () => {
  it('shows percentage and progress bar', () => {
    const output = formatBudget(5000, 100000)
    expect(output).toContain('5,000')
    expect(output).toContain('100,000')
    expect(output).toContain('5.0%')
    expect(output).toContain('█')
  })

  it('warns at high usage', () => {
    const output = formatBudget(90000, 100000)
    expect(output).toContain('⚠')
    expect(output).toContain('compact')
  })

  it('no warning at low usage', () => {
    const output = formatBudget(1000, 100000)
    expect(output).not.toContain('⚠')
  })
})
