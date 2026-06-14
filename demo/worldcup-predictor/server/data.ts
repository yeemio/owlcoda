// Data loading + merge. Authoritative analysis profiles come from the
// hermes-football VM snapshot (rich: FIFA ranking/points, WC history, Elo,
// 12m form, qualifying summary, official news, official 26-man squad).
// The local collector snapshot contributes zh names and group metadata.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Fixture, TeamProfile } from './framework/evidence.js'
import { deriveStrength, type TeamStrength } from './baseline.js'

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

// schedule names -> FIFA official names used by the VM profile pack
const VM_NAME_ALIAS: Record<string, string> = {
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
  'Cape Verde': 'Cabo Verde',
  Curacao: 'Curaçao',
  'Czech Republic': 'Czechia',
  'DR Congo': 'Congo DR',
  Iran: 'IR Iran',
  'Ivory Coast': "Côte d'Ivoire",
  'South Korea': 'Korea Republic',
  Turkey: 'Türkiye',
}

export interface RichTeamProfile extends TeamProfile {
  fifa_world_ranking?: number
  fifa_ranking_points?: number
  world_cup_participations?: number
  world_cup_history_best?: string
  world_cup_last_performance?: string
  elo_estimate?: number | string
  recent_competitive_form_12m?: unknown
  qualifying_campaign_summary?: unknown
  official_news_headlines?: string[]
  official_news_lead_summary?: string
  official_head_coach?: string
  host_country?: boolean
  // numeric strength for the deterministic baseline (parsed from raw VM,
  // because the flattened elo/form fields above are display strings)
  strength?: TeamStrength
  official_squad_26?: Array<{
    number?: number
    position_group?: string
    display_name?: string
    age_on_2026_06_11?: number
    club?: string
    club_country_code?: string
    height_cm?: number
  }>
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')) as T
}

export const schedule = loadJson<{ fixtures: Fixture[]; generated_at?: string }>('schedule.json')

const localTeams = loadJson<{ teams: TeamProfile[]; generated_at?: string }>('team_profiles.json')
const vmPack = loadJson<{ profiles: Record<string, any>; generated_at_bjt?: string }>('team_profiles_vm.json')

const vmByTeam = new Map<string, any>(Object.values(vmPack.profiles).map((p: any) => [p.team, p]))

// The VM pack wraps values in provenance objects; flatten to readable values
// (provenance stays in the raw file for audit).
function flatStage(v: any, stageKey: string, yearKey: string): string | undefined {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v : undefined
  const stage = v[stageKey]
  const year = v[yearKey]
  return stage ? `${stage}${year ? ` (${year})` : ''}` : undefined
}

function flatElo(v: any): string | undefined {
  if (!v || typeof v !== 'object') return v == null ? undefined : String(v)
  if (v.elo_rating == null) return undefined
  const change = v.one_year_rank_change_raw ? `, 1年排名变化 ${v.one_year_rank_change_raw}` : ''
  return `${v.elo_rating} (Elo第${v.elo_rank}名${change})`
}

function flatForm(v: any): unknown {
  if (!v || typeof v !== 'object') return v ?? undefined
  const s = v.summary
  const recent = Array.isArray(v.matches)
    ? v.matches.slice(-6).map((m: any) => `${m.date} ${m.team_a} ${m.score_a}-${m.score_b} ${m.team_b} (${m.tournament})`)
    : undefined
  return s ? { record_12m: `${s.matches}场 ${s.wins}胜${s.draws}平${s.losses}负, 进${s.goals_for}失${s.goals_against}`, recent_matches: recent } : undefined
}

function flatCoach(v: any): string | undefined {
  if (!v) return undefined
  if (typeof v === 'string') return v
  return v.display_name ?? v.coach_name_raw ?? undefined
}

function flatQualifying(v: any): string | undefined {
  if (!v || typeof v !== 'object') return v ?? undefined
  if (v.host_auto_qualified_2026) return '东道主自动晋级,近12月无预选赛'
  const s = v.summary_12m
  return s && s.matches > 0 ? `近12月预选赛 ${s.matches}场 ${s.wins}胜${s.draws}平${s.losses}负, 进${s.goals_for}失${s.goals_against}` : undefined
}

export const teams: RichTeamProfile[] = localTeams.teams.map((local) => {
  const vm = vmByTeam.get(local.team_name) ?? vmByTeam.get(VM_NAME_ALIAS[local.team_name] ?? '')
  if (!vm) return local
  return {
    ...local,
    fifa_world_ranking: vm.fifa_world_ranking,
    fifa_ranking_points: vm.fifa_ranking_points,
    world_cup_participations: vm.world_cup_participations,
    world_cup_history_best: flatStage(vm.world_cup_history_best, 'best_performance_stage', 'best_performance_year'),
    world_cup_last_performance: flatStage(vm.world_cup_last_performance, 'last_performance_stage', 'last_performance_year'),
    elo_estimate: flatElo(vm.elo_estimate),
    recent_competitive_form_12m: flatForm(vm.recent_competitive_form_12m),
    qualifying_campaign_summary: flatQualifying(vm.qualifying_campaign_summary),
    official_news_headlines: vm.official_news_headlines,
    official_news_lead_summary: vm.official_news_lead_summary,
    official_head_coach: flatCoach(vm.official_head_coach) ?? local.coach,
    host_country: vm.host_country,
    coach: flatCoach(vm.official_head_coach) ?? local.coach,
    strength: deriveStrength(vm) ?? undefined,
    official_squad_26: vm.official_squad_26,
    squad: vm.official_squad_26 ?? local.squad,
  }
})

export const teamByName = new Map(teams.map((t) => [t.team_name, t]))

export const teamsMeta = {
  generated_at_local: localTeams.generated_at,
  generated_at_vm: vmPack.generated_at_bjt,
  profile_source: 'hermes-football vm world_cup_48_team_profiles_current_20260606 + local zh-name pack',
}

export const showcases: Record<string, any> = Object.fromEntries(
  readdirSync(path.join(dataDir, 'showcase'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const pkg = JSON.parse(readFileSync(path.join(dataDir, 'showcase', f), 'utf8'))
      return [pkg.id as string, pkg]
    }),
)
