import type { ProviderProbeResult } from '../api/types'

interface Props {
  onTest: () => void
  submitting: boolean
  result: ProviderProbeResult | null
  error: string | null
  disabled?: boolean
  testIdPrefix?: string
}

/** Reusable test-connection button + result banner. Used in drawer and Add dialog. */
export function TestConnectionPanel({ onTest, submitting, result, error, disabled, testIdPrefix = 'test' }: Props) {
  return (
    <div className="test-panel" data-testid={`${testIdPrefix}-panel`}>
      <button
        type="button"
        onClick={onTest}
        disabled={submitting || disabled}
        data-testid={`${testIdPrefix}-run`}
      >
        {submitting ? 'Testing…' : 'Test connection'}
      </button>

      {result && (
        <div
          className={result.ok ? 'test-result tone-ok' : 'test-result tone-err'}
          data-testid={`${testIdPrefix}-result`}
        >
          {result.ok ? '● ' : '✕ '}
          <strong>{result.ok ? 'OK' : 'Failed'}</strong>{' '}
          <span className="tone-muted">
            status {result.status} · {result.latencyMs}ms
          </span>
          {result.detail && <div className="test-detail">{result.detail}</div>}
        </div>
      )}
      {error && !result && (
        <div className="test-result tone-err" data-testid={`${testIdPrefix}-error`}>{error}</div>
      )}
    </div>
  )
}
