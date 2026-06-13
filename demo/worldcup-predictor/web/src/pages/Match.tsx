import { useEffect, useRef, useState } from 'react'
import {
  autoAssignRoles,
  autoPickVisionModel,
  explainError,
  fetchCapabilities,
  fetchModels,
  fetchRunDetail,
  fetchRuns,
  fetchShowcase,
  fetchTeams,
  finalizeRun,
  loadSettings,
  saveDecision,
  saveSettings,
  streamAnalyze,
  type Fixture,
  type Role,
  type SeatRole,
  type Settings,
  type TeamProfile,
} from '../api'
import { EnginePanel } from '../components/EnginePanel'
import { RoleColumn } from '../components/RoleColumn'
import { PredictionCard } from '../components/PredictionCard'
import { initialRoleStates, type DimensionStatus, type RoleState } from '../components/debateTypes'

async function fileToBase64(file: File): Promise<{ name: string; mediaType: string; base64: string }> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return { name: file.name, mediaType: file.type || 'image/png', base64: btoa(binary) }
}

export function MatchPage({ fixture }: { fixture: Fixture | null }) {
  const [teams, setTeams] = useState<TeamProfile[]>([])
  const [roleStates, setRoleStates] = useState<Record<SeatRole, RoleState>>(initialRoleStates)
  const [activeRole, setActiveRole] = useState<SeatRole | null>(null)
  const [fallbacks, setFallbacks] = useState<Array<{ role: Role; from: string; to: string }>>([])
  const [manifest, setManifest] = useState<any>(null)
  const [dimensions, setDimensions] = useState<DimensionStatus[]>([])
  const [running, setRunning] = useState(false)
  const [replay, setReplay] = useState(false)
  const [error, setError] = useState('')
  const [humanDecision, setHumanDecision] = useState<any>(null)
  const [inputs, setInputs] = useState({ recentForm: '', injuriesNews: '', oddsText: '', extraNotes: '' })
  const [images, setImages] = useState<Array<{ name: string; mediaType: string; base64: string }>>([])
  const [dragOver, setDragOver] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [models, setModels] = useState<Array<{ id: string; display_name?: string }>>([])
  const [caps, setCaps] = useState<Record<string, { vision: boolean | null }>>({})
  const [sources, setSources] = useState<Array<{ title: string; url: string }>>([])
  const [history, setHistory] = useState<Array<{ stamp: string; manifest: any; judge: any }>>([])
  const [loadedStamp, setLoadedStamp] = useState<string | null>(null)
  const [humanNote, setHumanNote] = useState('')
  const [finalOutput, setFinalOutput] = useState<any>(null)
  const [finalPro, setFinalPro] = useState<any>(null)
  const [finalAnti, setFinalAnti] = useState<any>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [finalError, setFinalError] = useState('')

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => {})
    fetchModels(loadSettings().owlcodaBaseUrl)
      .then((m) => {
        setModels(m.models)
        if (m.models.length > 0) {
          setSettings((s) => {
            const ids = m.models.map((x) => x.id)
            const next = { ...s, roles: autoAssignRoles(ids, s.roles), visionModel: autoPickVisionModel(ids, s.visionModel) }
            saveSettings(next)
            return next
          })
        }
      })
      .catch(() => {})
    fetchCapabilities(loadSettings().owlcodaBaseUrl).then(setCaps).catch(() => {})
  }, [])

  useEffect(() => {
    if (fixture) fetchRuns(fixture.match_id).then(setHistory).catch(() => setHistory([]))
  }, [fixture?.match_id, running])

  function capBadge(id: string): string {
    const v = caps[id]?.vision
    return v === true ? ' 👁' : v === false ? ' ⛔图' : ''
  }

  function updateSettings(patch: Partial<Settings>) {
    setSettings((s) => {
      const next = { ...s, ...patch }
      saveSettings(next)
      return next
    })
  }
  function setRoleModel(role: Role, model: string) {
    updateSettings({ roles: { ...settings.roles, [role]: { ...settings.roles[role], model } } })
  }

  async function addImageFiles(files: File[]) {
    const fresh = await Promise.all(files.filter((f) => f.type.startsWith('image/')).map(fileToBase64))
    setImages((prev) => {
      const seen = new Set(prev.map((i) => i.name + i.base64.length))
      return [...prev, ...fresh.filter((i) => !seen.has(i.name + i.base64.length))]
    })
  }
  useEffect(() => {
    setRoleStates(initialRoleStates())
    setManifest(null)
    setFallbacks([])
    setError('')
    setReplay(false)
    setLoadedStamp(null)
    setHumanNote('')
    setFinalOutput(null)
    setFinalPro(null)
    setFinalAnti(null)
    setFinalError('')
    setSources([])
  }, [fixture?.match_id])

  if (!fixture) return <div className="card">从「赛程」页选择一场比赛开始分析。</div>

  const home = teams.find((t) => t.team_name === fixture.home_team)
  const away = teams.find((t) => t.team_name === fixture.away_team)

  function applyEvent(e: any) {
    if (e.type === 'run_start') setDimensions(e.dimensions)
    else if (e.type === 'role_start') {
      setActiveRole(e.role)
      setRoleStates((s) => ({
        ...s,
        [e.role]: { ...s[e.role as SeatRole], status: 'running', model: e.model, raw: '', charCount: 0, startedAt: Date.now() },
      }))
    } else if (e.type === 'token_delta') {
      setRoleStates((s) => ({
        ...s,
        [e.role]: {
          ...s[e.role as Role],
          raw: s[e.role as SeatRole].raw + e.text,
          charCount: s[e.role as SeatRole].charCount + e.text.length,
        },
      }))
    } else if (e.type === 'role_fallback') {
      setFallbacks((f) => [...f, { role: e.role, from: e.from, to: e.to }])
    } else if (e.type === 'role_done') {
      setRoleStates((s) => ({
        ...s,
        [e.role]: { ...s[e.role as SeatRole], status: 'done', output: e.output, raw: e.raw, durationMs: e.manifest.durationMs },
      }))
    } else if (e.type === 'role_error') {
      setRoleStates((s) => ({ ...s, [e.role]: { ...s[e.role as SeatRole], status: 'error' } }))
    } else if (e.type === 'recon_sources') {
      setSources(e.sources ?? [])
    } else if (e.type === 'manifest') {
      setManifest(e)
    } else if (e.type === 'error') {
      setError(e.error)
    }
  }

  async function run() {
    if (!fixture) return
    setRunning(true)
    setReplay(false)
    setError('')
    setFallbacks([])
    setManifest(null)
    setSources([])
    setLoadedStamp(null)
    setFinalOutput(null)
    setFinalPro(null)
    setFinalAnti(null)
    setFinalError('')
    setRoleStates(initialRoleStates())
    const roles = settings.singleModel
      ? { pro: settings.roles.pro, anti: settings.roles.pro, judge: settings.roles.pro }
      : settings.roles
    abortRef.current = new AbortController()
    try {
      await streamAnalyze(
        {
          matchId: fixture.match_id,
          homeTeam: fixture.home_team,
          awayTeam: fixture.away_team,
          owlcodaBaseUrl: settings.owlcodaBaseUrl,
          singleModel: settings.singleModel,
          roles,
          visionModel: settings.visionModel,
          webRecon: settings.webRecon,
          reconModel: settings.reconModel || settings.roles.judge.model || settings.roles.pro.model,
          inputs: { ...inputs, images },
        },
        applyEvent,
        abortRef.current.signal,
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setActiveRole(null)
      setRunning(false)
    }
  }

  async function playShowcase() {
    if (!fixture?.showcase_id || running) return
    setRunning(true)
    setReplay(true)
    setError('')
    setFallbacks([])
    setManifest(null)
    setRoleStates(initialRoleStates())
    const pkg = await fetchShowcase(fixture.showcase_id)
    setHumanDecision(pkg.human_decision ?? null)
    const rolesData: Array<[Role, any]> = [['pro', pkg.pro], ['anti', pkg.anti], ['judge', pkg.judge]]
    const modelOf = (role: Role) => pkg.run_manifest?.roles?.[role]?.model ?? pkg[`${role}_meta`]?.model ?? '线上模型'
    for (const [role, output] of rolesData) {
      setActiveRole(role)
      setRoleStates((s) => ({ ...s, [role]: { ...s[role], status: 'running', model: modelOf(role), startedAt: Date.now() } }))
      // Timeline replay: stream the real summary text chunk by chunk.
      const text = output?.summary ?? ''
      for (let i = 0; i < text.length; i += 6) {
        applyEvent({ type: 'token_delta', role, text: text.slice(i, i + 6) })
        await new Promise((r) => setTimeout(r, 24))
      }
      applyEvent({
        type: 'role_done',
        role,
        output,
        raw: JSON.stringify(output),
        manifest: { role, model: modelOf(role), durationMs: 800, fallbackUsed: false, parsed: true },
      })
    }
    setActiveRole(null)
    setManifest({
      type: 'manifest',
      roles: rolesData.map(([role]) => ({ role, model: modelOf(role), durationMs: 0, fallbackUsed: false })),
      totalMs: 0,
    })
    setRunning(false)
  }

  async function finalize() {
    if (!fixture) return
    setFinalizing(true)
    setFinalError('')
    try {
      const res = await finalizeRun({
        matchId: fixture.match_id,
        stamp: loadedStamp ?? undefined,
        humanNote,
        model: settings.roles.judge.model || settings.roles.pro.model,
        models: {
          pro: settings.roles.pro.model,
          anti: settings.roles.anti.model,
          judge: settings.roles.judge.model,
        },
        owlcodaBaseUrl: settings.owlcodaBaseUrl,
      })
      if (res.final) {
        setFinalOutput(res.final)
        setFinalPro(res.final_pro ?? null)
        setFinalAnti(res.final_anti ?? null)
        saveDecision(fixture.match_id, res.final.selection ?? res.final.verdict, res.final.summary)
      } else {
        setFinalError(res.error ?? '收口失败')
      }
    } catch (err) {
      setFinalError(String(err))
    } finally {
      setFinalizing(false)
    }
  }

  async function loadRun(stamp: string) {
    if (!fixture) return
    const d = await fetchRunDetail(fixture.match_id, stamp)
    if (d.error) return
    setReplay(false)
    setError('')
    setFallbacks([])
    setLoadedStamp(stamp)
    setSources(Array.isArray(d.recon_sources) ? d.recon_sources : [])
    setFinalOutput(d.final ?? null)
    setFinalPro(d.final_pro ?? null)
    setFinalAnti(d.final_anti ?? null)
    setHumanNote(d.human_note ?? '')
    const mk = (output: any, raw?: string | null): RoleState => ({
      status: output || raw ? 'done' : 'idle',
      model: '',
      raw: raw ?? (output ? JSON.stringify(output) : ''),
      output: typeof output === 'string' ? null : output,
      charCount: 0,
      startedAt: null,
      durationMs: null,
    })
    const states = initialRoleStates()
    states.pro = mk(d.pro)
    states.anti = mk(d.anti)
    states.judge = mk(d.judge)
    states.vision = mk(null, d.vision_transcript)
    states.recon = mk(null, d.recon_brief)
    // models from manifest
    for (const r of d.manifest?.roles ?? []) {
      if (states[r.role as SeatRole]) states[r.role as SeatRole].model = r.model
    }
    setRoleStates(states)
    setManifest(d.manifest ? { type: 'manifest', roles: d.manifest.roles, totalMs: d.manifest.total_ms ?? 0 } : null)
    setDimensions([])
  }

  const judgeDone = roleStates.judge.status === 'done' && roleStates.judge.output

  return (
    <div className="match-layout">
      {/* left: evidence inputs */}
      <div className="card inputs">
        <h3>
          {fixture.home_team} vs {fixture.away_team}
        </h3>
        <p className="hint" style={{ marginTop: 0 }}>
          {fixture.competition_stage_label} · {fixture.group} · {fixture.venue}
          <br />北京时间 {fixture.match_datetime_bjt ?? 'TBD'}
        </p>
        <p className="hint">
          画像: {home ? `✅ ${home.name_zh ?? home.team_name}` : '❌'} / {away ? `✅ ${away.name_zh ?? away.team_name}` : '❌'}(内置 FIFA 官方数据,自动注入证据包)
        </p>
        <label>近期状态(可选)</label>
        <textarea value={inputs.recentForm} onChange={(e) => setInputs({ ...inputs, recentForm: e.target.value })} placeholder="例:墨西哥近5场 3胜2平…" />
        <label>伤停与新闻(可选)</label>
        <textarea value={inputs.injuriesNews} onChange={(e) => setInputs({ ...inputs, injuriesNews: e.target.value })} placeholder="例:主力中卫伤缺;首发已确认…" />
        <label>赔率/盘口(可选;不填则该维度按 unsupported 处理,模型被禁止编造)</label>
        <textarea value={inputs.oddsText} onChange={(e) => setInputs({ ...inputs, oddsText: e.target.value })} placeholder="例:主胜1.40 平4.50 客8.50;亚盘 -1.25…" />
        <label>其他备注(可选)</label>
        <textarea value={inputs.extraNotes} onChange={(e) => setInputs({ ...inputs, extraNotes: e.target.value })} />
        <label>图片证据(赔率截图等,可多张;需所选模型支持视觉)</label>
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void addImageFiles(Array.from(e.dataTransfer.files))
          }}
          onClick={() => document.getElementById('wc26-file-input')?.click()}
        >
          <input
            id="wc26-file-input"
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={async (e) => {
              await addImageFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          {images.length === 0 ? (
            <span className="dz-hint">📷 点击或拖拽图片到这里(支持多张)</span>
          ) : (
            <div className="thumb-grid" onClick={(e) => e.stopPropagation()}>
              {images.map((img, i) => (
                <div key={i} className="thumb">
                  <img src={`data:${img.mediaType};base64,${img.base64}`} alt={img.name} />
                  <button
                    className="thumb-x"
                    title={img.name}
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="thumb add" onClick={() => document.getElementById('wc26-file-input')?.click()}>
                +
              </div>
            </div>
          )}
        </div>

        {images.length > 0 && (
          <div className={`role-pick-row role-vision ${!settings.visionModel ? 'warn' : ''}`}>
            <span className="role-dot" style={{ background: 'var(--cyan)', boxShadow: '0 0 7px var(--cyan)' }} />
            <span className="rp-name">👁 图片识别</span>
            <select
              value={settings.visionModel ?? ''}
              onChange={(e) => updateSettings({ visionModel: e.target.value || undefined })}
            >
              <option value="">未配置(图片将不可读)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{(m.display_name ?? m.id) + capBadge(m.id)}</option>
              ))}
            </select>
          </div>
        )}
        {images.length > 0 && !settings.visionModel && (
          <p className="hint" style={{ color: 'var(--warn)', margin: '2px 0 6px' }}>
            未配置多模态识别模型,截图内容不会进入证据包——选择带视觉能力的模型(如 omni/vl 系)。
          </p>
        )}
        {images.length > 0 && settings.visionModel && caps[settings.visionModel]?.vision === false && (
          <p className="hint" style={{ color: 'var(--warn)', margin: '2px 0 6px' }}>
            ⛔ 能力探测显示 {settings.visionModel} 不支持图片输入,识别会失败——换带 👁 徽标的模型。
          </p>
        )}
        {images.length > 0 && roleStates.vision.raw && (
          <details style={{ marginBottom: 8 }}>
            <summary className="hint" style={{ cursor: 'pointer' }}>
              图片转录结果({roleStates.vision.model},{roleStates.vision.status === 'running' ? '识别中…' : '已入证据包'})
            </summary>
            <div className="stream-raw" style={{ marginTop: 6 }}>{roleStates.vision.raw}</div>
          </details>
        )}

        <label>联网侦查(实验 · owlcoda agent 用 WebSearch 抓赛前情报,带来源)</label>
        <div className="role-pick-row role-recon">
          <input
            type="checkbox"
            checked={!!settings.webRecon}
            onChange={(e) => updateSettings({ webRecon: e.target.checked })}
          />
          <span className="rp-name">🔍 赛前侦查</span>
          <select
            value={settings.reconModel ?? ''}
            disabled={!settings.webRecon}
            onChange={(e) => updateSettings({ reconModel: e.target.value || undefined })}
          >
            <option value="">默认(裁决模型)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name ?? m.id}</option>
            ))}
          </select>
        </div>
        {roleStates.recon.raw && (
          <details style={{ marginBottom: 8 }}>
            <summary className="hint" style={{ cursor: 'pointer' }}>
              侦查情报({roleStates.recon.model},{roleStates.recon.status === 'running' ? '检索中…' : '已入证据包'})
            </summary>
            <div className="stream-raw" style={{ marginTop: 6 }}>{roleStates.recon.raw.slice(0, 4000)}</div>
          </details>
        )}

        <label>角色模型(谁侦查 · 谁风控 · 谁裁决)</label>
        <div className="role-pick">
          <button
            className={`chip ${!settings.singleModel ? 'on' : ''}`}
            onClick={() => updateSettings({ singleModel: false, modeChosen: true })}
          >
            多模型
          </button>
          <button
            className={`chip ${settings.singleModel ? 'on' : ''}`}
            onClick={() => updateSettings({ singleModel: true, modeChosen: true })}
          >
            单模型
          </button>
        </div>
        {(['pro', 'anti', 'judge'] as Role[]).map((role) => (
          <div key={role} className={`role-pick-row role-${role}`} style={settings.singleModel && role !== 'pro' ? { opacity: 0.4 } : undefined}>
            <span className="role-dot" />
            <span className="rp-name">{{ pro: 'Pro 侦查', anti: 'Anti 风控', judge: 'Judge 裁决' }[role]}</span>
            <select
              value={settings.roles[role].model}
              disabled={settings.singleModel && role !== 'pro'}
              onChange={(e) => setRoleModel(role, e.target.value)}
            >
              <option value="">未选择</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{(m.display_name ?? m.id) + capBadge(m.id)}</option>
              ))}
            </select>
          </div>
        ))}
        {settings.singleModel && <p className="hint" style={{ margin: '4px 0 0' }}>单模型模式:Pro 槽位的模型轮演三个角色。</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn" disabled={running || !settings.roles.pro.model} onClick={() => void run()}>
            {running ? '辩论进行中…' : '开始三角辩论'}
          </button>
          {fixture.showcase_id && (
            <button className="btn ghost" disabled={running} onClick={() => void playShowcase()}>
              回放线上示例
            </button>
          )}
        </div>
        {!settings.roles.pro.model && <p className="hint" style={{ color: 'var(--warn)' }}>未发现可用模型——请确认 owlcoda serve 已运行(设置页可检测)。</p>}
        {dimensions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="section-label">本次证据等级</div>
            {dimensions.map((d) => (
              <div key={d.dimension} className="hint">
                {d.dimension}: <b style={{ color: d.status === 'supported' ? 'var(--pro)' : d.status === 'unsupported' ? 'var(--anti)' : 'var(--warn)' }}>{d.status}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* middle: debate columns + prediction */}
      <div>
        {error && (() => { const ex = explainError(error); return (
          <div className="card" style={{ borderColor: 'var(--anti)', marginBottom: 10 }}>
            ❌ {ex.headline}
            <details style={{ marginTop: 6 }}>
              <summary className="hint" style={{ cursor: 'pointer' }}>原始错误</summary>
              <div className="stream-raw">{ex.detail}</div>
            </details>
          </div>
        ) })()}
        {/* verdict first: the prediction is the headline, the debate is the receipts */}
        {judgeDone && (
          <div style={{ marginBottom: 10 }}>
            <PredictionCard judge={roleStates.judge.output} home={fixture.home_team} away={fixture.away_team} />
          </div>
        )}
        {sources.length > 0 && (
          <div className="card" style={{ marginBottom: 10 }}>
            <h3>🔍 侦查来源(owlcoda agent WebSearch,已入证据包)</h3>
            <ul className="point-list">
              {sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>{s.title}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="debate-cols">
          {(['pro', 'anti', 'judge'] as Role[]).map((role) => (
            <RoleColumn key={role} role={role} state={roleStates[role]} />
          ))}
        </div>
        {history.length > 0 && (
          <div className="card" style={{ marginTop: 10 }}>
            <h3>历史分析存档({history.length} 次,data/runs/,含全部原始资料)</h3>
            {loadedStamp && (
              <p className="hint" style={{ color: 'var(--cyan)' }}>
                已加载 {loadedStamp} 的完整存档(证据包/侦查/转录/三方观点/收口)到上方界面。
              </p>
            )}
            {history.map((h) => (
              <div key={h.stamp} style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <button
                  className="btn ghost"
                  style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                  onClick={() => void loadRun(h.stamp)}
                >
                  {loadedStamp === h.stamp ? '已加载' : '加载'}
                </button>
                <span className="hint">
                  {h.stamp.replace(/T/, ' ').replace(/-(\d\d)-(\d\d\d)Z$/, ':$1')} —{' '}
                  {h.judge?.directional_pick ?? '?'} · 方向分 {h.judge?.directional_score ?? '?'} · {h.judge?.bet_grade ?? '?'}
                  {' '}({(h.manifest?.roles ?? []).map((r: any) => r.model).join(' / ')})
                </span>
              </div>
            ))}
          </div>
        )}
        {replay && humanDecision && judgeDone && (
          <div className="card" style={{ marginTop: 10, borderColor: 'var(--owl)' }}>
            <h3>主理人实战拍板({humanDecision.decided_at})— 人工拍板门示范</h3>
            <p style={{ margin: '4px 0', fontSize: 14 }}>
              <b style={{ color: 'var(--owl)' }}>{humanDecision.decision}</b>
              {humanDecision.scoreline_lean && <> · 比分倾向 {humanDecision.scoreline_lean}</>}
            </p>
            <p className="hint" style={{ margin: '4px 0' }}>{humanDecision.rationale}</p>
            {humanDecision.risks && <p className="hint" style={{ margin: '4px 0' }}>风险: {humanDecision.risks}</p>}
            <p className="hint" style={{ margin: '4px 0' }}>当轮排序: {humanDecision.ranking}</p>
          </div>
        )}
        {judgeDone && !replay && (
          <div className="card" style={{ marginTop: 10, borderColor: 'var(--owl)' }}>
            <h3>你的拍板(辩论包不是最终结论,这一步才是)</h3>
            {!finalOutput && (
              <>
                <textarea
                  className="final-note"
                  value={humanNote}
                  onChange={(e) => setHumanNote(e.target.value)}
                  placeholder="补充你的判断(可留空)。例:亚盘并非单源,Judge 该降权点应上修;我看 -1.25,比分 2-0/3-0…"
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <button className="btn" disabled={finalizing} onClick={() => void finalize()}>
                    {finalizing ? '终辩进行中…(Pro 检验 → Anti 审计 → 终审)' : humanNote.trim() ? '把我的意见交给战队终辩' : '复核并收口'}
                  </button>
                  <span className="hint">你的意见会被当作待检验输入再辩一轮——模型可以反对你;终审给出采纳/部分采纳/驳回</span>
                </div>
                {finalError && <p className="hint" style={{ color: 'var(--anti)' }}>{finalError}</p>}
              </>
            )}
            {finalOutput && (
              <div>
                {finalOutput.stance_on_human && (
                  <p style={{ margin: '0 0 8px', fontSize: 14 }}>
                    对主理人意见的终审: <b style={{ color: finalOutput.stance_on_human === 'adopt' ? 'var(--pro)' : finalOutput.stance_on_human === 'reject' ? 'var(--anti)' : 'var(--warn)' }}>
                      {{ adopt: '采纳', partial: '部分采纳', reject: '驳回' }[finalOutput.stance_on_human as string] ?? finalOutput.stance_on_human}
                    </b>
                    {finalOutput.stance_rationale && <span className="hint" style={{ display: 'block', marginTop: 4 }}>{finalOutput.stance_rationale}</span>}
                  </p>
                )}
                <div className="kv">
                  <span>最终: <b style={{ color: 'var(--owl)' }}>{finalOutput.selection}</b></span>
                  <span>verdict: <b>{finalOutput.verdict}</b></span>
                  {finalOutput.scoreline_lean && <span>比分: <b>{finalOutput.scoreline_lean}</b></span>}
                </div>
                {finalOutput.win_probabilities && (
                  <div className="kv">
                    胜平负: <b>{Math.round(finalOutput.win_probabilities.home * 100)}%</b> /{' '}
                    <b>{Math.round(finalOutput.win_probabilities.draw * 100)}%</b> /{' '}
                    <b>{Math.round(finalOutput.win_probabilities.away * 100)}%</b>
                  </div>
                )}
                <p style={{ fontSize: 13.5, lineHeight: 1.7, margin: '6px 0' }}>{finalOutput.summary}</p>
                {finalOutput.ranking_note && <p className="hint" style={{ margin: '4px 0' }}>{finalOutput.ranking_note}</p>}
                {finalPro && (
                  <details style={{ margin: '6px 0' }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>终辩 · Pro 检验({{ support: '支持', partial: '部分支持', oppose: '反对' }[finalPro.stance_on_human as string] ?? finalPro.stance_on_human ?? '—'})</summary>
                    <p className="hint" style={{ margin: '6px 0 0' }}>{finalPro.argument}</p>
                  </details>
                )}
                {finalAnti && (
                  <details style={{ margin: '6px 0' }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>终辩 · Anti 审计({{ support: '支持', partial: '部分支持', oppose: '反对' }[finalAnti.stance_on_human as string] ?? finalAnti.stance_on_human ?? '—'})</summary>
                    <p className="hint" style={{ margin: '6px 0 0' }}>{finalAnti.argument}</p>
                    {Array.isArray(finalAnti.veto_triggers) && finalAnti.veto_triggers.length > 0 && (
                      <p className="hint" style={{ margin: '4px 0 0', color: 'var(--warn)' }}>否决性风险: {finalAnti.veto_triggers.join(';')}</p>
                    )}
                  </details>
                )}
                <button className="btn ghost" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }} onClick={() => { setFinalOutput(null); setFinalError('') }}>
                  重新终辩
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* right: engine panel */}
      <EnginePanel
        roleStates={roleStates}
        activeRole={activeRole}
        fallbacks={fallbacks}
        manifest={manifest}
        owlcodaBase={settings.owlcodaBaseUrl}
        replay={replay}
      />
    </div>
  )
}
