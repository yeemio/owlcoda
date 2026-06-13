import type { ProviderProbeResult } from '../api/types'
import { useI18n } from '../i18n'

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
  const { t } = useI18n()
  return (
    <div className="test-panel" data-testid={`${testIdPrefix}-panel`}>
      <button
        type="button"
        onClick={onTest}
        disabled={submitting || disabled}
        data-testid={`${testIdPrefix}-run`}
      >
        {submitting ? t('testing') : t('testConnection')}
      </button>

      {result && (
        <div
          className={result.ok ? 'test-result tone-ok' : 'test-result tone-err'}
          data-testid={`${testIdPrefix}-result`}
        >
          {result.ok ? '● ' : '✕ '}
          <strong>{result.ok ? 'OK' : t('failed')}</strong>{' '}
          <span className="tone-muted">
            {t('statusLatency', { status: result.status, latency: result.latencyMs })}
          </span>
          <dl className="test-route" data-testid={`${testIdPrefix}-route`}>
            {result.provider && (
              <div>
                <dt>{t('providerLower')}</dt>
                <dd>{result.provider}</dd>
              </div>
            )}
            {result.backendModel && (
              <div>
                <dt>{t('modelTested')}</dt>
                <dd>{result.backendModel}</dd>
              </div>
            )}
            {result.resolvedModel && (
              <div>
                <dt>{t('modelReal')}</dt>
                <dd>
                  {result.resolvedModel.displayName ?? result.resolvedModel.id}
                  {result.resolvedModel.displayName &&
                    result.resolvedModel.id !== result.resolvedModel.displayName && (
                      <span className="tone-muted"> ({result.resolvedModel.id})</span>
                    )}
                </dd>
              </div>
            )}
            {result.endpoint && (
              <div>
                <dt>{t('routeTested')}</dt>
                <dd>{result.endpoint}</dd>
              </div>
            )}
          </dl>
          {result.detail && <div className="test-detail">{result.detail}</div>}
          {result.bodySnippet && (
            <pre className="test-snippet" data-testid={`${testIdPrefix}-body-snippet`}>{result.bodySnippet}</pre>
          )}
        </div>
      )}
      {error && !result && (
        <div className="test-result tone-err" data-testid={`${testIdPrefix}-error`}>{error}</div>
      )}
    </div>
  )
}
