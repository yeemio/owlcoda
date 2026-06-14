import { describe, expect, it, vi } from 'vitest'
import { runDailyReview, type DailyDeps } from '../server/review/daily.js'

const fixture = (id: number, kickoffUtc: string) => ({
  match_id: id, home_team: 'Mexico', away_team: 'South Africa', match_datetime_utc: kickoffUtc,
})

function baseDeps(over: Partial<DailyDeps>): DailyDeps {
  return {
    now: new Date('2026-06-12T00:00:00Z'),
    fixtures: [fixture(12, '2026-06-11T19:00:00Z')], // 开球已过 2.5h+
    listRunStamps: () => ['s1'],
    loadRunForReview: () => ({ baselineFile: { baseline: { win_probabilities: { home: 0.55, draw: 0.25, away: 0.2 } } }, judge: { directional_pick: 'home' }, decision: null }),
    loadResult: () => ({ status: 'final', home_goals: 2, away_goals: 0, outcome: 'home' }),
    hasReview: () => false,
    writeReviewArtifacts: vi.fn(),
    proposeResult: vi.fn(async () => {}),
    ...over,
  }
}

describe('runDailyReview', () => {
  it('grades a finished match with a confirmed result + no prior review', async () => {
    const deps = baseDeps({})
    const out = await runDailyReview('2026-06-12', deps)
    expect(deps.writeReviewArtifacts).toHaveBeenCalledTimes(1)
    expect(out.graded).toBe(1)
    expect(deps.proposeResult).not.toHaveBeenCalled()
  })
  it('skips matches before kickoff+2.5h', async () => {
    const deps = baseDeps({ fixtures: [fixture(12, '2026-06-11T22:00:00Z')] }) // now=00:00, kickoff+2.5h=00:30 未到
    const out = await runDailyReview('2026-06-12', deps)
    expect(out.graded).toBe(0)
    expect(deps.proposeResult).not.toHaveBeenCalled()
    expect(out.skipped).toBe(1)
  })
  it('proposes a result when finished but none on disk', async () => {
    const deps = baseDeps({ loadResult: () => null })
    const out = await runDailyReview('2026-06-12', deps)
    expect(deps.proposeResult).toHaveBeenCalledTimes(1)
    expect(out.graded).toBe(0)
    expect(out.proposed).toBe(1)
  })
  it('is idempotent: skips when a review already exists', async () => {
    const deps = baseDeps({ hasReview: () => true })
    const out = await runDailyReview('2026-06-12', deps)
    expect(deps.writeReviewArtifacts).not.toHaveBeenCalled()
    expect(out.graded).toBe(0)
  })
})
