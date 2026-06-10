import { useState } from 'react'
import type { ModelStatus } from '../api/types'
import { useI18n } from '../i18n'

interface Props {
  status: ModelStatus
  submitting: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Two-step delete confirm: user must type the id to confirm. */
export function ConfirmDelete({ status, submitting, error, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState('')
  const canConfirm = typed === status.id
  const { t } = useI18n()

  return (
    <div className="form" data-testid="confirm-delete">
      <div className="banner err">
        <strong>{t('deletePermanently', { id: status.id })}</strong>
        <div className="tone-muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('deleteIrreversible')}
        </div>
      </div>
      <label className="field">
        <span className="field-label">{t('typeToConfirm', { id: status.id })}</span>
        <input
          className="field-input"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          data-testid="confirm-typed"
          autoFocus
        />
      </label>
      {error && <div className="banner err" data-testid="delete-error">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>{t('cancel')}</button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm || submitting}
          className="danger"
          data-testid="confirm-delete-submit"
        >
          {submitting ? t('deleting') : t('delete')}
        </button>
      </div>
    </div>
  )
}
