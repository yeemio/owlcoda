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
  | { type: 'manifest'; roles: RoleManifestEntry[]; totalMs: number }
  | { type: 'done' }
  | { type: 'error'; error: string }
