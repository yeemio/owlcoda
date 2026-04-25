import { useEffect, useState } from 'react'
import type {
  ApiKeyPayload,
  ModelStatus,
  ProviderProbeResult,
  UpdateModelFieldsPatch,
} from '../api/types'
import { availabilityFixHints, availabilityPhrase, availabilityTone } from '../lib/availability'
import { StatusIcon } from './StatusIcon'
import { EditFieldsForm } from './EditFieldsForm'
import { KeyForm } from './KeyForm'
import { TestConnectionPanel } from './TestConnectionPanel'
import { ConfirmDelete } from './ConfirmDelete'

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
}

export function ModelDrawer(props: Props) {
  const { status } = props
  const [mode, setMode] = useState<Mode>('idle')

  // Reset mode when selection changes.
  useEffect(() => { setMode('idle') }, [status?.id])

  if (!status) {
    return (
      <aside className="panel-right drawer" data-testid="drawer-empty">
        <div className="empty">Select a model to see details.</div>
      </aside>
    )
  }
  return (
    <aside className="panel-right drawer" data-testid="drawer">
      <h3>
        <StatusIcon availability={status.availability} />{' '}
        <span data-testid="drawer-label">{status.label}</span>
        {status.isDefault && <span className="tone-ok" style={{ marginLeft: 8 }} data-testid="drawer-default-badge">★ default</span>}
      </h3>
      <div className="sub" data-testid="drawer-id">{status.id}</div>

      <div className="section">
        <h4>Status</h4>
        <div className={`tone-${availabilityTone(status.availability)}`} data-testid="drawer-phrase">
          {availabilityPhrase(status.availability)}
        </div>
      </div>

      <div className="section">
        <h4>Presence</h4>
        <div className="presence">
          {(['config', 'router', 'discovered', 'catalog'] as const).map(key => (
            <span key={key} className={`tag${status.presentIn[key] ? ' active' : ''}`} data-testid={`presence-${key}`}>
              {key} {status.presentIn[key] ? '✓' : '–'}
            </span>
          ))}
        </div>
      </div>

      <ModelFacts status={status} />
      <FixHints status={status} />

      <div className="section">
        <h4>Actions</h4>
        <div className="actions">
          <button
            type="button"
            onClick={() => props.onSetDefault(status.id)}
            disabled={status.isDefault || props.setDefaultState.submitting}
            data-testid="action-set-default"
          >
            {props.setDefaultState.submitting ? 'Setting…' : status.isDefault ? 'Default' : 'Set default'}
          </button>
          <button type="button" onClick={() => setMode(mode === 'key' ? 'idle' : 'key')} data-testid="action-key">
            {mode === 'key' ? 'Close key editor' : 'Replace key'}
          </button>
          <button type="button" onClick={() => setMode(mode === 'edit' ? 'idle' : 'edit')} data-testid="action-edit">
            {mode === 'edit' ? 'Close editor' : 'Edit fields'}
          </button>
          <TestSavedButton status={status} onTest={props.onTestSaved} submitting={props.testSubmitting} />
          <button
            type="button"
            className="danger"
            onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}
            data-testid="action-delete"
          >
            {mode === 'delete' ? 'Close' : 'Delete'}
          </button>
        </div>
        {props.setDefaultState.error && (
          <div className="banner err" data-testid="set-default-error">{props.setDefaultState.error}</div>
        )}
      </div>

      {props.testResult || props.testError ? (
        <div className="section">
          <h4>Test result</h4>
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
          <h4>Edit fields</h4>
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
          <h4>API key</h4>
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
          <h4>Confirm delete</h4>
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
  return (
    <button
      type="button"
      onClick={() => onTest(status.id)}
      disabled={!canTest || submitting}
      data-testid="action-test"
      title={canTest ? undefined : 'Test connection requires an endpoint (cloud model)'}
    >
      {submitting ? 'Testing…' : 'Test'}
    </button>
  )
}

function ModelFacts({ status }: { status: ModelStatus }) {
  const cfg = status.raw.config
  const disc = status.raw.discovered
  const rows: Array<[string, string]> = []
  rows.push(['provider', status.providerKind])
  if (status.role) rows.push(['role', status.role])
  if (cfg?.backendModel && cfg.backendModel !== status.id) rows.push(['backendModel', cfg.backendModel])
  if (cfg?.endpoint) rows.push(['endpoint', cfg.endpoint])
  if (cfg?.aliases && cfg.aliases.length > 0) rows.push(['aliases', cfg.aliases.join(', ')])
  if (cfg?.contextWindow) rows.push(['contextWindow', String(cfg.contextWindow)])
  if (cfg?.timeoutMs) rows.push(['timeoutMs', String(cfg.timeoutMs)])
  if (cfg?.apiKeyEnv) rows.push(['apiKeyEnv', cfg.apiKeyEnv])
  if (cfg?.apiKey?.set) rows.push(['apiKey', '(set)'])
  if (disc) {
    rows.push(['discovered-backend', `${disc.backend} @ ${disc.baseUrl}`])
    if (disc.parameterSize) rows.push(['parameterSize', disc.parameterSize])
    if (disc.quantization) rows.push(['quantization', disc.quantization])
  }

  if (rows.length === 0) return null
  return (
    <div className="section">
      <h4>Facts</h4>
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
  const hints = availabilityFixHints(status.availability)
  if (hints.length === 0) return null
  return (
    <div className="section">
      <h4>Next steps</h4>
      <div className="hints" data-testid="fix-hints">
        {hints.map((h, i) => <div key={i} className="hint">{h}</div>)}
      </div>
    </div>
  )
}
