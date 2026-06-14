// 让球结算。约定:line 是「所投一方」的让球数,负=该方让球(需净胜超过 |line|),
// 正=该方受让。四分之一盘(.25/.75)拆成相邻整/半两腿各半注,再合并裁决。
import type { HandicapVerdict, HandicapSettlement } from '../framework/types.js'

// 单条整数/半盘腿的结果:相对让球后的净胜 diff = stakedMargin + line
function settleLeg(diff: number): 'win' | 'push' | 'loss' {
  if (diff > 0) return 'win'
  if (diff < 0) return 'loss'
  return 'push'
}

export function classifyHandicap(
  line: number,
  side: 'home' | 'away',
  homeGoals: number,
  awayGoals: number,
): HandicapVerdict {
  const stakedMargin = side === 'home' ? homeGoals - awayGoals : awayGoals - homeGoals
  // 拆腿:.25/.75 拆为 [floor.0 或 .5, +0.5];整/半盘两腿相同
  const q = Math.round((line - Math.floor(line)) * 100) // 0,25,50,75
  let legs: number[]
  if (q === 25) legs = [Math.floor(line), Math.floor(line) + 0.5]
  else if (q === 75) legs = [Math.floor(line) + 0.5, Math.ceil(line)]
  else legs = [line, line]
  const r = legs.map((l) => settleLeg(stakedMargin + l))
  const wins = r.filter((x) => x === 'win').length
  const pushes = r.filter((x) => x === 'push').length
  const losses = r.filter((x) => x === 'loss').length
  if (wins === 2) return 'cover'
  if (losses === 2) return 'loss'
  if (wins === 1 && pushes === 1) return 'half_win'
  if (losses === 1 && pushes === 1) return 'half_loss'
  // pushes === 2 (整/半盘 push,如 -1.0 净胜1)
  return 'push'
}

export function verdictReturn(verdict: HandicapVerdict, odds: number): number {
  switch (verdict) {
    case 'cover': return odds - 1
    case 'half_win': return (odds - 1) / 2
    case 'push': return 0
    case 'half_loss': return -0.5
    case 'loss': return -1
  }
}

export function settleHandicap(
  line: number,
  side: 'home' | 'away',
  homeGoals: number,
  awayGoals: number,
  odds: number,
): HandicapSettlement {
  const margin = side === 'home' ? homeGoals - awayGoals : awayGoals - homeGoals
  const verdict = classifyHandicap(line, side, homeGoals, awayGoals)
  return { line, side, margin, verdict, realized_ev: verdictReturn(verdict, odds) }
}

// 从 selection 文本解析 {line, side}。匹配队名(中/英)+ 带符号小数。
export function parseHandicapSelection(
  selection: string,
  homeTeam: string,
  awayTeam: string,
): { line: number; side: 'home' | 'away' } | null {
  const m = selection.match(/([+-]?\d+(?:\.\d+)?)/)
  if (!m) return null
  const line = Number(m[1])
  const lower = selection.toLowerCase()
  const numIdx = m.index ?? lower.indexOf(m[1])
  // nearest character-distance from any occurrence of the team name to the number
  const nearest = (team: string): number | null => {
    if (!team) return null
    const t = team.toLowerCase()
    let best: number | null = null
    let from = lower.indexOf(t)
    while (from !== -1) {
      const d = Math.abs(from - numIdx)
      if (best === null || d < best) best = d
      from = lower.indexOf(t, from + 1)
    }
    return best
  }
  const dh = nearest(homeTeam)
  const da = nearest(awayTeam)
  if (dh !== null && da === null) return { line, side: 'home' }
  if (da !== null && dh === null) return { line, side: 'away' }
  if (dh !== null && da !== null) {
    if (dh < da) return { line, side: 'home' }
    if (da < dh) return { line, side: 'away' }
    return null // both equally near -> ambiguous
  }
  return null
}
