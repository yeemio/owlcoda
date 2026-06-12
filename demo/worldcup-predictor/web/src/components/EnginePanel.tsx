import { useEffect, useState } from 'react'
import { fetchHealth, fetchModels, type Role, type SeatRole } from '../api'
import { useT } from '../i18n'
import type { RoleState } from './debateTypes'

const ROLE_COLOR: Record<SeatRole, string> = { recon: 'var(--owl)', vision: 'var(--cyan)', pro: 'var(--pro)', anti: 'var(--anti)', judge: 'var(--judge)' }
const ROLE_HEX: Record<SeatRole, string> = { recon: '#7c5cff', vision: '#2dd6c1', pro: '#38b26a', anti: '#e05568', judge: '#d9a13b' }

function FlowDiagram({ activeRole, roleModels }: { activeRole: SeatRole | null; roleModels: Record<Role, string> }) {
  const t = useT()
  const models: Array<{ role: Role; label: string; y: number }> = (['pro', 'anti', 'judge'] as Role[]).map(
    (role, i) => ({ role, label: roleModels[role] || '—', y: 24 + i * 44 }),
  )
  const live = activeRole != null
  return (
    <svg className="flow-svg" viewBox="0 0 300 160">
      <defs>
        <radialGradient id="owlGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#7c5cff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="linkGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#2dd6c1" />
          <stop offset="100%" stopColor="#7c5cff" />
        </linearGradient>
        <pattern id="grid" width="14" height="14" patternUnits="userSpaceOnUse">
          <path d="M14 0H0V14" fill="none" stroke="rgba(124,92,255,0.08)" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="300" height="160" fill="url(#grid)" rx="8" />
      <rect className="scanline" x="0" y="0" width="300" height="3" fill="rgba(45,214,193,0.25)" rx="1.5" />

      {/* browser + demo nodes */}
      {[
        { x: 6, y: 62, w: 52, label: t('browser') },
        { x: 70, y: 62, w: 48, label: 'Demo' },
      ].map((n) => (
        <g key={n.label}>
          <rect className={`node-box ${live ? 'active' : ''}`} x={n.x} y={n.y} width={n.w} height={26} rx={7} />
          <text className="node-label" x={n.x + n.w / 2} y={n.y + 16} textAnchor="middle">{n.label}</text>
        </g>
      ))}

      {/* owlcoda core: pulsing rings */}
      <g>
        {live && (
          <>
            <circle cx={158} cy={75} r={26} fill="url(#owlGlow)" />
            <circle className="radar-ring" cx={158} cy={75} r={14} />
            <circle className="radar-ring r2" cx={158} cy={75} r={14} />
          </>
        )}
        <circle cx={158} cy={75} r={17} fill="var(--bg-2)" stroke={live ? '#7c5cff' : 'rgba(255,255,255,0.2)'} strokeWidth={live ? 2 : 1} />
        <text x={158} y={72} textAnchor="middle" style={{ fontSize: 8.5, fontWeight: 700 }} fill="#cdd3e0">Owl</text>
        <text x={158} y={82} textAnchor="middle" style={{ fontSize: 8.5, fontWeight: 700 }} fill="#7c5cff">Coda</text>
      </g>

      <line className={`link-line ${live ? 'flowing' : ''}`} x1={58} y1={75} x2={70} y2={75} stroke="url(#linkGrad)" />
      <line className={`link-line ${live ? 'flowing' : ''}`} x1={118} y1={75} x2={141} y2={75} stroke="url(#linkGrad)" />

      {models.map((m) => {
        const on = activeRole === m.role
        return (
          <g key={m.role} opacity={activeRole && !on ? 0.4 : 1}>
            <path
              className={`link-line ${on ? 'flowing' : ''}`}
              d={`M175,75 C 205,75 205,${m.y + 13} 232,${m.y + 13}`}
              fill="none"
              stroke={on ? ROLE_HEX[m.role] : 'rgba(255,255,255,0.13)'}
              strokeWidth={on ? 2 : 1.2}
            />
            <rect
              className={`node-box ${on ? 'active' : ''}`}
              x={232} y={m.y} width={62} height={27} rx={7}
              style={on ? { stroke: ROLE_HEX[m.role], filter: `drop-shadow(0 0 7px ${ROLE_HEX[m.role]})` } : undefined}
            />
            <text className="node-label" x={263} y={m.y + 11} textAnchor="middle" style={{ fontWeight: 700 }}>
              {m.role.toUpperCase()}
            </text>
            <text className="node-label" x={263} y={m.y + 21} textAnchor="middle" style={{ fontSize: 6.5 }}>
              {m.label.slice(0, 16)}
            </text>
            {on &&
              [0, 0.4, 0.8].map((delay) => (
                <circle key={delay} r={2.6} fill={ROLE_HEX[m.role]} style={{ filter: `drop-shadow(0 0 4px ${ROLE_HEX[m.role]})` }}>
                  <animateMotion
                    dur="1.3s"
                    begin={`${delay}s`}
                    repeatCount="indefinite"
                    path={`M32,75 L118,75 L158,75 C 200,75 200,${m.y + 13} 232,${m.y + 13}`}
                  />
                </circle>
              ))}
          </g>
        )
      })}
      <text className="node-label" x={150} y={154} textAnchor="middle" style={{ fontSize: 8.5 }}>
        {t('flowFooter')}
      </text>
    </svg>
  )
}

function Seat({ role, state }: { role: SeatRole; state: RoleState }) {
  const t = useT()
  const [, force] = useState(0)
  useEffect(() => {
    if (state.status !== 'running') return
    const timer = setInterval(() => force((x) => x + 1), 250)
    return () => clearInterval(timer)
  }, [state.status])
  const elapsed = state.startedAt
    ? ((state.durationMs ?? Date.now() - state.startedAt) / 1000).toFixed(1)
    : '—'
  const statusLabel = {
    idle: t('statusIdle'),
    running: t('statusRunning'),
    done: t('statusDone'),
    error: t('statusError'),
  }[state.status]
  return (
    <div className={`seat ${state.status === 'running' ? 'running' : ''} ${state.status === 'done' ? 'finished' : ''}`}>
      <span className="role-dot" style={{ background: ROLE_COLOR[role], boxShadow: `0 0 8px ${ROLE_COLOR[role]}` }} />
      <b style={{ fontSize: 13 }}>{role === 'vision' ? '👁 VL' : role === 'recon' ? '🔍 RECON' : role.toUpperCase()}</b>
      <span className="model-badge">{state.model || '—'}</span>
      <span className="status">{statusLabel}</span>
      <span className="timer">{elapsed}s</span>
      <span className="tokens">{state.charCount > 0 ? `${state.charCount} ch` : ''}</span>
      {state.status === 'running' && <span className="seat-shimmer" />}
    </div>
  )
}

export function EnginePanel({
  roleStates,
  activeRole,
  fallbacks,
  manifest,
  owlcodaBase,
  replay,
}: {
  roleStates: Record<SeatRole, RoleState>
  activeRole: SeatRole | null
  fallbacks: Array<{ role: SeatRole; from: string; to: string }>
  manifest: { roles: Array<{ role: Role; model: string; outputTokens?: number; durationMs: number; fallbackUsed: boolean }>; totalMs: number } | null
  owlcodaBase: string
  replay: boolean
}) {
  const t = useT()
  const [health, setHealth] = useState<boolean | null>(null)
  const [models, setModels] = useState<Array<{ id: string; tier?: string }>>([])
  const [showCode, setShowCode] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      const [h, m] = await Promise.all([fetchHealth(owlcodaBase), fetchModels(owlcodaBase)])
      if (!alive) return
      setHealth(h.ok)
      setModels(m.models)
    }
    void poll()
    const timer = setInterval(poll, 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [owlcodaBase])

  const roleModels = { pro: roleStates.pro.model, anti: roleStates.anti.model, judge: roleStates.judge.model }
  const live = activeRole != null

  return (
    <aside className="engine">
      <div className={`card engine-card ${live ? 'live' : ''}`}>
        {replay && <span className="replay-mark">{t('replayMark')}</span>}
        <h3>
          <span className={`pulse ${live ? 'on' : ''}`}>◉</span> {t('engineTitle')}
        </h3>
        <FlowDiagram activeRole={activeRole} roleModels={roleModels} />
      </div>

      <div className={`card engine-card ${live ? 'live' : ''}`}>
        <h3>{t('battleSeats')}</h3>
        {fallbacks.map((f, i) => (
          <div key={i} className="fallback-flash">
            ⚡ {f.role.toUpperCase()} {t('fallbackFlash', { from: f.from, to: f.to })}
          </div>
        ))}
        {(['recon', 'vision', 'pro', 'anti', 'judge'] as SeatRole[])
          .filter((role) => (role !== 'vision' && role !== 'recon') || roleStates[role].status !== 'idle')
          .map((role) => (
            <Seat key={role} role={role} state={roleStates[role]} />
          ))}
      </div>

      <div className="card engine-card">
        <h3>{t('modelHealth')}</h3>
        <div className="health-row">
          <span className={`hb ${health === true ? 'ok' : health === false ? 'bad' : ''}`} />
          proxy {owlcodaBase} {health === false && t('proxyOffline')}
        </div>
        {models.map((m) => (
          <div key={m.id} className="health-row">
            <span className={`hb ${health ? 'ok' : 'bad'}`} /> {m.id} {m.tier && <span className="tier">{m.tier}</span>}
          </div>
        ))}
      </div>

      {manifest && (
        <div className="card engine-card manifest-reveal">
          <h3>{t('runManifest')}</h3>
          <table className="manifest-table">
            <tbody>
              {manifest.roles.map((r) => (
                <tr key={r.role}>
                  <td>{r.role.toUpperCase()}</td>
                  <td>{r.model}{r.fallbackUsed ? ' (fallback)' : ''}</td>
                  <td>{r.outputTokens != null ? `${r.outputTokens} tok` : '—'}</td>
                  <td>{(r.durationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
              <tr>
                <td>{t('totalTime')}</td>
                <td colSpan={3}>{(manifest.totalMs / 1000).toFixed(1)}s · {t('auditHint')} <code>owlcoda audit</code></td>
              </tr>
            </tbody>
          </table>
          <button className="btn ghost" style={{ marginTop: 8, fontSize: 12, padding: '6px 10px' }} onClick={() => setShowCode(!showCode)}>
            {showCode ? t('collapse') : t('codeCard')}
          </button>
          {showCode && (
            <pre className="code-card">{`import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: '${owlcodaBase}',  // ← all you need
  apiKey: 'local',
})`}</pre>
          )}
        </div>
      )}
    </aside>
  )
}
