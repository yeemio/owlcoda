import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  writeResult, readResult, confirmResult,
  writeDecision, readDecision, writeReview, readReview,
  updateAggregate, readAggregate, appendDaily,
  writeFifaReport, readFifaReport, updateTeamTactics, readTeamTactics,
} from '../server/review/store.js'
import type { ReviewScorecard, FifaMatchReport } from '../server/framework/types.js'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'wc-review-')) })

const RESULT = {
  match_id: 12, match_key: 'Mexico::South Africa::2026-06-11T19:00:00Z',
  home_team: 'Mexico', away_team: 'South Africa',
  home_goals: 2, away_goals: 0, outcome: 'home' as const, status: 'pending' as const,
  source_urls: ['https://x'], fetched_by: 'owlcoda_agent' as const,
  confidence: 'supported' as const, proposed_at: '2026-06-12T03:00:00Z',
}

describe('result store + confirm gate', () => {
  it('write/read a pending proposal, then confirm flips status', () => {
    writeResult(root, RESULT)
    expect(readResult(root, 12)?.status).toBe('pending')
    const confirmed = confirmResult(root, 12, '2026-06-12T04:00:00Z')
    expect(confirmed?.status).toBe('final')
    expect(confirmed?.confirmed_at).toBe('2026-06-12T04:00:00Z')
    expect(readResult(root, 12)?.status).toBe('final')
  })
  it('confirm returns null when no proposal exists', () => {
    expect(confirmResult(root, 99, 'now')).toBeNull()
  })
})

describe('decision store (per run stamp)', () => {
  it('round-trips a decision under the run dir', () => {
    writeDecision(root, { match_id: 12, stamp: 's1', decision: 'home', at: 'now' })
    expect(readDecision(root, 12, 's1')?.decision).toBe('home')
    expect(readDecision(root, 12, 'missing')).toBeNull()
  })
})

const SC: ReviewScorecard = {
  match_id: 12, stamp: 's1', reviewed_at: 'now',
  result: { home_goals: 2, away_goals: 0, outcome: 'home', scoreline: '2-0' },
  layers: {
    baseline: { directional_pick: 'home', hit: true, p_actual: 0.55, brier: 0.305 },
    judge: { directional_pick: 'home', hit: true, p_actual: 0.62, brier: 0.21 },
    human: { directional_pick: 'home', hit: true, p_actual: null, brier: null },
  },
  attribution: { debate_vs_baseline: 0.07, human_vs_judge: null },
  calibration: { baseline_brier: 0.305, judge_brier: 0.21, scoreline_hit_baseline: true, scoreline_hit_judge: true },
  betting: { reads: [{ outcome: 'home', market: 'h2h', selection: 'home', flagged_edge: 0.05, flagged_ev: 0.045, won: true, realized_ev: 0.9 }], handicap_lean: { line: -1.25, side: 'home', margin: 2, verdict: 'cover', realized_ev: 0.9 } },
  clv: { status: 'n/a', note: '无收盘线' },
  confidence: 'partial',
}

describe('review write/read + aggregate', () => {
  it('writes a review under its run stamp', () => {
    writeReview(root, SC)
    expect(readReview(root, 12, 's1')?.result.scoreline).toBe('2-0')
  })
  it('aggregate accumulates hit-rate / brier / roi / cover', () => {
    updateAggregate(root, SC)
    const agg = readAggregate(root)!
    expect(agg.n_matches).toBe(1)
    expect(agg.directional_hit_rate.baseline).toBe(1)
    expect(agg.mean_brier.judge).toBeCloseTo(0.21, 6)
    expect(agg.cover_rate).toBe(1)
    expect(agg.realized_roi).toBeCloseTo(0.9, 6)
  })
  it('aggregate is idempotent per stamp (no double count)', () => {
    updateAggregate(root, SC)
    updateAggregate(root, SC)
    expect(readAggregate(root)!.n_matches).toBe(1)
  })
})

describe('appendDaily + null-hit aggregate', () => {
  it('appends per-date and dedups by match+stamp', () => {
    appendDaily(root, '2026-06-11', SC)
    appendDaily(root, '2026-06-11', SC) // same match+stamp -> no dup
    const file = JSON.parse(readFileSync(path.join(root, 'reviews', '2026-06-11.json'), 'utf8'))
    expect(file.reviews.length).toBe(1)
  })
  it('excludes a null directional hit from the hit-rate (not counted as a miss)', () => {
    updateAggregate(root, SC) // baseline hit true
    const SC2 = { ...SC, match_id: 99, stamp: 's2', layers: { ...SC.layers, baseline: { directional_pick: 'none', hit: null, p_actual: null, brier: null } } } as typeof SC
    updateAggregate(root, SC2)
    const agg = readAggregate(root)!
    expect(agg.n_matches).toBe(2)
    expect(agg.directional_hit_rate.baseline).toBe(1) // SC2's null excluded, only SC's hit=1 counts
  })
})

const FIFA: FifaMatchReport = {
  match_id: 12, home_team: 'Mexico', away_team: 'South Africa',
  source_pdf_url: 'https://x/PMSR-M01.pdf', extracted_by: 'pdftotext', confidence: 'supported',
  contested_possession_pct: 6.8,
  home: { possession_pct: 57.1, goals: 2, xg: 1.78, attempts: 16, attempts_on_target: 4, passes: 547, passes_complete: 495, pass_completion_pct: 90, completed_line_breaks: 105, defensive_line_breaks: 10, receptions_final_third: 117, crosses: 13, ball_progressions: 23, defensive_pressures: 170, direct_pressures: 26, forced_turnovers: 31, second_balls: 56, total_distance_km: 107.3, low_speed_sprint_km: 5.3, phases: { in_possession: { build_up_unopposed: 47, build_up_opposed: 13, progression: 16, final_third: 11, long_ball: 3, attacking_transition: 10, counter_attack: 1, set_piece: 5 }, out_of_possession: { high_press: 9, mid_press: 3, low_press: 0, high_block: 7, mid_block: 25, low_block: 11, recovery: 5, defensive_transition: 12, counter_press: 8 } } },
  away: { possession_pct: 36.1, goals: 0, xg: 0.1, attempts: 3, attempts_on_target: 2, passes: 351, passes_complete: 290, pass_completion_pct: 83, completed_line_breaks: 57, defensive_line_breaks: 3, receptions_final_third: 36, crosses: 8, ball_progressions: 8, defensive_pressures: 306, direct_pressures: 45, forced_turnovers: 32, second_balls: 45, total_distance_km: 97.1, low_speed_sprint_km: 5.1, phases: { in_possession: { build_up_unopposed: 43, build_up_opposed: 13, progression: 14, final_third: 7, long_ball: 6, attacking_transition: 12, counter_attack: 2, set_piece: 5 }, out_of_possession: { high_press: 6, mid_press: 3, low_press: 1, high_block: 5, mid_block: 30, low_block: 14, recovery: 2, defensive_transition: 10, counter_press: 7 } } },
  proposed_at: 'now',
}

describe('fifa report + team tactics store', () => {
  it('round-trips a fifa report', () => {
    writeFifaReport(root, FIFA)
    expect(readFifaReport(root, 12)?.home.xg).toBeCloseTo(1.78, 5)
  })
  it('updates per-team rolling tactics (home + away sides), idempotent', () => {
    updateTeamTactics(root, FIFA)
    updateTeamTactics(root, FIFA) // same match_id -> no double count
    const mex = readTeamTactics(root, 'Mexico')!
    expect(mex.matches).toBe(1)
    expect(mex.avg.possession_pct).toBeCloseTo(57.1, 5)
    expect(mex.avg.xg_for).toBeCloseTo(1.78, 5)
    expect(mex.avg.xg_against).toBeCloseTo(0.1, 5)
    const rsa = readTeamTactics(root, 'South Africa')!
    expect(rsa.avg.xg_for).toBeCloseTo(0.1, 5)
    expect(rsa.avg.mid_block).toBeCloseTo(30, 5)
    expect(rsa.matches).toBe(1)
    expect(rsa.avg.xg_against).toBeCloseTo(1.78, 5)
  })
  it('readTeamTactics strips internal _seen/_samples fields', () => {
    updateTeamTactics(root, FIFA)
    const mex = readTeamTactics(root, 'Mexico')! as any
    expect('_seen' in mex).toBe(false)
    expect('_samples' in mex).toBe(false)
  })
})
