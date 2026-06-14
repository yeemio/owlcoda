import { describe, expect, it } from 'vitest'
import { computeScorecard, type ScorecardInput } from '../server/review/scorecard.js'

// 墨西哥揭幕战 golden fixture:2-0(净胜2),数学基线与终判都看主胜,终判信心更高。
const GOLDEN: ScorecardInput = {
  matchId: 12,
  stamp: '2026-06-11T19-00-00-000Z',
  homeTeam: 'Mexico',
  awayTeam: 'South Africa',
  reviewedAt: '2026-06-12T03:00:00Z',
  baselineFile: {
    baseline: {
      win_probabilities: { home: 0.55, draw: 0.25, away: 0.2 },
      top_scorelines: [{ score: '1-0', probability: 0.13 }, { score: '2-0', probability: 0.1 }],
      confidence: 'partial',
    },
    values: [{ outcome: 'home', odds: 1.9, pModel: 0.55, pMarket: 0.5, edge: 0.05, ev: 0.045 }],
  },
  judge: {
    win_probabilities: { home: 0.62, draw: 0.2, away: 0.18 },
    top_scorelines: [{ score: '2-0', probability: 0.14 }],
    directional_pick: 'home',
    market: 'asian_handicap',
    selection: 'Mexico -1.25',
    verdict: 'lean',
  },
  decision: { decision: 'home', human_note: '同意主胜', at: '2026-06-11T18:00:00Z' },
  result: { home_goals: 2, away_goals: 0, outcome: 'home' },
}

describe('computeScorecard (golden: Mexico 2-0)', () => {
  const sc = computeScorecard(GOLDEN)

  it('records the result + scoreline', () => {
    expect(sc.result).toEqual({ home_goals: 2, away_goals: 0, outcome: 'home', scoreline: '2-0' })
  })
  it('three-layer hits', () => {
    expect(sc.layers.baseline.hit).toBe(true)
    expect(sc.layers.judge.hit).toBe(true)
    expect((sc.layers.human as any).hit).toBe(true)
  })
  it('p_actual + brier per probabilistic layer', () => {
    expect(sc.layers.baseline.p_actual).toBeCloseTo(0.55, 6)
    expect(sc.layers.judge.p_actual).toBeCloseTo(0.62, 6)
    expect(sc.calibration.baseline_brier).toBeCloseTo(0.305, 6)
    expect(sc.calibration.judge_brier).toBeGreaterThan(0)
  })
  it('attribution: debate added confidence on the true outcome', () => {
    expect(sc.attribution.debate_vs_baseline).toBeCloseTo(0.07, 6)
    expect(sc.attribution.human_vs_judge).toBeNull() // 人层无概率分布
  })
  it('scoreline hit detection', () => {
    expect(sc.calibration.scoreline_hit_baseline).toBe(true) // 2-0 在基线 top
    expect(sc.calibration.scoreline_hit_judge).toBe(true)
  })
  it('betting: ev>0 read won; handicap -1.25 covered (穿盘)', () => {
    expect(sc.betting.reads[0].won).toBe(true)
    expect(sc.betting.reads[0].realized_ev).toBeCloseTo(0.9, 6) // 1.9-1
    expect(sc.betting.handicap_lean?.verdict).toBe('cover')
  })
  it('CLV n/a in v1 (no closing odds)', () => {
    expect(sc.clv.status).toBe('n/a')
  })
})

describe('computeScorecard (misses + n/a human)', () => {
  it('away win flips hits; missing decision -> human n/a', () => {
    const sc = computeScorecard({
      ...GOLDEN,
      decision: null,
      result: { home_goals: 0, away_goals: 1, outcome: 'away' },
    })
    expect(sc.layers.baseline.hit).toBe(false)
    expect(sc.layers.judge.hit).toBe(false)
    expect(sc.layers.human).toEqual({ status: 'n/a' })
    expect(sc.betting.reads[0].won).toBe(false)
    expect(sc.betting.reads[0].realized_ev).toBe(-1)
    expect(sc.betting.handicap_lean?.verdict).toBe('loss')
  })
})
