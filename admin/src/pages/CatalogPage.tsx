import { useEffect, useMemo, useState } from 'react'
import { bulkCreateModels, fetchCatalog } from '../api/client'
import type {
  BulkCreateItem,
  CatalogResponse,
  CreateEndpointModelPatch,
  ModelTruthSnapshot,
} from '../api/types'
import { BatchResultList } from '../components/BatchResultList'
import { PageHeader } from '../components/PageHeader'
import { Pill } from '../components/Pill'
import { useBatchMutation } from '../hooks/useBatchMutation'
import { useI18n } from '../i18n'

type ImportStatus = 'configured' | 'orphan' | 'not-imported'

interface CatalogRow {
  id: string
  backend?: string
  role?: string
  endpoint?: string
  channel?: string
  contextWindow?: number
  status: ImportStatus
  raw: unknown
}

interface Props {
  snapshot: ModelTruthSnapshot
  onSnapshotUpdate: (snapshot: ModelTruthSnapshot) => void
  /** Handoff target — catalog id to pre-select / scroll into view. */
  initialSelect?: string
}

interface DraftPlan {
  selected: boolean
  endpoint: string
  apiKey: string
  apiKeyEnv: string
  keyMode: 'inline' | 'env' | 'none'
}

function seedDraft(row: CatalogRow): DraftPlan {
  return {
    selected: false,
    endpoint: row.endpoint ?? '',
    apiKey: '',
    apiKeyEnv: '',
    keyMode: row.endpoint ? 'none' : 'none',
  }
}

/**
 * Heuristic: derive a coarse provider id from a catalog row's endpoint URL.
 * Mirrors the design's `providerOf` — endpoints we don't recognize fall into
 * `openai-compat` for cloud rows, or `local` for rows without an endpoint.
 */
function providerOf(endpoint: string | undefined, channel: string | undefined): string {
  if (!endpoint || channel === 'local') return 'local'
  const e = endpoint.toLowerCase()
  if (e.includes('anthropic')) return 'anthropic'
  if (e.includes('minimax')) return 'minimax'
  if (e.includes('moonshot') || e.includes('kimi')) return 'moonshot'
  if (e.includes('deepseek')) return 'deepseek'
  if (e.includes('mistral')) return 'mistral'
  if (e.includes('openrouter')) return 'openrouter'
  if (e.includes('dashscope') || e.includes('bailian')) return 'bailian'
  return 'openai-compat'
}

function providerLabel(id: string): string {
  switch (id) {
    case 'anthropic': return 'Anthropic'
    case 'minimax': return 'MiniMax'
    case 'moonshot': return 'Moonshot · Kimi'
    case 'deepseek': return 'DeepSeek'
    case 'mistral': return 'Mistral'
    case 'openrouter': return 'OpenRouter'
    case 'bailian': return 'Bailian / DashScope'
    case 'openai-compat': return 'OpenAI-compatible'
    case 'local': return 'Local'
    default: return id
  }
}

/**
 * Catalog import is deliberately restricted to catalog entries that carry a
 * cloud endpoint. Entries without endpoint are local/backend models — they
 * belong to the Orphans flow, not catalog import. The UI will:
 *   - disable the selection checkbox for non-endpoint rows
 *   - show "local-only" pill + link to Orphans in the detail drawer
 *   - refuse to emit them in the bulk/create payload even if a stale draft
 *     state lingers from before this restriction landed.
 */
export function isCatalogImportable(row: CatalogRow): boolean {
  return row.status === 'not-imported' && Boolean(row.endpoint && row.endpoint.trim())
}

export function CatalogPage({ snapshot, onSnapshotUpdate, initialSelect }: Props) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImportStatus | 'all'>('not-imported')
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(initialSelect ?? null)
  const [drafts, setDrafts] = useState<Record<string, DraftPlan>>({})
  const [didHandoffAdjust, setDidHandoffAdjust] = useState(false)

  useEffect(() => {
    fetchCatalog()
      .then(setCatalog)
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  const rows = useMemo<CatalogRow[]>(() => {
    if (!catalog) return []
    const configuredIds = new Set<string>()
    const orphanIds = new Set<string>()
    for (const s of snapshot.statuses) {
      if (s.raw.config) configuredIds.add(s.id)
      if (s.availability.kind === 'orphan_discovered') orphanIds.add(s.id)
    }
    return catalog.items.map((item): CatalogRow => {
      const raw = item as Record<string, unknown>
      const id = String(raw.id ?? '')
      const status: ImportStatus = configuredIds.has(id)
        ? 'configured'
        : orphanIds.has(id)
          ? 'orphan'
          : 'not-imported'
      return {
        id,
        backend: typeof raw.backend === 'string' ? raw.backend : undefined,
        role: typeof raw.priority_role === 'string' ? raw.priority_role : undefined,
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
        channel: typeof raw.channel === 'string' ? raw.channel : undefined,
        contextWindow: typeof raw.context_window === 'number' ? raw.context_window : undefined,
        status,
        raw,
      }
    })
  }, [catalog, snapshot.statuses])

  // Keep drafts map in sync with catalog rows.
  useEffect(() => {
    setDrafts(prev => {
      const next: Record<string, DraftPlan> = {}
      for (const r of rows) next[r.id] = prev[r.id] ?? seedDraft(r)
      return next
    })
  }, [rows])

  const providerOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) seen.add(providerOf(r.endpoint, r.channel))
    return Array.from(seen).sort()
  }, [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (filter !== 'all' && r.status !== filter) return false
      if (providerFilter !== 'all' && providerOf(r.endpoint, r.channel) !== providerFilter) return false
      if (q && !`${r.id} ${r.backend ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, filter, query, providerFilter])

  // If the handoff-selected catalog id isn't visible under the default
  // filter ("not-imported"), auto-switch to "all" so the user sees their
  // target. Only fire once on arrival.
  useEffect(() => {
    if (didHandoffAdjust) return
    if (!initialSelect || rows.length === 0) return
    const targetRow = rows.find(r => r.id === initialSelect)
    if (!targetRow) {
      setDidHandoffAdjust(true)
      return
    }
    if (!visible.some(r => r.id === initialSelect)) {
      setFilter('all')
    }
    setDidHandoffAdjust(true)
    // scroll target into view
    if (typeof document !== 'undefined') {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>(`[data-testid="catalog-row-${initialSelect}"]`)
        if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
      })
    }
  }, [didHandoffAdjust, initialSelect, rows, visible])

  const counts = useMemo(() => ({
    total: rows.length,
    configured: rows.filter(r => r.status === 'configured').length,
    orphan: rows.filter(r => r.status === 'orphan').length,
    notImported: rows.filter(r => r.status === 'not-imported').length,
  }), [rows])

  const batch = useBatchMutation<[BulkCreateItem[]]>(async (items) => bulkCreateModels(items))

  const selected = selectedId ? rows.find(r => r.id === selectedId) ?? null : null

  function toggle(id: string) {
    setDrafts(prev => {
      const existing = prev[id]
      const fallbackRow = existing ? undefined : rows.find(r => r.id === id)
      const current = existing ?? (fallbackRow ? seedDraft(fallbackRow) : undefined)
      if (!current) return prev
      return { ...prev, [id]: { ...current, selected: !current.selected } }
    })
  }

  function updateDraft(id: string, patch: Partial<DraftPlan>) {
    setDrafts(prev => {
      const existing = prev[id]
      const fallbackRow = existing ? undefined : rows.find(r => r.id === id)
      const current = existing ?? (fallbackRow ? seedDraft(fallbackRow) : undefined)
      if (!current) return prev
      return { ...prev, [id]: { ...current, ...patch } }
    })
  }

  const items = useMemo<BulkCreateItem[]>(() => {
    const out: BulkCreateItem[] = []
    for (const r of rows) {
      if (!isCatalogImportable(r)) continue
      const d = drafts[r.id]
      if (!d?.selected) continue
      // Only the catalog-native endpoint is honoured. Users cannot smuggle a
      // local/backend entry in by hand-filling the endpoint field — that
      // ambiguous path (was it really cloud? or a local mis-routed to HTTP?)
      // lives on the Orphans page after backend discovery.
      const endpoint = r.endpoint!
      const patch: CreateEndpointModelPatch = {
        id: r.id,
        label: r.id,
        endpoint,
        role: r.role,
        contextWindow: r.contextWindow,
      }
      out.push({ model: patch })
    }
    return out
  }, [drafts, rows])

  async function execute() {
    if (items.length === 0) return
    const res = await batch.run(items)
    if (res?.snapshot) onSnapshotUpdate(res.snapshot)
  }

  if (loadError) {
    return (
      <section className="panel full">
        <div className="banner err" data-testid="catalog-load-error">{t('catalogLoadFailed')} {loadError}</div>
      </section>
    )
  }
  if (!catalog) {
    return <section className="panel full"><div className="empty">{t('loadingCatalog')}</div></section>
  }

  return (
    <div className="app-main">
      <section className="panel">
        <PageHeader
          eyebrow={t('codingModels')}
          title={t('catalog')}
          sub={t('catalogSub', { version: catalog.catalogVersion ?? '?' })}
          right={<Pill kind="muted" testId="catalog-total">{t('entries', { count: counts.total })}</Pill>}
        />

        <div className="toolbar">
          <input
            type="search"
            placeholder={t('searchCatalog')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            data-testid="catalog-search"
            style={{ minWidth: 200 }}
          />
          <select
            value={providerFilter}
            onChange={e => setProviderFilter(e.target.value)}
            data-testid="catalog-provider-filter"
          >
            <option value="all">{t('allProviders')}</option>
            {providerOptions.map(p => (
              <option key={p} value={p}>{providerLabel(p)}</option>
            ))}
          </select>
          <div className="filter" role="tablist">
            {(['not-imported', 'orphan', 'configured', 'all'] as const).map(f => (
              <button
                key={f}
                type="button"
                className={filter === f ? 'active' : ''}
                onClick={() => setFilter(f)}
                data-testid={`catalog-filter-${f}`}
              >
                {f === 'not-imported' ? `${t('notImported')} (${counts.notImported})`
                  : f === 'orphan' ? `${t('orphan')} (${counts.orphan})`
                    : f === 'configured' ? `${t('configured')} (${counts.configured})`
                      : `${t('all')} (${counts.total})`}
              </button>
            ))}
          </div>
          <span className="count" data-testid="catalog-visible-count">{t('showing')} {visible.length}</span>
        </div>

        <ul className="catalog-list" data-testid="catalog-list">
          {visible.map(r => {
            const d = drafts[r.id] ?? seedDraft(r)
            const importable = isCatalogImportable(r)
            const unimportableReason = r.status !== 'not-imported'
              ? null
              : !r.endpoint
                ? 'local (bind via Orphans)'
                : null
            return (
              <li
                key={r.id}
                className={`catalog-row status-${r.status}${selectedId === r.id ? ' active' : ''}${!importable && r.status === 'not-imported' ? ' unimportable' : ''}`}
                data-testid={`catalog-row-${r.id}`}
                data-status={r.status}
                data-importable={importable ? 'true' : 'false'}
              >
                <label className="catalog-check">
                  <input
                    type="checkbox"
                    checked={importable ? d.selected : false}
                    onChange={() => importable && toggle(r.id)}
                    disabled={!importable}
                    data-testid={`catalog-check-${r.id}`}
                  />
                </label>
                <button
                  type="button"
                  className="catalog-link"
                  onClick={() => setSelectedId(r.id)}
                  data-testid={`catalog-select-${r.id}`}
                >
                  <span className="name">{r.id}</span>
                  {r.role && <span className="tone-muted"> · {r.role}</span>}
                </button>
                <span className={`status-pill status-${r.status}`} data-testid={`catalog-status-${r.id}`}>
                  {r.status === 'configured' ? t('configuredStatus')
                    : r.status === 'orphan' ? t('orphanStatus')
                      : importable ? t('import') : t('localOnly')}
                </span>
                {unimportableReason && (
                  <span className="tone-muted" style={{ fontSize: 11 }} data-testid={`catalog-unimportable-${r.id}`}>
                    {unimportableReason}
                  </span>
                )}
              </li>
            )
          })}
        </ul>

        <div className="batch-bar">
          <span className="tone-muted" data-testid="catalog-selected-count">
            {t('selectedForImport', { count: items.length })}
          </span>
          <div className="spacer" />
          <button
            type="button"
            onClick={execute}
            disabled={items.length === 0 || batch.status === 'submitting'}
            data-testid="catalog-execute"
          >
            {batch.status === 'submitting' ? t('importing') : t('importSelected')}
          </button>
        </div>

        {batch.error && <div className="banner err" data-testid="catalog-error">{batch.error}</div>}
        <BatchResultList results={batch.results} testId="catalog-batch-results" />
      </section>

      <aside className="panel-right drawer" data-testid="catalog-drawer">
        {!selected ? (
          <div className="empty">{t('selectCatalogEntry')}</div>
        ) : (
          <CatalogDetail
            row={selected}
            draft={drafts[selected.id] ?? seedDraft(selected)}
            onUpdateDraft={patch => updateDraft(selected.id, patch)}
            t={t}
          />
        )}
      </aside>
    </div>
  )
}

interface DetailProps {
  row: CatalogRow
  draft: DraftPlan
  onUpdateDraft: (patch: Partial<DraftPlan>) => void
  t: ReturnType<typeof useI18n>['t']
}

function CatalogDetail({ row, draft, onUpdateDraft, t }: DetailProps) {
  const importable = isCatalogImportable(row)
  const isLocalOnly = row.status === 'not-imported' && !row.endpoint
  return (
    <div className="drawer" data-testid={`catalog-detail-${row.id}`}>
      <h3>{row.id}</h3>
      <div className="sub">
        <span className={`status-pill status-${row.status}`}>{row.status}</span>
        {row.channel && <span className="tone-muted"> · {row.channel}</span>}
      </div>

      <div className="section">
        <h4>{t('facts')}</h4>
        <dl className="kv">
          {row.backend && <><dt>{t('backend')}</dt><dd>{row.backend}</dd></>}
          {row.role && <><dt>role</dt><dd>{row.role}</dd></>}
          {row.endpoint && <><dt>{t('endpointCatalog')}</dt><dd>{row.endpoint}</dd></>}
          {row.contextWindow && <><dt>contextWindow</dt><dd>{row.contextWindow}</dd></>}
        </dl>
      </div>

      {isLocalOnly && (
        <div className="section" data-testid="catalog-note-no-endpoint">
          <div className="banner" style={{ background: 'transparent' }}>
            <strong className="tone-info">{t('localBackendEntry')}</strong>
            <div className="tone-muted" style={{ fontSize: 12, marginTop: 4 }}>
              {t('localBackendHelp')}{' '}
              <a href="#/orphans" data-testid="catalog-goto-orphans">{t('orphans')}</a>
            </div>
          </div>
        </div>
      )}

      {importable && (
        <div className="section">
          <h4>{t('importTitle')}</h4>
          <div className="tone-muted" style={{ fontSize: 11, marginBottom: 6 }}>
            {t('importHint')} <code>{row.endpoint}</code>
          </div>
          <label className="catalog-select-for-batch" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={draft.selected}
              onChange={e => onUpdateDraft({ selected: e.target.checked })}
              data-testid="catalog-draft-select"
            />
            {t('includeBatch')}
          </label>
        </div>
      )}

      {!importable && (
        <div className="section tone-muted">
          {row.status === 'configured'
            ? t('alreadyConfigured')
            : t('discoveredBindOrphans')}
        </div>
      )}
    </div>
  )
}
