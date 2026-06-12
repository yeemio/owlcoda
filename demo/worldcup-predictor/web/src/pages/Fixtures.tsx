import { useEffect, useMemo, useState } from 'react'
import { fetchFixtures, fetchModels, fetchTeams, loadSettings, type Fixture, type TeamProfile } from '../api'
import { teamLabel, useLang, useT } from '../i18n'

function Hero({ onCta }: { onCta: () => void }) {
  const t = useT()
  const [modelCount, setModelCount] = useState<number | null>(null)
  useEffect(() => {
    fetchModels(loadSettings().owlcodaBaseUrl)
      .then((m) => setModelCount(m.ok ? m.models.length : 0))
      .catch(() => setModelCount(0))
  }, [])
  const points: Array<[string, string]> = [
    [t('heroPoint1T'), t('heroPoint1D')],
    [t('heroPoint2T'), t('heroPoint2D')],
    [t('heroPoint3T'), t('heroPoint3D')],
    [t('heroPoint4T'), t('heroPoint4D')],
  ]
  return (
    <section className="hero">
      <div className="hero-main">
        <div className="hero-kicker">{t('heroKicker')}</div>
        <h1 className="hero-title">
          {t('heroTitle1')}
          <br />
          <span className="hero-grad">{t('heroTitle2')}</span>
        </h1>
        <p className="hero-sub">{t('heroSub')}</p>
        <div className="hero-actions">
          <button className="btn hero-btn" onClick={onCta}>{t('heroCta')}</button>
          <span className={`hero-status ${modelCount ? 'on' : ''}`}>
            {modelCount ? (
              <>
                <span className="hb ok" /> {modelCount} {t('heroModelsOnline')}
              </>
            ) : (
              <>
                <span className="hb bad" /> {t('heroOffline')}
              </>
            )}
          </span>
        </div>
      </div>
      <div className="hero-points">
        {points.map(([title, desc]) => (
          <div key={title} className="hero-point">
            <b>{title}</b>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

const STAGES = ['all', 'group', 'round32', 'round16', 'quarter', 'semi', 'third', 'final'] as const

const FLAGS: Record<string, string> = {
  MEX: '🇲🇽', RSA: '🇿🇦', KOR: '🇰🇷', CZE: '🇨🇿', CAN: '🇨🇦', BIH: '🇧🇦', USA: '🇺🇸', PAR: '🇵🇾',
  AUS: '🇦🇺', TUR: '🇹🇷', QAT: '🇶🇦', SUI: '🇨🇭', BRA: '🇧🇷', MAR: '🇲🇦', HAI: '🇭🇹', SCO: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  GER: '🇩🇪', CUW: '🇨🇼', NED: '🇳🇱', JPN: '🇯🇵', CIV: '🇨🇮', ECU: '🇪🇨', TUN: '🇹🇳', SWE: '🇸🇪',
  ESP: '🇪🇸', CPV: '🇨🇻', BEL: '🇧🇪', EGY: '🇪🇬', KSA: '🇸🇦', URU: '🇺🇾', IRN: '🇮🇷', NZL: '🇳🇿',
  AUT: '🇦🇹', JOR: '🇯🇴', FRA: '🇫🇷', SEN: '🇸🇳', ENG: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', CRO: '🇭🇷', GHA: '🇬🇭', PAN: '🇵🇦',
  POR: '🇵🇹', UZB: '🇺🇿', COL: '🇨🇴', NOR: '🇳🇴', ARG: '🇦🇷', ALG: '🇩🇿', ITA: '🇮🇹', COD: '🇨🇩',
}

function flag(team: TeamProfile | undefined): string {
  return (team?.fifa_code && FLAGS[team.fifa_code]) || '⚽'
}

export function FixturesPage({ onOpen }: { onOpen: (f: Fixture) => void }) {
  const t = useT()
  const lang = useLang()
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [teams, setTeams] = useState<TeamProfile[]>([])
  const [view, setView] = useState<'groups' | 'schedule'>('groups')
  const [stage, setStage] = useState('all')

  useEffect(() => {
    fetchFixtures().then(setFixtures).catch(() => setFixtures([]))
    fetchTeams().then(setTeams).catch(() => setTeams([]))
  }, [])

  const teamMap = useMemo(() => new Map(teams.map((x) => [x.team_name, x])), [teams])
  const label = (name: string) => teamLabel(name, teamMap.get(name)?.name_zh, lang)

  const groups = useMemo(() => {
    const m = new Map<string, { teams: Set<string>; fixtures: Fixture[] }>()
    for (const f of fixtures) {
      if (f.stage !== 'group' || !f.group) continue
      if (!m.has(f.group)) m.set(f.group, { teams: new Set(), fixtures: [] })
      const g = m.get(f.group)!
      g.fixtures.push(f)
      if (!f.home_team.includes('TBD')) g.teams.add(f.home_team)
      if (!f.away_team.includes('TBD')) g.teams.add(f.away_team)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [fixtures])

  const dayKey = (f: Fixture) => (f.match_datetime_bjt ?? 'TBD').slice(0, 10)
  const scheduleDays = useMemo(() => {
    const filtered = fixtures.filter((f) => stage === 'all' || f.stage === stage)
    const m = new Map<string, Fixture[]>()
    for (const f of filtered) {
      const k = dayKey(f)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(f)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [fixtures, stage])

  function FixtureRow({ f }: { f: Fixture }) {
    const tbd = f.is_placeholder || f.home_team.includes('TBD') || f.away_team.includes('TBD')
    return (
      <div className={`fixture-row ${tbd ? 'tbd' : ''}`} onClick={() => !tbd && onOpen(f)}>
        <span className="fr-time">{(f.match_datetime_bjt ?? '').slice(11, 16) || '--:--'}</span>
        <span className="fr-team home">
          {label(f.home_team)} {flag(teamMap.get(f.home_team))}
        </span>
        <span className="fr-vs">vs</span>
        <span className="fr-team away">
          {flag(teamMap.get(f.away_team))} {label(f.away_team)}
        </span>
        {f.showcase_id && <span className="badge">{t('showcaseBadge')}</span>}
        {tbd && <span className="fr-tbd">{t('tbd')}</span>}
      </div>
    )
  }

  return (
    <div>
      <Hero
        onCta={() => {
          const showcase = fixtures.find((f) => f.showcase_id)
          if (showcase) onOpen(showcase)
        }}
      />
      <div className="filters">
        <button className={`chip ${view === 'groups' ? 'on' : ''}`} onClick={() => setView('groups')}>
          {t('viewGroups')}
        </button>
        <button className={`chip ${view === 'schedule' ? 'on' : ''}`} onClick={() => setView('schedule')}>
          {t('viewSchedule')}
        </button>
        {view === 'schedule' &&
          STAGES.map((s) => (
            <button key={s} className={`chip ${stage === s ? 'on' : ''}`} onClick={() => setStage(s)}>
              {t(`stage_${s}`)}
            </button>
          ))}
      </div>

      {view === 'groups' && (
        <div className="group-grid">
          {groups.map(([groupName, g]) => (
            <div key={groupName} className="card group-card">
              <div className="group-head">
                <span className="group-letter">{groupName.replace('Group ', '')}</span>
                <span className="group-title">
                  {lang === 'zh' ? `${groupName.replace('Group ', '')} ${t('groupWord')}` : groupName}
                </span>
              </div>
              <div className="group-teams">
                {[...g.teams].map((name) => {
                  const tp = teamMap.get(name)
                  return (
                    <div key={name} className="group-team">
                      <span className="gt-flag">{flag(tp)}</span>
                      <span className="gt-name">{label(name)}</span>
                      {(tp as any)?.fifa_world_ranking && <span className="gt-rank">#{(tp as any).fifa_world_ranking}</span>}
                    </div>
                  )
                })}
              </div>
              <div className="group-fixtures">
                <div className="section-label">{t('matchesInGroup')}</div>
                {g.fixtures.map((f) => (
                  <FixtureRow key={String(f.match_id)} f={f} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'schedule' && (
        <div>
          {scheduleDays.map(([day, list]) => (
            <div key={day} className="day-block">
              <div className="day-head">
                {day === 'TBD' ? t('tbd') : `${day}(${t('bjt')})`}
                <span className="day-count">{list.length}</span>
              </div>
              <div className="card" style={{ padding: '4px 10px' }}>
                {list.map((f) => (
                  <div key={String(f.match_id)} className="sched-line">
                    <span className="sched-stage">{t(`stage_${f.stage ?? 'group'}`)}{f.group ? ` · ${f.group.replace('Group ', '')}` : ''}</span>
                    <FixtureRow f={f} />
                    <span className="sched-venue">{f.venue}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
