import type { ModelStatus } from '../api/types'
import { overviewCounts } from '../lib/availability'
import { StatusIcon } from './StatusIcon'

interface Props {
  statuses: ModelStatus[]
  defaultModel: ModelStatus | undefined
  refreshedAt: number
  cacheHit: boolean
}

export function OverviewSummary({ statuses, defaultModel, refreshedAt, cacheHit }: Props) {
  const counts = overviewCounts(statuses)
  const ageMs = Math.max(0, Date.now() - refreshedAt)
  const age = ageMs < 1000 ? 'just now' : ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s ago` : `${Math.floor(ageMs / 60_000)}m ago`

  return (
    <section className="overview" data-testid="overview">
      <div className="card default" data-testid="overview-default">
        <div className="label">Default</div>
        <div className="value">
          {defaultModel ? (
            <>
              <StatusIcon availability={defaultModel.availability} />{' '}
              <span data-testid="overview-default-label">{defaultModel.label}</span>
            </>
          ) : (
            <span className="tone-muted">(none)</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="label">Status</div>
        <div className="value">
          <span className="tone-ok" data-testid="overview-ok-count">{counts.ok}</span>
          <span className="tone-muted"> / </span>
          <span data-testid="overview-total">{counts.total}</span>
          <span className="tone-muted"> ok</span>
        </div>
      </div>

      <div className="card">
        <div className="label">Blocked</div>
        <div className={counts.blocked > 0 ? 'value tone-err' : 'value tone-muted'} data-testid="overview-blocked">
          {counts.blocked}
        </div>
      </div>

      <div className="card">
        <div className="label">Orphan</div>
        <div className={counts.orphan > 0 ? 'value tone-info' : 'value tone-muted'} data-testid="overview-orphan">
          {counts.orphan}
        </div>
      </div>

      <div className="card">
        <div className="label">Local / Cloud</div>
        <div className="value">
          {counts.local}
          <span className="tone-muted"> · </span>
          {counts.cloud}
        </div>
      </div>

      <div className="card">
        <div className="label">Refreshed</div>
        <div className="value" style={{ fontSize: 13 }}>
          {age}
          {cacheHit && <span className="tone-muted"> (cache)</span>}
        </div>
      </div>
    </section>
  )
}
