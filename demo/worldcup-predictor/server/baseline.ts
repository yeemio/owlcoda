// Deterministic statistical baseline — Poisson + Dixon-Coles, adapted from
// qqyule/worldcup-predictor-skill (MIT) to our real team fields.
//
// This is a reproducible PRIOR, not a prediction of truth: same inputs ->
// identical numbers, no model sampling. It knows long-run strength (Elo),
// a 12m opponent-UNadjusted goals tendency (shrunk for noise), W/D/L form,
// and home-soil advantage. It does NOT know injuries, lineups, live odds,
// tactics, H2H, weather. The Judge must treat it as a prior to be adjusted.
//
// Constants: LEAGUE_AVG_GOALS + qqyule coefficients are inherited from the
// MIT model and NOT re-tuned. LEAGUE_GF/GA_PER_GAME are measured from THIS
// 48-team snapshot (recompute if the data pack is refreshed).

export type Confidence = 'supported' | 'partial' | 'best_effort' | 'inferred' | 'unsupported'

const LEAGUE_AVG_GOALS = 1.32 // qqyule TOURNAMENT_AVG_GOALS (≈ dataset combined avg 1.388)
const LEAGUE_GF_PER_GAME = 1.76 // dataset mean goals_for / matches
const LEAGUE_GA_PER_GAME = 1.02 // dataset mean goals_against / matches
const SHRINK_K = 10 // pseudo-matches; median sample ~11.5 -> raw ≈ half weight
const RATING_COEF = 0.38 // qqyule
const FORM_COEF = 0.15 // qqyule
const HOST_BOOST_HOME = 0.12 // additive goals to the team on home soil
// NOTE: qqyule also adds +0.08 to the opponent's xG as a "match tempo" bump,
// but that is a totals concern: for a 1X2 directional prior it can REVERSE the
// host's win probability for strong home favourites (inflating the underdog's
// scoring grows draw/upset mass faster than it grows the saturated home-win
// mass). We drop the opponent bump so home-soil advantage is monotone for 1X2.
const ELO_MEAN = 1783 // dataset Elo mean (last-resort rating)
const XG_MIN = 0.35
const XG_MAX = 3.25

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export interface TeamStrength {
  rating: number
  attack: number
  defense: number
  formScore: number // 0..100
  isHost: boolean
  ratingConfidence: Confidence
  formConfidence: Confidence
}

interface RawSummary {
  matches?: number
  goals_for?: number
  goals_against?: number
  wins?: number
  draws?: number
  losses?: number
}

// Normalize the heterogeneous VM profile into numeric strength inputs.
// elo_estimate is a rich dict for 8 teams, a bare number for 40.
export function deriveStrength(vm: any | null): TeamStrength | null {
  if (!vm) return null
  // rating: real Elo (supported) -> fifa rank synthesis (partial) -> mean (inferred)
  let rating: number
  let ratingConfidence: Confidence
  const elo = vm.elo_estimate
  const eloNum = typeof elo === 'object' && elo !== null ? elo.elo_rating : elo
  if (typeof eloNum === 'number' && Number.isFinite(eloNum)) {
    rating = eloNum
    ratingConfidence = 'supported'
  } else if (typeof vm.fifa_world_ranking === 'number') {
    rating = clamp(2120 - 16.0 * vm.fifa_world_ranking, 1400, 2180)
    ratingConfidence = 'partial'
  } else {
    rating = ELO_MEAN
    ratingConfidence = 'inferred'
  }

  const s: RawSummary | undefined = vm.recent_competitive_form_12m?.summary
  let attack = 1.0
  let defense = 1.0
  let formScore = 50
  let formConfidence: Confidence = 'inferred'
  if (s && typeof s.matches === 'number' && s.matches > 0) {
    const m = s.matches
    const rawAttack = (s.goals_for ?? 0) / m / LEAGUE_GF_PER_GAME
    const rawDefense = (s.goals_against ?? 0) / m / LEAGUE_GA_PER_GAME
    const w = m / (m + SHRINK_K)
    attack = clamp(1 + w * (rawAttack - 1), 0.65, 1.55)
    defense = clamp(1 + w * (rawDefense - 1), 0.65, 1.55)
    const ppg = ((s.wins ?? 0) * 3 + (s.draws ?? 0)) / m
    formScore = (ppg / 3) * 100
    formConfidence = 'supported'
  }

  return { rating, attack, defense, formScore, isHost: vm.host_country === true, ratingConfidence, formConfidence }
}

function poisson(k: number, lambda: number): number {
  let fact = 1
  for (let i = 2; i <= k; i++) fact *= i
  return (Math.exp(-lambda) * lambda ** k) / fact
}

export interface BaselineResult {
  win_probabilities: { home: number; draw: number; away: number }
  top_scorelines: Array<{ score: string; probability: number }>
  home_xg: number
  away_xg: number
  confidence: Confidence
  note: string
}

// homeOnSoil / awayOnSoil come from venue-country vs team identity.
export function computeBaseline(
  home: TeamStrength | null,
  away: TeamStrength | null,
  homeOnSoil: boolean,
  awayOnSoil: boolean,
): BaselineResult {
  if (!home || !away) {
    return {
      win_probabilities: { home: 0.34, draw: 0.3, away: 0.36 },
      top_scorelines: [],
      home_xg: 0,
      away_xg: 0,
      confidence: 'unsupported',
      note: '缺一方球队画像,无法计算基线(no-prior 占位,Judge 应忽略)',
    }
  }
  const ratingDelta = (home.rating - away.rating) / 400
  const formDelta = (home.formScore - away.formScore) / 100

  const homeXg = clamp(
    LEAGUE_AVG_GOALS * home.attack * away.defense +
      ratingDelta * RATING_COEF +
      formDelta * FORM_COEF +
      (homeOnSoil ? HOST_BOOST_HOME : 0),
    XG_MIN,
    XG_MAX,
  )
  const awayXg = clamp(
    LEAGUE_AVG_GOALS * away.attack * home.defense -
      ratingDelta * RATING_COEF -
      formDelta * FORM_COEF +
      (awayOnSoil ? HOST_BOOST_HOME : 0),
    XG_MIN,
    XG_MAX,
  )

  const avgXg = (homeXg + awayXg) / 2
  const rho = avgXg < 1.5 ? -0.13 : avgXg < 2.0 ? -0.1 : avgXg < 2.5 ? -0.06 : -0.03
  const tau = (i: number, j: number): number => {
    if (i === 0 && j === 0) return 1 - homeXg * awayXg * rho
    if (i === 0 && j === 1) return 1 + homeXg * rho
    if (i === 1 && j === 0) return 1 + awayXg * rho
    if (i === 1 && j === 1) return 1 - rho
    return 1
  }

  const N = 6
  const cells: Array<{ i: number; j: number; p: number }> = []
  let total = 0
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = poisson(i, homeXg) * poisson(j, awayXg) * tau(i, j)
      cells.push({ i, j, p })
      total += p
    }
  }
  let pHome = 0
  let pDraw = 0
  let pAway = 0
  for (const c of cells) {
    c.p /= total
    if (c.i > c.j) pHome += c.p
    else if (c.i === c.j) pDraw += c.p
    else pAway += c.p
  }
  const s = pHome + pDraw + pAway
  const home4 = Math.round((pHome / s) * 10000) / 10000
  const draw4 = Math.round((pDraw / s) * 10000) / 10000
  const away4 = Math.round((pAway / s) * 10000) / 10000
  // absorb rounding drift into the genuinely largest bucket (keeps sum=1 and
  // home/away-swap symmetry on the rounding grid)
  const r = { home: home4, draw: draw4, away: away4 }
  const big = (Object.keys(r) as Array<keyof typeof r>).reduce((a, b) => (r[a] >= r[b] ? a : b))
  r[big] = Math.round((1 - (home4 + draw4 + away4 - r[big])) * 10000) / 10000

  const top = [...cells]
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .map((c) => ({ score: `${c.i}-${c.j}`, probability: Math.round(c.p * 10000) / 10000 }))

  // weakest input dictates overall confidence
  const order: Confidence[] = ['unsupported', 'inferred', 'best_effort', 'partial', 'supported']
  const worst = (a: Confidence, b: Confidence) => (order.indexOf(a) < order.indexOf(b) ? a : b)
  const confidence = worst(
    worst(home.ratingConfidence, away.ratingConfidence),
    worst(home.formConfidence, away.formConfidence),
  )

  return {
    win_probabilities: { home: r.home, draw: r.draw, away: r.away },
    top_scorelines: top,
    home_xg: Math.round(homeXg * 100) / 100,
    away_xg: Math.round(awayXg * 100) / 100,
    confidence,
    note: '确定性统计先验(Elo+近12月进球+主场);未含伤停/阵容/赔率/战意,待证据修正',
  }
}
