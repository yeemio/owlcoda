import { useRef, useState } from 'react'
import type { ModelStatus, UpdateModelFieldsPatch } from '../api/types'
import { CsvField, NumberField, TextField } from './FormFields'

interface Props {
  status: ModelStatus
  submitting: boolean
  error: string | null
  onSubmit: (patch: UpdateModelFieldsPatch) => void
  onCancel: () => void
}

/**
 * Whitelisted fields only — mirrors src/model-config-mutator.ts ALLOWED_PATCH_FIELDS.
 * default/apiKey/apiKeyEnv/id are NOT editable here (server rejects them).
 */
export function EditFieldsForm({ status, submitting, error, onSubmit, onCancel }: Props) {
  const cfg = status.raw.config
  const [label, setLabel] = useState(cfg?.label ?? status.label)
  const [aliases, setAliases] = useState<string[]>(cfg?.aliases ?? [])
  const [backendModel, setBackendModel] = useState(cfg?.backendModel ?? '')
  const [endpoint, setEndpoint] = useState(cfg?.endpoint ?? '')
  const [role, setRole] = useState(cfg?.role ?? '')
  const [contextWindow, setContextWindow] = useState<number | undefined>(cfg?.contextWindow)
  const [timeoutMs, setTimeoutMs] = useState<number | undefined>(cfg?.timeoutMs)
  const [headersRaw, setHeadersRaw] = useState(
    cfg?.headers ? JSON.stringify(cfg.headers, null, 2) : '',
  )
  const [headersError, setHeadersError] = useState<string | null>(null)
  // Baseline frozen at mount — patch diff is "what user actually changed",
  // not "what differs from server state", so we don't accidentally send
  // fields seeded from catalog or other non-config sources.
  const initial = useRef({
    label: cfg?.label ?? status.label,
    aliases: cfg?.aliases ?? [],
    backendModel: cfg?.backendModel ?? '',
    endpoint: cfg?.endpoint ?? '',
    role: cfg?.role ?? '',
    contextWindow: cfg?.contextWindow,
    timeoutMs: cfg?.timeoutMs,
    headersRaw: cfg?.headers ? JSON.stringify(cfg.headers, null, 2) : '',
  })

  function submit() {
    let headers: Record<string, string> | undefined
    if (headersRaw.trim() === '') {
      headers = undefined
    } else {
      try {
        const parsed = JSON.parse(headersRaw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setHeadersError('headers must be a JSON object')
          return
        }
        headers = parsed as Record<string, string>
      } catch {
        setHeadersError('invalid JSON')
        return
      }
    }
    setHeadersError(null)

    const i = initial.current
    const patch: UpdateModelFieldsPatch = {}
    if (label !== i.label) patch.label = label
    if (!arraysEqual(aliases, i.aliases)) patch.aliases = aliases
    if (backendModel && backendModel !== i.backendModel) patch.backendModel = backendModel
    if (endpoint && endpoint !== i.endpoint) patch.endpoint = endpoint
    if (role && role !== i.role) patch.role = role
    if (contextWindow !== i.contextWindow) patch.contextWindow = contextWindow
    if (timeoutMs !== i.timeoutMs) patch.timeoutMs = timeoutMs
    if (headersRaw !== i.headersRaw && headers) patch.headers = headers
    onSubmit(patch)
  }

  return (
    <div className="form" data-testid="edit-fields-form">
      <div className="form-hint">Editing whitelisted fields only. Default / API key are separate actions.</div>
      <TextField label="label" value={label} onChange={setLabel} testId="field-label" autoFocus />
      <CsvField label="aliases" values={aliases} onChange={setAliases} testId="field-aliases" />
      <TextField label="backendModel" value={backendModel} onChange={setBackendModel} testId="field-backendModel" />
      <TextField label="endpoint" value={endpoint} onChange={setEndpoint} testId="field-endpoint" placeholder="https://… (blank for router-routed)" />
      <TextField label="role" value={role} onChange={setRole} testId="field-role" />
      <NumberField label="contextWindow" value={contextWindow} onChange={setContextWindow} testId="field-contextWindow" />
      <NumberField label="timeoutMs" value={timeoutMs} onChange={setTimeoutMs} testId="field-timeoutMs" />
      <label className="field">
        <span className="field-label">headers (JSON)</span>
        <textarea
          className="field-textarea"
          rows={4}
          value={headersRaw}
          onChange={e => setHeadersRaw(e.target.value)}
          data-testid="field-headers"
          placeholder='{ "x-api-key": "…" }'
        />
      </label>
      {headersError && <div className="tone-err" data-testid="headers-error">{headersError}</div>}
      {error && <div className="banner err" data-testid="edit-error">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" onClick={submit} disabled={submitting} data-testid="edit-submit">
          {submitting ? 'Saving…' : 'Save fields'}
        </button>
      </div>
    </div>
  )
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}
