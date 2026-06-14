import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  writeResult, readResult, confirmResult,
  writeDecision, readDecision, writeReview, readReview,
  updateAggregate, readAggregate, appendDaily,
} from '../server/review/store.js'
import type { ReviewScorecard } from '../server/framework/types.js'

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
