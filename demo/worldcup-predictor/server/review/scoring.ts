import type { Outcome } from '../framework/types.js'

export type Probs = { home: number; draw: number; away: number }

export function pForOutcome(p: Probs, actual: Outcome): number {
  return p[actual]
}

export function argmaxOutcome(p: Probs): Outcome {
  const entries: Array<[Outcome, number]> = [['home', p.home], ['draw', p.draw], ['away', p.away]]
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

export function brierScore(p: Probs, actual: Outcome): number {
  const o = { home: actual === 'home' ? 1 : 0, draw: actual === 'draw' ? 1 : 0, away: actual === 'away' ? 1 : 0 }
  return (p.home - o.home) ** 2 + (p.draw - o.draw) ** 2 + (p.away - o.away) ** 2
}

// Judge.directional_pick / selection 文本 -> 标准 Outcome。识别 home/draw/away、
// 队名(中/英)、以及「平」类词。无法识别返回 'none'。
export function normalizeOutcome(raw: string, homeTeam: string, awayTeam: string): Outcome | 'none' {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === 'home' || s === '主' || s === '主胜') return 'home'
  if (s === 'away' || s === '客' || s === '客胜') return 'away'
  if (s === 'draw' || s.includes('平')) return 'draw'
  if (homeTeam && s.includes(homeTeam.toLowerCase())) return 'home'
  if (awayTeam && s.includes(awayTeam.toLowerCase())) return 'away'
  return 'none'
}

// CLV = (收盘隐含 − 推荐隐含) / 推荐隐含,用十进制赔率。
export function computeClv(recOdds: number, closeOdds: number): number {
  if (recOdds <= 0 || closeOdds <= 0) throw new RangeError('odds must be positive')
  const recImplied = 1 / recOdds
  const closeImplied = 1 / closeOdds
  return (closeImplied - recImplied) / recImplied
}
