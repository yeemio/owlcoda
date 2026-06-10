import type { ModelStatus } from '../api/types'
import { overviewCounts } from '../lib/availability'
import { StatusIcon } from './StatusIcon'
import { useI18n } from '../i18n'

interface Props {
  statuses: ModelStatus[]
  defaultModel: ModelStatus | undefined
  refreshedAt: number
  cacheHit: boolean
  configSourceLabel?: string
}

export function OverviewSummary({ statuses, defaultModel, refreshedAt, cacheHit, configSourceLabel }: Props) {
  const { t } = useI18n()
  const counts = overviewCounts(statuses)
  const ageMs = Math.max(0, Date.now() - refreshedAt)
  const age = ageMs < 1000 ? t('justNow')
    : ageMs < 60_000 ? t('secondsAgo', { count: Math.floor(ageMs / 1000) })
      : t('minutesAgo', { count: Math.floor(ageMs / 60_000) })

  return (
    <section className="overview" data-testid="overview">
      <div className="card default" data-testid="overview-default">
        <div className="label">{t('default')}</div>
        <div className="value">
          {defaultModel ? (
            <>
              <StatusIcon availability={defaultModel.availability} />{' '}
              <span data-testid="overview-default-label">{defaultModel.label}</span>
            </>
          ) : (
            <span className="tone-muted">{t('noneParen')}</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="label">{t('status')}</div>
        <div className="value">
          <span className="tone-ok" data-testid="overview-ok-count">{counts.ok}</span>
          <span className="tone-muted"> / </span>
          <span data-testid="overview-total">{counts.total}</span>
          <span className="tone-muted"> {t('ok')}</span>
        </div>
      </div>

      <div className="card">
        <div className="label">{t('blocked')}</div>
        <div className={counts.blocked > 0 ? 'value tone-err' : 'value tone-muted'} data-testid="overview-blocked">
          {counts.blocked}
        </div>
      </div>

      <div className="card">
        <div className="label">{t('configSource')}</div>
        <div className="value" style={{ fontSize: 13 }} data-testid="overview-config-source">
          {configSourceLabel ?? t('localProfile')}
        </div>
      </div>

      <div className="card">
        <div className="label">{t('localCloud')}</div>
        <div className="value">
          {counts.local}
          <span className="tone-muted"> · </span>
          {counts.cloud}
        </div>
      </div>

      <div className="card">
        <div className="label">{t('foundNotConfigured')}</div>
        <div className={counts.orphan > 0 ? 'value tone-info' : 'value tone-muted'} data-testid="overview-orphan">
          {counts.orphan}
        </div>
      </div>

      <div className="card">
        <div className="label">{t('refreshed')}</div>
        <div className="value" style={{ fontSize: 13 }}>
          {age}
          {cacheHit && <span className="tone-muted"> ({t('cache')})</span>}
        </div>
      </div>
    </section>
  )
}
