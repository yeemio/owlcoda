import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  bulkCreateModels,
  createEndpointModel as apiCreateEndpointModel,
  deleteModel as apiDeleteModel,
  fetchConfig,
  setDefaultModel as apiSetDefaultModel,
  setModelKey,
  testSavedModel,
  updateModelFields,
  updateRuntimeSettings,
} from '../api/client'
import type {
  ApiKeyPayload,
  BatchResponse,
  CreateEndpointModelPatch,
  LocalRuntimeProtocol,
  ModelStatus,
  ModelTruthSnapshot,
  ProviderProbeResult,
  UpdateModelFieldsPatch,
} from '../api/types'
import { AddModelDialog } from '../components/AddModelDialog'
import { ModelDrawer } from '../components/ModelDrawer'
import { ModelList } from '../components/ModelList'
import { OverviewSummary } from '../components/OverviewSummary'
import { useMutation } from '../hooks/useMutation'
import { filterIssues, sortStatuses } from '../lib/availability'
import { useI18n } from '../i18n'

type FilterMode = 'all' | 'configured' | 'issues' | 'orphans'

interface Props {
  snapshot: ModelTruthSnapshot
  onRefresh: () => void
  onSnapshotUpdate: (snapshot: ModelTruthSnapshot) => void
  loading: boolean
  initialFilter?: FilterMode
  initialView?: string
  initialProvider?: string
  /** Handoff target — model id to pre-select on first mount. */
  initialSelect?: string
}

function pickInitialSelection(visible: ModelStatus[]): string | null {
  if (visible.length === 0) return null
  const def = visible.find(s => s.isDefault)
  return (def ?? visible[0]!).id
}

export function ModelsPage({
  snapshot,
  onRefresh,
  onSnapshotUpdate,
  loading,
  initialFilter = 'all',
  initialView,
  initialProvider,
  initialSelect,
}: Props) {
  const { t } = useI18n()
  // Handoff target resolution: if the incoming select isn't visible under the
  // incoming filter, flip to 'all' on first mount so the context isn't
  // silently dropped. Otherwise honour initialFilter.
  const sortedAll = useMemo(() => sortStatuses(snapshot.statuses), [snapshot.statuses])
  const issuesAll = useMemo(() => filterIssues(sortedAll), [sortedAll])
  const handoffResolvedFilter: FilterMode = (() => {
    if (!initialSelect) return initialFilter
    const inIssues = issuesAll.some(s => s.id === initialSelect)
    const inAll = sortedAll.some(s => s.id === initialSelect)
    if (initialFilter === 'issues' && !inIssues && inAll) return 'all'
    return initialFilter
  })()

  const [filter, setFilter] = useState<FilterMode>(handoffResolvedFilter)
  const [addOpen, setAddOpen] = useState(initialView === 'add')

  // Empty state: no configured models in config (presentIn.config === true).
  const configuredCount = useMemo(
    () => snapshot.statuses.filter(s => s.presentIn.config).length,
    [snapshot.statuses],
  )

  const sorted = sortedAll
  const issues = issuesAll
  const configured = useMemo(() => sortedAll.filter(s => s.raw.config !== undefined), [sortedAll])
  const orphans = useMemo(() => sortedAll.filter(s => s.availability.kind === 'orphan_discovered'), [sortedAll])
  const discoveredLocalModels = useMemo(() =>
    orphans
      .filter(s => s.raw.discovered?.id != null)
      .map(s => {
        const d = s.raw.discovered!
        return { id: d.id, backend: d.backend, contextWindow: d.contextWindow, label: d.label }
      }),
  [orphans])
  const visible = filter === 'issues' ? issues
    : filter === 'configured' ? configured
      : filter === 'orphans' ? orphans
        : sorted

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (initialSelect) {
      const pool = handoffResolvedFilter === 'issues' ? issues : sorted
      if (pool.some(s => s.id === initialSelect)) return initialSelect
      // target isn't visible even after filter reconciliation — fall back to
      // the usual pick but don't silently forget the id: the useEffect below
      // will still reconcile on snapshot changes.
    }
    return pickInitialSelection(visible)
  })

  useEffect(() => {
    if (selectedId && visible.some(s => s.id === selectedId)) return
    setSelectedId(pickInitialSelection(visible))
  }, [visible, selectedId])

  useEffect(() => {
    if (initialView === 'add') setAddOpen(true)
  }, [initialView])

  // Mutation state that is bound to a specific model (test result, replace-key
  // error, edit error, delete error) must NOT survive a selection change —
  // otherwise model B renders model A's last test outcome under B's heading.
  // Selection changes clear all per-model mutation residues.
  // (createMut is page-level, not per-model — we leave it alone.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDefault.reset()
    editFields.reset()
    replaceKey.reset()
    testSaved.reset()
    deleteMut.reset()
  }, [selectedId])

  const defaultModel = sorted.find(s => s.isDefault)
  const selected = selectedId ? visible.find(s => s.id === selectedId) ?? null : null

  // ─── Mutations ─────────────────────────────────────────────────

  const setDefault = useMutation<[string], unknown>(async (modelId) => {
    const res = await apiSetDefaultModel(modelId)
    if (res.snapshot) onSnapshotUpdate(res.snapshot)
    return res
  })

  const editFields = useMutation<[string, UpdateModelFieldsPatch], boolean>(async (id, patch) => {
    const res = await updateModelFields(id, patch)
    if (res.snapshot) onSnapshotUpdate(res.snapshot)
    return true
  })

  const replaceKey = useMutation<[string, ApiKeyPayload], boolean>(async (id, payload) => {
    const res = await setModelKey(id, payload)
    if (res.snapshot) onSnapshotUpdate(res.snapshot)
    return true
  })

  const testSaved = useMutation<[string], ProviderProbeResult>(async (id) => {
    const res = await testSavedModel(id)
    return res.result
  })

  const deleteMut = useMutation<[string], boolean>(async (id) => {
    const res = await apiDeleteModel(id)
    if (res.snapshot) onSnapshotUpdate(res.snapshot)
    return true
  })

  const createMut = useMutation<[CreateEndpointModelPatch], boolean>(async (patch) => {
    const res = await apiCreateEndpointModel(patch)
    if (res.snapshot) onSnapshotUpdate(res.snapshot)
    return true
  })

  // ─── Runtime settings (for local model drawer) ────────────────────

  const [routerUrl, setRouterUrl] = useState<string>('')

  useEffect(() => {
    fetchConfig().then(res => setRouterUrl(res.config.routerUrl ?? '')).catch(() => {})
  }, [])

  const onConnectRuntime = useCallback(
    async (patch: { routerUrl: string; localRuntimeProtocol: LocalRuntimeProtocol }): Promise<boolean> => {
      const res = await updateRuntimeSettings(patch)
      if (res.snapshot) onSnapshotUpdate(res.snapshot)
      setRouterUrl(patch.routerUrl)
      return true
    },
    [onSnapshotUpdate],
  )

  const onSetDefault = useCallback((id: string) => { setDefault.run(id) }, [setDefault])
  const onUpdateFields = useCallback(
    async (id: string, patch: UpdateModelFieldsPatch) => Boolean(await editFields.run(id, patch)),
    [editFields],
  )
  const onReplaceKey = useCallback(
    async (id: string, payload: ApiKeyPayload) => Boolean(await replaceKey.run(id, payload)),
    [replaceKey],
  )
  const onTestSaved = useCallback(
    async (id: string) => (await testSaved.run(id)) ?? null,
    [testSaved],
  )
  const onDelete = useCallback(async (id: string) => {
    const ok = await deleteMut.run(id)
    if (ok) {
      // Let the reconcile effect pick a new selection from whatever's visible.
      setSelectedId(null)
    }
    return Boolean(ok)
  }, [deleteMut])

  const onCreateModel = useCallback(
    async (patch: CreateEndpointModelPatch) => Boolean(await createMut.run(patch)),
    [createMut],
  )
  const onCreateBatch = useCallback(
    async (patches: CreateEndpointModelPatch[]): Promise<BatchResponse> => {
      const res = await bulkCreateModels(patches.map(model => ({ model })))
      if (res.snapshot) onSnapshotUpdate(res.snapshot)
      return res
    },
    [onSnapshotUpdate],
  )

  function onCreated(createdId: string) {
    setSelectedId(createdId)
    setAddOpen(false)
    createMut.reset()
  }

  return (
    <div className="app-main">
      <section className="panel">
        <OverviewSummary
          statuses={sorted}
          defaultModel={defaultModel}
          refreshedAt={snapshot.refreshedAt}
          cacheHit={snapshot.cacheHit}
          configSourceLabel={snapshot.configSourceLabel}
        />

        {configuredCount === 0 ? (
          <div className="empty-state" data-testid="models-empty">
            <img src="/admin/owlcoda-icon-dark.svg" alt="OwlCoda" width={48} />
            <h2>{t('emptyTitle')}</h2>
            <p>{t('emptyBody')}</p>
            <a
              className="button-link primary"
              href="#/models?view=add"
              onClick={() => setAddOpen(true)}
              data-testid="models-empty-add"
            >
              {t('emptyAddCta')}
            </a>
          </div>
        ) : (
          <>
            <div className="toolbar">
              <div className="filter" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={filter === 'all' ? 'active' : ''}
                  onClick={() => setFilter('all')}
                  data-testid="filter-all"
                >
                  {t('all')} ({sorted.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'configured'}
                  className={filter === 'configured' ? 'active' : ''}
                  onClick={() => setFilter('configured')}
                  data-testid="filter-configured"
                >
                  {t('configured')} ({configured.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'issues'}
                  className={filter === 'issues' ? 'active' : ''}
                  onClick={() => setFilter('issues')}
                  data-testid="filter-issues"
                >
                  {t('issues')} ({issues.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'orphans'}
                  className={filter === 'orphans' ? 'active' : ''}
                  onClick={() => setFilter('orphans')}
                  data-testid="filter-orphans"
                >
                  {t('foundNotConfigured')} ({orphans.length})
                </button>
              </div>
              <span className="count" data-testid="visible-count">
                {t('showing')} {visible.length}
              </span>
              <div className="spacer" />
              <button type="button" onClick={() => setAddOpen(true)} data-testid="add-model-open">{t('addModel')}</button>
              <button type="button" onClick={onRefresh} disabled={loading} data-testid="refresh">
                {loading ? t('refreshing') : t('refresh')}
              </button>
            </div>

            <ModelList
              statuses={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </>
        )}
      </section>

      <ModelDrawer
        status={selected}
        setDefaultState={{ submitting: setDefault.status === 'submitting', error: setDefault.error }}
        editState={{ submitting: editFields.status === 'submitting', error: editFields.error }}
        keyState={{ submitting: replaceKey.status === 'submitting', error: replaceKey.error }}
        deleteState={{ submitting: deleteMut.status === 'submitting', error: deleteMut.error }}
        testResult={testSaved.data}
        testSubmitting={testSaved.status === 'submitting'}
        testError={testSaved.error}
        onSetDefault={onSetDefault}
        onUpdateFields={onUpdateFields}
        onReplaceKey={onReplaceKey}
        onTestSaved={onTestSaved}
        onDelete={onDelete}
        runtimeOk={snapshot.runtimeOk}
        routerUrl={routerUrl}
        onConnectRuntime={onConnectRuntime}
      />

      {addOpen && (
        <AddModelDialog
          onCreate={onCreateModel}
          createSubmitting={createMut.status === 'submitting'}
          createError={createMut.error}
          onCreateBatch={onCreateBatch}
          onCreated={onCreated}
          onCancel={() => { setAddOpen(false); createMut.reset() }}
          initialProviderId={initialProvider}
          discoveredLocalModels={discoveredLocalModels}
        />
      )}
    </div>
  )
}
