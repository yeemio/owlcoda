import { describe, expect, it } from 'vitest'
import { buildEvidence, type Fixture, type TeamProfile } from '../server/framework/evidence.js'
import type { TeamTactics } from '../server/framework/types.js'

const fixture: Fixture = {
  match_id: 42,
  home_team: 'Brazil',
  away_team: 'Argentina',
  group: 'Group C',
  venue: 'MetLife Stadium',
  competition_stage_label: 'Group Stage',
  match_datetime_utc: '2026-06-20T22:00:00Z',
}

const home: TeamProfile = { team_name: 'Brazil', fifa_code: 'BRA' }
const away: TeamProfile = { team_name: 'Argentina', fifa_code: 'ARG' }

function makeTactics(team: string, matches: number): TeamTactics {
  return {
    team,
    matches,
    updated_at: '2026-06-19T10:00:00Z',
    avg: {
      possession_pct: 58.3,
      pass_completion_pct: 87.1,
      total_distance_km: 112.4,
      xg_for: 2.15,
      xg_against: 0.93,
      high_press: 34,
      mid_block: 41,
      counter_press: 22,
    },
  }
}

describe('buildEvidence — priors (FIFA flywheel)', () => {
  it('includes 本届实测风格画像 section when home has matches>=1', () => {
    const homeTactics = makeTactics('Brazil', 2)
    const { brief, dimensions } = buildEvidence(fixture, home, away, {}, {
      home: homeTactics,
      away: null,
    })

    // Section header present
    expect(brief).toContain('本届实测风格画像')
    // The inferred label
    expect(brief).toContain('inferred')
    // Honest framing clause
    expect(brief).toContain('不得用历史风格覆盖')
    // Home team numbers
    expect(brief).toContain('58.3%')
    expect(brief).toContain('2.15')
    expect(brief).toContain('0.93')
    // Home team match count
    expect(brief).toContain('2 场')
    // Dimension row added
    const priorsRow = dimensions.find((d) => d.dimension.includes('本届实测风格'))
    expect(priorsRow).toBeDefined()
    expect(priorsRow?.status).toBe('inferred')
  })

  it('includes both team blocks when both have matches>=1', () => {
    const { brief } = buildEvidence(fixture, home, away, {}, {
      home: makeTactics('Brazil', 2),
      away: makeTactics('Argentina', 3),
    })

    const section = brief.slice(brief.indexOf('## 本届实测风格画像'), brief.indexOf('## 用户补充证据'))
    expect(section).toContain('Brazil')
    expect(section).toContain('Argentina')
    expect(brief).toContain('3 场')
  })

  it('does NOT include 本届实测风格画像 when priors is null', () => {
    const { brief, dimensions } = buildEvidence(fixture, home, away, {})

    expect(brief).not.toContain('本届实测风格画像')
    const priorsRow = dimensions.find((d) => d.dimension.includes('本届实测风格'))
    expect(priorsRow).toBeUndefined()
  })

  it('does NOT include 本届实测风格画像 when both teams have matches=0', () => {
    const { brief, dimensions } = buildEvidence(fixture, home, away, {}, {
      home: makeTactics('Brazil', 0),
      away: makeTactics('Argentina', 0),
    })

    expect(brief).not.toContain('本届实测风格画像')
    const priorsRow = dimensions.find((d) => d.dimension.includes('本届实测风格'))
    expect(priorsRow).toBeUndefined()
  })

  it('does NOT include 本届实测风格画像 when priors both are explicitly null', () => {
    const { brief, dimensions } = buildEvidence(fixture, home, away, {}, {
      home: null,
      away: null,
    })

    expect(brief).not.toContain('本届实测风格画像')
    expect(dimensions.find((d) => d.dimension.includes('本届实测风格'))).toBeUndefined()
  })

  it('section appears AFTER Team Profiles and BEFORE 用户补充证据', () => {
    const { brief } = buildEvidence(fixture, home, away, {}, {
      home: makeTactics('Brazil', 1),
      away: null,
    })

    const profilesIdx = brief.indexOf('## Team Profiles')
    const priorsIdx = brief.indexOf('## 本届实测风格画像')
    const userIdx = brief.indexOf('## 用户补充证据')

    expect(profilesIdx).toBeGreaterThanOrEqual(0)
    expect(priorsIdx).toBeGreaterThan(profilesIdx)
    expect(userIdx).toBeGreaterThan(priorsIdx)
  })

  it('only includes away block when only away has matches>=1', () => {
    const { brief } = buildEvidence(fixture, home, away, {}, {
      home: null,
      away: makeTactics('Argentina', 1),
    })

    expect(brief).toContain('本届实测风格画像')
    expect(brief).toContain('Argentina')
    // Brazil block should NOT appear in the priors section (it has no data)
    // The section must exist but only contain the away block
    const sectionStart = brief.indexOf('## 本届实测风格画像')
    const sectionEnd = brief.indexOf('## 用户补充证据')
    const section = brief.slice(sectionStart, sectionEnd)
    expect(section).toContain('Argentina')
  })
})
