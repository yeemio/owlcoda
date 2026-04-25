import { useEffect, useMemo, useState } from 'react'
import { fetchProviders, testConnectionDryRun } from '../api/client'
import type {
  BatchResponse,
  CreateEndpointModelPatch,
  DryRunProbePayload,
  ProviderProbeResult,
  ProviderTemplate,
} from '../api/types'
import { useBatchMutation } from '../hooks/useBatchMutation'
import { useMutation } from '../hooks/useMutation'
import { BatchResultList } from './BatchResultList'
import { CsvField, NumberField, TextField } from './FormFields'
import { TestConnectionPanel } from './TestConnectionPanel'

interface Props {
  /** Page-owned create callback. Returns true iff snapshot was updated. */
  onCreate: (patch: CreateEndpointModelPatch) => Promise<boolean>
  onCreateBatch: (patches: CreateEndpointModelPatch[]) => Promise<BatchResponse>
  createSubmitting: boolean
  createError: string | null
  onCreated: (id: string) => void
  onCancel: () => void
  initialProviderId?: string
}

interface FormState {
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

function initialForm(): FormState {
  return {
    providerId: 'openai-compat',
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
}: Props) {
  const [providers, setProviders] = useState<ProviderTemplate[]>([])
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(initialForm)
  const [validation, setValidation] = useState<string | null>(null)

  useEffect(() => {
    fetchProviders()
      .then(r => {
        setProviders(r.providers)
        const preferred = r.providers.find(provider => provider.id === initialProviderId)
          ?? r.providers.find(provider => provider.id === form.providerId)
          ?? r.providers[0]
        if (preferred) {
          setForm(f => applyTemplateToForm(f, preferred, undefined))
        }
      })
      .catch((e: Error) => setProvidersError(e.message))
  }, [initialProviderId])

  const currentTemplate = useMemo(
    () => providers.find(p => p.id === form.providerId) ?? null,
    [providers, form.providerId],
  )
  const stagedBackendModels = useMemo(
    () => parseBackendModelList(form.batchBackendModels),
    [form.batchBackendModels],
  )
  const primaryBackendModel = form.backendModel.trim() || stagedBackendModels[0] || form.id.trim() || 'dry-run'
  const batchMode = stagedBackendModels.length > 1 || (stagedBackendModels.length === 1 && !form.id.trim())

  function onProviderChange(nextId: string) {
    const template = providers.find(p => p.id === nextId)
    setForm(f => applyTemplateToForm(f, template, currentTemplate))
  }

  function buildPatch(): { ok: true; patch: CreateEndpointModelPatch } | { ok: false; reason: string } {
    const id = form.id.trim()
    const endpoint = form.endpoint.trim()
    if (!id) return { ok: false, reason: 'id is required' }
    if (!endpoint) return { ok: false, reason: 'endpoint is required' }
    if (currentTemplate?.requiresBackendModel && !primaryBackendModel.trim()) {
      return { ok: false, reason: 'backendModel is required for this provider family' }
    }
    const patch: CreateEndpointModelPatch = {
      id,
      endpoint,
      label: form.label.trim() || id,
      backendModel: primaryBackendModel || id,
      aliases: form.aliases,
      role: form.role.trim() || undefined,
      contextWindow: form.contextWindow,
      timeoutMs: form.timeoutMs,
    }
    applyCredentialFields(patch, form)
    return { ok: true, patch }
  }

  function buildBatchPatches(): { ok: true; patches: CreateEndpointModelPatch[] } | { ok: false; reason: string } {
    const endpoint = form.endpoint.trim()
    if (!endpoint) return { ok: false, reason: 'endpoint is required' }
    if (stagedBackendModels.length === 0) return { ok: false, reason: 'enter at least one backend model id' }

    const patches = stagedBackendModels.map((backendModel): CreateEndpointModelPatch => {
      const patch: CreateEndpointModelPatch = {
        id: backendModel,
        label: backendModel,
        backendModel,
        endpoint,
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
      label: form.label.trim() || form.id.trim() || primaryBackendModel || 'Dry Run',
      endpoint: form.endpoint.trim(),
      backendModel: primaryBackendModel,
      aliases: form.aliases,
      role: form.role.trim() || undefined,
      contextWindow: form.contextWindow,
      timeoutMs: form.timeoutMs,
      testPath: currentTemplate?.testPath,
      testMode: currentTemplate?.testMode,
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
      setValidation('backendModel is required for this provider family test')
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
    ? 'Creating…'
    : batchMode
      ? `Create models (${stagedBackendModels.length})`
      : 'Create model'

  return (
    <div className="modal-backdrop" data-testid="add-model-dialog">
      <div className="modal">
        <header className="modal-header">
          <h3>Add cloud / endpoint model</h3>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="close">✕</button>
        </header>
        <div className="modal-body">
          {providersError && <div className="banner err">Providers: {providersError}</div>}

          <label className="field">
            <span className="field-label">provider</span>
            <select
              className="field-input"
              value={form.providerId}
              onChange={e => onProviderChange(e.target.value)}
              data-testid="field-provider"
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>

          {currentTemplate && (
            <section className="provider-template-panel" data-testid={`provider-template-${currentTemplate.id}`}>
              <div className="provider-template-head">
                <div className="provider-template-title">
                  <strong>{currentTemplate.label}</strong>
                  <span className={`provider-chip provider-chip-${currentTemplate.family}`}>
                    {currentTemplate.family === 'multi-model' ? 'Provider family' : 'Single endpoint'}
                  </span>
                </div>
                {currentTemplate.docs && (
                  <a href={currentTemplate.docs} target="_blank" rel="noreferrer" className="button-link subtle small">
                    Docs
                  </a>
                )}
              </div>
              {currentTemplate.description && (
                <p className="provider-template-copy">{currentTemplate.description}</p>
              )}
              <div className="provider-template-meta">
                <div className="provider-template-meta-item">
                  <span className="field-label">Default endpoint</span>
                  <code>{currentTemplate.endpoint}</code>
                </div>
                {currentTemplate.endpointHint && (
                  <div className="provider-template-meta-item">
                    <span className="field-label">Endpoint note</span>
                    <span>{currentTemplate.endpointHint}</span>
                  </div>
                )}
                {currentTemplate.backendModelHint && (
                  <div className="provider-template-meta-item">
                    <span className="field-label">Backend model rule</span>
                    <span>{currentTemplate.backendModelHint}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          <TextField label="id" value={form.id} onChange={v => setForm(f => ({ ...f, id: v }))} testId="field-id" placeholder="e.g. kimi-k2" autoFocus />
          <TextField label="label" value={form.label} onChange={v => setForm(f => ({ ...f, label: v }))} testId="field-label" placeholder="human label (defaults to id)" />
          <TextField label="endpoint" value={form.endpoint} onChange={v => setForm(f => ({ ...f, endpoint: v }))} testId="field-endpoint" />
          {currentTemplate?.family === 'multi-model' && (
            <label className="field">
              <span className="field-label">batch backend models</span>
              <textarea
                className="field-input field-textarea"
                value={form.batchBackendModels}
                onChange={event => setForm(f => ({ ...f, batchBackendModels: event.target.value }))}
                placeholder="one backend model id per line, or comma-separated"
                rows={4}
                data-testid="field-batch-backendModels"
              />
            </label>
          )}
          {currentTemplate?.family === 'multi-model' && (
            <div className="tone-muted add-model-hint" data-testid="field-batch-backendModels-hint">
              Paste multiple backend model ids here to create a provider-family batch. When this list is used, each config id defaults to its backend model id.
            </div>
          )}
          <TextField
            label="backendModel"
            value={form.backendModel}
            onChange={v => setForm(f => ({ ...f, backendModel: v }))}
            testId="field-backendModel"
            placeholder={
              currentTemplate?.family === 'multi-model'
                ? 'optional override for dry-run; otherwise uses the first staged backend model'
                : backendModelRequired
                  ? 'required for this provider family'
                  : 'defaults to id'
            }
          />
          {currentTemplate?.backendModelHint && (
            <div className="tone-muted add-model-hint" data-testid="field-backendModel-hint">
              {currentTemplate.backendModelHint}
            </div>
          )}
          <CsvField label="aliases" values={form.aliases} onChange={v => setForm(f => ({ ...f, aliases: v }))} testId="field-aliases" />
          <TextField label="role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} testId="field-role" />
          <NumberField label="contextWindow" value={form.contextWindow} onChange={v => setForm(f => ({ ...f, contextWindow: v }))} testId="field-contextWindow" />
          <NumberField label="timeoutMs" value={form.timeoutMs} onChange={v => setForm(f => ({ ...f, timeoutMs: v }))} testId="field-timeoutMs" />

          <div className="section">
            <h4>API key</h4>
            <div className="filter" role="tablist">
              <button type="button" className={form.keyMode === 'inline' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'inline' }))} data-testid="add-key-inline">Inline</button>
              <button type="button" className={form.keyMode === 'env' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'env' }))} data-testid="add-key-env">Env</button>
              <button type="button" className={form.keyMode === 'none' ? 'active' : ''} onClick={() => setForm(f => ({ ...f, keyMode: 'none' }))} data-testid="add-key-none">None</button>
            </div>
            {form.keyMode === 'inline' && (
              <TextField label="apiKey" type="password" value={form.apiKey} onChange={v => setForm(f => ({ ...f, apiKey: v }))} testId="field-apiKey" />
            )}
            {form.keyMode === 'env' && (
              <TextField label="apiKeyEnv" value={form.apiKeyEnv} onChange={v => setForm(f => ({ ...f, apiKeyEnv: v }))} testId="field-apiKeyEnv" />
            )}
            <div className="tone-muted" style={{ fontSize: 11, marginTop: 4 }}>
              Keys are still hidden on the read path. Save them here during onboarding, or choose "None" to create models without credentials.
            </div>
          </div>

          <div className="section">
            <h4>Dry-run test</h4>
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
                This provider family probes via chat completions, so enter a real backend model id before testing.
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
          <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
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

function shouldFillEmptyValue(currentValue: string): boolean {
  return currentValue.trim() === ''
}

function shouldFillEmptyList(currentValue: string[]): boolean {
  return currentValue.length === 0
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
      ? template.endpoint ?? form.endpoint
      : form.endpoint,
    id: shouldFillEmptyValue(form.id) ? template.defaultModelId ?? form.id : form.id,
    label: shouldFillEmptyValue(form.label) ? template.defaultModelLabel ?? form.label : form.label,
    backendModel: shouldFillEmptyValue(form.backendModel) ? template.defaultBackendModel ?? form.backendModel : form.backendModel,
    aliases: shouldFillEmptyList(form.aliases) ? template.defaultAliases ?? form.aliases : form.aliases,
    contextWindow: form.contextWindow ?? template.defaultContextWindow,
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
