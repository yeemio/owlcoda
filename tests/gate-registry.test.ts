import { describe, expect, it } from 'vitest'
import { findFlagDebt, GATE_REGISTRY } from '../src/native/gate-registry.js'

const NOW = Date.parse('2026-06-06T00:00:00Z')

const reg = [
  { id: 'a', envVar: 'OWLCODA_A', stage: 'shadow', openedDate: '2026-05-01', reviewBy: '2026-05-20' }, // overdue
  { id: 'b', envVar: 'OWLCODA_B', stage: 'shadow', openedDate: '2026-06-01', reviewBy: '2026-06-20' }, // future
  { id: 'c', envVar: 'OWLCODA_C', stage: 'default', openedDate: '2026-04-01', reviewBy: '2026-04-10' }, // settled
] as const

describe('findFlagDebt', () => {
  it('flags an opt-in gate past its review date, with overdue days', () => {
    const debt = findFlagDebt(reg as never, NOW)
    expect(debt.map(d => d.id)).toEqual(['a'])
    expect(debt[0]!.overdueDays).toBeGreaterThan(0)
  })

  it('does not flag a gate whose review date is still in the future', () => {
    expect(findFlagDebt(reg as never, NOW).find(d => d.id === 'b')).toBeUndefined()
  })

  it('never flags a settled (default/retired) gate even if its date passed', () => {
    expect(findFlagDebt(reg as never, NOW).find(d => d.id === 'c')).toBeUndefined()
  })

  it('returns empty when nothing is overdue yet', () => {
    expect(findFlagDebt(reg as never, Date.parse('2026-05-01T00:00:00Z'))).toEqual([])
  })
})

describe('GATE_REGISTRY', () => {
  it('registers opt-in gates with OWLCODA_ env vars, valid stages, and parseable review dates', () => {
    expect(GATE_REGISTRY.length).toBeGreaterThan(0)
    for (const e of GATE_REGISTRY) {
      expect(e.envVar).toMatch(/^OWLCODA_/)
      expect(['shadow', 'canary', 'default', 'retired']).toContain(e.stage)
      expect(Number.isNaN(Date.parse(e.reviewBy))).toBe(false)
    }
  })

  it('includes the cutover-tracked gates', () => {
    const ids = GATE_REGISTRY.map(e => e.id)
    expect(ids).toContain('provenance')
    expect(ids).toContain('gate_v2')
  })
})
