import { describe, expect, it } from 'vitest'
import { compactOlderToolResults } from '../../src/native/rolling-context-hygiene.js'

describe('rolling context hygiene', () => {
  it('skips sub-4k savings below the high-water pressure threshold', () => {
    const oldOutput = `HEAD-${'x'.repeat(1800)}-TAIL`
    const conversation = {
      turns: Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: String(index), content: index === 0 ? oldOutput : 'short' }],
      })),
    } as any

    const result = compactOlderToolResults(conversation, { iteration: 8, contextUsageRatio: 0.5 })

    expect(result).toEqual({ compactedResults: 0, omittedChars: 0 })
    expect(conversation.turns[0].content[0].content).toBe(oldOutput)
  })

  it('uses high/low-water hysteresis for small compactions', () => {
    const makeConversation = () => ({
      turns: Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: String(index), content: index === 0 ? `HEAD-${'x'.repeat(1800)}-TAIL` : 'short' }],
      })),
      options: {},
    } as any)
    const conversation = makeConversation()

    expect(compactOlderToolResults(conversation, { iteration: 8, contextUsageRatio: 0.91 }).compactedResults).toBe(1)
    expect(conversation.options.contextHygieneActive).toBe(true)

    const continued = makeConversation()
    continued.options.contextHygieneActive = true
    expect(compactOlderToolResults(continued, { iteration: 8, contextUsageRatio: 0.8 }).compactedResults).toBe(1)

    const stopped = makeConversation()
    stopped.options.contextHygieneActive = true
    expect(compactOlderToolResults(stopped, { iteration: 8, contextUsageRatio: 0.74 }).compactedResults).toBe(0)
    expect(stopped.options.contextHygieneActive).toBe(false)
  })

  it('compacts large savings at low pressure and preserves the six newest turns', () => {
    const oldOutput = `HEAD-${'x'.repeat(6000)}-TAIL`
    const conversation = {
      turns: Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: String(index), content: index === 0 || index === 4 ? oldOutput : 'short' }],
      })),
    } as any

    const result = compactOlderToolResults(conversation, { iteration: 8, contextUsageRatio: 0.5 })

    expect(result.compactedResults).toBe(1)
    const compacted = conversation.turns[0].content[0].content as string
    expect(compacted).toContain('HEAD-')
    expect(compacted).toContain('-TAIL')
    expect(compacted).toContain('omitted')
    expect(conversation.turns[4].content[0].content).toBe(oldOutput)
  })

  it('records a concrete Read recovery hint when the matching tool call has a path', () => {
    const oldOutput = `HEAD-${'x'.repeat(6000)}-TAIL`
    const conversation = {
      turns: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/tmp/report.txt', offset: 20, limit: 40 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: oldOutput }] },
        ...Array.from({ length: 8 }, () => ({ role: 'user', content: [{ type: 'text', text: 'next' }] })),
      ],
    } as any

    compactOlderToolResults(conversation, { iteration: 8, contextUsageRatio: 0.5 })

    const compacted = conversation.turns[1].content[0].content as string
    expect(compacted).toContain('Read(path="/tmp/report.txt", offset=20, limit=40)')
    expect(compacted).not.toContain('raw output retained')
  })
})
