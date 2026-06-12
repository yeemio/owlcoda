import { describe, expect, it } from 'vitest'
import { buildEvidence, type Fixture, type TeamProfile } from '../server/framework/evidence.js'

const fixture: Fixture = {
  match_id: 1,
  home_team: 'Mexico',
  away_team: 'South Africa',
  group: 'Group A',
  venue: 'Estadio Azteca, Mexico City',
  competition_stage_label: 'Group Stage',
  match_datetime_utc: '2026-06-11T19:00:00Z',
}

const home: TeamProfile = {
  team_name: 'Mexico',
  name_zh: '墨西哥',
  fifa_code: 'MEX',
  coach: 'Javier Aguirre',
  group: 'Group A',
  squad: [
    { display_name: 'Santiago Gimenez', position_group: 'FWD', club: 'AC Milan (ITA)', club_country_code: 'ITA' },
    { display_name: 'Raúl Rangel', position_group: 'GK', club: 'CD Guadalajara (MEX)', club_country_code: 'MEX' },
  ],
}

describe('buildEvidence', () => {
  it('marks user-missing dimensions as unsupported and forbids odds fabrication', () => {
    const { brief, dimensions } = buildEvidence(fixture, home, null, {})
    const odds = dimensions.find((d) => d.dimension.includes('赔率'))
    expect(odds?.status).toBe('unsupported')
    expect(brief).toContain('严禁编造任何赔率数字')
    expect(dimensions.find((d) => d.dimension.includes('近期状态'))?.status).toBe('unsupported')
  })

  it('upgrades dimensions when user provides evidence', () => {
    const { dimensions, brief } = buildEvidence(fixture, home, null, {
      injuriesNews: '南非主力中卫伤缺',
      oddsText: '主胜 1.40 / 平 4.50 / 客胜 8.50',
    })
    expect(dimensions.find((d) => d.dimension.includes('近期状态'))?.status).toBe('supported')
    expect(dimensions.find((d) => d.dimension.includes('赔率'))?.status).toBe('partial')
    expect(brief).toContain('南非主力中卫伤缺')
    expect(brief).toContain('主胜 1.40')
  })

  it('summarises squads with abroad players and counts', () => {
    const { brief } = buildEvidence(fixture, home, null, {})
    expect(brief).toContain('2 人名单')
    expect(brief).toContain('Santiago Gimenez(AC Milan (ITA))')
    expect(brief).toContain('墨西哥')
  })
})
