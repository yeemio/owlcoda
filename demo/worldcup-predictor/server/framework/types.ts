// Types mirror the hermes-football jingcai debate schemas (vm-engineering,
// world-cup-2026-md1), extended with win probabilities for the demo's
// prediction card.

export type Verdict = 'bet' | 'lean' | 'pass'
export type Market = 'h2h' | 'asian_handicap' | 'totals' | 'correct_score' | 'parlay' | 'none'
export type Confidence = 'low' | 'medium' | 'high'
export type DataQuality = 'complete' | 'partial' | 'weak'
export type BetGrade = 'bet' | 'lean' | 'watch' | 'pass'
export type ExecutionAction = 'bet_now' | 'lean_only' | 'watch_trigger' | 'pass_bet' | 'reduce_exposure'
export type EvidenceFreshness = 'fresh' | 'stale' | 'post_match' | 'mixed'

export type SourceStatus = 'supported' | 'partial' | 'best_effort' | 'inferred' | 'unsupported'

export interface DimensionStatus {
  dimension: string
  source: string
  status: SourceStatus
}

export interface ProOutput {
  role: 'pro'
  verdict: Verdict
  market: Market
  selection: string
  confidence: Confidence
  summary: string
  facts: string[]
  core_points: string[]
  risks: string[]
  data_quality: DataQuality
  market_coverage: string[]
  data_gaps: string[]
}

export interface AntiOutput {
  role: 'anti'
  verdict: Verdict
  market: Market
  selection: string
  confidence: Confidence
  summary: string
  facts: string[]
  core_points: string[]
  counter_to_pro: string[]
  risks: string[]
  data_quality: DataQuality
  market_coverage: string[]
  data_gaps: string[]
}

export interface JudgeOutput {
  role: 'judge'
  verdict: Verdict
  market: Market
  selection: string
  confidence: Confidence
  summary: string
  directional_pick: string
  directional_score: number
  bet_grade: BetGrade
  accepted_pro_points: string[]
  accepted_anti_points: string[]
  rejected_points: string[]
  final_risks: string[]
  directional_score_rationale: string
  anti_direction_case: string
  risk_veto_assessment: string
  opportunity_cost_note: string
  execution_action: ExecutionAction
  evidence_freshness_verdict: EvidenceFreshness
  data_quality: DataQuality
  market_coverage: string[]
  data_gaps: string[]
  // Demo extension: structured prediction card
  win_probabilities: { home: number; draw: number; away: number }
  top_scorelines: Array<{ score: string; probability: number }>
}

export type Role = 'pro' | 'anti' | 'judge'
// vision = multimodal transcription stage; recon = owlcoda-agent web
// reconnaissance stage — both run before the debate and feed the brief
export type SeatRole = Role | 'vision' | 'recon'

export interface UserEvidenceInputs {
  recentForm?: string
  injuriesNews?: string
  oddsText?: string
  extraNotes?: string
  images?: Array<{ name: string; mediaType: string; base64: string }>
}

export interface RoleModelConfig {
  model: string
  fallback?: string
}

export interface AnalyzeRequest {
  matchId: number | string
  homeTeam: string
  awayTeam: string
  owlcodaBaseUrl?: string
  roles: { pro: RoleModelConfig; anti: RoleModelConfig; judge: RoleModelConfig }
  // dedicated multimodal model that transcribes uploaded images into text
  visionModel?: string
  // optional owlcoda-agent web reconnaissance (experimental)
  webRecon?: boolean
  reconModel?: string
  singleModel: boolean
  inputs: UserEvidenceInputs
}

export interface RoleManifestEntry {
  role: SeatRole
  model: string
  fallbackUsed: boolean
  inputTokens?: number
  outputTokens?: number
  durationMs: number
  parsed: boolean
}

export type AnalyzeEvent =
  | { type: 'run_start'; matchKey: string; roles: Record<Role, string>; singleModel: boolean; dimensions: DimensionStatus[] }
  | { type: 'role_start'; role: SeatRole; model: string }
  | { type: 'token_delta'; role: SeatRole; text: string }
  | { type: 'role_fallback'; role: SeatRole; from: string; to: string; reason: string }
  | { type: 'role_done'; role: SeatRole; output: ProOutput | AntiOutput | JudgeOutput | null; raw: string; manifest: RoleManifestEntry }
  | { type: 'role_error'; role: SeatRole; error: string }
  | { type: 'recon_sources'; sources: Array<{ title: string; url: string }> }
  | { type: 'baseline'; baseline: unknown }
  | { type: 'manifest'; roles: RoleManifestEntry[]; totalMs: number }
  | { type: 'done' }
  | { type: 'error'; error: string }

// ---- daily review (复盘) types ----

export type Outcome = 'home' | 'draw' | 'away'
export type ResultStatus = 'pending' | 'final' | 'unsupported'
export type HandicapVerdict = 'cover' | 'half_win' | 'push' | 'half_loss' | 'loss'

export interface MatchResult {
  match_id: number | string
  match_key: string
  home_team: string
  away_team: string
  home_goals: number | null
  away_goals: number | null
  outcome: Outcome | null
  status: ResultStatus
  scorers?: Array<{ team: 'home' | 'away'; player: string; minute?: number }>
  source_urls: string[]
  fetched_by: 'owlcoda_agent' | 'human'
  confidence: SourceStatus
  proposed_at: string
  confirmed_at?: string
  confirmed_by?: 'human'
}

export interface DecisionLog {
  match_id: number | string
  stamp: string
  decision: string
  human_note?: string
  final_judge_ref?: string
  at: string
}

export interface LayerScore {
  directional_pick: Outcome | 'none'
  hit: boolean | null
  p_actual: number | null
  brier: number | null
}

export interface BettingRead {
  outcome: string
  market: string
  selection: string
  flagged_edge: number | null
  flagged_ev: number | null
  won: boolean | 'push'
  realized_ev: number
}

export interface HandicapSettlement {
  line: number
  side: 'home' | 'away'
  margin: number
  verdict: HandicapVerdict
  realized_ev: number
}

export interface ReviewScorecard {
  match_id: number | string
  stamp: string
  reviewed_at: string
  result: { home_goals: number; away_goals: number; outcome: Outcome; scoreline: string }
  layers: {
    baseline: LayerScore
    judge: LayerScore
    human: LayerScore | { status: 'n/a' }
  }
  attribution: { debate_vs_baseline: number | null; human_vs_judge: number | null }
  calibration: {
    baseline_brier: number | null
    judge_brier: number | null
    scoreline_hit_baseline: boolean
    scoreline_hit_judge: boolean
  }
  betting: { reads: BettingRead[]; handicap_lean?: HandicapSettlement }
  clv: { status: 'computed' | 'n/a'; value?: number; note?: string }
  narrative?: string
  confidence: SourceStatus
}

export interface ReviewAggregate {
  n_matches: number
  updated_at: string
  directional_hit_rate: { baseline: number; judge: number; human: number }
  mean_brier: { baseline: number; judge: number }
  realized_roi: number
  cover_rate: number
  calibration_bins: Array<{ p_lo: number; p_hi: number; predicted: number; observed: number; n: number }>
}

// ---- FIFA post-match report (Phase 2) types ----

export interface FifaPhases {
  in_possession: {
    build_up_unopposed: number; build_up_opposed: number; progression: number; final_third: number
    long_ball: number; attacking_transition: number; counter_attack: number; set_piece: number
  }
  out_of_possession: {
    high_press: number; mid_press: number; low_press: number; high_block: number; mid_block: number
    low_block: number; recovery: number; defensive_transition: number; counter_press: number
  }
}

export interface FifaTeamStats {
  possession_pct: number
  goals: number
  xg: number
  attempts: number; attempts_on_target: number
  passes: number; passes_complete: number
  pass_completion_pct: number
  completed_line_breaks: number
  defensive_line_breaks: number
  receptions_final_third: number
  crosses: number
  ball_progressions: number
  defensive_pressures: number; direct_pressures: number
  forced_turnovers: number
  second_balls: number
  total_distance_km: number
  low_speed_sprint_km: number
  phases: FifaPhases
}

export interface FifaMatchReport {
  match_id: number | string
  home_team: string
  away_team: string
  source_pdf_url: string
  extracted_by: 'pdftotext' | 'human'
  confidence: SourceStatus
  contested_possession_pct: number
  home: FifaTeamStats
  away: FifaTeamStats
  proposed_at: string
  confirmed_at?: string
}

export interface TeamTactics {
  team: string
  matches: number
  updated_at: string
  // observed-style rolling averages (fills VM pack todo tactical fields)
  avg: {
    possession_pct: number; pass_completion_pct: number; total_distance_km: number
    xg_for: number; xg_against: number; high_press: number; mid_block: number; counter_press: number
  }
}
