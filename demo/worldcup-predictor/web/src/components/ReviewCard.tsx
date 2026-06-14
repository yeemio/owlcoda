// 单场复盘卡:四维记分 + 三层归因 + 让球兑现 + owlcoda 叙事。
import type { ReviewScorecardClient } from '../api'

const OUT_ZH: Record<string, string> = { home: '主胜', draw: '平局', away: '客胜', none: '未表态' }
const VERDICT_ZH: Record<string, string> = { cover: '穿盘', half_win: '半赢', push: '走盘', half_loss: '半输', loss: '输盘' }

function hitTag(hit: boolean | null) {
  if (hit === null) return <span className="conf-tag">n/a</span>
  return <span className={`delta-pill ${hit ? 'up' : 'down'}`}>{hit ? '命中' : '未中'}</span>
}

export function ReviewCard({ sc, home, away }: { sc: ReviewScorecardClient; home: string; away: string }) {
  const L = sc.layers
  const layerRow = (name: string, layer: any) => {
    if (layer?.status === 'n/a') return (<div className="kv"><span>{name}</span><span className="conf-tag">n/a(未落盘)</span></div>)
    return (
      <div className="kv">
        <span>{name}</span>
        <span>方向 <b>{OUT_ZH[layer.directional_pick] ?? layer.directional_pick}</b></span>
        {hitTag(layer.hit)}
        {layer.p_actual != null && <span>真值概率 <b>{(layer.p_actual * 100).toFixed(0)}%</b></span>}
        {layer.brier != null && <span>Brier <b>{layer.brier.toFixed(3)}</b></span>}
      </div>
    )
  }
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>复盘记分卡 · 真实结果 {home} {sc.result.home_goals}–{sc.result.away_goals} {away}</h3>
      {layerRow('数学基线', L.baseline)}
      {layerRow('辩论终判', L.judge)}
      {layerRow('人工决策', L.human)}
      <div className="kv">
        <span>辩论增量(真值概率)</span>
        <b style={{ color: 'var(--cyan)' }}>
          {sc.attribution.debate_vs_baseline == null ? 'n/a' : `${sc.attribution.debate_vs_baseline > 0 ? '+' : ''}${(sc.attribution.debate_vs_baseline * 100).toFixed(1)}pt`}
        </b>
      </div>
      {sc.betting.handicap_lean && (
        <div className="kv">
          <span>让球兑现 {sc.betting.handicap_lean.side === 'home' ? home : away} {sc.betting.handicap_lean.line}</span>
          <span className={`delta-pill ${['cover', 'half_win'].includes(sc.betting.handicap_lean.verdict) ? 'up' : sc.betting.handicap_lean.verdict === 'push' ? '' : 'down'}`}>
            {VERDICT_ZH[sc.betting.handicap_lean.verdict] ?? sc.betting.handicap_lean.verdict}
          </span>
          <span>realized EV <b>{sc.betting.handicap_lean.realized_ev >= 0 ? '+' : ''}{sc.betting.handicap_lean.realized_ev.toFixed(2)}</b></span>
        </div>
      )}
      {sc.betting.reads?.length > 0 && (
        <div className="kv">价值兑现:
          {sc.betting.reads.map((r: any, i: number) => (
            <span key={i} className={`delta-pill ${r.won === true ? 'up' : r.won === 'push' ? '' : 'down'}`}>
              {OUT_ZH[r.outcome] ?? r.outcome} {r.won === true ? '赢' : r.won === 'push' ? '走' : '输'}
            </span>
          ))}
        </div>
      )}
      <div className="kv"><span>CLV</span><span className="conf-tag">{sc.clv.status === 'n/a' ? `n/a · ${sc.clv.note ?? ''}` : (sc.clv.value ?? 0).toFixed(3)}</span></div>
      {sc.narrative && <p className="hint" style={{ margin: '6px 0 0' }}>{sc.narrative}</p>}
    </div>
  )
}
