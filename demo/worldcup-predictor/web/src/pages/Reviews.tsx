import { useEffect, useState } from 'react'
import { fetchReviewAggregate } from '../api'

export function Reviews() {
  const [agg, setAgg] = useState<any>(null)
  useEffect(() => { fetchReviewAggregate().then(setAgg).catch(() => {}) }, [])
  if (!agg || agg.n_matches === 0) {
    return <div className="card"><h3>owlcoda 闭环战绩</h3><p className="hint">暂无已复盘的比赛。比赛结束后,引擎会自动抓赛果(人一键确认),并在此累计战绩。</p></div>
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`
  return (
    <div className="card">
      <h3>owlcoda 闭环战绩 · 已复盘 {agg.n_matches} 场</h3>
      <div className="kv">
        <span>方向命中率</span>
        <span>数学 <b>{pct(agg.directional_hit_rate.baseline)}</b></span>
        <span>辩论 <b style={{ color: 'var(--cyan)' }}>{pct(agg.directional_hit_rate.judge)}</b></span>
        <span>人 <b>{pct(agg.directional_hit_rate.human)}</b></span>
      </div>
      <div className="kv">
        <span>平均 Brier(越低越准)</span>
        <span>数学 <b>{agg.mean_brier.baseline.toFixed(3)}</b></span>
        <span>辩论 <b>{agg.mean_brier.judge.toFixed(3)}</b></span>
      </div>
      <div className="kv">
        <span>让球穿盘率</span><b>{pct(agg.cover_rate)}</b>
        <span>realized ROI</span><b style={{ color: agg.realized_roi >= 0 ? 'var(--cyan)' : 'var(--rose, #f43f5e)' }}>{agg.realized_roi >= 0 ? '+' : ''}{(agg.realized_roi * 100).toFixed(1)}%</b>
      </div>
      {agg.calibration_bins?.length > 0 && (
        <div className="kv" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <span className="hint">校准曲线(预测概率 vs 实际命中)</span>
          {agg.calibration_bins.map((bin: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <span style={{ width: 70 }}>{pct(bin.p_lo)}–{pct(bin.p_hi)}</span>
              <span>预测 {pct(bin.predicted)}</span>
              <span>实际 {pct(bin.observed)}</span>
              <span className="hint">n={bin.n}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint" style={{ marginTop: 8 }}>数学管地板 · 模型管洞察 · 人管拍板。每场赛果由 owlcoda 智能体抓取、人一键确认,记分卡为确定性计算。CLV 在无收盘线时如实标 n/a。</p>
    </div>
  )
}
