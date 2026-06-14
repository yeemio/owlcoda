import { describe, expect, it } from 'vitest'
import { devig, valueReads, extractH2HOdds } from '../server/odds.js'

const HEAVY = [1.3, 5.5, 11.0]

describe('devig (TS port, parity with jingcai_pipeline.py)', () => {
  it('proportional sums to 1 and recovers overround', () => {
    const r = devig(HEAVY, 'proportional')!
    expect(r.parameterName).toBe('overround')
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(r.parameter).toBeCloseTo(0.042, 3)
  })
  it('shin and power push favourite up, longshot down vs proportional', () => {
    const prop = devig(HEAVY, 'proportional')!.probabilities
    const shin = devig(HEAVY, 'shin')!.probabilities
    const power = devig(HEAVY, 'power')!.probabilities
    for (const corrected of [shin, power]) {
      expect(corrected[0]).toBeGreaterThan(prop[0]) // favourite up
      expect(corrected[2]).toBeLessThan(prop[2]) // longshot down
      expect(corrected.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
  })
  it('auto picks shin for 3-way, proportional for 2-way', () => {
    expect(devig(HEAVY, 'auto')!.method).toBe('shin')
    expect(devig([1.9, 2.0], 'auto')!.method).toBe('proportional')
  })
  it('returns null for invalid odds', () => {
    expect(devig([1.3, 1.0, 11.0])).toBeNull()
  })
})

describe('valueReads: edge vs EV are distinct coordinates', () => {
  it('edge>0 does not imply EV>0 (vig can eat the value)', () => {
    // model says home 0.39; de-vigged market fair prob ~0.381; raw 1/2.5=0.40
    const reads = valueReads({ home: 0.39, draw: 0.31, away: 0.3 }, [0.381, 0.31, 0.309], [2.5, 3.2, 3.0])
    const home = reads[0]
    expect(home.edge).toBeGreaterThan(0) // beats fair price
    expect(home.ev).toBeLessThan(0) // but loses against the offered 2.5 (0.39*2.5-1 < 0)
  })
})

describe('extractH2HOdds (label-anchored, hardened)', () => {
  it('pulls the labelled 1X2 triplet and IGNORES a handicap line in the same text', () => {
    expect(extractH2HOdds('收盘 主胜1.40 平4.50 客胜8.50;亚盘 -1.25')).toEqual([1.4, 4.5, 8.5])
    expect(extractH2HOdds('home 1.80 draw 3.60 away 4.50')).toEqual([1.8, 3.6, 4.5])
  })
  it('returns null without explicit 1X2 labels (cannot guess from bare numbers)', () => {
    expect(extractH2HOdds('1.40 4.50 8.50')).toBeNull()
    expect(extractH2HOdds('没有赔率,只有伤停消息')).toBeNull()
  })
  it('does not slice years/dates/handicap counts into fake odds', () => {
    // a date + handicap-only text must NOT yield a triplet
    expect(extractH2HOdds('2026-06-14 开球,亚盘主队 -1.25,大小球 2.5')).toBeNull()
    // labels present but one price missing -> null
    expect(extractH2HOdds('主胜 1.40 平 4.50')).toBeNull()
  })
  it('rejects an implausible book (overround out of 1%..30%)', () => {
    // arbitrage-ish / underround
    expect(extractH2HOdds('主胜 3.0 平 3.0 客胜 3.0')).toBeNull()
  })
})
