import type { Outcome } from '../framework/types.js'
import { computeScorecard, type ScorecardInput } from './scorecard.js'

const SETTLE_DELAY_MS = 2.5 * 60 * 60 * 1000

export interface DailyDeps {
  now: Date
  fixtures: Array<{ match_id: number | string; home_team: string; away_team: string; match_datetime_utc?: string }>
  /** Must return stamps in reverse-chronological order (newest first); the orchestrator grades stamps[0] as the latest prediction. */
  listRunStamps: (matchId: number | string) => string[]
  loadRunForReview: (matchId: number | string, stamp: string) => Pick<ScorecardInput, 'baselineFile' | 'judge' | 'decision'> | null
  loadResult: (matchId: number | string) => { status: string; home_goals: number | null; away_goals: number | null; outcome: Outcome | null } | null
  hasReview: (matchId: number | string, stamp: string) => boolean
  writeReviewArtifacts: (input: ScorecardInput) => void
  proposeResult: (fixture: { match_id: number | string; home_team: string; away_team: string; match_datetime_utc?: string }) => Promise<void>
}

export async function runDailyReview(_date: string, deps: DailyDeps): Promise<{ graded: number; proposed: number; skipped: number }> {
  let graded = 0
  let proposed = 0
  let skipped = 0
  for (const f of deps.fixtures) {
    const kickoff = f.match_datetime_utc ? new Date(f.match_datetime_utc).getTime() : NaN
    if (!Number.isFinite(kickoff) || deps.now.getTime() < kickoff + SETTLE_DELAY_MS) { skipped++; continue }
    const stamps = deps.listRunStamps(f.match_id)
    if (stamps.length === 0) { skipped++; continue } // 无预测,无可打分
    const result = deps.loadResult(f.match_id)
    if (!result || result.status !== 'final' || result.outcome == null || result.home_goals == null || result.away_goals == null) {
      try {
        await deps.proposeResult(f)
        proposed++
      } catch (err) {
        console.error('[review] proposeResult failed for match', f.match_id, err)
        skipped++
      }
      continue
    }
    const stamp = stamps[0] // 最近一次预测(listRunStamps 返回已倒序)
    if (deps.hasReview(f.match_id, stamp)) { skipped++; continue } // 幂等
    const run = deps.loadRunForReview(f.match_id, stamp)
    if (!run) { skipped++; continue }
    deps.writeReviewArtifacts({
      matchId: f.match_id,
      stamp,
      homeTeam: f.home_team,
      awayTeam: f.away_team,
      reviewedAt: deps.now.toISOString(),
      baselineFile: run.baselineFile,
      judge: run.judge,
      decision: run.decision,
      result: { home_goals: result.home_goals, away_goals: result.away_goals, outcome: result.outcome },
    })
    graded++
  }
  return { graded, proposed, skipped }
}

// 便捷:把 ScorecardInput 跑成记分卡(供 writeReviewArtifacts 实现复用)
export { computeScorecard }
