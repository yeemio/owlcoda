// Ghost Floor: the deterministic baseline is painted as faint dashed "stakes"
// on the same prob-bar the Judge final fills — math floor + model fill read in
// one eye-fixation. Delta pills attribute who moved the line (debate vs human).
const CONF_ZH: Record<string, string> = {
  supported: '可靠', partial: '部分', best_effort: '尽力', inferred: '推断', unsupported: '不可用',
}

function GhostFloor({ baseline, moved }: { baseline: any; moved: boolean }) {
  const b = baseline.win_probabilities
  // cumulative split points of the baseline (home|draw, draw|away), in %.
  // The prob-bar is rendered with exact % widths so these line up precisely.
  const c1 = b.home * 100
  const c2 = (b.home + b.draw) * 100
  return (
    <>
      {[c1, c2].map((pos, i) => (
        <div key={i} className="ghost-stake" style={{ left: `${pos}%` }}>
          <span className="ghost-ring" />
        </div>
      ))}
      {!moved && <span className="ghost-flush">数学 ≈ 模型 · 无实质位移</span>}
    </>
  )
}

export function PredictionCard({ judge, baseline, home, away, result }: { judge: any; baseline?: any; home: string; away: string; result?: { outcome: string; scoreline: string } }) {
  if (!judge) return null
  const wp = judge.win_probabilities
  // ghost floor only when BOTH the baseline and judge probs exist AND the
  // baseline is a usable prior (unsupported = no-prior placeholder -> hide it,
  // matching the baseline's own note that the Judge should ignore it).
  const b =
    wp && baseline?.win_probabilities && baseline.confidence !== 'unsupported' ? baseline.win_probabilities : null
  // one source of truth for deltas: rounded integer points, used by both the
  // pills and the "no movement" flush message (no raw-vs-rounded mismatch).
  const deltas: Array<[string, number]> = b
    ? [
        ['主', Math.round(wp.home * 100) - Math.round(b.home * 100)],
        ['平', Math.round(wp.draw * 100) - Math.round(b.draw * 100)],
        ['客', Math.round(wp.away * 100) - Math.round(b.away * 100)],
      ]
    : []
  const moved = deltas.some(([, d]) => Math.abs(d) >= 2)
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>预测卡片(Judge 输出 · 辩论包,非最终推荐)</h3>
      {wp && (
        <div className="prob-bar" style={{ position: 'relative' }}>
          <div className="prob-home" style={{ width: `${Math.max(wp.home * 100, 6)}%`, flex: 'none' }}>
            {home} {Math.round(wp.home * 100)}%
          </div>
          <div className="prob-draw" style={{ width: `${Math.max(wp.draw * 100, 6)}%`, flex: 'none' }}>平 {Math.round(wp.draw * 100)}%</div>
          <div className="prob-away" style={{ width: `${Math.max(wp.away * 100, 6)}%`, flex: 'none' }}>
            {away} {Math.round(wp.away * 100)}%
          </div>
          {b && <GhostFloor baseline={baseline} moved={moved} />}
          {result && (
            <div
              className="truth-line"
              title={`真实结果 ${result.scoreline}`}
              style={{
                position: 'absolute', top: -4, bottom: -4,
                left: result.outcome === 'home' ? '0%' : result.outcome === 'away' ? '100%' : '50%',
                width: 0, borderLeft: '2px solid var(--truth, #ffd166)',
              }}
            >
              <span style={{ position: 'absolute', top: -16, left: 2, fontSize: 11, color: 'var(--truth, #ffd166)', whiteSpace: 'nowrap' }}>
                真相 {result.scoreline}
              </span>
            </div>
          )}
        </div>
      )}
      {b && (
        <>
          <div className="baseline-cap">
            <span className="ghost-swatch" /> 数学基线(辩论前 · 确定性):主 {Math.round(b.home * 100)}% / 平 {Math.round(b.draw * 100)}% / 客 {Math.round(b.away * 100)}%
            {baseline.confidence && <span className="conf-tag"> {CONF_ZH[baseline.confidence] ?? baseline.confidence}</span>}
            {' · 实线=终判'}
          </div>
          <div className="delta-row">
            <span className="hint" style={{ marginRight: 4 }}>辩论位移 ⚖</span>
            {deltas.map(([k, d]) => (
              <span key={k} className={`delta-pill ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>
                {k} {d > 0 ? '+' : ''}{d}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="kv">
        <span>方向: <b>{judge.directional_pick}</b></span>
        <span>方向分: <b>{judge.directional_score}</b>/100</span>
        <span>bet_grade: <b>{judge.bet_grade}</b></span>
        <span>执行: <b>{judge.execution_action}</b></span>
        <span>证据新鲜度: <b>{judge.evidence_freshness_verdict}</b></span>
      </div>
      {judge.value_verdict && <div className="kv"><span>价值判定: <b style={{ color: 'var(--cyan)' }}>{judge.value_verdict}</b></span></div>}
      {judge.top_scorelines?.length > 0 && (
        <div className="kv">
          比分倾向:
          {judge.top_scorelines.map((s: any, i: number) => (
            <span key={i}><b>{s.score}</b> ({Math.round(s.probability * 100)}%)</span>
          ))}
          {baseline?.top_scorelines?.length > 0 && (
            <span className="hint">基线比分: {baseline.top_scorelines.map((s: any) => s.score).join('/')}</span>
          )}
        </div>
      )}
      {judge.directional_score_rationale && (
        <p className="hint" style={{ margin: '6px 0 0' }}>{judge.directional_score_rationale}</p>
      )}
    </div>
  )
}
