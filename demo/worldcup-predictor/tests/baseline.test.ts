import { describe, expect, it } from 'vitest'
import { deriveStrength, computeBaseline } from '../server/baseline.js'

const MEX = { team: 'Mexico', elo_estimate: 1860, host_country: true, fifa_world_ranking: 15, recent_competitive_form_12m: { summary: { matches: 12, goals_for: 13, goals_against: 10, wins: 4, draws: 6, losses: 2 } } }
const RSA = { team: 'South Africa', elo_estimate: 1518, host_country: false, fifa_world_ranking: 60, recent_competitive_form_12m: { summary: { matches: 19, goals_for: 25, goals_against: 16, wins: 8, draws: 6, losses: 5 } } }
const ELITE = { team: 'Spain', elo_estimate: { elo_rating: 2165, elo_rank: 1 }, host_country: false, fifa_world_ranking: 2, recent_competitive_form_12m: { summary: { matches: 14, goals_for: 30, goals_against: 8, wins: 11, draws: 2, losses: 1 } } }

describe('deriveStrength', () => {
  it('reads bare-number and dict elo shapes, marks confidence', () => {
    expect(deriveStrength(MEX)!.rating).toBe(1860)
    expect(deriveStrength(MEX)!.ratingConfidence).toBe('supported')
    expect(deriveStrength(ELITE)!.rating).toBe(2165) // dict.elo_rating
  })
  it('falls back to fifa rank synthesis when elo missing (partial)', () => {
    const s = deriveStrength({ team: 'X', fifa_world_ranking: 30, recent_competitive_form_12m: { summary: { matches: 10, goals_for: 10, goals_against: 10, wins: 3, draws: 3, losses: 4 } } })!
    expect(s.ratingConfidence).toBe('partial')
    expect(s.rating).toBeGreaterThan(1400)
  })
  it('shrinks attack/defense toward 1 by sample size', () => {
    const s = deriveStrength(MEX)!
    expect(s.attack).toBeGreaterThan(0.65)
    expect(s.attack).toBeLessThan(1.55)
  })
})

describe('computeBaseline', () => {
  it('home-soil favourite (Mexico vs South Africa) leans home, sums to 1', () => {
    const b = computeBaseline(deriveStrength(MEX), deriveStrength(RSA), true, false)
    const { home, draw, away } = b.win_probabilities
    expect(home + draw + away).toBeCloseTo(1, 3)
    expect(home).toBeGreaterThan(away) // 342 elo gap + host -> home favourite
    expect(home).toBeGreaterThan(0.45)
    expect(b.home_xg).toBeGreaterThan(b.away_xg)
    expect(b.top_scorelines.length).toBeGreaterThan(0)
    expect(b.confidence).toBe('supported')
  })
  it('host boost increases the home-soil team probability', () => {
    const withHost = computeBaseline(deriveStrength(MEX), deriveStrength(RSA), true, false).win_probabilities.home
    const neutral = computeBaseline(deriveStrength(MEX), deriveStrength(RSA), false, false).win_probabilities.home
    expect(withHost).toBeGreaterThan(neutral)
  })
  it('is symmetric: swapping teams inverts the favourite', () => {
    const ab = computeBaseline(deriveStrength(MEX), deriveStrength(RSA), false, false).win_probabilities
    const ba = computeBaseline(deriveStrength(RSA), deriveStrength(MEX), false, false).win_probabilities
    expect(ab.home).toBeCloseTo(ba.away, 2)
    expect(ab.away).toBeCloseTo(ba.home, 2)
  })
  it('returns unsupported no-prior when a team profile is missing', () => {
    const b = computeBaseline(deriveStrength(MEX), null, true, false)
    expect(b.confidence).toBe('unsupported')
    expect(b.top_scorelines).toEqual([])
  })
})
