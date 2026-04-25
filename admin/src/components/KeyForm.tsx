import { useState } from 'react'
import type { ApiKeyPayload, ModelStatus } from '../api/types'
import { TextField } from './FormFields'

interface Props {
  status: ModelStatus
  submitting: boolean
  error: string | null
  onSubmit: (payload: ApiKeyPayload) => void
  onCancel: () => void
}

type Mode = 'inline' | 'env'

export function KeyForm({ status, submitting, error, onSubmit, onCancel }: Props) {
  const cfg = status.raw.config
  const currentEnv = cfg?.apiKeyEnv ?? ''
  const currentInlineSet = cfg?.apiKey?.set === true

  const [mode, setMode] = useState<Mode>(currentEnv ? 'env' : 'inline')
  const [apiKey, setApiKey] = useState('')
  const [envName, setEnvName] = useState(currentEnv)
  const [validation, setValidation] = useState<string | null>(null)

  function submit() {
    if (mode === 'inline') {
      if (!apiKey.trim()) {
        setValidation('API key cannot be empty')
        return
      }
      setValidation(null)
      onSubmit({ apiKey })
    } else {
      if (!envName.trim()) {
        setValidation('env name cannot be empty')
        return
      }
      setValidation(null)
      onSubmit({ apiKeyEnv: envName.trim() })
    }
  }

  return (
    <div className="form" data-testid="key-form">
      <div className="form-hint">
        Current: {currentEnv ? <span data-testid="key-current-env">env <code>{currentEnv}</code></span>
          : currentInlineSet ? <span data-testid="key-current-inline">inline (set)</span>
            : <span className="tone-muted" data-testid="key-current-none">none</span>}
      </div>

      <div className="filter" role="tablist" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className={mode === 'inline' ? 'active' : ''}
          onClick={() => setMode('inline')}
          data-testid="key-mode-inline"
        >Inline</button>
        <button
          type="button"
          className={mode === 'env' ? 'active' : ''}
          onClick={() => setMode('env')}
          data-testid="key-mode-env"
        >Env</button>
      </div>

      {mode === 'inline' ? (
        <TextField
          label="new apiKey"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          testId="field-apiKey"
          autoFocus
          placeholder="value will be written to config.json"
        />
      ) : (
        <TextField
          label="env var name"
          value={envName}
          onChange={setEnvName}
          testId="field-apiKeyEnv"
          autoFocus
          placeholder="e.g. KIMI_API_KEY"
        />
      )}

      {validation && <div className="tone-err" data-testid="key-validation">{validation}</div>}
      {error && <div className="banner err" data-testid="key-error">{error}</div>}

      <div className="form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" onClick={submit} disabled={submitting} data-testid="key-submit">
          {submitting ? 'Saving…' : 'Save key'}
        </button>
      </div>
      <div className="tone-muted" style={{ fontSize: 11, marginTop: 6 }}>
        Secrets are never read back from the server. Status shown as "set" / env name only.
        (model: {status.id})
      </div>
    </div>
  )
}
