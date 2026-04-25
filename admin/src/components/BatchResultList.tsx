import type { BatchResultItem } from '../api/types'

interface Props {
  results: BatchResultItem[]
  /** Optional id → human label lookup for nicer result rows. */
  labelFor?: (id: string) => string | undefined
  testId?: string
}

/**
 * Per-item batch result renderer. Used by every δ batch flow so the shape is
 * identical — users learn it once.
 */
export function BatchResultList({ results, labelFor, testId }: Props) {
  if (results.length === 0) return null
  const okCount = results.filter(r => r.ok).length
  const failCount = results.length - okCount
  return (
    <div className="batch-results" data-testid={testId ?? 'batch-results'}>
      <div className="batch-summary">
        <span className="tone-ok" data-testid="batch-ok-count">{okCount} ok</span>
        {failCount > 0 && (
          <>
            <span className="tone-muted"> · </span>
            <span className="tone-err" data-testid="batch-fail-count">{failCount} failed</span>
          </>
        )}
      </div>
      <ul className="batch-list">
        {results.map(r => (
          <li
            key={r.id}
            className={r.ok ? 'batch-item tone-ok' : 'batch-item tone-err'}
            data-testid={`batch-result-${r.id}`}
            data-ok={r.ok ? 'true' : 'false'}
          >
            <span className="glyph">{r.ok ? '●' : '✕'}</span>
            <span className="label">{labelFor?.(r.id) ?? r.id}</span>
            {!r.ok && r.error && (
              <span className="error-detail">
                {' '}— {r.error.code}: {r.error.message}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
