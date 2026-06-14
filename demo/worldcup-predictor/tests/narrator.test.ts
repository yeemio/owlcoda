import { describe, expect, it, vi } from 'vitest'
import { buildNarratorPrompt, narrateScorecard } from '../server/review/narrator.js'
import { streamMessage } from '../server/owlcoda.js'
import type { ReviewScorecard } from '../server/framework/types.js'

vi.mock('../server/owlcoda.js', () => ({
  streamMessage: vi.fn(async () => ({ text: '  数学地板看对了方向。  ', thinking: '', durationMs: 1 })),
}))

const SC = {
  match_id: 12, stamp: 's1', reviewed_at: 'now',
  result: { home_goals: 2, away_goals: 0, outcome: 'home', scoreline: '2-0' },
  layers: {
    baseline: { directional_pick: 'home', hit: true, p_actual: 0.55, brier: 0.305 },
    judge: { directional_pick: 'home', hit: true, p_actual: 0.62, brier: 0.21 },
    human: { directional_pick: 'home', hit: true, p_actual: null, brier: null },
  },
  attribution: { debate_vs_baseline: 0.07, human_vs_judge: null },
  calibration: { baseline_brier: 0.305, judge_brier: 0.21, scoreline_hit_baseline: true, scoreline_hit_judge: true },
  betting: { reads: [], handicap_lean: { line: -1.25, side: 'home', margin: 2, verdict: 'cover', realized_ev: 0.9 } },
  clv: { status: 'n/a', note: '无收盘线' },
  confidence: 'partial',
} as ReviewScorecard

describe('buildNarratorPrompt', () => {
  const { system, user } = buildNarratorPrompt(SC, 'Mexico', 'South Africa')
  it('injects the real numbers from the scorecard', () => {
    expect(user).toContain('2-0')
    expect(user).toContain('cover')
    expect(user).toContain('0.55')
    expect(user).toContain('0.62')
  })
  it('instructs to narrate only the given numbers (no fabrication)', () => {
    expect(system).toMatch(/只.*(叙述|依据|根据).*(数字|记分卡)/)
    expect(system).toMatch(/不.*(编造|杜撰|新增)/)
  })
})

describe('narrateScorecard', () => {
  it('passes the built prompt to streamMessage and returns trimmed text', async () => {
    const out = await narrateScorecard({ baseUrl: 'http://x', model: 'm', scorecard: SC, homeTeam: 'Mexico', awayTeam: 'South Africa' })
    expect(out).toBe('数学地板看对了方向。')
    expect(streamMessage).toHaveBeenCalledOnce()
    const arg = (streamMessage as unknown as { mock: { calls: any[][] } }).mock.calls[0][0]
    expect(arg.system).toMatch(/不得编造|不.*编造/)
    expect(arg.user).toContain('2-0')
    expect(arg.maxTokens).toBe(4096)
  })
})
