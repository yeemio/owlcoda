export function PredictionCard({ judge, home, away }: { judge: any; home: string; away: string }) {
  if (!judge) return null
  const wp = judge.win_probabilities
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>预测卡片(Judge 输出 · 辩论包,非最终推荐)</h3>
      {wp && (
        <div className="prob-bar">
          <div className="prob-home" style={{ flex: Math.max(wp.home, 0.04) }}>
            {home} {Math.round(wp.home * 100)}%
          </div>
          <div className="prob-draw" style={{ flex: Math.max(wp.draw, 0.04) }}>平 {Math.round(wp.draw * 100)}%</div>
          <div className="prob-away" style={{ flex: Math.max(wp.away, 0.04) }}>
            {away} {Math.round(wp.away * 100)}%
          </div>
        </div>
      )}
      <div className="kv">
        <span>方向: <b>{judge.directional_pick}</b></span>
        <span>方向分: <b>{judge.directional_score}</b>/100</span>
        <span>bet_grade: <b>{judge.bet_grade}</b></span>
        <span>执行: <b>{judge.execution_action}</b></span>
        <span>证据新鲜度: <b>{judge.evidence_freshness_verdict}</b></span>
      </div>
      {judge.top_scorelines?.length > 0 && (
        <div className="kv">
          比分倾向:
          {judge.top_scorelines.map((s: any, i: number) => (
            <span key={i}><b>{s.score}</b> ({Math.round(s.probability * 100)}%)</span>
          ))}
        </div>
      )}
      {judge.directional_score_rationale && (
        <p className="hint" style={{ margin: '6px 0 0' }}>{judge.directional_score_rationale}</p>
      )}
    </div>
  )
}
