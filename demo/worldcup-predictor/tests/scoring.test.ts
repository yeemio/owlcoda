import { describe, expect, it } from 'vitest'
import { brierScore, pForOutcome, argmaxOutcome, normalizeOutcome, computeClv } from '../server/review/scoring.js'

const P = { home: 0.55, draw: 0.25, away: 0.2 }

describe('pForOutcome / argmaxOutcome', () => {
  it('reads the probability assigned to the actual outcome', () => {
    expect(pForOutcome(P, 'home')).toBe(0.55)
    expect(pForOutcome(P, 'away')).toBe(0.2)
  })
  it('argmax picks the top bucket', () => {
    expect(argmaxOutcome(P)).toBe('home')
    expect(argmaxOutcome({ home: 0.2, draw: 0.5, away: 0.3 })).toBe('draw')
  })
})

describe('brierScore (3-outcome, one-hot actual)', () => {
  it('= sum (p_i - o_i)^2', () => {
    // actual home: (0.55-1)^2 + 0.25^2 + 0.2^2 = 0.2025+0.0625+0.04 = 0.305
    expect(brierScore(P, 'home')).toBeCloseTo(0.305, 6)
  })
  it('perfect forecast scores 0', () => {
    expect(brierScore({ home: 1, draw: 0, away: 0 }, 'home')).toBeCloseTo(0, 6)
  })
})

describe('normalizeOutcome', () => {
  it('passes through home/draw/away', () => {
    expect(normalizeOutcome('home', 'Mexico', 'South Africa')).toBe('home')
    expect(normalizeOutcome('draw', 'Mexico', 'South Africa')).toBe('draw')
  })
  it('maps team name to side', () => {
    expect(normalizeOutcome('Mexico', 'Mexico', 'South Africa')).toBe('home')
    expect(normalizeOutcome('South Africa', 'Mexico', 'South Africa')).toBe('away')
  })
  it('maps zh draw words', () => {
    expect(normalizeOutcome('平局', 'Mexico', 'South Africa')).toBe('draw')
  })
  it('returns none when unrecognized', () => {
    expect(normalizeOutcome('???', 'Mexico', 'South Africa')).toBe('none')
  })
  it('matches team names case-insensitively', () => {
    expect(normalizeOutcome('MEXICO', 'Mexico', 'South Africa')).toBe('home')
    expect(normalizeOutcome('south africa', 'Mexico', 'South Africa')).toBe('away')
  })
})

describe('computeClv (Phase-2 ready; v1 wiring marks n/a)', () => {
  it('positive when closing price implies higher prob than rec price', () => {
    // rec 2.5 -> 0.40 implied; close 2.2 -> ~0.4545; clv ~ +0.1364
    expect(computeClv(2.5, 2.2)).toBeCloseTo(0.1364, 4)
  })
  it('throws on non-positive odds', () => {
    expect(() => computeClv(0, 2.2)).toThrow()
    expect(() => computeClv(2.5, -1)).toThrow()
  })
})
