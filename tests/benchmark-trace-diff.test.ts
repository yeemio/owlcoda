import { describe, expect, it } from 'vitest'
import { diffResults, diffIsClean, traceFromMockSequence } from '../src/benchmark/runner.js'
import type { BenchmarkDryRunResult } from '../src/benchmark/types.js'

type Bare = Omit<BenchmarkDryRunResult, 'caseId' | 'packageVersion' | 'binaryBuild'>

function base(overrides: Partial<Bare> = {}): Bare {
  return {
    selectedSkill: null,
    timeToFirstWriteMs: 0,
    readCallsBeforeFirstWrite: 0,
    artifacts: [],
    verification: [],
    taskNoProgress: { hard: 0, suppressed: 0 },
    finalStatus: 'passed',
    ...overrides,
  }
}

describe('diffResults — golden trace', () => {
  it('ignores the trace when the fixture declares no golden trace', () => {
    const d = diffResults(base(), base({ trace: [{ name: 'Read', input: {} }] }))
    expect(d.traceMismatches).toBeUndefined()
    expect(diffIsClean(d)).toBe(true)
  })

  it('flags a trace mismatch and fails clean when actual diverges from the golden', () => {
    const golden = base({ trace: [{ name: 'Read', input: { path: '/a' } }] })
    const actual = base({ trace: [{ name: 'Edit', input: { path: '/a' } }] })
    const d = diffResults(golden, actual)
    expect((d.traceMismatches ?? []).length).toBeGreaterThan(0)
    expect(diffIsClean(d)).toBe(false)
  })

  it('passes when the actual trace matches the golden', () => {
    const t = [{ name: 'Read', input: { path: '/a' } }]
    const d = diffResults(base({ trace: t }), base({ trace: [...t] }))
    expect(d.traceMismatches).toBeUndefined()
    expect(diffIsClean(d)).toBe(true)
  })
})

describe('traceFromMockSequence', () => {
  it('derives the golden tool-call trace from the cassette responses', () => {
    const seq = [
      { text: '', toolUse: [{ toolName: 'read', input: { path: '/a' } }], stopReason: 'tool_use' as const },
      { text: '', toolUse: [{ toolName: 'write', input: { path: '/b' } }], stopReason: 'tool_use' as const },
      { text: 'done', toolUse: [], stopReason: 'end_turn' as const },
    ]
    expect(traceFromMockSequence(seq)).toEqual([
      { name: 'read', input: { path: '/a' } },
      { name: 'write', input: { path: '/b' } },
    ])
  })
})
