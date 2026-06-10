import { useState } from 'react'
import type { ApiKeyPayload, ModelStatus } from '../api/types'
import { TextField } from './FormFields'
import { useI18n } from '../i18n'

interface Props {
  status: ModelStatus
  submitting: boolean
  error: string | null
  onSubmit: (payload: ApiKeyPayload) => void
  onCancel: () => void
}

type Mode = 'inline' | 'env'

export function KeyForm({ status, submitting, error, onSubmit, onCancel }: Props) {
  const { t } = useI18n()
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
        setValidation(t('apiKeyEmpty'))
        return
      }
      setValidation(null)
      onSubmit({ apiKey })
    } else {
      if (!envName.trim()) {
        setValidation(t('envNameEmpty'))
        return
      }
      setValidation(null)
      onSubmit({ apiKeyEnv: envName.trim() })
    }
  }

  return (
    <div className="form" data-testid="key-form">
      <div className="form-hint">
        {t('current')} {currentEnv ? <span data-testid="key-current-env">env <code>{currentEnv}</code></span>
          : currentInlineSet ? <span data-testid="key-current-inline">{t('inlineSet')}</span>
            : <span className="tone-muted" data-testid="key-current-none">{t('keyNone')}</span>}
      </div>

      <div className="filter" role="tablist" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className={mode === 'inline' ? 'active' : ''}
          onClick={() => setMode('inline')}
          data-testid="key-mode-inline"
        >{t('inline')}</button>
        <button
          type="button"
          className={mode === 'env' ? 'active' : ''}
          onClick={() => setMode('env')}
          data-testid="key-mode-env"
        >{t('env')}</button>
      </div>

      {mode === 'inline' ? (
        <TextField
          label={t('newApiKey')}
          type="password"
          value={apiKey}
          onChange={setApiKey}
          testId="field-apiKey"
          autoFocus
          placeholder={t('keyPlaceholder')}
        />
      ) : (
        <TextField
          label={t('envVarName')}
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
        <button type="button" onClick={onCancel} disabled={submitting}>{t('cancel')}</button>
        <button type="button" onClick={submit} disabled={submitting} data-testid="key-submit">
          {submitting ? t('saving') : t('saveKey')}
        </button>
      </div>
      <div className="tone-muted" style={{ fontSize: 11, marginTop: 6 }}>
        {t('secretsNotRead')}
        (model: {status.id})
      </div>
    </div>
  )
}
