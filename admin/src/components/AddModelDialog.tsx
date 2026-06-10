import { useEffect, useMemo, useState } from 'react'
import { fetchLocalRuntimes, fetchProviders, testConnectionDryRun } from '../api/client'
import type {
  BatchResponse,
  CreateEndpointModelPatch,
  DiscoveredLocalRuntime,
  DryRunProbePayload,
  ProviderProbeResult,
  ProviderTemplate,
} from '../api/types'
import { useBatchMutation } from '../hooks/useBatchMutation'
import { useMutation } from '../hooks/useMutation'
import { Advanced } from './Advanced'
import { BatchResultList } from './BatchResultList'
import { CsvField, NumberField, TextField } from './FormFields'
import { TestConnectionPanel } from './TestConnectionPanel'
import { useI18n } from '../i18n'

interface Props {
  /** Page-owned create callback. Returns true iff snapshot was updated. */
  onCreate: (patch: CreateEndpointModelPatch) => Promise<boolean>
  onCreateBatch: (patches: CreateEndpointModelPatch[]) => Promise<BatchResponse>
  createSubmitting: boolean
  createError: string | null
  onCreated: (id: string) => void
  onCancel: () => void
  initialProviderId?: string
  /** Discovered local models to present as a picker in Lane 2-A. Empty = manual-input only. */
  discoveredLocalModels?: Array<{ id: string; backend?: string; contextWindow?: number; label?: string }>
}

type Lane = 'brand' | 'custom'
type CustomSub = 'local' | 'endpoint'

interface FormState {
  lane: Lane
  customSub: CustomSub
  providerId: string
  id: string
  label: string
  endpoint: string
  backendModel: string
  aliases: string[]
  role: string
  contextWindow: number | undefined
  timeoutMs: number | undefined
  batchBackendModels: string
  keyMode: 'inline' | 'env' | 'none'
  apiKey: string
  apiKeyEnv: string
}

// Cloud-brand tile IDs in display order
const CLOUD_IDS = ['kimi', 'deepseek', 'glm', 'minimax', 'gpt', 'claude', 'gemini', 'grok']
// Local-runtime tile IDs in display order
const LOCAL_IDS = ['ollama', 'lm-studio', 'vllm', 'owlmlx']
// Custom/endpoint protocol provider IDs
const CUSTOM_IDS = ['openai-compat', 'anthropic']

// All known IDs in order for sorting
const ALL_ORDER_IDS = [...CLOUD_IDS, ...LOCAL_IDS, ...CUSTOM_IDS]

function tierForProvider(p: ProviderTemplate): 'cloud' | 'local' | 'custom' {
  return p.tier ?? (CLOUD_IDS.includes(p.id) ? 'cloud' : LOCAL_IDS.includes(p.id) ? 'local' : 'custom')
}

function laneForTier(tier: 'cloud' | 'local' | 'custom'): Lane {
  return tier === 'cloud' ? 'brand' : 'custom'
}

function subForTier(tier: 'cloud' | 'local' | 'custom'): CustomSub {
  return tier === 'local' ? 'local' : 'endpoint'
}

function keyModeDefault(lane: Lane, customSub: CustomSub): 'inline' | 'none' {
  if (lane === 'brand') return 'inline'
  if (customSub === 'local') return 'none'
  return 'inline'
}

function initialForm(): FormState {
  return {
    lane: 'brand',
    customSub: 'local',
    providerId: '',
    id: '',
    label: '',
    endpoint: '',
    backendModel: '',
    aliases: [],
    role: '',
    contextWindow: undefined,
    timeoutMs: undefined,
    batchBackendModels: '',
    keyMode: 'inline',
    apiKey: '',
    apiKeyEnv: '',
  }
}

export function AddModelDialog({
  onCreate,
  onCreateBatch,
  createSubmitting,
  createError,
  onCreated,
  onCancel,
  initialProviderId,
  discoveredLocalModels = [],
}: Props) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderTemplate[]>([])
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [discoveries, setDiscoveries] = useState<DiscoveredLocalRuntime[]>([])
  const [form, setForm] = useState<FormState>(initialForm)
  const [validation, setValidation] = useState<string | null>(null)
  const [providerQuery, setProviderQuery] = useState('')

  useEffect(() => {
    fetchProviders()
      .then(r => {
        setProviders(r.providers)
        const preferred = r.providers.find(p => p.id === initialProviderId)
          ?? r.providers.find(p => p.id === form.providerId)
          ?? null
        setForm(f => {
          let nextForm = f
          if (preferred) {
            const tier = tierForProvider(preferred)
            const lane = laneForTier(tier)
            const customSub = subForTier(tier)
            const km = keyModeDefault(lane, customSub)
            nextForm = applyTemplateToForm({ ...f, lane, customSub, keyMode: km }, preferred, undefined)
          } else {
            // No matching preferred — pick best available for current lane
            const cloudProviders = r.providers.filter(p => tierForProvider(p) === 'cloud')
            const localProviders = r.providers.filter(p => tierForProvider(p) === 'local')
            const customProviders = r.providers.filter(p => tierForProvider(p) === 'custom')

            let fallback: ProviderTemplate | undefined
            let lane: Lane = f.lane
            let customSub: CustomSub = f.customSub

            if (f.lane === 'brand') {
              fallback = cloudProviders[0]
              if (!fallback) {
                // No cloud providers — fall back to whatever is available
                if (localProviders.length > 0) { lane = 'custom'; customSub = 'local'; fallback = localProviders[0] }
                else if (customProviders.length > 0) { lane = 'custom'; customSub = 'endpoint'; fallback = customProviders[0] }
              }
            } else if (f.customSub === 'local') {
              fallback = localProviders[0]
              if (!fallback && customProviders.length > 0) { customSub = 'endpoint'; fallback = customProviders[0] }
            } else {
              fallback = customProviders[0]
            }

            if (fallback) {
              const km = keyModeDefault(lane, customSub)
              nextForm = applyTemplateToForm({ ...f, lane, customSub, keyMode: km }, fallback, undefined)
            }
          }
          return nextForm
        })
      })
      .catch((e: Error) => setProvidersError(e.message))
  }, [initialProviderId])

  useEffect(() => {
    fetchLocalRuntimes()
      .then(r => setDiscoveries(r.runtimes))
      .catch(() => {
        // Discovery is a non-blocking hint.
      })
  }, [])

  const currentTemplate = useMemo(
    () => providers.find(p => p.id === form.providerId) ?? null,
    [providers, form.providerId],
  )

  // Providers filtered by current lane/sub-mode for tiles
  const sortedByOrder = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()
    const matches = q
      ? providers.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      : providers
    const order = new Map<string, number>(ALL_ORDER_IDS.map((id, i) => [id, i]))
    return [...matches].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
  }, [providers, providerQuery])

  const cloudTiles = useMemo(
    () => sortedByOrder.filter(p => tierForProvider(p) === 'cloud'),
    [sortedByOrder],
  )
  const localTiles = useMemo(
    () => sortedByOrder.filter(p => tierForProvider(p) === 'local'),
    [sortedByOrder],
  )

  // Which tiles are visible in the current lane
  const visibleTiles = useMemo(() => {
    if (form.lane === 'brand') return cloudTiles
    if (form.customSub === 'local') return localTiles
    return [] // Lane 2-B uses protocol select, not tiles
  }, [form.lane, form.customSub, cloudTiles, localTiles])

  const stagedBackendModels = useMemo(
    () => parseBackendModelList(form.batchBackendModels),
    [form.batchBackendModels],
  )
  const primaryBackendModel = form.backendModel.trim() || stagedBackendModels[0] || form.id.trim() || 'dry-run'
  const batchMode = stagedBackendModels.length > 1 || (stagedBackendModels.length === 1 && !form.id.trim())

  const isMulti = currentTemplate?.family === 'multi-model'

  // Auto-derive id from backendModel for local/multi-model presets
  // (not for custom/endpoint where user enters id manually)
  useEffect(() => {
    if (form.lane === 'custom' && form.customSub === 'endpoint') return
    if (!isMulti) return
    if (form.id.trim()) return
    const derived = form.backendModel.trim() || stagedBackendModels[0] || ''
    if (derived) setForm(f => (f.id.trim() ? f : { ...f, id: derived }))
  }, [form.backendModel, form.id, form.lane, form.customSub, isMulti, stagedBackendModels])

  function onProviderChange(nextId: string) {
    const template = providers.find(p => p.id === nextId)
    setForm(f => {
      const tier = template ? tierForProvider(template) : (f.lane === 'brand' ? 'cloud' : f.customSub === 'local' ? 'local' : 'custom')
      const lane = laneForTier(tier)
      const customSub = subForTier(tier)
      const km = keyModeDefault(lane, customSub)
      const base = { ...f, lane, customSub, keyMode: km }
      return applyTemplateToForm(base, template, currentTemplate)
    })
  }

  function switchLane(nextLane: Lane) {
    setForm(f => {
      const sub = f.customSub
      const km = keyModeDefault(nextLane, sub)
      let nextForm: FormState = { ...f, lane: nextLane, keyMode: km }
      // Auto-select first provider for the new lane
      const candidates = nextLane === 'brand' ? cloudTiles : sub === 'local' ? localTiles : providers.filter(p => tierForProvider(p) === 'custom')
      const first = candidates[0]
      if (first) {
        nextForm = applyTemplateToForm(nextForm, first, currentTemplate)
      }
      return nextForm
    })
  }

  function switchCustomSub(nextSub: CustomSub) {
    setForm(f => {
      const km = keyModeDefault('custom', nextSub)
      let nextForm: FormState = { ...f, customSub: nextSub, keyMode: km }
      const candidates = nextSub === 'local' ? localTiles : providers.filter(p => tierForProvider(p) === 'custom')
      const first = candidates[0]
      if (first) {
        nextForm = applyTemplateToForm(nextForm, first, currentTemplate)
      }
      return nextForm
    })
  }

  function buildPatch(): { ok: true; patch: CreateEndpointModelPatch } | { ok: false; reason: string } {
    const id = form.id.trim()
    const endpoint = normalizeEndpoint(form.endpoint)
    if (!id) return { ok: false, reason: t('idRequired') }
    if (!endpoint) return { ok: false, reason: t('endpointRequired') }
    if (currentTemplate?.requiresBackendModel && !primaryBackendModel.trim()) {
      return { ok: false, reason: t('backendRequired') }
    }
    const patch: CreateEndpointModelPatch = {
      id,
      endpoint,
      label: form.label.trim() || id,
      backendModel: primaryBackendModel || id,
      aliases: form.aliases,
      provider: providerForConfig(currentTemplate),
      headers: currentTemplate?.headers ? { ...currentTemplate.headers } : undefined,
      role: form.role.trim() || undefined,
      contextWindow: form.contextWindow,
      timeoutMs: form.timeoutMs,
    }
    applyCredentialFields(patch, form)
    return { ok: true, patch }
  }

  function buildBatchPatches(): { ok: true; patches: CreateEndpointModelPatch[] } | { ok: false; reason: string } {
    const endpoint = normalizeEndpoint(form.endpoint)
    if (!endpoint) return { ok: false, reason: t('endpointRequired') }
    if (stagedBackendModels.length === 0) return { ok: false, reason: t('enterBackend') }

    const patches = stagedBackendModels.map((backendModel): CreateEndpointModelPatch => {
      const patch: CreateEndpointModelPatch = {
        id: backendModel,
        label: backendModel,
        backendModel,
        endpoint,
        provider: providerForConfig(currentTemplate),
        headers: currentTemplate?.headers ? { ...currentTemplate.headers } : undefined,
        role: form.role.trim() || undefined,
        contextWindow: form.contextWindow,
        timeoutMs: form.timeoutMs,
      }
      applyCredentialFields(patch, form)
      return patch
    })
    return { ok: true, patches }
  }

  function buildDryRun(): DryRunProbePayload {
    const payload: DryRunProbePayload = {
      provider: form.providerId,
      id: form.id.trim() || primaryBackendModel || 'dry-run',
      label: form.label.trim() || form.id.trim() || primaryBackendModel || t('dryRun'),
      endpoint: normalizeEndpoint(form.endpoint),
      backendModel: primaryBackendModel,
      aliases: form.aliases,
      role: form.role.trim() || undefined,
      contextWindow: form.contextWindow,
      timeoutMs: form.timeoutMs,
      testPath: currentTemplate?.testPath,
      testMode: currentTemplate?.testMode,
      headers: currentTemplate?.headers,
    }
    if (form.keyMode === 'inline' && form.apiKey.trim()) payload.apiKey = form.apiKey
    if (form.keyMode === 'env' && form.apiKeyEnv.trim()) payload.apiKeyEnv = form.apiKeyEnv
    return payload
  }

  const testMutation = useMutation<[DryRunProbePayload], ProviderProbeResult>(async (payload) => {
    const res = await testConnectionDryRun(payload)
    return res.result
  })
  const batchCreate = useBatchMutation<[CreateEndpointModelPatch[]]>(async (patches) => onCreateBatch(patches))

  const backendModelRequired = currentTemplate?.requiresBackendModel === true
  const testDisabled = !form.endpoint.trim() || (backendModelRequired && !primaryBackendModel.trim())

  function runTest() {
    setValidation(null)
    if (backendModelRequired && !primaryBackendModel.trim()) {
      setValidation(t('backendRequired'))
      return
    }
    testMutation.run(buildDryRun())
  }

  async function submit() {
    setValidation(null)
    if (batchMode) {
      const built = buildBatchPatches()
      if (!built.ok) { setValidation(built.reason); return }
      const response = await batchCreate.run(built.patches)
      if (response && response.results.length > 0 && response.results.every(result => result.ok)) {
        onCreated(response.results[0]!.id)
      }
      return
    }

    const built = buildPatch()
    if (!built.ok) { setValidation(built.reason); return }
    const ok = await onCreate(built.patch)
    if (ok) onCreated(built.patch.id)
  }

  const submitting = createSubmitting || batchCreate.status === 'submitting'
  const createButtonLabel = submitting
    ? t('creating')
    : batchMode
      ? t('createModels', { count: stagedBackendModels.length })
      : t('createModel')

  // ── Render helpers ──────────────────────────────────────────────────

  function renderKeySection() {
    return (
      <div className="section">
        <h4>{t('apiKey')}</h4>
        <div className="filter" role="tablist">
          <button type="button" className={form.keyMode === 'inline' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'inline' }))} data-testid="add-key-inline">{t('inline')}</button>
          <button type="button" className={form.keyMode === 'env' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'env' }))} data-testid="add-key-env">{t('env')}</button>
          <button type="button" className={form.keyMode === 'none' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'none' }))} data-testid="add-key-none">{t('keyNone')}</button>
        </div>
        {form.keyMode === 'inline' && (
          <TextField field="apiKey" type="password" value={form.apiKey} onChange={v => setForm(f => ({ ...f, apiKey: v }))} testId="field-apiKey" />
        )}
        {form.keyMode === 'env' && (
          <TextField field="apiKeyEnv" value={form.apiKeyEnv} onChange={v => setForm(f => ({ ...f, apiKeyEnv: v }))} testId="field-apiKeyEnv" />
        )}
        <div className="tone-muted" style={{ fontSize: 11, marginTop: 4 }}>
          {t('keysStored')}
        </div>
      </div>
    )
  }

  function renderProviderTileGrid(tiles: ProviderTemplate[]) {
    return (
      <div
        className="provider-tile-grid"
        role="radiogroup"
        aria-labelledby="provider-picker-label"
        data-testid="provider-tile-grid"
      >
        {tiles.map(p => {
          const detection = p.tier === 'local' ? discoveries.find(d => d.templateId === p.id) : undefined
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={form.providerId === p.id}
              className={`provider-tile${form.providerId === p.id ? ' active' : ''}`}
              onClick={() => onProviderChange(p.id)}
              data-testid={`provider-tile-${p.id}`}
              data-provider={p.id}
            >
              <strong className="provider-tile-label">
                {p.featured && <span className="provider-tile-star" aria-hidden>★ </span>}
                {p.label}
              </strong>
              <span className="provider-tile-meta">
                {p.family === 'multi-model' ? t('family') : p.family === 'single-model' ? t('single') : t('custom')}
              </span>
              {detection && (
                <span
                  className={`provider-tile-detection${detection.reachable ? ' reachable' : ' unreachable'}`}
                  data-testid={`provider-tile-detection-${p.id}`}
                  title={detection.detail}
                >
                  {detection.reachable ? `✓ ${t('detected')} · ${detection.latencyMs}ms` : `○ ${t('notRunning')}`}
                </span>
              )}
            </button>
          )
        })}
        {tiles.length === 0 && providerQuery && (
          <div className="provider-tile-empty tone-muted">{t('noProviderMatches', { query: providerQuery })}</div>
        )}
      </div>
    )
  }

  function renderTemplatePanel() {
    if (!currentTemplate) return null
    return (
      <section className="provider-template-panel" data-testid={`provider-template-${currentTemplate.id}`}>
        <div className="provider-template-head">
          <div className="provider-template-title">
            <strong>{currentTemplate.label}</strong>
            <span className={`provider-chip provider-chip-${currentTemplate.family}`}>
              {currentTemplate.family === 'multi-model' ? t('providerFamily') : t('singleEndpoint')}
            </span>
          </div>
          {currentTemplate.docs && (
            <a href={currentTemplate.docs} target="_blank" rel="noreferrer" className="button-link subtle small">
              {t('docs')}
            </a>
          )}
        </div>
        {currentTemplate.description && (
          <p className="provider-template-copy">{currentTemplate.description}</p>
        )}
        <div className="provider-template-meta">
          {currentTemplate.endpoint && currentTemplate.endpoint.trim() && (
            <div className="provider-template-meta-item">
              <span className="field-label">{t('defaultEndpoint')}</span>
              <code>{currentTemplate.endpoint}</code>
            </div>
          )}
          {currentTemplate.endpointHint && (
            <div className="provider-template-meta-item">
              <span className="field-label">{t('endpointNote')}</span>
              <span>{currentTemplate.endpointHint}</span>
            </div>
          )}
          {currentTemplate.backendModelHint && (
            <div className="provider-template-meta-item">
              <span className="field-label">{t('backendModelRule')}</span>
              <span>{currentTemplate.backendModelHint}</span>
            </div>
          )}
        </div>
      </section>
    )
  }

  // ── Lane 1: Brand ───────────────────────────────────────────────────

  function renderLaneBrand() {
    return (
      <>
        {renderProviderTileGrid(visibleTiles)}
        {renderTemplatePanel()}

        {/* Brand lane: auto-configured summary */}
        {currentTemplate && (
          <div className="add-model-brand-summary tone-muted" data-testid="brand-auto-summary">
            <span className="field-label">{t('brandAutoConfigured')}</span>
            <span>{t('brandConfigSummary')}</span>
          </div>
        )}

        {/* API Key — default inline; "no key for now" link */}
        {renderKeySection()}
        {form.keyMode !== 'none' && (
          <button
            type="button"
            className="button-link subtle small"
            style={{ marginTop: 4 }}
            onClick={() => setForm(f => ({ ...f, keyMode: 'none' }))}
            data-testid="brand-no-key-later"
          >
            {t('noKeyLater')}
          </button>
        )}

        {/* Advanced: override defaults — brand lane: backendModel + aliases only */}
        <Advanced testId="add-advanced">
          <TextField field="backendModel" value={form.backendModel} onChange={v => setForm(f => ({ ...f, backendModel: v }))} testId="field-backendModel" placeholder="defaults to id" />
          <CsvField field="aliases" values={form.aliases} onChange={v => setForm(f => ({ ...f, aliases: v }))} testId="field-aliases" />
        </Advanced>
      </>
    )
  }

  // ── Lane 2-A: Local runtime ─────────────────────────────────────────

  function renderLaneLocal() {
    return (
      <>
        {renderProviderTileGrid(visibleTiles)}
        {renderTemplatePanel()}

        <TextField
          field="endpoint"
          value={form.endpoint}
          onChange={v => setForm(f => ({ ...f, endpoint: v }))}
          testId="field-endpoint"
          placeholder="http://127.0.0.1:8080"
        />
        {discoveredLocalModels.length > 0 && (
          <label className="field">
            <span className="field-label">{t('discoveredLocalModels')}</span>
            <select
              className="field-input"
              data-testid="local-discovered-select"
              value={discoveredLocalModels.some(m => m.id === form.backendModel) ? form.backendModel : ''}
              onChange={e => {
                const chosen = discoveredLocalModels.find(m => m.id === e.target.value)
                if (chosen) {
                  setForm(f => ({
                    ...f,
                    backendModel: chosen.id,
                    contextWindow: f.contextWindow === undefined && chosen.contextWindow !== undefined
                      ? chosen.contextWindow
                      : f.contextWindow,
                  }))
                }
              }}
            >
              <option value="">— {t('pickDiscovered')} —</option>
              {discoveredLocalModels.map(m => (
                <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
              ))}
            </select>
          </label>
        )}
        <TextField
          field="backendModel"
          value={form.backendModel}
          onChange={v => setForm(f => ({ ...f, backendModel: v }))}
          testId="field-backendModel"
          placeholder={
            discoveredLocalModels.length > 0
              ? t('orPickAbove')
              : backendModelRequired
                ? t('requiredForProvider')
                : t('defaultsToId')
          }
          autoFocus
        />
        {currentTemplate?.backendModelHint && (
          <div className="tone-muted add-model-hint" data-testid="field-backendModel-hint">
            {currentTemplate.backendModelHint}
          </div>
        )}

        {/* Key section — defaults to none for local */}
        {renderKeySection()}

        <Advanced testId="add-advanced">
          <TextField field="id" value={form.id} onChange={v => setForm(f => ({ ...f, id: v }))} testId="field-id" placeholder={currentTemplate?.defaultModelId ?? 'e.g. local-model'} />
          <TextField field="label" value={form.label} onChange={v => setForm(f => ({ ...f, label: v }))} testId="field-label" placeholder={t('humanLabel')} />
          <CsvField field="aliases" values={form.aliases} onChange={v => setForm(f => ({ ...f, aliases: v }))} testId="field-aliases" />
          <TextField field="role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} testId="field-role" />
          <NumberField field="contextWindow" value={form.contextWindow} onChange={v => setForm(f => ({ ...f, contextWindow: v }))} testId="field-contextWindow" />
          <NumberField field="timeoutMs" value={form.timeoutMs} onChange={v => setForm(f => ({ ...f, timeoutMs: v }))} testId="field-timeoutMs" />
          {isMulti && (
            <label className="field">
              <span className="field-label">{t('batchBackendModels')}</span>
              <textarea
                className="field-input field-textarea"
                value={form.batchBackendModels}
                onChange={event => setForm(f => ({ ...f, batchBackendModels: event.target.value }))}
                placeholder={t('backendModelsPlaceholder')}
                rows={4}
                data-testid="field-batch-backendModels"
              />
            </label>
          )}
        </Advanced>
      </>
    )
  }

  // ── Lane 2-B: Custom endpoint ───────────────────────────────────────

  function renderLaneEndpoint() {
    const customProviders = providers.filter(p => tierForProvider(p) === 'custom')
    return (
      <>
        {/* Protocol select */}
        <label className="field">
          <span className="field-label">{t('protocolSelect')}</span>
          <select
            className="field-input"
            value={form.providerId}
            onChange={e => onProviderChange(e.target.value)}
            data-testid="protocol-select"
          >
            {customProviders.map(p => (
              <option key={p.id} value={p.id}>
                {p.id === 'openai-compat' ? t('protocolOpenAICompat') : t('protocolAnthropicCompat')}
              </option>
            ))}
            {customProviders.length === 0 && (
              <option value="">—</option>
            )}
          </select>
        </label>

        {renderTemplatePanel()}

        <TextField
          field="endpoint"
          value={form.endpoint}
          onChange={v => setForm(f => ({ ...f, endpoint: v }))}
          testId="field-endpoint"
          placeholder={
            form.providerId === 'anthropic'
              ? 'e.g. api.your-relay.com/anthropic'
              : 'e.g. api.your-gateway.com/v1'
          }
        />
        {(form.providerId === 'anthropic' || form.providerId === 'openai-compat') && (
          <div className="tone-muted add-model-hint" data-testid="custom-endpoint-hint">
            {t('endpointHint')}
          </div>
        )}
        <TextField
          field="backendModel"
          value={form.backendModel}
          onChange={v => setForm(f => ({ ...f, backendModel: v }))}
          testId="field-backendModel"
          placeholder={backendModelRequired ? t('requiredForProvider') : t('defaultsToId')}
        />
        {currentTemplate?.backendModelHint && (
          <div className="tone-muted add-model-hint" data-testid="field-backendModel-hint">
            {currentTemplate.backendModelHint}
          </div>
        )}
        <TextField field="id" value={form.id} onChange={v => setForm(f => ({ ...f, id: v }))} testId="field-id" placeholder="e.g. my-model" autoFocus />

        {renderKeySection()}

        <Advanced testId="add-advanced">
          <TextField field="label" value={form.label} onChange={v => setForm(f => ({ ...f, label: v }))} testId="field-label" placeholder={t('humanLabel')} />
          <CsvField field="aliases" values={form.aliases} onChange={v => setForm(f => ({ ...f, aliases: v }))} testId="field-aliases" />
          <TextField field="role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} testId="field-role" />
          <NumberField field="contextWindow" value={form.contextWindow} onChange={v => setForm(f => ({ ...f, contextWindow: v }))} testId="field-contextWindow" />
          <NumberField field="timeoutMs" value={form.timeoutMs} onChange={v => setForm(f => ({ ...f, timeoutMs: v }))} testId="field-timeoutMs" />
          {isMulti && (
            <label className="field">
              <span className="field-label">{t('batchBackendModels')}</span>
              <textarea
                className="field-input field-textarea"
                value={form.batchBackendModels}
                onChange={event => setForm(f => ({ ...f, batchBackendModels: event.target.value }))}
                placeholder={t('backendModelsPlaceholder')}
                rows={4}
                data-testid="field-batch-backendModels"
              />
            </label>
          )}
          {isMulti && (
            <div className="tone-muted add-model-hint" data-testid="field-batch-backendModels-hint">
              {t('batchBackendHint')}
            </div>
          )}
        </Advanced>
      </>
    )
  }

  return (
    <div className="modal-backdrop" data-testid="add-model-dialog">
      <div className="modal">
        <header className="modal-header">
          <h3>{t('addCloudEndpoint')}</h3>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label={t('close')}>✕</button>
        </header>
        <div className="modal-body">
          {providersError && <div className="banner err">{t('providers')}: {providersError}</div>}

          {/* ── Lane selector ── */}
          <div className="add-model-lane-selector" data-testid="lane-selector">
            <button
              type="button"
              className={`add-model-lane-btn${form.lane === 'brand' ? ' active' : ''}`}
              onClick={() => switchLane('brand')}
              data-testid="lane-brand"
            >
              {t('laneCloudBrand')}
            </button>
            <button
              type="button"
              className={`add-model-lane-btn${form.lane === 'custom' ? ' active' : ''}`}
              onClick={() => switchLane('custom')}
              data-testid="lane-custom"
            >
              {t('laneCustomLocal')}
            </button>
          </div>

          {/* ── Lane 2 sub-mode toggle ── */}
          {form.lane === 'custom' && (
            <div className="add-model-sub-selector" data-testid="custom-sub-selector">
              <button
                type="button"
                className={`add-model-sub-btn${form.customSub === 'local' ? ' active' : ''}`}
                onClick={() => switchCustomSub('local')}
                data-testid="sub-local"
              >
                {t('laneLocalSub')}
              </button>
              <button
                type="button"
                className={`add-model-sub-btn${form.customSub === 'endpoint' ? ' active' : ''}`}
                onClick={() => switchCustomSub('endpoint')}
                data-testid="sub-endpoint"
              >
                {t('laneEndpointSub')}
              </button>
            </div>
          )}

          {/* ── Provider picker header (search) ── */}
          <div className="add-model-provider-picker" data-testid="provider-picker">
            <div className="add-model-provider-head">
              <span className="field-label" id="provider-picker-label">{t('provider')}</span>
              <input
                type="search"
                className="field-input add-model-provider-search"
                placeholder={t('searchProviders')}
                value={providerQuery}
                onChange={e => setProviderQuery(e.target.value)}
                data-testid="provider-search"
              />
            </div>

            {/* Hidden select preserves data-testid="field-provider" for tests
                that fire change events with a value. The visible UI is the
                tile grid or protocol select; all three write the same form.providerId. */}
            <select
              className="visually-hidden"
              aria-hidden="true"
              tabIndex={-1}
              value={form.providerId}
              onChange={e => onProviderChange(e.target.value)}
              data-testid="field-provider"
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.id}</option>
              ))}
            </select>

            {/* Lane-specific content */}
            {form.lane === 'brand' && renderLaneBrand()}
            {form.lane === 'custom' && form.customSub === 'local' && renderLaneLocal()}
            {form.lane === 'custom' && form.customSub === 'endpoint' && renderLaneEndpoint()}
          </div>

          <div className="section">
            <h4>{t('dryRunTest')}</h4>
            <TestConnectionPanel
              onTest={runTest}
              submitting={testMutation.status === 'submitting'}
              result={testMutation.data}
              error={testMutation.error}
              testIdPrefix="add-test"
              disabled={testDisabled}
            />
            {backendModelRequired && !primaryBackendModel.trim() && (
              <div className="tone-muted add-model-hint" data-testid="add-backend-required-hint">
                {t('backendRequiredTest')}
              </div>
            )}
          </div>

          {validation && <div className="banner err" data-testid="add-validation">{validation}</div>}
          {createError && (
            <div className="banner err" data-testid="add-error">{createError}</div>
          )}
          {batchCreate.error && (
            <div className="banner err" data-testid="add-batch-error">{batchCreate.error}</div>
          )}
          <BatchResultList results={batchCreate.results} testId="add-batch-results" />
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onCancel} disabled={submitting}>{t('cancel')}</button>
          <button type="button" onClick={submit} disabled={submitting} data-testid="add-submit">
            {createButtonLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}

// Re-export wire shape for the page to wire its callback.
export type { CreateEndpointModelPatch }

function shouldReplaceTemplateValue(currentValue: string, previousTemplateValue: string | undefined): boolean {
  const trimmed = currentValue.trim()
  return trimmed === '' || (previousTemplateValue ? trimmed === previousTemplateValue : false)
}

function shouldReplaceTemplateList(currentValue: string[], previousTemplateValue: string[] | undefined): boolean {
  if (currentValue.length === 0) return true
  if (!previousTemplateValue || previousTemplateValue.length !== currentValue.length) return false
  return previousTemplateValue.every((v, i) => v === currentValue[i])
}

function shouldReplaceTemplateNumber(currentValue: number | undefined, previousTemplateValue: number | undefined): boolean {
  if (currentValue === undefined) return true
  if (previousTemplateValue === undefined) return false
  return currentValue === previousTemplateValue
}

function applyTemplateToForm(
  form: FormState,
  template: ProviderTemplate | undefined,
  previousTemplate: ProviderTemplate | null | undefined,
): FormState {
  if (!template) return form
  return {
    ...form,
    providerId: template.id,
    endpoint: shouldReplaceTemplateValue(form.endpoint, previousTemplate?.endpoint)
      ? template.endpoint ?? ''
      : form.endpoint,
    id: shouldReplaceTemplateValue(form.id, previousTemplate?.defaultModelId)
      ? template.defaultModelId ?? ''
      : form.id,
    label: shouldReplaceTemplateValue(form.label, previousTemplate?.defaultModelLabel)
      ? template.defaultModelLabel ?? ''
      : form.label,
    backendModel: shouldReplaceTemplateValue(form.backendModel, previousTemplate?.defaultBackendModel)
      ? template.defaultBackendModel ?? ''
      : form.backendModel,
    aliases: shouldReplaceTemplateList(form.aliases, previousTemplate?.defaultAliases)
      ? template.defaultAliases ?? []
      : form.aliases,
    contextWindow: shouldReplaceTemplateNumber(form.contextWindow, previousTemplate?.defaultContextWindow)
      ? template.defaultContextWindow
      : form.contextWindow,
  }
}

function parseBackendModelList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\n,]+/)) {
    const trimmed = part.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function applyCredentialFields(patch: CreateEndpointModelPatch, form: Pick<FormState, 'keyMode' | 'apiKey' | 'apiKeyEnv'>): void {
  if (form.keyMode === 'inline' && form.apiKey.trim()) {
    patch.apiKey = form.apiKey.trim()
  }
  if (form.keyMode === 'env' && form.apiKeyEnv.trim()) {
    patch.apiKeyEnv = form.apiKeyEnv.trim()
  }
}

function providerForConfig(template: ProviderTemplate | null | undefined): string | undefined {
  if (!template || template.id === 'custom') return undefined
  return template.provider
}

/**
 * Tolerant endpoint normalization for the custom presets and any user input.
 */
function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}
