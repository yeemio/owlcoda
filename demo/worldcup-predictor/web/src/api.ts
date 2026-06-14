// Client-side API helpers + shared types (mirrors server/framework/types.ts).

export interface Fixture {
  match_id: number | string
  home_team: string
  away_team: string
  group?: string
  venue?: string
  stage?: string
  competition_stage_label?: string
  match_datetime_utc?: string
  match_datetime_bjt?: string
  is_placeholder?: boolean
  showcase_id?: string | null
}

export interface TeamProfile {
  team_name: string
  name_zh?: string
  fifa_code?: string
  confederation?: string
  group?: string
  coach?: string
  squad?: Array<{
    number?: number
    position_group?: string
    display_name?: string
    age_on_2026_06_11?: number
    club?: string
    height_cm?: number
  }>
}

export type Role = 'pro' | 'anti' | 'judge'
export type SeatRole = Role | 'vision' | 'recon'

export interface Settings {
  owlcodaBaseUrl: string
  singleModel: boolean
  // set once the user explicitly picks a mode; until then we keep
  // steering them to multi-model when they have enough models
  modeChosen?: boolean
  roles: Record<Role, { model: string; fallback?: string }>
  // dedicated multimodal transcription model (images → text for all roles)
  visionModel?: string
  // owlcoda-agent web reconnaissance (experimental)
  webRecon?: boolean
  reconModel?: string
}

export const DEFAULT_SETTINGS: Settings = {
  owlcodaBaseUrl: 'http://127.0.0.1:8019',
  // Multi-model debate is the product's signature move — default on.
  singleModel: false,
  roles: { pro: { model: '' }, anti: { model: '' }, judge: { model: '' } },
}

// v3: re-run auto-assign with vision-first Pro preference (mimo-omni)
const SETTINGS_KEY = 'wc26.settings.v3'
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings
    // Migration: earlier builds defaulted to single-model; unless the user
    // explicitly chose a mode, prefer the multi-model debate.
    if (!parsed.modeChosen) parsed.singleModel = false
    return parsed
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function autoPickVisionModel(modelIds: string[], current?: string): string | undefined {
  if (current && modelIds.includes(current)) return current
  return modelIds.find((id) => /omni|vision|-vl\b|vl-/i.test(id))
}

// Heuristic role routing matching the production lineup:
// Pro=mimo-class scout, Anti=kimi-class risk auditor, Judge=deepseek-class.
export function autoAssignRoles(modelIds: string[], roles: Settings['roles']): Settings['roles'] {
  if (modelIds.length === 0) return roles
  // Pro gathers evidence (screenshots) — vision-capable models (omni/vl/
  // vision variants, e.g. mimo-omni) take priority over plain mimo.
  const prefer: Record<Role, RegExp[]> = {
    pro: [/omni/i, /vision/i, /-vl\b|vl-/i, /mimo/i],
    anti: [/kimi/i],
    judge: [/deepseek/i],
  }
  const next = { ...roles }
  const taken = new Set<string>()
  for (const role of ['pro', 'anti', 'judge'] as Role[]) {
    const cur = next[role].model
    if (cur && modelIds.includes(cur)) {
      taken.add(cur)
      continue
    }
    for (const pattern of prefer[role]) {
      const match = modelIds.find((id) => pattern.test(id) && !taken.has(id))
      if (match) {
        next[role] = { ...next[role], model: match }
        taken.add(match)
        break
      }
    }
  }
  // Fill remaining roles with distinct unused models, then round-robin.
  let i = 0
  for (const role of ['pro', 'anti', 'judge'] as Role[]) {
    if (next[role].model && modelIds.includes(next[role].model)) continue
    const free = modelIds.find((id) => !taken.has(id))
    const pick = free ?? modelIds[i++ % modelIds.length]
    next[role] = { ...next[role], model: pick }
    taken.add(pick)
  }
  return next
}
export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

export function saveDecision(matchId: string | number, decision: string, judgeSummary?: string, stamp?: string, humanNote?: string) {
  const key = 'wc26.decisions'
  const all = JSON.parse(localStorage.getItem(key) ?? '{}')
  all[String(matchId)] = { decision, judgeSummary, at: new Date().toISOString() }
  localStorage.setItem(key, JSON.stringify(all))
  // 服务端落盘(复盘需要它来评人层);失败不阻塞 UI
  if (stamp) {
    fetch('/api/decision', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId, stamp, decision, humanNote }),
    }).catch(() => {})
  }
}
export function loadDecision(matchId: string | number): { decision: string; at: string } | null {
  const all = JSON.parse(localStorage.getItem('wc26.decisions') ?? '{}')
  return all[String(matchId)] ?? null
}

export async function fetchFixtures(): Promise<Fixture[]> {
  const res = await fetch('/api/fixtures')
  return (await res.json()).fixtures
}
export async function fetchTeams(): Promise<TeamProfile[]> {
  const res = await fetch('/api/teams')
  return (await res.json()).teams
}
export async function fetchModels(base: string): Promise<{ ok: boolean; models: Array<{ id: string; tier?: string; display_name?: string }>; error?: string }> {
  const res = await fetch(`/api/models?base=${encodeURIComponent(base)}`)
  return res.json()
}
export async function fetchHealth(base: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/health?base=${encodeURIComponent(base)}`)
  return res.json()
}
export async function fetchCapabilities(base: string): Promise<Record<string, { vision: boolean | null }>> {
  const res = await fetch(`/api/capabilities?base=${encodeURIComponent(base)}`)
  return (await res.json()).capabilities ?? {}
}
export async function fetchRuns(matchId: string | number): Promise<Array<{ stamp: string; manifest: any; judge: any }>> {
  const res = await fetch(`/api/runs/${matchId}`)
  return (await res.json()).runs ?? []
}
export async function fetchRunDetail(matchId: string | number, stamp: string): Promise<any> {
  const res = await fetch(`/api/runs/${matchId}/${encodeURIComponent(stamp)}`)
  return res.json()
}
export async function finalizeRun(body: {
  matchId: string | number
  stamp?: string
  humanNote?: string
  model: string
  models?: { pro?: string; anti?: string; judge?: string }
  owlcodaBaseUrl?: string
}): Promise<{ ok?: boolean; stamp?: string; final?: any; final_pro?: any; final_anti?: any; error?: string; raw?: string }> {
  const res = await fetch('/api/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// T5: turn raw upstream error JSON into a human sentence + raw detail.
export function explainError(error: string): { headline: string; detail: string } {
  const m = error.match(/"diagnostic":\s*({.*?})\s*[,}]/s)
  let diag: any = null
  if (m) {
    try { diag = JSON.parse(m[1]) } catch { /* keep raw */ }
  }
  if (!diag) {
    const provider = error.match(/"provider"\s*:\s*"([^"]+)"/)?.[1]
    const model = error.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
    const status = error.match(/"status"\s*:\s*(\d+)/)?.[1]
    diag = provider || model || status ? { provider, model, status } : null
  }
  if (diag) {
    const who = [diag.model, diag.provider && `(${diag.provider})`].filter(Boolean).join(' ')
    const status = diag.status ? `${diag.status} ` : ''
    return {
      headline: `${who || '上游模型'} 拒绝了请求(${status}上游错误)——通常是模型型号/端点配置或消息形态问题,可运行 owlcoda audit 查看完整记录。`,
      detail: error,
    }
  }
  if (/fetch failed|ECONNREFUSED|abort/i.test(error)) {
    return { headline: '无法连接 owlcoda proxy——请确认 owlcoda serve 已运行,或到设置页检测连接。', detail: error }
  }
  return { headline: error.slice(0, 160), detail: error }
}

export async function fetchShowcase(id: string): Promise<any> {
  const res = await fetch(`/api/showcase/${id}`)
  return res.json()
}

export interface AnalyzeBody {
  matchId: number | string
  homeTeam: string
  awayTeam: string
  owlcodaBaseUrl: string
  singleModel: boolean
  roles: Settings['roles']
  visionModel?: string
  webRecon?: boolean
  reconModel?: string
  inputs: {
    recentForm?: string
    injuriesNews?: string
    oddsText?: string
    extraNotes?: string
    images?: Array<{ name: string; mediaType: string; base64: string }>
  }
}

// POST /api/analyze with SSE response; dispatches each parsed event.
export async function streamAnalyze(body: AnalyzeBody, onEvent: (e: any) => void, signal?: AbortSignal) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`analyze failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()))
      } catch {
        /* ignore malformed chunk */
      }
    }
  }
}

export interface ReviewScorecardClient {
  match_id: number | string
  stamp: string
  result: { home_goals: number; away_goals: number; outcome: string; scoreline: string }
  layers: any
  attribution: { debate_vs_baseline: number | null; human_vs_judge: number | null }
  calibration: any
  betting: any
  clv: { status: string; value?: number; note?: string }
  narrative?: string
  confidence: string
}

export async function proposeResult(matchId: string | number): Promise<{ ok: boolean; result?: any; error?: string }> {
  const res = await fetch(`/api/review/result/${matchId}`, { method: 'POST' })
  return res.json()
}
export async function confirmResult(matchId: string | number, body: { homeGoals?: number; awayGoals?: number; narrate?: boolean }): Promise<{ ok: boolean; result?: any; graded?: boolean; error?: string }> {
  const res = await fetch(`/api/review/result/${matchId}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.json()
}
export async function fetchReview(matchId: string | number, stamp: string): Promise<ReviewScorecardClient | { error: string }> {
  const res = await fetch(`/api/review/${matchId}/${encodeURIComponent(stamp)}`)
  return res.json()
}
export async function fetchReviewAggregate(): Promise<any> {
  const res = await fetch('/api/reviews/aggregate')
  return res.json()
}
