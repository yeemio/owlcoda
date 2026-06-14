// 确定性解析 FIFA 赛后报告(pdftotext -layout 文本)。规则:每个指标行里
// 第一个数值=home、最后一个数值=away,忽略 label 内嵌数字(Zone 4 / 20-25 / (On Target))。
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export interface NumTok { value: number; paren: number | null }

const NUM_RE = /(\d+(?:\.\d+)?)(?:\s*(?:km|%))?(?:\s*\((\d+)\))?/g

export function firstLastNumbers(line: string): { first: NumTok | null; last: NumTok | null } {
  const toks: NumTok[] = []
  for (const m of line.matchAll(NUM_RE)) {
    toks.push({ value: Number(m[1]), paren: m[2] != null ? Number(m[2]) : null })
  }
  return { first: toks[0] ?? null, last: toks[toks.length - 1] ?? null }
}

// label substring -> setter on a partial team stats object (primary + optional paren)
const KEY_SPECS: Array<{ label: string; not?: string; set: (t: any, n: NumTok) => void }> = [
  { label: 'Goals', not: 'xG', set: (t, n) => (t.goals = n.value) },
  { label: 'xG (Expected Goals)', set: (t, n) => (t.xg = n.value) },
  { label: 'Attempts at Goal', set: (t, n) => { t.attempts = n.value; t.attempts_on_target = n.paren ?? 0 } },
  { label: 'Total Passes', set: (t, n) => { t.passes = n.value; t.passes_complete = n.paren ?? 0 } },
  { label: 'Pass Completion', set: (t, n) => (t.pass_completion_pct = n.value) },
  { label: 'Completed Line Breaks', set: (t, n) => (t.completed_line_breaks = n.value) },
  { label: 'Defensive Line Breaks', set: (t, n) => (t.defensive_line_breaks = n.value) },
  { label: 'Receptions in the Final Third', set: (t, n) => (t.receptions_final_third = n.value) },
  { label: 'Crosses', set: (t, n) => (t.crosses = n.value) },
  { label: 'Ball Progressions', set: (t, n) => (t.ball_progressions = n.value) },
  { label: 'Defensive Pressures Applied', set: (t, n) => { t.defensive_pressures = n.value; t.direct_pressures = n.paren ?? 0 } },
  { label: 'Forced Turnovers', set: (t, n) => (t.forced_turnovers = n.value) },
  { label: 'Second Balls', set: (t, n) => (t.second_balls = n.value) },
  { label: 'Total Distance Covered', set: (t, n) => (t.total_distance_km = n.value) },
  { label: 'Low Speed Sprinting', set: (t, n) => (t.low_speed_sprint_km = n.value) },
]

export function parseKeyStatistics(text: string): { home: any; away: any; contested: number } {
  const lines = text.split('\n')
  const home: any = {}
  const away: any = {}
  let contested = 0
  // possession: the line after the 'Possession' header carries home / contested / away percents
  const posIdx = lines.findIndex((l) => /\bPossession\b/.test(l))
  if (posIdx >= 0) {
    for (let k = posIdx + 1; k < lines.length; k++) {
      const nums = [...lines[k].matchAll(NUM_RE)].map((m) => Number(m[1]))
      if (nums.length >= 3) { home.possession_pct = nums[0]; contested = nums[1]; away.possession_pct = nums[nums.length - 1]; break }
    }
  }
  for (const spec of KEY_SPECS) {
    const line = lines.find((l) => l.includes(spec.label) && (!spec.not || !l.includes(spec.not)))
    if (!line) continue
    const { first, last } = firstLastNumbers(line)
    if (first) spec.set(home, first)
    if (last) spec.set(away, last)
  }
  return { home, away, contested }
}

// ---- Phases of Play ----

import type { FifaPhases } from '../framework/types.js'

const PHASE_SPECS: Array<{ label: string; group: 'in_possession' | 'out_of_possession'; key: string }> = [
  { label: 'Build Up Unopposed', group: 'in_possession', key: 'build_up_unopposed' },
  { label: 'Build Up Opposed', group: 'in_possession', key: 'build_up_opposed' },
  { label: 'Progression', group: 'in_possession', key: 'progression' },
  { label: 'Final Third', group: 'in_possession', key: 'final_third' },
  { label: 'Long Ball', group: 'in_possession', key: 'long_ball' },
  { label: 'Attacking Transition', group: 'in_possession', key: 'attacking_transition' },
  { label: 'Counter Attack', group: 'in_possession', key: 'counter_attack' },
  { label: 'Set Piece', group: 'in_possession', key: 'set_piece' },
  { label: 'High Press', group: 'out_of_possession', key: 'high_press' },
  { label: 'Mid Press', group: 'out_of_possession', key: 'mid_press' },
  { label: 'Low Press', group: 'out_of_possession', key: 'low_press' },
  { label: 'High Block', group: 'out_of_possession', key: 'high_block' },
  { label: 'Mid Block', group: 'out_of_possession', key: 'mid_block' },
  { label: 'Low Block', group: 'out_of_possession', key: 'low_block' },
  { label: 'Recovery', group: 'out_of_possession', key: 'recovery' },
  { label: 'Defensive Transition', group: 'out_of_possession', key: 'defensive_transition' },
  { label: 'Counter-press', group: 'out_of_possession', key: 'counter_press' },
]

function blankPhases(): FifaPhases {
  return {
    in_possession: { build_up_unopposed: 0, build_up_opposed: 0, progression: 0, final_third: 0, long_ball: 0, attacking_transition: 0, counter_attack: 0, set_piece: 0 },
    out_of_possession: { high_press: 0, mid_press: 0, low_press: 0, high_block: 0, mid_block: 0, low_block: 0, recovery: 0, defensive_transition: 0, counter_press: 0 },
  }
}

export function parsePhasesOfPlay(text: string): { home: FifaPhases; away: FifaPhases } {
  const lines = text.split('\n')
  const home = blankPhases()
  const away = blankPhases()
  for (const spec of PHASE_SPECS) {
    // Use exact label matching: find a line containing the label.
    // For 'Build Up Opposed', we must NOT match the 'Build Up Unopposed' line.
    // Strategy: require that the label is not immediately preceded by 'Un' (case-insensitive).
    // We check that 'Unopposed' does not appear on the line when matching 'Opposed'.
    const escapedLabel = spec.label.replace(/[-]/g, '\\$&')
    let line: string | undefined
    if (spec.key === 'build_up_opposed') {
      // Explicitly exclude lines containing 'Unopposed'
      line = lines.find((l) => l.includes(spec.label) && !l.includes('Unopposed'))
    } else {
      line = lines.find((l) => new RegExp(`\\b${escapedLabel}\\b`).test(l))
    }
    if (!line) continue
    const { first, last } = firstLastNumbers(line)
    if (first) (home[spec.group] as any)[spec.key] = first.value
    if (last) (away[spec.group] as any)[spec.key] = last.value
  }
  return { home, away }
}

// ---- Report assembly ----

import type { FifaMatchReport, SourceStatus } from '../framework/types.js'

export function extractFifaReport(opts: {
  matchId: number | string; homeTeam: string; awayTeam: string; sourcePdfUrl: string
  p3text: string; p4text: string; proposedAt: string
}): FifaMatchReport {
  const ks = parseKeyStatistics(opts.p3text)
  const ph = parsePhasesOfPlay(opts.p4text)
  const home = { ...ks.home, phases: ph.home }
  const away = { ...ks.away, phases: ph.away }
  // confidence: supported if the anchor metrics parsed, else partial
  const ok = Number.isFinite(home.possession_pct) && Number.isFinite(home.xg) && Number.isFinite(home.total_distance_km)
    && Number.isFinite(away.possession_pct) && Number.isFinite(away.xg) && Number.isFinite(away.total_distance_km)
  const confidence: SourceStatus = ok ? 'supported' : 'partial'
  return {
    match_id: opts.matchId, home_team: opts.homeTeam, away_team: opts.awayTeam,
    source_pdf_url: opts.sourcePdfUrl, extracted_by: 'pdftotext', confidence,
    contested_possession_pct: ks.contested, home, away, proposed_at: opts.proposedAt,
  }
}

// thin wrapper: pdftotext -f N -l N -layout <pdf> -  (poppler). Rejects if not installed.
export function runPdftotext(pdfPath: string, page: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pdftotext', ['-f', String(page), '-l', String(page), '-layout', pdfPath, '-'],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`pdftotext failed (poppler installed?): ${err.message}`))
        resolve(stdout)
      })
  })
}

export async function fetchFifaPdf(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`FIFA pdf ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destPath, buf)
}
