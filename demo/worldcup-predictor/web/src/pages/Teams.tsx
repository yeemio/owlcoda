import { useEffect, useState } from 'react'
import { fetchTeams, type TeamProfile } from '../api'

export function TeamsPage() {
  const [teams, setTeams] = useState<TeamProfile[]>([])
  const [open, setOpen] = useState<TeamProfile | null>(null)

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams([]))
  }, [])

  return (
    <div>
      <div className="team-grid">
        {teams.map((t) => (
          <div key={t.team_name} className="card team-card" onClick={() => setOpen(t)}>
            <div style={{ fontWeight: 700 }}>
              {t.team_name} {t.name_zh ? `· ${t.name_zh}` : ''}
            </div>
            <div className="meta" style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 6 }}>
              {t.fifa_code} · {t.confederation} · {t.group}
              {(t as any).fifa_world_ranking && <> · FIFA #{(t as any).fifa_world_ranking}</>}
              <br />教练: {t.coach ?? '未知'} · 名册 {t.squad?.length ?? 0} 人
              {(t as any).world_cup_participations != null && <> · {(t as any).world_cup_participations} 次参赛</>}
            </div>
          </div>
        ))}
      </div>

      {open && (
        <div className="modal-mask" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>
              {open.team_name} {open.name_zh ? `· ${open.name_zh}` : ''}
            </h2>
            <p className="hint">
              {open.confederation} · {open.group} · 教练 {open.coach ?? '未知'}
              {(open as any).fifa_world_ranking && <> · FIFA 排名 #{(open as any).fifa_world_ranking}{(open as any).fifa_ranking_points ? `(${(open as any).fifa_ranking_points}分)` : ''}</>}
              {(open as any).elo_estimate && <> · Elo {(open as any).elo_estimate}</>}
            </p>
            <p className="hint">
              世界杯: 参赛 {(open as any).world_cup_participations ?? '?'} 次
              {(open as any).world_cup_history_best && <> · 历史最佳: {(open as any).world_cup_history_best}</>}
              {(open as any).world_cup_last_performance && <> · 上届: {(open as any).world_cup_last_performance}</>}
            </p>
            {Array.isArray((open as any).official_news_headlines) && (open as any).official_news_headlines.length > 0 && (
              <p className="hint">官方新闻: {(open as any).official_news_headlines.slice(0, 3).join(' / ')}</p>
            )}
            <p className="hint">来源: hermes-football VM 画像包 + FIFA 官方 26 人名单(2026-06 快照)</p>
            <table className="squad-table">
              <thead>
                <tr><th>#</th><th>位置</th><th>姓名</th><th>年龄</th><th>俱乐部</th></tr>
              </thead>
              <tbody>
                {(open.squad ?? []).map((p, i) => (
                  <tr key={i}>
                    <td>{p.number}</td>
                    <td>{p.position_group}</td>
                    <td>{p.display_name}</td>
                    <td>{p.age_on_2026_06_11}</td>
                    <td>{p.club}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
