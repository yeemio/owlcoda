import { describe, expect, it } from 'vitest'
import { classifyHandicap, verdictReturn, settleHandicap, parseHandicapSelection } from '../server/review/handicap.js'

describe('classifyHandicap (back the given side at the line)', () => {
  // home -1.25, 主队净胜决定结果
  it('-1.25 home: win by 1 -> half_loss (−1.0 push, −1.5 loss)', () => {
    expect(classifyHandicap(-1.25, 'home', 2, 1)).toBe('half_loss')
  })
  it('-1.25 home: win by 2 -> cover (穿盘, both legs win)', () => {
    expect(classifyHandicap(-1.25, 'home', 2, 0)).toBe('cover')
  })
  it('-1.0 home: win by 1 -> push', () => {
    expect(classifyHandicap(-1.0, 'home', 1, 0)).toBe('push')
  })
  it('-1.0 home: win by 2 -> cover', () => {
    expect(classifyHandicap(-1.0, 'home', 3, 1)).toBe('cover')
  })
  it('-1.0 home: draw -> loss', () => {
    expect(classifyHandicap(-1.0, 'home', 1, 1)).toBe('loss')
  })
  it('-0.75 home: win by 1 -> half_win (0 push, −0.5 win)', () => {
    expect(classifyHandicap(-0.75, 'home', 1, 0)).toBe('half_win')
  })
  it('-0.5 home: draw -> loss', () => {
    expect(classifyHandicap(-0.5, 'home', 0, 0)).toBe('loss')
  })
  it('away +0.5 (line −0.5 on away side flipped): away loses by 1 -> loss', () => {
    expect(classifyHandicap(-0.5, 'away', 2, 1)).toBe('loss')
  })
  it('away -0.5: away wins by 1 -> cover', () => {
    expect(classifyHandicap(-0.5, 'away', 1, 2)).toBe('cover')
  })
})

describe('verdictReturn (decimal odds)', () => {
  it('maps verdict + odds to net unit return', () => {
    expect(verdictReturn('cover', 1.9)).toBeCloseTo(0.9, 6)
    expect(verdictReturn('half_win', 1.9)).toBeCloseTo(0.45, 6)
    expect(verdictReturn('push', 1.9)).toBe(0)
    expect(verdictReturn('half_loss', 1.9)).toBe(-0.5)
    expect(verdictReturn('loss', 1.9)).toBe(-1)
  })
})

describe('settleHandicap', () => {
  it('combines classify + return + margin', () => {
    const s = settleHandicap(-1.25, 'home', 2, 0, 1.9)
    expect(s).toEqual({ line: -1.25, side: 'home', margin: 2, verdict: 'cover', realized_ev: verdictReturn('cover', 1.9) })
  })
  it('margin is signed from the staked side', () => {
    expect(settleHandicap(-0.5, 'away', 1, 2, 2.0).margin).toBe(1)
  })
})

describe('parseHandicapSelection', () => {
  it('parses an English/number selection', () => {
    expect(parseHandicapSelection('Mexico -1.25', 'Mexico', 'South Africa')).toEqual({ line: -1.25, side: 'home' })
  })
  it('parses a zh selection on the away team', () => {
    expect(parseHandicapSelection('南非 +0.5', 'Mexico', '南非')).toEqual({ line: 0.5, side: 'away' })
  })
  it('returns null when no team/line found', () => {
    expect(parseHandicapSelection('看好大球', 'Mexico', 'South Africa')).toBeNull()
  })
  it('matches team names case-insensitively', () => {
    expect(parseHandicapSelection('mexico -1.25', 'Mexico', 'South Africa')).toEqual({ line: -1.25, side: 'home' })
  })
  it('picks the team nearest the line when both appear', () => {
    expect(parseHandicapSelection('Mexico vs South Africa, lean Mexico -1.25', 'Mexico', 'South Africa')).toEqual({ line: -1.25, side: 'home' })
  })
})
