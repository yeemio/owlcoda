import { useEffect, useMemo, useState } from 'react'
import { bulkBindDiscovered, fetchConfig, fetchProviders, updateRuntimeSettings } from '../api/client'
import type {
  BulkBindItem,
  ConfigResponse,
  LocalRuntimeProtocol,
  ModelStatus,
  ModelTruthSnapshot,
  ProviderTemplate,
  UpdateRuntimeSettingsPatch,
} from '../api/types'
import { overviewCounts } from '../lib/availability'
import { BatchResultList } from '../components/BatchResultList'
import { PageHeader } from '../components/PageHeader'
import { Pill } from '../components/Pill'
import { useBatchMutation } from '../hooks/useBatchMutation'
import { useMutation } from '../hooks/useMutation'

interface Props {
  snapshot: ModelTruthSnapshot
  onSnapshotUpdate: (snapshot: ModelTruthSnapshot) => void
  onRefresh: () => void
  loading: boolean
}

interface RuntimeFormState {
  routerUrl: string
  localRuntimeProtocol: LocalRuntimeProtocol
}

const PROTOCOL_OPTIONS: Array<{ value: LocalRuntimeProtocol, label: string }> = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'openai_chat', label: 'OpenAI chat' },
  { value: 'anthropic_messages', label: 'Messages-shaped API' },
]

const HELP_ITEMS = [
  { id: 'models', label: 'Models', detail: 'Daily editing — add or edit a code model, review defaults, test connections.' },
  { id: 'aliases', label: 'Aliases', detail: 'Only when two models claim the same alias and you need to pick a winner.' },
  { id: 'orphans', label: 'Orphans', detail: "Only when the runtime offers a local model your config doesn't yet bind." },
] as const

function initialRuntimeForm(): RuntimeFormState {
  return { routerUrl: '', localRuntimeProtocol: 'auto' }
}

export function StartPage({ snapshot, onSnapshotUpdate, onRefresh, loading }: Props) {
  const [config, setConfig] = useState<ConfigResponse['config'] | null>(null)
  const [providers, setProviders] = useState<ProviderTemplate[]>([])
  const [configError, setConfigError] = useState<string | null>(null)
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [runtimeForm, setRuntimeForm] = useState<RuntimeFormState>(initialRuntimeForm)
  const [selectedLocalModels, setSelectedLocalModels] = useState<Record<string, boolean>>({})

  const counts = useMemo(() => overviewCounts(snapshot.statuses), [snapshot.statuses])
  const localDiscovered = useMemo(
    () => snapshot.statuses.filter(status => status.availability.kind === 'orphan_discovered'),
    [snapshot.statuses],
  )
  const issuesCount = snapshot.statuses.filter(
    s => !['ok', 'orphan_discovered'].includes(s.availability.kind),
  ).length
  const aliasConflicts = snapshot.statuses.filter(s => s.availability.kind === 'alias_conflict').length
  const defaultModel = snapshot.statuses.find(s => s.isDefault) ?? null
  const visibilityRule = snapshot.platformVisibility?.rule ?? null

  useEffect(() => {
    void loadConfig()
    void loadProviders()
  }, [])

  useEffect(() => {
    setSelectedLocalModels(previous => {
      const next: Record<string, boolean> = {}
      for (const status of localDiscovered) {
        next[status.id] = previous[status.id] ?? true
      }
      return next
    })
  }, [localDiscovered])

  async function loadConfig() {
    try {
      const response = await fetchConfig()
      setConfigError(null)
      setConfig(response.config)
      setRuntimeForm({
        routerUrl: response.config.routerUrl ?? '',
        localRuntimeProtocol: response.config.localRuntimeProtocol ?? 'auto',
      })
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadProviders() {
    try {
      const response = await fetchProviders()
      setProvidersError(null)
      setProviders(response.providers)
    } catch (error) {
      setProvidersError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveRuntime = useMutation<[UpdateRuntimeSettingsPatch], boolean>(async patch => {
    const response = await updateRuntimeSettings(patch)
    if (response.snapshot) onSnapshotUpdate(response.snapshot)
    return true
  })
  const importLocalModels = useBatchMutation<[BulkBindItem[]]>(async items => bulkBindDiscovered(items))

  async function submitRuntime() {
    const ok = await saveRuntime.run({
      routerUrl: runtimeForm.routerUrl,
      localRuntimeProtocol: runtimeForm.localRuntimeProtocol,
    })
    if (ok) {
      onRefresh()
      await loadConfig()
    }
  }

  function toggleLocalModel(modelId: string) {
    setSelectedLocalModels(prev => ({ ...prev, [modelId]: !prev[modelId] }))
    importLocalModels.setSelecting()
  }

  function setAllLocalModels(selected: boolean) {
    setSelectedLocalModels(Object.fromEntries(localDiscovered.map(s => [s.id, selected])))
    importLocalModels.setSelecting()
  }

  const localImportItems = useMemo<BulkBindItem[]>(() => {
    return localDiscovered
      .filter(s => selectedLocalModels[s.id])
      .map(s => buildQuickImportItem(s))
  }, [localDiscovered, selectedLocalModels])

  async function importSelectedLocalModels() {
    if (localImportItems.length === 0) return
    const response = await importLocalModels.run(localImportItems)
    if (response?.snapshot) onSnapshotUpdate(response.snapshot)
  }

  const selectedLocalCount = localImportItems.length
  const runtimeStatusLabel = snapshot.runtimeOk
    ? `runtime reachable${snapshot.runtimeModelCount > 0 ? ` · ${snapshot.runtimeModelCount} visible models` : ''}`
    : 'runtime not yet reachable'

  return (
    <div className="app-main full start-layout">
      <section className="panel start-panel" data-testid="start-page">
        <PageHeader
          eyebrow="OwlCoda · Admin"
          title="Configure your coding models"
          sub={(
            <>
              Local + cloud model wiring, alias resolution, and runtime discovery.
              Truth from the daemon at <code className="page-header-code">{config?.routerUrl ? new URL(config.routerUrl).host : '127.0.0.1:9999'}</code>.
              Default model: {defaultModel
                ? <strong className="tone-ok" data-testid="start-default-model">{defaultModel.id}</strong>
                : <span className="tone-muted" data-testid="start-default-model">— not set —</span>}.
            </>
          )}
          right={(
            <Pill kind={snapshot.runtimeOk ? 'ok' : 'warn'} testId="start-runtime-pill">
              {snapshot.runtimeOk ? 'all green' : 'needs attention'}
            </Pill>
          )}
        />

        <div className="start-stats" data-testid="start-stats">
          <StartStat label="Configured" value={String(counts.total)} />
          <StartStat label="Issues" value={String(issuesCount)} tone={issuesCount > 0 ? 'warn' : undefined} />
          <StartStat label="Orphans" value={String(counts.orphan)} />
          <StartStat label="Runtime models" value={String(snapshot.runtimeModelCount)} />
        </div>

        <div className="start-actions">
          <a className="button-link primary" href="#/models" data-testid="start-cta-models">Open models</a>
          <a
            className={`button-link${aliasConflicts > 0 ? '' : ' subtle'}`}
            href="#/aliases"
            data-testid="start-cta-aliases"
          >
            Resolve aliases{aliasConflicts > 0 ? ` (${aliasConflicts})` : ''}
          </a>
          <a className="button-link subtle" href="#/orphans" data-testid="start-cta-orphans">
            Adopt orphans ({localDiscovered.length})
          </a>
          <a className="button-link subtle" href="#/runs" data-testid="start-cta-runs">Latest run report</a>
          <button type="button" onClick={onRefresh} data-testid="start-refresh">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="start-grid">
          <article className="start-card start-card-emphasis" data-testid="start-card-health">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Health</div>
                <h3>Daemon · runtime · provider keys</h3>
              </div>
              <span className={`start-badge ${snapshot.runtimeOk ? 'ok' : 'warn'}`}>{runtimeStatusLabel}</span>
            </div>

            {!runtimeForm.routerUrl.trim() && (
              <div className="banner warn" data-testid="start-router-empty-banner">
                <strong>Set the router URL below to bring local models online.</strong>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Without a reachable router URL the runtime can't probe local models. Cloud-only models still work via the Models page.
                </div>
              </div>
            )}

            <div className="start-runtime-form" data-testid="start-runtime-form">
              <div className="start-runtime-form-head">
                <strong>Runtime configuration</strong>
                <span className="tone-muted">routerUrl · protocol</span>
              </div>
              {configError && <div className="banner err">Config: {configError}</div>}
              {saveRuntime.error && <div className="banner err" data-testid="start-runtime-error">{saveRuntime.error}</div>}
              <div className="start-runtime-form-grid">
                <label className="field">
                  <span className="field-label">routerUrl</span>
                  <input
                    className="field-input"
                    value={runtimeForm.routerUrl}
                    onChange={e => setRuntimeForm(f => ({ ...f, routerUrl: e.target.value }))}
                    placeholder="http://127.0.0.1:11435/v1"
                    data-testid="start-router-url-input"
                  />
                </label>
                <label className="field">
                  <span className="field-label">localRuntimeProtocol</span>
                  <select
                    className="field-input"
                    value={runtimeForm.localRuntimeProtocol}
                    onChange={e => setRuntimeForm(f => ({
                      ...f,
                      localRuntimeProtocol: e.target.value as LocalRuntimeProtocol,
                    }))}
                    data-testid="start-runtime-protocol"
                  >
                    {PROTOCOL_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="start-runtime-save"
                  onClick={submitRuntime}
                  disabled={saveRuntime.status === 'submitting' || !runtimeForm.routerUrl.trim()}
                  data-testid="start-runtime-save"
                >
                  {saveRuntime.status === 'submitting' ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            <p className="start-card-copy" style={{ marginTop: 8 }}>
              {snapshot.runtimeProbeDetail || 'Runtime probe pending. Save a router URL above, then refresh.'}
            </p>
            {snapshot.platformVisibility && (
              <div className="start-runtime-detail" data-testid="start-visibility-contract">
                <strong>Platform visibility</strong>
                <span>
                  {visibilityRule ?? 'unknown rule'}
                  {snapshot.platformVisibility.gateStatus ? ` · gate ${snapshot.platformVisibility.gateStatus}` : ''}
                  {snapshot.platformVisibility.formalSurfaceEndpoint
                    ? ` · truth ${snapshot.platformVisibility.formalSurfaceEndpoint}`
                    : ''}
                  {snapshot.platformVisibility.deprecatedFallback ? ' · deprecated fallback' : ''}
                </span>
              </div>
            )}
          </article>

          <article className="start-card" data-testid="start-card-help">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Help</div>
                <h3>Where to start</h3>
              </div>
            </div>
            <div className="start-help-list">
              {HELP_ITEMS.map((item, i) => (
                <a key={item.id} href={`#/${item.id}`} className={`start-help-item${i === 0 ? ' active' : ''}`}>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </a>
              ))}
            </div>
          </article>

          <article className="start-card" data-testid="start-card-discovery">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Discovery</div>
                <h3>
                  {localDiscovered.length === 0
                    ? 'No unbound local models right now'
                    : `Runtime is offering ${localDiscovered.length} unbound model${localDiscovered.length === 1 ? '' : 's'}`}
                </h3>
              </div>
              <a className="start-badge" href="#/orphans" data-testid="start-open-orphans">go ›</a>
            </div>
            {localDiscovered.length === 0 ? (
              <div className="start-empty-hint">
                {snapshot.runtimeOk
                  ? 'Router looks reachable. New unbound local models will show up here when the runtime sees them.'
                  : 'Save a reachable local router above, then refresh truth.'}
              </div>
            ) : (
              <>
                <div className="start-discovery-actions">
                  <button type="button" onClick={() => setAllLocalModels(true)} data-testid="start-local-select-all">Select all</button>
                  <button type="button" onClick={() => setAllLocalModels(false)} data-testid="start-local-select-none">Clear</button>
                  <span className="tone-muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                    {selectedLocalCount} of {localDiscovered.length} selected
                  </span>
                </div>
                <ul className="start-discovery-list">
                  {localDiscovered.map(s => {
                    const discovered = s.raw.discovered
                    return (
                      <li key={s.id} className="start-discovery-item" data-testid={`start-orphan-${s.id}`}>
                        <label className="start-discovery-check">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedLocalModels[s.id])}
                            onChange={() => toggleLocalModel(s.id)}
                            data-testid={`start-orphan-check-${s.id}`}
                          />
                          <span>
                            <strong>{discovered?.label ?? s.label}</strong>
                            <span className="tone-muted"> {s.id}</span>
                          </span>
                        </label>
                        <div className="start-discovery-meta">
                          <span>{discovered?.backend ?? 'local runtime'}</span>
                          {discovered?.contextWindow && <span>{discovered.contextWindow.toLocaleString()} ctx</span>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <div className="start-card-actions">
                  <button
                    type="button"
                    onClick={importSelectedLocalModels}
                    disabled={selectedLocalCount === 0 || importLocalModels.status === 'submitting'}
                    data-testid="start-local-import"
                  >
                    {importLocalModels.status === 'submitting'
                      ? 'Importing…'
                      : `Quick import (${selectedLocalCount})`}
                  </button>
                  <a href="#/orphans" className="button-link subtle">Open advanced binder</a>
                </div>
              </>
            )}
            {importLocalModels.error && (
              <div className="banner err" data-testid="start-local-import-error">{importLocalModels.error}</div>
            )}
            <BatchResultList
              results={importLocalModels.results}
              labelFor={id => snapshot.byModelId[id]?.raw.discovered?.label ?? snapshot.byModelId[id]?.label ?? id}
              testId="start-local-import-results"
            />
          </article>

          <article className="start-card" data-testid="start-card-catalog">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Catalog</div>
                <h3>Provider quickstart</h3>
              </div>
              <a className="start-badge planned" href="#/catalog" data-testid="start-open-catalog">browse</a>
            </div>
            {providersError && <div className="banner err">Providers: {providersError}</div>}
            {providers.length === 0 && <div className="tone-muted">Loading provider templates…</div>}
            <div className="start-provider-grid" data-testid="start-provider-list">
              {providers.map(provider => (
                <a
                  key={provider.id}
                  href={`#/models?view=add&provider=${provider.id}`}
                  className="start-provider-preset"
                  data-testid={`start-provider-link-${provider.id}`}
                  data-provider={provider.id}
                >
                  <div className="start-provider-preset-head">
                    <strong>{provider.featured ? '★ ' : ''}{provider.label}</strong>
                    {provider.family && (
                      <span className="provider-chip" data-testid={`start-provider-${provider.id}`}>
                        {provider.family === 'multi-model' ? 'Family' : 'Single'}
                      </span>
                    )}
                  </div>
                  {provider.description && <span>{provider.description}</span>}
                </a>
              ))}
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}

interface StartStatProps {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'err' | 'info'
  valueClass?: string
}

function StartStat({ label, value, tone, valueClass }: StartStatProps) {
  const className = valueClass ?? (tone ? `tone-${tone}` : undefined)
  return (
    <div className="start-stat">
      <span className="start-stat-label">{label}</span>
      <strong className={className}>{value}</strong>
    </div>
  )
}

function buildQuickImportItem(status: ModelStatus): BulkBindItem {
  const discovered = status.raw.discovered
  return {
    discoveredId: status.id,
    patch: {
      label: discovered?.label ?? status.label,
      backendModel: discovered?.id ?? status.id,
      contextWindow: discovered?.contextWindow,
      tier: 'local',
    },
  }
}
