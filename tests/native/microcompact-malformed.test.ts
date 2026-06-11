import { describe, expect, it } from 'vitest'
import { analyzeMicrocompact, recordMicrocompactShadow } from '../../src/native/microcompact.js'

// A streamed tool_use whose JSON args failed to parse can leave `input` as
// undefined/null. analyzeMicrocompact reads block.input.path, so a malformed
// block threw a TypeError straight into the conversation loop (recordMicrocompactShadow
// runs on the compaction path). Shadow analysis must never disturb the caller.
describe('analyzeMicrocompact — malformed tool_use robustness', () => {
  const malformedTurns = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: undefined },
        { type: 'tool_use', id: 't2', name: 'Read', input: null },
        { type: 'tool_use', id: 't3', name: 'Read', input: 'not-an-object' },
      ],
    },
  ] as never

  it('does not throw when a tool_use block has a non-object input', () => {
    expect(() => analyzeMicrocompact(malformedTurns)).not.toThrow()
  })

  it('recordMicrocompactShadow never throws into the caller (shadow enabled)', () => {
    expect(() =>
      recordMicrocompactShadow(malformedTurns, { OWLCODA_MICROCOMPACT_SHADOW: '1' } as NodeJS.ProcessEnv),
    ).not.toThrow()
  })
})
