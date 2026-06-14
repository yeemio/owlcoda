import type {
  Outcome, ReviewScorecard, LayerScore, BettingRead, DecisionLog, SourceStatus,
} from '../framework/types.js'
import { brierScore, pForOutcome, argmaxOutcome, normalizeOutcome, type Probs } from './scoring.js'
import { settleHandicap, parseHandicapSelection } from './handicap.js'

export interface ScorecardInput {
  matchId: number | string
  stamp: string
  homeTeam: string
  awayTeam: string
  reviewedAt: string
  baselineFile: {
    baseline: {
      win_probabilities?: Probs
      top_scorelines?: Array<{ score: string; probability: number }>
      confidence?: SourceStatus
    }
    values?: Array<{ outcome: string; odds: number; pModel?: number; pMarket?: number; edge?: number; ev?: number }>
  } | null
  judge: {
    win_probabilities?: Probs
    top_scorelines?: Array<{ score: string; probability: number }>
    directional_pick?: string
    market?: string
    selection?: string
    verdict?: string
  } | null
  decision: Pick<DecisionLog, 'decision' | 'human_note' | 'at'> | null
  result: { home_goals: number; away_goals: number; outcome: Outcome }
}

function scorelineHit(scoreline: string, tops?: Array<{ score: string }>): boolean {
  return !!tops?.some((s) => s.score === scoreline)
}

function probLayer(probs: Probs | undefined, pick: Outcome | 'none', actual: Outcome): LayerScore {
  if (!probs) return { directional_pick: pick, hit: pick === 'none' ? null : pick === actual, p_actual: null, brier: null }
  return {
    directional_pick: pick,
    hit: pick === 'none' ? null : pick === actual,
    p_actual: pForOutcome(probs, actual),
    brier: brierScore(probs, actual),
  }
}

export function computeScorecard(input: ScorecardInput): ReviewScorecard {
  const { homeTeam, awayTeam, result } = input
  const actual = result.outcome
  const scoreline = `${result.home_goals}-${result.away_goals}`

  // --- layers ---
  const baseProbs = input.baselineFile?.baseline.win_probabilities
  const baseline = probLayer(baseProbs, baseProbs ? argmaxOutcome(baseProbs) : 'none', actual)

  const judgeProbs = input.judge?.win_probabilities
  const judgePick = normalizeOutcome(input.judge?.directional_pick ?? '', homeTeam, awayTeam)
  const judge = probLayer(judgeProbs, judgePick, actual)

  let human: LayerScore | { status: 'n/a' }
  if (input.decision) {
    const hp = normalizeOutcome(input.decision.decision, homeTeam, awayTeam)
    human = { directional_pick: hp, hit: hp === 'none' ? null : hp === actual, p_actual: null, brier: null }
  } else {
    human = { status: 'n/a' }
  }

  // --- attribution ---
  const debate_vs_baseline =
    baseline.p_actual != null && judge.p_actual != null ? round6(judge.p_actual - baseline.p_actual) : null
  const human_vs_judge = null // 人层无概率分布

  // --- betting ---
  const reads: BettingRead[] = (input.baselineFile?.values ?? [])
    .filter((v) => (v.ev ?? 0) > 0)
    .map((v) => {
      const won = normalizeOutcome(v.outcome, homeTeam, awayTeam) === actual
      return {
        outcome: v.outcome,
        market: 'h2h',
        selection: v.outcome,
        flagged_edge: v.edge ?? null,
        flagged_ev: v.ev ?? null,
        won,
        realized_ev: won ? v.odds - 1 : -1,
      }
    })

  let handicap_lean
  if (input.judge?.market === 'asian_handicap' && input.judge.selection) {
    const parsed = parseHandicapSelection(input.judge.selection, homeTeam, awayTeam)
    if (parsed) {
      // 无报价时以 1.9(near-even)作占位价计 realized_ev,verdict 本身与价格无关。
      const odds = readSelectionOdds(input.baselineFile?.values, parsed.side) ?? 1.9
      handicap_lean = settleHandicap(parsed.line, parsed.side, result.home_goals, result.away_goals, odds)
    }
  }

  return {
    match_id: input.matchId,
    stamp: input.stamp,
    reviewed_at: input.reviewedAt,
    result: { home_goals: result.home_goals, away_goals: result.away_goals, outcome: actual, scoreline },
    layers: { baseline, judge, human },
    attribution: { debate_vs_baseline, human_vs_judge },
    calibration: {
      baseline_brier: baseline.brier,
      judge_brier: judge.brier,
      scoreline_hit_baseline: scorelineHit(scoreline, input.baselineFile?.baseline.top_scorelines),
      scoreline_hit_judge: scorelineHit(scoreline, input.judge?.top_scorelines),
    },
    betting: { reads, ...(handicap_lean ? { handicap_lean } : {}) },
    clv: { status: 'n/a', note: '无收盘线' },
    confidence: input.baselineFile?.baseline.confidence ?? 'inferred',
  }
}

function readSelectionOdds(
  values: Array<{ outcome: string; odds: number }> | undefined,
  side: 'home' | 'away',
): number | undefined {
  return values?.find((v) => v.outcome === side)?.odds
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
