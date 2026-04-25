import { useState } from 'react'
import type { ModelStatus } from '../api/types'

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

  return (
    <div className="form" data-testid="confirm-delete">
      <div className="banner err">
        <strong>Delete <code>{status.id}</code> permanently?</strong>
        <div className="tone-muted" style={{ fontSize: 12, marginTop: 4 }}>
          This removes the entry from <code>config.json</code>. The entry cannot be recovered from the UI.
        </div>
      </div>
      <label className="field">
        <span className="field-label">type <code>{status.id}</code> to confirm</span>
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
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm || submitting}
          className="danger"
          data-testid="confirm-delete-submit"
        >
          {submitting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  )
}
