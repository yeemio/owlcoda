import { describe, expect, it } from 'vitest'
import { traceFromTurns, diffTrace, traceMatches } from '../src/native/transcript-trace.js'
import type { ConversationTurn } from '../src/native/protocol/types.js'

function toolTurn(name: string, input: Record<string, unknown>): ConversationTurn {
  return { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }], timestamp: 0 }
}
function textTurn(text: string): ConversationTurn {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 }
}

describe('traceFromTurns', () => {
  it('extracts the ordered tool-call sequence, ignoring text and results', () => {
    const turns = [
      toolTurn('Read', { path: '/a.ts' }),
      textTurn('thinking'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }], timestamp: 0 } as ConversationTurn,
      toolTurn('Edit', { path: '/a.ts' }),
    ]
    expect(traceFromTurns(turns)).toEqual([
      { name: 'Read', input: { path: '/a.ts' } },
      { name: 'Edit', input: { path: '/a.ts' } },
    ])
  })

  it('applies the normalize hook to inputs', () => {
    const turns = [toolTurn('Read', { path: '/tmp/x/a.ts' })]
    const trace = traceFromTurns(turns, i => ({ ...i, path: String(i.path).replace('/tmp/x', '__WS__') }))
    expect(trace[0]!.input.path).toBe('__WS__/a.ts')
  })
})

describe('diffTrace', () => {
  const g = [{ name: 'Read', input: { path: '/a' } }, { name: 'Edit', input: { path: '/a' } }]

  it('returns no diffs for identical traces (key order independent)', () => {
    expect(diffTrace(g, [{ name: 'Read', input: { path: '/a' } }, { name: 'Edit', input: { path: '/a' } }])).toEqual([])
  })

  it('flags a tool-name mismatch at the position', () => {
    const d = diffTrace(g, [{ name: 'Read', input: { path: '/a' } }, { name: 'Write', input: { path: '/a' } }])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ index: 1, kind: 'name_mismatch' })
  })

  it('flags an input mismatch', () => {
    const d = diffTrace(g, [{ name: 'Read', input: { path: '/b' } }, { name: 'Edit', input: { path: '/a' } }])
    expect(d[0]).toMatchObject({ index: 0, kind: 'input_mismatch' })
  })

  it('flags extra and missing trace entries', () => {
    expect(diffTrace(g, [g[0]!])[0]).toMatchObject({ index: 1, kind: 'missing_in_actual' })
    expect(diffTrace([g[0]!], g)[0]).toMatchObject({ index: 1, kind: 'extra_in_actual' })
  })

  it('treats inputs as equal regardless of key order', () => {
    expect(diffTrace(
      [{ name: 'Edit', input: { path: '/a', old: 'x', new: 'y' } }],
      [{ name: 'Edit', input: { new: 'y', path: '/a', old: 'x' } }],
    )).toEqual([])
  })
})

describe('traceMatches', () => {
  it('is true iff there are no diffs', () => {
    expect(traceMatches([{ name: 'Read', input: {} }], [{ name: 'Read', input: {} }])).toBe(true)
    expect(traceMatches([{ name: 'Read', input: {} }], [{ name: 'Edit', input: {} }])).toBe(false)
  })
})
