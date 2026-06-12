import type { Role } from '../api'
import type { RoleState } from './debateTypes'

const ROLE_TITLE: Record<Role, string> = { pro: 'Pro · 机会侦察', anti: 'Anti · 风控审计', judge: 'Judge · 裁决' }

function List({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null
  return (
    <>
      <div className="section-label">{label}</div>
      <ul className="point-list">
        {items.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </>
  )
}

export function RoleColumn({ role, state }: { role: Role; state: RoleState }) {
  const o = state.output
  return (
    <div className={`card role-col role-${role}`}>
      <div className="role-head">
        <span className="role-dot" />
        <b>{ROLE_TITLE[role]}</b>
        {state.model && <span className="model-badge">{state.model}</span>}
      </div>

      {state.status === 'idle' && <div className="hint">等待执行</div>}
      {state.status === 'running' && <div className="stream-raw">{state.raw || '…'}</div>}
      {state.status === 'error' && <div style={{ color: 'var(--anti)' }}>角色执行失败</div>}

      {state.status === 'done' && o && (
        <div>
          <div className="kv">
            <span>verdict: <b>{o.verdict}</b></span>
            {o.market && <span>market: <b>{o.market}</b></span>}
            <span>confidence: <b>{o.confidence}</b></span>
            <span>data: <b>{o.data_quality}</b></span>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{o.summary}</div>
          {role === 'judge' ? (
            <>
              <List label="采纳 Pro" items={o.accepted_pro_points} />
              <List label="采纳 Anti" items={o.accepted_anti_points} />
              <List label="驳回" items={o.rejected_points} />
              <List label="最终风险" items={o.final_risks} />
              {o.anti_direction_case && (
                <>
                  <div className="section-label">最强反方向路径</div>
                  <div style={{ fontSize: 13 }}>{o.anti_direction_case}</div>
                </>
              )}
            </>
          ) : (
            <>
              <List label="核心论点" items={o.core_points} />
              {role === 'anti' && <List label="逐条反驳 Pro" items={o.counter_to_pro} />}
              <List label="自报风险" items={o.risks} />
            </>
          )}
          {o.data_gaps?.length > 0 && (
            <>
              <div className="section-label">Data Gaps</div>
              <div>
                {o.data_gaps.map((g: string, i: number) => (
                  <span key={i} className="gap-tag">{g}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {state.status === 'done' && !o && (
        <div>
          <div style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 6 }}>⚠ 输出未能解析为结构化 JSON,以下为原文(unstructured)</div>
          <div className="stream-raw">{state.raw}</div>
        </div>
      )}
    </div>
  )
}
