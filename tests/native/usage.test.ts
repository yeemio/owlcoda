import { describe, it, expect, beforeEach } from 'vitest'
import {
  UsageTracker,
  buildContextBudgetSnapshot,
  estimateConversationTokenBreakdown,
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

  it('formats usage as an aligned key-value panel (chrome spec S3)', () => {
    tracker.recordUsage({ inputTokens: 1500, outputTokens: 3000 })
    const formatted = tracker.formatUsage().replace(/\x1b\[[0-9;]*m/g, '')
    expect(formatted).toContain('1,500 in')
    expect(formatted).toContain('3,000 out')
    expect(formatted).toContain('4,500 total')
    expect(formatted).toMatch(/Requests\s+1/)
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

describe('estimateConversationTokenBreakdown', () => {
  it('separates request text, tool calls, and retained tool evidence', () => {
    const conv = {
      system: 'System rules',
      turns: [
        { role: 'user', content: [{ type: 'text', text: 'User asks' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect' },
            { type: 'tool_use', input: { command: 'rg context' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'tool evidence retained' }],
        },
      ],
    }
    const breakdown = estimateConversationTokenBreakdown(conv)
    expect(breakdown.systemTokens).toBe(estimateTokens('System rules'))
    expect(breakdown.userTextTokens).toBe(estimateTokens('User asks'))
    expect(breakdown.assistantTextTokens).toBe(estimateTokens('I will inspect'))
    expect(breakdown.toolUseTokens).toBe(estimateTokens(JSON.stringify({ command: 'rg context' })))
    expect(breakdown.toolResultTokens).toBe(estimateTokens('tool evidence retained'))
    expect(breakdown.totalTokens).toBe(
      breakdown.systemTokens
      + breakdown.userTextTokens
      + breakdown.assistantTextTokens
      + breakdown.toolUseTokens
      + breakdown.toolResultTokens,
    )
  })

  it('counts array-style tool result text content', () => {
    const breakdown = estimateConversationTokenBreakdown({
      system: '',
      turns: [
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            content: [
              { type: 'text', text: 'first chunk' },
              { type: 'text', text: 'second chunk' },
            ],
          }],
        },
      ],
    })
    expect(breakdown.toolResultTokens).toBe(estimateTokens('first chunk') + estimateTokens('second chunk'))
  })
})

describe('buildContextBudgetSnapshot', () => {
  it('keeps context window, output cap, and threshold as separate facts', () => {
    const conv = {
      system: '',
      turns: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }],
    }
    const snapshot = buildContextBudgetSnapshot(conv, 1000, {
      outputMaxTokens: 2048,
      thresholdRatio: 0.75,
    })
    expect(snapshot.usedTokens).toBe(100)
    expect(snapshot.contextWindow).toBe(1000)
    expect(snapshot.outputMaxTokens).toBe(2048)
    expect(snapshot.thresholdTokens).toBe(750)
    expect(snapshot.overThreshold).toBe(false)
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

  it('distinguishes request context from output max tokens and display scrollback', () => {
    const output = formatBudget(1000, 100000, {
      outputMaxTokens: 4096,
      breakdown: {
        systemTokens: 10,
        userTextTokens: 20,
        assistantTextTokens: 30,
        toolUseTokens: 40,
        toolResultTokens: 900,
        turnTokens: 990,
        totalTokens: 1000,
      },
      includeBreakdown: true,
      includeDisplayNote: true,
    })
    expect(output).toContain('Request context')
    expect(output).toContain('Output max_tokens')
    expect(output).toContain('Tool evidence retained')
    expect(output).toContain('Display scrollback')
  })
})
