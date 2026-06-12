import type { DimensionStatus, UserEvidenceInputs } from './types.js'

interface SquadPlayer {
  number?: number
  position_group?: string
  display_name?: string
  age_on_2026_06_11?: number
  club?: string
  club_country_code?: string
  height_cm?: number
}

export interface TeamProfile {
  team_name: string
  name_zh?: string
  fifa_code?: string
  confederation?: string
  group?: string
  coach?: string
  squad?: SquadPlayer[]
  fifa_ranking_raw?: string | number
  [k: string]: unknown
}

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
  [k: string]: unknown
}

function squadSummary(profile: TeamProfile | null): string {
  const squad = profile?.squad
  if (!Array.isArray(squad) || squad.length === 0) return '阵容数据缺失'
  const byGroup: Record<string, number> = {}
  const abroad: string[] = []
  for (const p of squad) {
    const g = p.position_group ?? 'UNK'
    byGroup[g] = (byGroup[g] ?? 0) + 1
    if (p.club && p.club_country_code && profile?.fifa_code !== p.club_country_code) {
      abroad.push(`${p.display_name}(${p.club})`)
    }
  }
  const dist = Object.entries(byGroup).map(([g, n]) => `${g}:${n}`).join(' ')
  const abroadLine = abroad.length > 0 ? `海外球员 ${abroad.length} 人: ${abroad.slice(0, 12).join('、')}${abroad.length > 12 ? ' 等' : ''}` : '全部效力本国联赛'
  return `${squad.length} 人名单(${dist});${abroadLine}`
}

function compactJson(value: unknown, max = 700): string {
  if (value == null) return ''
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function teamBlock(label: string, profile: TeamProfile | null): string {
  if (!profile) return `### ${label}\n- 画像缺失(unsupported)\n`
  const p = profile as TeamProfile & Record<string, unknown>
  const lines = [
    `### ${label}: ${profile.team_name}${profile.name_zh ? `(${profile.name_zh})` : ''}`,
    `- FIFA代码: ${profile.fifa_code ?? '未知'} | 赛区: ${profile.confederation ?? '未知'} | 分组: ${profile.group ?? '未知'}${p.host_country ? ' | 东道主' : ''}`,
    `- 教练: ${profile.coach ?? '未知'}`,
    `- FIFA排名: ${p.fifa_world_ranking ?? profile.fifa_ranking_raw ?? '未提供'}${p.fifa_ranking_points ? `(${p.fifa_ranking_points}分)` : ''} | Elo估值: ${p.elo_estimate ?? '未提供'}`,
    `- 世界杯: 参赛${p.world_cup_participations ?? '?'}次 | 历史最佳: ${p.world_cup_history_best ?? '未知'} | 上届表现: ${p.world_cup_last_performance ?? '未知'}`,
    `- 阵容: ${squadSummary(profile)}`,
  ]
  if (p.recent_competitive_form_12m) lines.push(`- 近12月正式比赛战绩: ${compactJson(p.recent_competitive_form_12m)}`)
  if (p.qualifying_campaign_summary) lines.push(`- 预选赛概览: ${compactJson(p.qualifying_campaign_summary)}`)
  if (Array.isArray(p.official_news_headlines) && p.official_news_headlines.length > 0) {
    lines.push(`- 官方新闻标题(2026-06快照): ${(p.official_news_headlines as string[]).slice(0, 5).join(' / ')}`)
  }
  if (p.official_news_lead_summary) lines.push(`- 官方新闻导语: ${compactJson(p.official_news_lead_summary, 300)}`)
  return lines.join('\n')
}

export function buildEvidence(
  fixture: Fixture,
  home: TeamProfile | null,
  away: TeamProfile | null,
  inputs: UserEvidenceInputs,
): { brief: string; dimensions: DimensionStatus[] } {
  const dimensions: DimensionStatus[] = [
    { dimension: '比赛背景(阶段/场馆/时间)', source: '内置官方赛程快照', status: 'supported' },
    { dimension: '双方阵容/教练/分组', source: '内置 FIFA 官方 48 队画像', status: home && away ? 'supported' : 'partial' },
    {
      dimension: '近期状态/伤停/新闻',
      source: inputs.recentForm || inputs.injuriesNews
        ? '用户输入 + 内置近12月战绩'
        : (home as any)?.recent_competitive_form_12m || (away as any)?.recent_competitive_form_12m
          ? '内置近12月战绩快照(2026-06,非临场)'
          : '无',
      status: inputs.recentForm || inputs.injuriesNews
        ? 'supported'
        : (home as any)?.recent_competitive_form_12m || (away as any)?.recent_competitive_form_12m
          ? 'partial'
          : 'unsupported',
    },
    {
      dimension: '赔率/盘口',
      source: inputs.oddsText ? '用户输入(单源,未交叉验证)' : inputs.images?.length ? '用户截图(单源,未交叉验证)' : '无',
      status: inputs.oddsText || inputs.images?.length ? 'partial' : 'unsupported',
    },
    { dimension: '历史交锋', source: '模型先验知识,未经证据验证', status: 'best_effort' },
  ]

  const lines: string[] = [
    `# Debate Evidence | ${fixture.home_team} vs ${fixture.away_team}`,
    '',
    `- Match key: \`${fixture.home_team}::${fixture.away_team}::${fixture.match_datetime_utc ?? 'TBD'}\``,
    `- 阶段: ${fixture.competition_stage_label ?? fixture.stage ?? '未知'} | 分组: ${fixture.group ?? '-'}`,
    `- 场馆: ${fixture.venue ?? '未知'}`,
    `- 开球(UTC): ${fixture.match_datetime_utc ?? 'TBD'} | 开球(北京时间): ${fixture.match_datetime_bjt ?? 'TBD'}`,
    '',
    '## 数据维度与来源等级',
    ...dimensions.map((d) => `- ${d.dimension}: ${d.status}(${d.source})`),
    '',
    '## Team Profiles',
    teamBlock('home_team', home),
    '',
    teamBlock('away_team', away),
    '',
    '## 用户补充证据',
    inputs.recentForm ? `### 近期状态\n${inputs.recentForm}` : '### 近期状态\n(用户未提供,该维度 unsupported)',
    inputs.injuriesNews ? `### 伤停与新闻\n${inputs.injuriesNews}` : '### 伤停与新闻\n(用户未提供,该维度 unsupported)',
    inputs.oddsText
      ? `### 赔率/盘口(用户提供,单源)\n${inputs.oddsText}`
      : inputs.images?.length
        ? '### 赔率/盘口\n(用户以图片形式提供,内容见下方"图片证据转录"章节;除转录内容外严禁编造任何赔率数字)'
        : '### 赔率/盘口\n(用户未提供,该维度 unsupported,严禁编造任何赔率数字)',
    inputs.extraNotes ? `### 其他备注\n${inputs.extraNotes}` : '',
    inputs.images?.length ? `### 图片证据\n用户上传了 ${inputs.images.length} 张图片,已由专职多模态角色转录为文本(见"图片证据转录"章节);只能引用转录中真实出现的内容。` : '',
  ]
  return { brief: lines.filter(Boolean).join('\n'), dimensions }
}
