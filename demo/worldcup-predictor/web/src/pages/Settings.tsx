import { useEffect, useState } from 'react'
import { autoAssignRoles, fetchHealth, fetchModels, loadSettings, saveSettings, type Role, type Settings } from '../api'

const ROLE_LABEL: Record<Role, string> = { pro: 'Pro 正方', anti: 'Anti 反方', judge: 'Judge 裁判' }

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [models, setModels] = useState<Array<{ id: string; tier?: string; display_name?: string }>>([])
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [error, setError] = useState('')

  async function refresh(s: Settings = settings) {
    const [h, m] = await Promise.all([fetchHealth(s.owlcodaBaseUrl), fetchModels(s.owlcodaBaseUrl)])
    setHealthOk(h.ok)
    setModels(m.models)
    setError(m.ok ? '' : (m.error ?? ''))
    // Auto-assign roles (mimo→Pro, kimi→Anti, deepseek→Judge, else distinct).
    if (m.models.length > 0) {
      const next = { ...s, roles: autoAssignRoles(m.models.map((x) => x.id), s.roles) }
      setSettings(next)
      saveSettings(next)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update(patch: Partial<Settings>) {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
  }
  function updateRole(role: Role, key: 'model' | 'fallback', value: string) {
    const next = { ...settings, roles: { ...settings.roles, [role]: { ...settings.roles[role], [key]: value } } }
    setSettings(next)
    saveSettings(next)
  }

  return (
    <div className="settings">
      <div className="card">
        <h3>OwlCoda 连接</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={settings.owlcodaBaseUrl}
            onChange={(e) => update({ owlcodaBaseUrl: e.target.value })}
            placeholder="http://127.0.0.1:8019"
          />
          <button className="btn ghost" onClick={() => void refresh()}>检测</button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          {healthOk === null && '未检测'}
          {healthOk === true && <>✅ owlcoda proxy 在线,发现 {models.length} 个模型</>}
          {healthOk === false && (
            <>
              ❌ 无法连接 owlcoda({error})。上手三步:<br />
              1. <code>npm install -g owlcoda</code>(或见主仓库 README)<br />
              2. <code>owlcoda init --endpoint http://127.0.0.1:11434/v1</code> 自动发现你的本地模型<br />
              3. <code>owlcoda serve</code> 启动 proxy,然后回来点"检测"
            </>
          )}
        </p>
      </div>

      <div className="card">
        <h3>分析模式</h3>
        <div className="switch-row">
          <label>
            <input
              type="radio"
              checked={settings.singleModel}
              onChange={() => update({ singleModel: true, modeChosen: true })}
            />{' '}
            单模型三角(一个模型轮演 Pro/Anti/Judge)
          </label>
          <label>
            <input
              type="radio"
              checked={!settings.singleModel}
              onChange={() => update({ singleModel: false, modeChosen: true })}
            />{' '}
            多模型辩论(每个角色独立模型,owlcoda 路由)
          </label>
        </div>
      </div>

      <div className="card">
        <h3>角色模型路由 {settings.singleModel ? '(单模型模式下仅 Pro 槽位生效,三角色共用)' : ''}</h3>
        <div className="role-route" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          <span>角色</span><span>主模型</span><span>Fallback(可选)</span>
        </div>
        {(['pro', 'anti', 'judge'] as Role[]).map((role) => (
          <div key={role} className="role-route">
            <span>{ROLE_LABEL[role]}</span>
            <select value={settings.roles[role].model} onChange={(e) => updateRole(role, 'model', e.target.value)}>
              <option value="">未选择</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name ?? m.id} {m.tier ? `[${m.tier}]` : ''}
                </option>
              ))}
            </select>
            <select value={settings.roles[role].fallback ?? ''} onChange={(e) => updateRole(role, 'fallback', e.target.value)}>
              <option value="">无</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name ?? m.id}</option>
              ))}
            </select>
          </div>
        ))}
        <p className="hint">
          线上参考路由(hermes-football):Pro=mimo-v2.5-pro,Anti=kimi-for-coding,Judge=deepseek-chat。
          在 owlcoda 里配好等价模型后,在这里按角色分配即可——换模型不需要改一行代码。
        </p>
      </div>
    </div>
  )
}
