import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { MatchResult, DecisionLog, ReviewScorecard, ReviewAggregate } from '../framework/types.js'

const runDir = (root: string, matchId: number | string, stamp?: string) =>
  stamp ? path.join(root, 'runs', String(matchId), stamp) : path.join(root, 'runs', String(matchId))
const reviewsDir = (root: string) => path.join(root, 'reviews')

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}
function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

// --- result (per match, at runs/{matchId}/result.json) ---
export function writeResult(root: string, r: MatchResult) {
  writeJson(path.join(runDir(root, r.match_id), 'result.json'), r)
}
export function readResult(root: string, matchId: number | string): MatchResult | null {
  return readJson<MatchResult>(path.join(runDir(root, matchId), 'result.json'))
}
export function confirmResult(root: string, matchId: number | string, at: string): MatchResult | null {
  const r = readResult(root, matchId)
  if (!r) return null
  const confirmed: MatchResult = { ...r, status: 'final', confirmed_at: at, confirmed_by: 'human' }
  writeResult(root, confirmed)
  return confirmed
}

// --- decision (per run stamp) ---
export function writeDecision(root: string, d: DecisionLog) {
  writeJson(path.join(runDir(root, d.match_id, d.stamp), 'decision.json'), d)
}
export function readDecision(root: string, matchId: number | string, stamp: string): DecisionLog | null {
  return readJson<DecisionLog>(path.join(runDir(root, matchId, stamp), 'decision.json'))
}

// --- review (per run stamp) ---
export function writeReview(root: string, sc: ReviewScorecard) {
  writeJson(path.join(runDir(root, sc.match_id, sc.stamp), 'review.json'), sc)
}
export function readReview(root: string, matchId: number | string, stamp: string): ReviewScorecard | null {
  return readJson<ReviewScorecard>(path.join(runDir(root, matchId, stamp), 'review.json'))
}

// --- daily rollup (reviews/{date}.json) ---
export function appendDaily(root: string, date: string, sc: ReviewScorecard) {
  const file = path.join(reviewsDir(root), `${date}.json`)
  const cur = readJson<{ date: string; reviews: ReviewScorecard[] }>(file) ?? { date, reviews: [] }
  if (!cur.reviews.some((r) => r.match_id === sc.match_id && r.stamp === sc.stamp)) cur.reviews.push(sc)
  writeJson(file, cur)
}

// --- cumulative aggregate (reviews/aggregate.json) ---
// 用 seen 列表保证按 {matchId}::{stamp} 幂等;命中率/Brier/ROI/cover 全量重算。
interface AggState extends ReviewAggregate {
  _seen: string[]
  _samples: Array<{
    baseHit: number | null; judgeHit: number | null; humanHit: number | null
    baseBrier: number | null; judgeBrier: number | null
    realized: number[]; coverHits: number; coverTotal: number
    bins: Array<{ p: number; win: number }>
  }>
}

export function updateAggregate(root: string, sc: ReviewScorecard) {
  const file = path.join(reviewsDir(root), 'aggregate.json')
  const st = (readJson<AggState>(file) ?? blankAgg())
  const key = `${sc.match_id}::${sc.stamp}`
  if (st._seen.includes(key)) return
  st._seen.push(key)

  const reads = sc.betting.reads.map((r) => r.realized_ev)
  if (sc.betting.handicap_lean) reads.push(sc.betting.handicap_lean.realized_ev)
  const hl = sc.betting.handicap_lean
  st._samples.push({
    baseHit: sc.layers.baseline.hit == null ? null : sc.layers.baseline.hit ? 1 : 0,
    judgeHit: sc.layers.judge.hit == null ? null : sc.layers.judge.hit ? 1 : 0,
    humanHit: 'status' in sc.layers.human ? null : sc.layers.human.hit == null ? null : sc.layers.human.hit ? 1 : 0,
    baseBrier: sc.calibration.baseline_brier,
    judgeBrier: sc.calibration.judge_brier,
    realized: reads,
    coverHits: hl && (hl.verdict === 'cover' || hl.verdict === 'half_win') ? 1 : 0,
    coverTotal: hl ? 1 : 0,
    bins: sc.layers.judge.p_actual != null && sc.layers.judge.hit != null ? [{ p: sc.layers.judge.p_actual, win: sc.layers.judge.hit ? 1 : 0 }] : [],
  })
  recompute(st)
  writeJson(file, st)
}

export function readAggregate(root: string): ReviewAggregate | null {
  const st = readJson<AggState>(path.join(reviewsDir(root), 'aggregate.json'))
  if (!st) return null
  const { _seen, _samples, ...pub } = st
  return pub
}

function blankAgg(): AggState {
  return {
    n_matches: 0, updated_at: '',
    directional_hit_rate: { baseline: 0, judge: 0, human: 0 },
    mean_brier: { baseline: 0, judge: 0 },
    realized_roi: 0, cover_rate: 0, calibration_bins: [],
    _seen: [], _samples: [],
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function recompute(st: AggState) {
  const s = st._samples
  st.n_matches = s.length
  st.directional_hit_rate = {
    baseline: mean(s.filter((x) => x.baseHit != null).map((x) => x.baseHit as number)),
    judge: mean(s.filter((x) => x.judgeHit != null).map((x) => x.judgeHit as number)),
    human: mean(s.filter((x) => x.humanHit != null).map((x) => x.humanHit as number)),
  }
  st.mean_brier = {
    baseline: mean(s.map((x) => x.baseBrier).filter((b): b is number => b != null)),
    judge: mean(s.map((x) => x.judgeBrier).filter((b): b is number => b != null)),
  }
  const allReturns = s.flatMap((x) => x.realized)
  st.realized_roi = mean(allReturns)
  const coverHits = s.reduce((a, x) => a + x.coverHits, 0)
  const coverTotal = s.reduce((a, x) => a + x.coverTotal, 0)
  st.cover_rate = coverTotal ? coverHits / coverTotal : 0
  // 校准分箱:宽度 0.1
  const bins: ReviewAggregate['calibration_bins'] = []
  for (let lo = 0; lo < 1; lo += 0.1) {
    const hi = Math.round((lo + 0.1) * 10) / 10
    const pts = s.flatMap((x) => x.bins).filter((b) => b.p >= lo && b.p < hi)
    if (pts.length) bins.push({ p_lo: Math.round(lo * 10) / 10, p_hi: hi, predicted: mean(pts.map((p) => p.p)), observed: mean(pts.map((p) => p.win)), n: pts.length })
  }
  st.calibration_bins = bins
  // updated_at 由调用方(daily/endpoint)在写盘前注入,纯逻辑不取系统时钟(可复现)
}
