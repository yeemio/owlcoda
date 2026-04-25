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

const PROTOCOL_OPTIONS: Array<{ value: LocalRuntimeProtocol, label: string, help: string }> = [
  { value: 'auto', label: 'Auto detect', help: 'Prefer this for owlmlx, Ollama gateways, and routers that expose runtime truth.' },
  { value: 'openai_chat', label: 'OpenAI chat', help: 'Use when the local router only speaks OpenAI-compatible chat/completions.' },
  { value: 'anthropic_messages', label: 'Anthropic messages', help: 'Use when the router exposes Anthropic-compatible /v1/messages semantics.' },
]

const SUBSCRIPTION_TRACKS = [
  {
    id: 'oauth-bridge',
    label: 'OAuth / subscription-auth provider bridges',
    status: 'Planned',
    detail: 'Needs a dedicated browser handoff or login-backed gateway, then entitlement-aware model surfacing. Should not be faked as a plain API-key box.',
  },
]

function initialRuntimeForm(): RuntimeFormState {
  return {
    routerUrl: '',
    localRuntimeProtocol: 'auto',
  }
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
  const routerMissing = snapshot.statuses.filter(status => status.availability.kind === 'router_missing').length
  const aliasConflicts = snapshot.statuses.filter(status => status.availability.kind === 'alias_conflict').length
  const missingKeys = snapshot.statuses.filter(status => status.availability.kind === 'missing_key').length
  const readyCloud = snapshot.statuses.filter(
    status => status.providerKind === 'cloud' && status.availability.kind === 'ok',
  ).length
  const readyLocal = snapshot.statuses.filter(
    status => status.providerKind === 'local' && status.availability.kind === 'ok',
  ).length
  const visibilityRule = snapshot.platformVisibility?.rule
  const visibilityGateStatus = snapshot.platformVisibility?.gateStatus
  const usingDeprecatedFallback = snapshot.platformVisibility?.deprecatedFallback === true
  const routerIssueLabel = visibilityRule === 'runtime_gate_required_before_visible'
    ? 'waiting on owlmlx visibility gate'
    : visibilityRule === 'gate_required_before_visible'
      ? 'waiting on deprecated router gate'
      : usingDeprecatedFallback
        ? 'using deprecated router fallback'
        : 'not visible'

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
    setSelectedLocalModels(previous => ({ ...previous, [modelId]: !previous[modelId] }))
    importLocalModels.setSelecting()
  }

  function setAllLocalModels(selected: boolean) {
    setSelectedLocalModels(Object.fromEntries(localDiscovered.map(status => [status.id, selected])))
    importLocalModels.setSelecting()
  }

  const localImportItems = useMemo<BulkBindItem[]>(() => {
    return localDiscovered
      .filter(status => selectedLocalModels[status.id])
      .map(status => buildQuickImportItem(status))
  }, [localDiscovered, selectedLocalModels])

  async function importSelectedLocalModels() {
    if (localImportItems.length === 0) return
    const response = await importLocalModels.run(localImportItems)
    if (response?.snapshot) {
      onSnapshotUpdate(response.snapshot)
    }
  }

  function refreshAll() {
    onRefresh()
    void loadConfig()
    void loadProviders()
  }

  const runtimeStatusTone = snapshot.runtimeOk ? 'tone-ok' : 'tone-warn'
  const runtimeStatusLabel = snapshot.runtimeOk
    ? `runtime reachable${snapshot.runtimeModelCount > 0 ? ` · ${snapshot.runtimeModelCount} visible models` : ''}`
    : 'runtime not yet reachable'
  const providerFamilyHint = providers.some(provider => provider.id === 'openai-compat')
    ? 'Multi-model clouds can ride the OpenAI-compatible family: one endpoint, many backend model ids.'
    : 'Provider templates are loading.'
  const featuredProviders = providers.filter(provider => provider.featured)
  const cloudPresets = featuredProviders.length > 0 ? featuredProviders : providers.slice(0, 4)
  const selectedLocalCount = localImportItems.length

  return (
    <div className="app-main full start-layout">
      <section className="panel start-panel">
        <section className="start-hero" data-testid="start-page">
          <div className="start-eyebrow">First-run configuration</div>
          <h2>Turn OwlCoda admin into the first place users land.</h2>
          <p className="start-copy">
            Point OwlCoda at a real local router, attach cloud providers that pass a connection test,
            then clean up whatever the runtime still sees as stale, missing, or unbound.
          </p>
          <div className="start-actions">
            <a href={buildAddModelHref('openai-compat')} className="button-link primary" data-testid="start-cta-add">
              Add cloud provider
            </a>
            <a href="#/orphans" className="button-link" data-testid="start-cta-orphans">
              Bind local models
            </a>
            <a href="#/catalog" className="button-link" data-testid="start-cta-catalog">
              Import catalog entries
            </a>
            <button type="button" onClick={refreshAll} data-testid="start-refresh">
              {loading ? 'Refreshing…' : 'Refresh truth'}
            </button>
          </div>
          <div className="start-stats">
            <div className="start-stat">
              <span className="start-stat-label">Configured</span>
              <strong>{counts.total}</strong>
            </div>
            <div className="start-stat">
              <span className="start-stat-label">Ready</span>
              <strong>{counts.ok}</strong>
            </div>
            <div className="start-stat">
              <span className="start-stat-label">Blocked</span>
              <strong>{counts.blocked}</strong>
            </div>
            <div className="start-stat">
              <span className="start-stat-label">Orphans</span>
              <strong>{counts.orphan}</strong>
            </div>
          </div>
        </section>

        <div className="start-grid">
          <article className="start-card start-card-emphasis">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Local router</div>
                <h3>Set where local models should come from</h3>
              </div>
              <span className={`start-badge ${snapshot.runtimeOk ? 'ok' : 'warn'}`}>Ready now</span>
            </div>
            <p className="start-card-copy">
              Use this for owlmlx, Ollama gateways, LM Studio, vLLM, or any router that should feed the local side of OwlCoda.
            </p>

            <div className="start-inline-kv">
              <div>
                <span className="start-inline-label">Observed runtime</span>
                <strong className={runtimeStatusTone} data-testid="start-runtime-status">{runtimeStatusLabel}</strong>
              </div>
              <div>
                <span className="start-inline-label">Current issues</span>
                <strong>{routerMissing} {routerIssueLabel}</strong>
              </div>
            </div>

            {configError && <div className="banner err">Config: {configError}</div>}
            {saveRuntime.error && <div className="banner err" data-testid="start-runtime-error">{saveRuntime.error}</div>}

            <label className="field">
              <span className="field-label">routerUrl</span>
              <input
                className="field-input"
                value={runtimeForm.routerUrl}
                onChange={event => setRuntimeForm(form => ({ ...form, routerUrl: event.target.value }))}
                placeholder="http://127.0.0.1:11435/v1"
                data-testid="start-router-url-input"
              />
            </label>

            <label className="field">
              <span className="field-label">localRuntimeProtocol</span>
              <select
                className="field-input"
                value={runtimeForm.localRuntimeProtocol}
                onChange={event => setRuntimeForm(form => ({
                  ...form,
                  localRuntimeProtocol: event.target.value as LocalRuntimeProtocol,
                }))}
                data-testid="start-runtime-protocol"
              >
                {PROTOCOL_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <div className="start-help-list">
              {PROTOCOL_OPTIONS.map(option => (
                <div
                  key={option.value}
                  className={`start-help-item${runtimeForm.localRuntimeProtocol === option.value ? ' active' : ''}`}
                >
                  <strong>{option.label}</strong>
                  <span>{option.help}</span>
                </div>
              ))}
            </div>

            <div className="start-runtime-detail">
              <strong>Runtime probe</strong>
              <span>{snapshot.runtimeProbeDetail || 'No runtime detail yet. Save the router, then refresh truth.'}</span>
            </div>
            {snapshot.platformVisibility && (
              <div className="start-runtime-detail" data-testid="start-visibility-contract">
                <strong>Visibility contract</strong>
                <span>
                  {visibilityRule ?? 'unknown rule'}
                  {visibilityGateStatus ? ` · gate ${visibilityGateStatus}` : ''}
                  {snapshot.platformVisibility.formalSurfaceEndpoint ? ` · truth ${snapshot.platformVisibility.formalSurfaceEndpoint}` : ''}
                  {snapshot.platformVisibility.diagnosticSurfaceEndpoint ? ` · diag ${snapshot.platformVisibility.diagnosticSurfaceEndpoint}` : ''}
                  {snapshot.platformVisibility.loadedInventoryEndpoint
                    ? ` · inventory ${snapshot.platformVisibility.loadedInventoryEndpoint}${snapshot.platformVisibility.loadedInventorySemanticRole ? ` (${snapshot.platformVisibility.loadedInventorySemanticRole})` : ''}`
                    : ''}
                  {snapshot.platformVisibility.deprecatedFallback ? ' · deprecated fallback' : ''}
                </span>
              </div>
            )}

            <div className="start-discovery-panel" data-testid="start-local-discovery">
              <div className="start-discovery-header">
                <div>
                  <strong>Discovered local models</strong>
                  <span className="tone-muted">
                    {localDiscovered.length === 0
                      ? 'Nothing unbound right now'
                      : `${localDiscovered.length} waiting to be configured`}
                  </span>
                </div>
                {localDiscovered.length > 0 && (
                  <div className="start-discovery-actions">
                    <button type="button" onClick={() => setAllLocalModels(true)} data-testid="start-local-select-all">
                      Select all
                    </button>
                    <button type="button" onClick={() => setAllLocalModels(false)} data-testid="start-local-select-none">
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {localDiscovered.length === 0 ? (
                <div className="start-empty-hint">
                  {snapshot.runtimeOk
                    ? 'Router looks reachable. When local runtimes expose models that are not yet in config, they will show up here.'
                    : 'Save a reachable local router and refresh truth; discovered local models will appear here once the runtime answers.'}
                </div>
              ) : (
                <>
                  <ul className="start-discovery-list">
                    {localDiscovered.map(status => {
                      const discovered = status.raw.discovered
                      return (
                        <li key={status.id} className="start-discovery-item" data-testid={`start-orphan-${status.id}`}>
                          <label className="start-discovery-check">
                            <input
                              type="checkbox"
                              checked={Boolean(selectedLocalModels[status.id])}
                              onChange={() => toggleLocalModel(status.id)}
                              data-testid={`start-orphan-check-${status.id}`}
                            />
                            <span>
                              <strong>{discovered?.label ?? status.label}</strong>
                              <span className="tone-muted"> {status.id}</span>
                            </span>
                          </label>
                          <div className="start-discovery-meta">
                            <span>{discovered?.backend ?? 'local runtime'}</span>
                            {discovered?.baseUrl && <span>{discovered.baseUrl}</span>}
                            {discovered?.contextWindow && <span>{discovered.contextWindow} ctx</span>}
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
                        : `Import selected (${selectedLocalCount})`}
                    </button>
                    <a href="#/orphans" className="button-link subtle" data-testid="start-open-orphans">
                      Open advanced binder
                    </a>
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
            </div>

            <div className="start-card-actions">
              <button
                type="button"
                onClick={submitRuntime}
                disabled={saveRuntime.status === 'submitting' || !runtimeForm.routerUrl.trim()}
                data-testid="start-runtime-save"
              >
                {saveRuntime.status === 'submitting' ? 'Saving…' : 'Save runtime settings'}
              </button>
              <a href="#/models" className="button-link subtle">Open model workspace</a>
            </div>
          </article>

          <article className="start-card">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Cloud providers</div>
                <h3>Attach APIs and provider families</h3>
              </div>
              <span className="start-badge ok">Ready now</span>
            </div>
            <p className="start-card-copy">
              Single-model clouds like Kimi or MiniMax fit one saved endpoint. Multi-model clouds like Bailian or OpenRouter
              should be treated as a provider family first, then configured with the concrete backend model ids you actually plan to use.
            </p>
            {providersError && <div className="banner err">Providers: {providersError}</div>}
            <div className="provider-chip-list">
              {providers.map(provider => (
                <span key={provider.id} className="provider-chip" data-testid={`start-provider-${provider.id}`}>
                  {provider.label}
                </span>
              ))}
              {providers.length === 0 && <span className="tone-muted">Loading provider templates…</span>}
            </div>
            {cloudPresets.length > 0 && (
              <div className="start-provider-grid">
                {cloudPresets.map(provider => (
                  <a
                    key={provider.id}
                    href={buildAddModelHref(provider.id)}
                    className="start-provider-preset"
                    data-testid={`start-provider-link-${provider.id}`}
                  >
                    <div className="start-provider-preset-head">
                      <strong>{provider.label}</strong>
                      <span className="provider-chip">
                        {provider.family === 'multi-model' ? 'Family' : 'Single'}
                      </span>
                    </div>
                    <span>{provider.description ?? 'Open the add-model flow with this preset.'}</span>
                    {provider.endpointHint && <span className="tone-muted">{provider.endpointHint}</span>}
                  </a>
                ))}
              </div>
            )}
            <div className="start-runtime-detail">
              <strong>Model-family rule</strong>
              <span>{providerFamilyHint}</span>
            </div>
            <div className="start-inline-kv compact">
              <div>
                <span className="start-inline-label">Ready cloud models</span>
                <strong>{readyCloud}</strong>
              </div>
              <div>
                <span className="start-inline-label">Missing credentials</span>
                <strong>{missingKeys}</strong>
              </div>
            </div>
            <div className="start-card-actions">
              <a href={buildAddModelHref('openai-compat')} className="button-link primary">Open add-model flow</a>
              <a href="#/catalog" className="button-link subtle">Review catalog</a>
            </div>
          </article>

          <article className="start-card">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Subscription adapters</div>
                <h3>Plan auth-backed bridges honestly</h3>
              </div>
              <span className="start-badge planned">Planned</span>
            </div>
            <p className="start-card-copy">
              Subscription-backed tools should land as dedicated adapters with real auth and entitlement handling.
              Do not squeeze them into a generic key textbox and pretend the bridge exists.
            </p>
            <div className="start-track-list">
              {SUBSCRIPTION_TRACKS.map(track => (
                <div key={track.id} className="start-track">
                  <div className="start-track-head">
                    <strong>{track.label}</strong>
                    <span className="start-badge planned small">{track.status}</span>
                  </div>
                  <span>{track.detail}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="start-card">
            <div className="start-card-header">
              <div>
                <div className="start-card-kicker">Cleanup lane</div>
                <h3>Resolve the truth that is still messy</h3>
              </div>
              <span className={`start-badge ${counts.blocked > 0 || counts.orphan > 0 ? 'warn' : 'ok'}`}>
                {counts.blocked > 0 || counts.orphan > 0 ? 'Needs attention' : 'Clean'}
              </span>
            </div>
            <div className="start-checklist">
              <a href="#/models?view=issues" className="start-check">
                <strong>{routerMissing}</strong>
                <span>
                  {visibilityRule === 'runtime_gate_required_before_visible'
                    ? 'configured entries still waiting on the owlmlx runtime visibility gate'
                    : visibilityRule === 'gate_required_before_visible'
                      ? 'configured entries still waiting on the deprecated router visibility gate'
                      : 'configured entries still missing from the runtime visibility list'}
                </span>
              </a>
              <a href="#/aliases" className="start-check">
                <strong>{aliasConflicts}</strong>
                <span>alias conflicts waiting for cleanup</span>
              </a>
              <a href="#/orphans" className="start-check">
                <strong>{counts.orphan}</strong>
                <span>local models discovered but not yet bound</span>
              </a>
              <div className="start-check static">
                <strong>{readyLocal}</strong>
                <span>local models already ready once the router is healthy</span>
              </div>
            </div>
          </article>
        </div>

        <section className="start-footnote">
          <strong>Today&apos;s truth surface</strong>
          <span>
            Start here to set the router and choose the next lane, then drop into Models, Orphans, Aliases, or Catalog only for the
            focused fix you actually need.
          </span>
          {config && (
            <span className="tone-muted" data-testid="start-current-router">
              Current config: <code>{config.routerUrl}</code> · protocol <code>{config.localRuntimeProtocol}</code>
            </span>
          )}
        </section>
      </section>
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

function buildAddModelHref(providerId?: string): string {
  const params = new URLSearchParams()
  params.set('view', 'add')
  if (providerId) params.set('provider', providerId)
  return `#/models?${params.toString()}`
}
