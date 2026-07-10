import { describe, expect, it } from 'vitest'
import { compactOlderToolResults } from '../../src/native/rolling-context-hygiene.js'

describe('rolling context hygiene', () => {
  it('compacts old large tool results and preserves recent turns', () => {
    const oldOutput = `HEAD-${'x'.repeat(1800)}-TAIL`
    const conversation = {
      turns: Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: String(index), content: index === 0 ? oldOutput : 'short' }],
      })),
    } as any

    const result = compactOlderToolResults(conversation, { iteration: 8 })

    expect(result.compactedResults).toBe(1)
    const compacted = conversation.turns[0].content[0].content as string
    expect(compacted).toContain('HEAD-')
    expect(compacted).toContain('-TAIL')
    expect(compacted).toContain('omitted')
    expect(conversation.turns[9].content[0].content).toBe('short')
  })
})
