import { useEffect, useState } from 'react'
import { fetchEndpointHealth, fetchLocalRuntimes } from '../api/client'
import type {
  ApiKeyPayload,
  DiscoveredLocalRuntime,
  EndpointHealthSample,
  LocalRuntimeProtocol,
  ModelStatus,
  ProviderProbeResult,
  UpdateModelFieldsPatch,
} from '../api/types'
import { availabilityFixHints, availabilityPhrase, availabilityTone } from '../lib/availability'
import { StatusIcon } from './StatusIcon'
import { EditFieldsForm } from './EditFieldsForm'
import { KeyForm } from './KeyForm'
import { Pill } from './Pill'
import { TestConnectionPanel } from './TestConnectionPanel'
import { ConfirmDelete } from './ConfirmDelete'
import { useI18n } from '../i18n'

type Mode = 'idle' | 'edit' | 'key' | 'delete'

export interface DrawerMutationState {
  submitting: boolean
  error: string | null
}

export interface DrawerCallbacks {
  onSetDefault: (modelId: string) => void
  onUpdateFields: (modelId: string, patch: UpdateModelFieldsPatch) => Promise<boolean>
  onReplaceKey: (modelId: string, payload: ApiKeyPayload) => Promise<boolean>
  onTestSaved: (modelId: string) => Promise<ProviderProbeResult | null>
  onDelete: (modelId: string) => Promise<boolean>
  onConnectRuntime: (patch: { routerUrl: string; localRuntimeProtocol: LocalRuntimeProtocol }) => Promise<boolean>
}

interface Props extends DrawerCallbacks {
  status: ModelStatus | null
  setDefaultState: DrawerMutationState
  editState: DrawerMutationState
  keyState: DrawerMutationState
  deleteState: DrawerMutationState
  testResult: ProviderProbeResult | null
  testSubmitting: boolean
  testError: string | null
  runtimeOk: boolean
  routerUrl: string
}

export function ModelDrawer(props: Props) {
  const { status } = props
  const [mode, setMode] = useState<Mode>('idle')
  const { t } = useI18n()
  const [endpointHealth, setEndpointHealth] = useState<EndpointHealthSample | null>(null)

  // Reset mode when selection changes.
  useEffect(() => { setMode('idle') }, [status?.id])

  // Fetch most recent endpoint health for the currently-selected model. Best
  // effort: silently drop when cache empty or API unreachable.
  useEffect(() => {
    const endpoint = status?.raw.config?.endpoint
    if (!endpoint) {
      setEndpointHealth(null)
      return
    }
    let cancelled = false
    fetchEndpointHealth()
      .then(r => {
        if (cancelled) return
        setEndpointHealth(r.samples.find(s => s.endpoint === endpoint) ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [status?.id, status?.raw.config?.endpoint])

  if (!status) {
    return (
      <aside className="panel-right drawer" data-testid="drawer-empty">
        <div className="empty">{t('selectModel')}</div>
      </aside>
    )
  }
  return (
    <aside className="panel-right drawer" data-testid="drawer">
      <h3>
        <StatusIcon availability={status.availability} />{' '}
        <span data-testid="drawer-label">{status.label}</span>
        {status.isDefault && <span className="tone-ok" style={{ marginLeft: 8 }} data-testid="drawer-default-badge">★ {t('defaultBadge')}</span>}
      </h3>
      <div className="sub" data-testid="drawer-id">{status.id}</div>

      <div className="section">
        <h4>{t('drawerStatus')}</h4>
        <Pill kind={availabilityTone(status.availability)} testId="drawer-phrase">
          {availabilityPhrase(status.availability, t)}
        </Pill>
      </div>

      <div className="section">
        <h4>{t('presence')}</h4>
        <div className="presence">
          {(['config', 'router', 'discovered', 'catalog'] as const).map(key => (
            <span key={key} className={`tag${status.presentIn[key] ? ' active' : ''}`} data-testid={`presence-${key}`}>
              {key} {status.presentIn[key] ? '✓' : '–'}
            </span>
          ))}
        </div>
      </div>

      <ModelFacts status={status} endpointHealth={endpointHealth} />
      <FixHints status={status} />

      {status.providerKind === 'local' && (
        <LocalRuntimeSection
          status={status}
          runtimeOk={props.runtimeOk}
          routerUrl={props.routerUrl}
          onConnectRuntime={props.onConnectRuntime}
        />
      )}

      <div className="section">
        <h4>{t('actions')}</h4>
        <div className="actions">
          <button
            type="button"
            onClick={() => props.onSetDefault(status.id)}
            disabled={status.isDefault || props.setDefaultState.submitting}
            data-testid="action-set-default"
          >
            {props.setDefaultState.submitting ? t('setting') : status.isDefault ? t('default') : t('setDefault')}
          </button>
          <button type="button" onClick={() => setMode(mode === 'key' ? 'idle' : 'key')} data-testid="action-key">
            {mode === 'key' ? t('closeKeyEditor') : t('replaceKey')}
          </button>
          <button type="button" onClick={() => setMode(mode === 'edit' ? 'idle' : 'edit')} data-testid="action-edit">
            {mode === 'edit' ? t('closeEditor') : t('editFields')}
          </button>
          <TestSavedButton status={status} onTest={props.onTestSaved} submitting={props.testSubmitting} />
          <button
            type="button"
            className="danger"
            onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}
            data-testid="action-delete"
          >
            {mode === 'delete' ? t('close') : t('delete')}
          </button>
        </div>
        {props.setDefaultState.error && (
          <div className="banner err" data-testid="set-default-error">{props.setDefaultState.error}</div>
        )}
      </div>

      {props.testResult || props.testError ? (
        <div className="section">
          <h4>{t('testResult')}</h4>
          <TestConnectionPanel
            onTest={() => props.onTestSaved(status.id)}
            submitting={props.testSubmitting}
            result={props.testResult}
            error={props.testError}
            testIdPrefix="saved-test"
          />
        </div>
      ) : null}

      {mode === 'edit' && (
        <div className="section">
          <h4>{t('editFields')}</h4>
          <EditFieldsForm
            status={status}
            submitting={props.editState.submitting}
            error={props.editState.error}
            onSubmit={async patch => {
              const ok = await props.onUpdateFields(status.id, patch)
              if (ok) setMode('idle')
            }}
            onCancel={() => setMode('idle')}
          />
        </div>
      )}

      {mode === 'key' && (
        <div className="section">
          <h4>{t('apiKey')}</h4>
          <KeyForm
            status={status}
            submitting={props.keyState.submitting}
            error={props.keyState.error}
            onSubmit={async payload => {
              const ok = await props.onReplaceKey(status.id, payload)
              if (ok) setMode('idle')
            }}
            onCancel={() => setMode('idle')}
          />
        </div>
      )}

      {mode === 'delete' && (
        <div className="section">
          <h4>{t('confirmDelete')}</h4>
          <ConfirmDelete
            status={status}
            submitting={props.deleteState.submitting}
            error={props.deleteState.error}
            onConfirm={async () => {
              const ok = await props.onDelete(status.id)
              if (ok) setMode('idle')
            }}
            onCancel={() => setMode('idle')}
          />
        </div>
      )}
    </aside>
  )
}

function TestSavedButton({
  status, onTest, submitting,
}: { status: ModelStatus; onTest: (id: string) => Promise<ProviderProbeResult | null>; submitting: boolean }) {
  const canTest = Boolean(status.raw.config?.endpoint)
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => onTest(status.id)}
      disabled={!canTest || submitting}
      data-testid="action-test"
      title={canTest ? undefined : t('testRequiresEndpoint')}
    >
      {submitting ? t('testing') : t('test')}
    </button>
  )
}

function ModelFacts({ status, endpointHealth }: { status: ModelStatus; endpointHealth: EndpointHealthSample | null }) {
  const { t } = useI18n()
  const cfg = status.raw.config
  const disc = status.raw.discovered
  const rows: Array<[string, string]> = []
  rows.push(['provider', status.providerKind])
  if (status.role) rows.push(['role', status.role])
  if (cfg?.backendModel && cfg.backendModel !== status.id) rows.push(['backendModel', cfg.backendModel])
  if (cfg?.endpoint) rows.push(['endpoint', cfg.endpoint])
  if (endpointHealth) {
    const ageSec = Math.floor((Date.now() - endpointHealth.observedAt) / 1000)
    const ageText = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`
    const mark = endpointHealth.ok ? '✓' : '✗'
    rows.push(['endpointHealth', `${mark} ${endpointHealth.latencyMs}ms (${ageText})`])
  }
  if (cfg?.aliases && cfg.aliases.length > 0) rows.push(['aliases', cfg.aliases.join(', ')])
  if (status.contextCapability) {
    rows.push(['contextWindow', `${status.contextCapability.contextWindow} (${status.contextCapability.source}, ${status.contextCapability.confidence})`])
  } else if (cfg?.contextWindow) {
    rows.push(['contextWindow', String(cfg.contextWindow)])
  }
  if (cfg?.timeoutMs) rows.push(['timeoutMs', String(cfg.timeoutMs)])
  if (cfg?.apiKeyEnv) rows.push(['apiKeyEnv', cfg.apiKeyEnv])
  if (cfg?.apiKey?.set) rows.push(['apiKey', '(set)'])
  if (cfg?.apiKeySource) rows.push(['credentialSource', cfg.apiKeySource])
  if (disc) {
    rows.push(['discovered-backend', `${disc.backend} @ ${disc.baseUrl}`])
    if (disc.parameterSize) rows.push(['parameterSize', disc.parameterSize])
    if (disc.quantization) rows.push(['quantization', disc.quantization])
  }

  if (rows.length === 0) return null
  return (
    <div className="section">
      <h4>{t('facts')}</h4>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt><dd data-testid={`fact-${k}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function FixHints({ status }: { status: ModelStatus }) {
  const { t } = useI18n()
  const hints = availabilityFixHints(status.availability, t)
  if (hints.length === 0) return null
  return (
    <div className="section">
      <h4>{t('nextSteps')}</h4>
      <div className="hints" data-testid="fix-hints">
        {hints.map((h, i) => <div key={i} className="hint">{h}</div>)}
      </div>
    </div>
  )
}

interface LocalRuntimeSectionProps {
  status: ModelStatus
  runtimeOk: boolean
  routerUrl: string
  onConnectRuntime: (patch: { routerUrl: string; localRuntimeProtocol: LocalRuntimeProtocol }) => Promise<boolean>
}

function LocalRuntimeSection({ status, runtimeOk, routerUrl, onConnectRuntime }: LocalRuntimeSectionProps) {
  const { t } = useI18n()
  const [detectedRuntimes, setDetectedRuntimes] = useState<DiscoveredLocalRuntime[]>([])
  const [detectDone, setDetectDone] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualUrl, setManualUrl] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [editAddrOpen, setEditAddrOpen] = useState(false)
  const [editUrl, setEditUrl] = useState(routerUrl)

  const isRouterMissing = status.availability.kind === 'router_missing'
  const isConnected = runtimeOk && !isRouterMissing

  // When not connected: detect local runtimes once on mount.
  useEffect(() => {
    if (isConnected) return
    let cancelled = false
    fetchLocalRuntimes()
      .then(res => {
        if (cancelled) return
        setDetectedRuntimes(res.runtimes.filter(r => r.reachable))
        setDetectDone(true)
      })
      .catch(() => { if (!cancelled) setDetectDone(true) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.id])

  async function handleConnect(endpoint: string) {
    setConnecting(true)
    try {
      await onConnectRuntime({ routerUrl: endpoint, localRuntimeProtocol: 'auto' })
    } finally {
      setConnecting(false)
    }
  }

  async function handleSaveEdit() {
    if (!editUrl.trim()) return
    await handleConnect(editUrl.trim())
    setEditAddrOpen(false)
  }

  async function handleManualSave() {
    if (!manualUrl.trim()) return
    await handleConnect(manualUrl.trim())
    setManualOpen(false)
  }

  return (
    <div className="section" data-testid="drawer-runtime">
      <h4>{t('runtimeSectionTitle')}</h4>

      {isConnected ? (
        <div>
          <span className="tone-ok">
            {`✓ ${t('runtimeConnected')}`}
            {routerUrl ? ` · ${routerUrl}` : ''}
          </span>
          {' '}
          <button
            type="button"
            className="subtle"
            onClick={() => { setEditAddrOpen(v => !v); setEditUrl(routerUrl) }}
          >
            {t('runtimeEditAddr')}
          </button>
          {editAddrOpen && (
            <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
              <input
                className="field-input"
                value={editUrl}
                onChange={e => setEditUrl(e.target.value)}
                placeholder="http://127.0.0.1:11435/v1"
              />
              <button type="button" onClick={handleSaveEdit} disabled={connecting}>
                {connecting ? t('saving') : t('save')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <p>{t('runtimeNotConnected')}</p>
          {detectDone && detectedRuntimes.length > 0 && (
            <div data-testid="drawer-runtime-detect">
              {detectedRuntimes.map(rt => (
                <div key={rt.templateId} style={{ marginBottom: 8 }}>
                  <span className="tone-ok">
                    {`✓ ${t('runtimeDetected', { label: rt.label })} · ${rt.endpoint}`}
                  </span>
                  <div style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => handleConnect(rt.endpoint)}
                      disabled={connecting}
                      data-testid="drawer-runtime-connect"
                    >
                      {connecting ? t('saving') : t('runtimeConnectAll')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {detectDone && detectedRuntimes.length === 0 && (
            <p className="tone-muted">{t('runtimeNoneDetected')}</p>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="subtle"
              onClick={() => setManualOpen(v => !v)}
              data-testid="drawer-runtime-manual"
            >
              {t('runtimeManual')} {manualOpen ? '▴' : '▾'}
            </button>
            {manualOpen && (
              <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                <input
                  className="field-input"
                  value={manualUrl}
                  onChange={e => setManualUrl(e.target.value)}
                  placeholder="http://127.0.0.1:11435/v1"
                />
                <button type="button" onClick={handleManualSave} disabled={connecting || !manualUrl.trim()}>
                  {connecting ? t('saving') : t('save')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
