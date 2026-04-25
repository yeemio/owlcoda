import { useEffect, useMemo, useState } from 'react'
import { bulkBindDiscovered, bulkPatchModels } from '../api/client'
import type {
  BatchResponse,
  BatchResultItem,
  BulkBindItem,
  BulkPatchItem,
  ModelStatus,
  ModelTruthSnapshot,
} from '../api/types'
import { BatchResultList } from '../components/BatchResultList'
import { useBatchMutation } from '../hooks/useBatchMutation'

interface Props {
  snapshot: ModelTruthSnapshot
  onSnapshotUpdate: (snapshot: ModelTruthSnapshot) => void
  /** Handoff target — orphan id to pre-check on arrival. */
  initialSelect?: string
}

type BindMode = 'create' | 'existing'

interface OrphanPlan {
  selected: boolean
  mode: BindMode
  /** Fields for mode=create */
  label: string
  aliases: string
  role: string
  /** Fields for mode=existing: config model id to redirect backendModel onto. */
  targetModelId: string
}

function seedPlan(s: ModelStatus): OrphanPlan {
  const disc = s.raw.discovered
  return {
    selected: false,
    mode: 'create',
    label: disc?.label ?? s.label,
    aliases: '',
    role: '',
    targetModelId: '',
  }
}

/**
 * "Bind to existing" = point an existing config model's backendModel at the
 * discovered id. Uses the whitelisted PATCH endpoint — no new server surface.
 * "Create new" = existing behaviour: append the orphan as its own entry.
 *
 * Submission runs whichever bulk endpoint(s) are needed for the selected
 * plans and merges per-item results into a single list the user can read.
 */
export function OrphansPage({ snapshot, onSnapshotUpdate, initialSelect }: Props) {
  const orphans = useMemo(() => extractOrphans(snapshot.statuses), [snapshot.statuses])
  // Target picker for "bind to existing" MUST be limited to local config
  // models. A cloud model's routing contract is "hit this endpoint with this
  // key"; redirecting its backendModel to a locally-discovered id produces
  // silent misconfiguration — the model looks bound, the orphan disappears,
  // but the model still tries to reach the cloud endpoint. Filtering cloud
  // out of the picker is the UX guard; a submit-time check enforces it.
  const localConfigTargets = useMemo(
    () => snapshot.statuses.filter(isLocalConfigTarget),
    [snapshot.statuses],
  )

  const [plans, setPlans] = useState<Record<string, OrphanPlan>>(() => {
    const seed: Record<string, OrphanPlan> = {}
    for (const s of orphans) {
      const base = seedPlan(s)
      seed[s.id] = s.id === initialSelect ? { ...base, selected: true } : base
    }
    return seed
  })

  useEffect(() => {
    if (!initialSelect) return
    if (typeof document === 'undefined') return
    const el = document.querySelector<HTMLElement>(`[data-testid="orphan-${initialSelect}"]`)
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useMemo(() => {
    setPlans(prev => {
      const next: Record<string, OrphanPlan> = {}
      for (const s of orphans) next[s.id] = prev[s.id] ?? seedPlan(s)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphans])

  const batch = useBatchMutation<[{ createItems: BulkBindItem[]; patchItems: BulkPatchItem[] }]>(
    async ({ createItems, patchItems }) => {
      return await submitMixed(createItems, patchItems)
    },
  )

  function toggle(id: string) {
    setPlans(prev => ({ ...prev, [id]: { ...prev[id]!, selected: !prev[id]!.selected } }))
  }

  function updatePlan(id: string, patch: Partial<OrphanPlan>) {
    setPlans(prev => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
  }

  function toggleAll(flag: boolean) {
    setPlans(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, selected: flag }])))
  }

  // Split selected plans into two payloads — one per endpoint.
  const { createItems, patchItems, needsTargetIds, cloudTargetIds } = useMemo(() => {
    const createItems: BulkBindItem[] = []
    const patchItems: BulkPatchItem[] = []
    const needsTargetIds: string[] = []
    const cloudTargetIds: string[] = []
    for (const s of orphans) {
      const p = plans[s.id]
      if (!p || !p.selected) continue
      if (p.mode === 'create') {
        const aliases = p.aliases.split(',').map(x => x.trim()).filter(Boolean)
        createItems.push({
          discoveredId: s.id,
          patch: {
            label: p.label.trim() || s.label,
            aliases: aliases.length > 0 ? aliases : undefined,
            role: p.role.trim() || undefined,
            backendModel: s.raw.discovered?.id ?? s.id,
          },
        })
      } else {
        if (!p.targetModelId) {
          needsTargetIds.push(s.id)
          continue
        }
        // Defense-in-depth: UI filters cloud from picker, but a snapshot
        // refresh between selection and submit could flip a model cloud.
        // Reject here rather than ship a silently-misrouted backendModel.
        const target = snapshot.byModelId[p.targetModelId]
        if (!target || !isLocalConfigTarget(target)) {
          cloudTargetIds.push(s.id)
          continue
        }
        patchItems.push({
          id: p.targetModelId,
          patch: { backendModel: s.raw.discovered?.id ?? s.id },
        })
      }
    }
    return { createItems, patchItems, needsTargetIds, cloudTargetIds }
  }, [orphans, plans, snapshot.byModelId])

  const totalSelected = createItems.length + patchItems.length
  const hasIncomplete = needsTargetIds.length > 0 || cloudTargetIds.length > 0

  async function execute() {
    if (totalSelected === 0 || hasIncomplete) return
    const res = await batch.run({ createItems, patchItems })
    if (res?.snapshot) onSnapshotUpdate(res.snapshot)
  }

  if (orphans.length === 0) {
    return (
      <section className="panel full" data-testid="orphans-empty">
        <div className="empty">
          <span className="tone-ok">●</span> No orphan models. Everything discovered locally is already in your config.
        </div>
        <BatchResultList results={batch.results} testId="orphans-batch-results" />
      </section>
    )
  }

  return (
    <section className="panel full" data-testid="orphans-page">
      <header className="page-header">
        <h2>Orphan local models</h2>
        <div className="tone-muted" style={{ fontSize: 12 }}>
          Discovered on a backend but not bound. Either create a new <code>config.json</code> entry for the orphan,
          or attach it to an existing model by redirecting that model's <code>backendModel</code>.
        </div>
      </header>

      <div className="toolbar">
        <button type="button" onClick={() => toggleAll(true)} data-testid="orphans-select-all">Select all</button>
        <button type="button" onClick={() => toggleAll(false)} data-testid="orphans-select-none">Select none</button>
        <span className="count" data-testid="orphans-count">{orphans.length} orphan{orphans.length === 1 ? '' : 's'}</span>
      </div>

      <ul className="orphan-list">
        {orphans.map(s => {
          const p = plans[s.id] ?? seedPlan(s)
          const disc = s.raw.discovered
          const isCreate = p.mode === 'create'
          return (
            <li
              key={s.id}
              className={`orphan-item${p.selected ? ' selected' : ''}`}
              data-testid={`orphan-${s.id}`}
              data-mode={p.mode}
            >
              <label className="orphan-check">
                <input
                  type="checkbox"
                  checked={p.selected}
                  onChange={() => toggle(s.id)}
                  data-testid={`orphan-check-${s.id}`}
                />
                <strong>{s.label}</strong>
                <span className="tone-muted"> {s.id}</span>
              </label>
              <dl className="kv" style={{ fontSize: 12 }}>
                {disc?.backend && <><dt>backend</dt><dd data-testid={`orphan-backend-${s.id}`}>{disc.backend} @ {disc.baseUrl}</dd></>}
                {disc?.parameterSize && <><dt>size</dt><dd>{disc.parameterSize}</dd></>}
                {disc?.quantization && <><dt>quant</dt><dd>{disc.quantization}</dd></>}
                {disc?.contextWindow && <><dt>ctx</dt><dd>{disc.contextWindow}</dd></>}
              </dl>

              <div className="orphan-mode" role="tablist">
                <label>
                  <input
                    type="radio"
                    name={`orphan-mode-${s.id}`}
                    checked={p.mode === 'create'}
                    onChange={() => updatePlan(s.id, { mode: 'create' })}
                    disabled={!p.selected}
                    data-testid={`orphan-mode-create-${s.id}`}
                  />
                  Create new config entry
                </label>
                <label>
                  <input
                    type="radio"
                    name={`orphan-mode-${s.id}`}
                    checked={p.mode === 'existing'}
                    onChange={() => updatePlan(s.id, { mode: 'existing' })}
                    disabled={!p.selected}
                    data-testid={`orphan-mode-existing-${s.id}`}
                  />
                  Bind to existing model
                </label>
              </div>

              {isCreate ? (
                <div className="orphan-form">
                  <label className="field inline">
                    <span className="field-label">label</span>
                    <input
                      type="text"
                      className="field-input"
                      value={p.label}
                      onChange={e => updatePlan(s.id, { label: e.target.value })}
                      disabled={!p.selected}
                      data-testid={`orphan-label-${s.id}`}
                    />
                  </label>
                  <label className="field inline">
                    <span className="field-label">aliases</span>
                    <input
                      type="text"
                      className="field-input"
                      value={p.aliases}
                      onChange={e => updatePlan(s.id, { aliases: e.target.value })}
                      disabled={!p.selected}
                      placeholder="comma-separated"
                      data-testid={`orphan-aliases-${s.id}`}
                    />
                  </label>
                  <label className="field inline">
                    <span className="field-label">role</span>
                    <input
                      type="text"
                      className="field-input"
                      value={p.role}
                      onChange={e => updatePlan(s.id, { role: e.target.value })}
                      disabled={!p.selected}
                      data-testid={`orphan-role-${s.id}`}
                    />
                  </label>
                </div>
              ) : (
                <div className="orphan-form">
                  <label className="field inline" style={{ minWidth: 260 }}>
                    <span className="field-label">bind to (local only)</span>
                    <select
                      className="field-input"
                      value={p.targetModelId}
                      onChange={e => updatePlan(s.id, { targetModelId: e.target.value })}
                      disabled={!p.selected || localConfigTargets.length === 0}
                      data-testid={`orphan-target-${s.id}`}
                    >
                      <option value="">— pick a local config model —</option>
                      {localConfigTargets.map(cm => (
                        <option key={cm.id} value={cm.id}>
                          {cm.label} ({cm.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  {p.selected && localConfigTargets.length === 0 && (
                    <div className="tone-warn" style={{ fontSize: 12 }} data-testid={`orphan-no-local-targets-${s.id}`}>
                      No local config models available. Cloud / endpoint-based models cannot accept a backendModel redirect —
                      switch to <strong>Create new config entry</strong> instead.
                    </div>
                  )}
                  {p.selected && p.targetModelId && (
                    <div className="tone-muted" data-testid={`orphan-bind-preview-${s.id}`} style={{ fontSize: 12 }}>
                      will patch <code>{p.targetModelId}</code>.backendModel ← <code>{s.raw.discovered?.id ?? s.id}</code>
                    </div>
                  )}
                  {p.selected && !p.targetModelId && localConfigTargets.length > 0 && (
                    <div className="tone-warn" style={{ fontSize: 12 }}>
                      pick a target local config model
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="batch-bar">
        <span className="tone-muted" data-testid="orphans-selected-count">
          {totalSelected} selected · {createItems.length} create / {patchItems.length} bind-existing
        </span>
        <div className="spacer" />
        <button
          type="button"
          onClick={execute}
          disabled={totalSelected === 0 || hasIncomplete || batch.status === 'submitting'}
          data-testid="orphans-execute"
        >
          {batch.status === 'submitting' ? 'Applying…' : 'Apply'}
        </button>
      </div>

      {hasIncomplete && (
        <div className="banner err" data-testid="orphans-incomplete">
          {needsTargetIds.length > 0 && (
            <div>
              {needsTargetIds.length} orphan{needsTargetIds.length === 1 ? '' : 's'} missing a target —
              pick a local config model or switch to "Create new".
            </div>
          )}
          {cloudTargetIds.length > 0 && (
            <div data-testid="orphans-cloud-rejected">
              {cloudTargetIds.length} orphan{cloudTargetIds.length === 1 ? '' : 's'} targeting a cloud model —
              not allowed. Cloud endpoints can't accept a local <code>backendModel</code> redirect.
            </div>
          )}
        </div>
      )}

      {batch.error && <div className="banner err" data-testid="orphans-error">{batch.error}</div>}
      <BatchResultList
        results={batch.results}
        testId="orphans-batch-results"
        labelFor={id => snapshot.byModelId[id]?.label ?? id}
      />
    </section>
  )
}

export function extractOrphans(statuses: ModelStatus[]): ModelStatus[] {
  return statuses.filter(s => s.availability.kind === 'orphan_discovered')
}

/**
 * Local config target = a model that exists in config AND routes through
 * the local router (no endpoint field). These are the only safe bind
 * targets for orphans — redirecting a cloud model's backendModel would
 * leave the endpoint/key cloud wiring in place and silently misroute.
 */
export function isLocalConfigTarget(s: ModelStatus): boolean {
  if (!s.raw.config) return false
  const hasEndpoint = Boolean(s.raw.config.endpoint && s.raw.config.endpoint.trim())
  if (hasEndpoint) return false
  return s.providerKind !== 'cloud'
}

/**
 * Dispatch existing-bind (bulk patch) then create (bulk bind-discovered)
 * **sequentially**. Parallel writes against ModelConfigMutator's whole-file
 * read/modify/write cadence can race — one call's write overwrites the other's.
 * Serial guarantees each call sees the prior's effect in config, and we can
 * pick the final snapshot as the single source of truth.
 *
 * Order: patch → create.
 *   - Patch edits existing config entries; mutator writes config.json with
 *     those fields updated.
 *   - Create appends new entries; mutator then rewrites config.json including
 *     the just-patched entries + the new ones.
 *   - The create call's snapshot reflects both sets of changes.
 *
 * Per-item results from both calls are merged. Request-level failures (4xx/
 * 5xx that throw) are captured and surface with whatever per-item results the
 * earlier call DID produce — nothing is silently dropped.
 */
async function submitMixed(
  createItems: BulkBindItem[],
  patchItems: BulkPatchItem[],
): Promise<BatchResponse> {
  let patchRes: BatchResponse | null = null
  let createRes: BatchResponse | null = null
  const requestErrors: string[] = []

  if (patchItems.length > 0) {
    try {
      patchRes = await bulkPatchModels(patchItems)
    } catch (e) {
      requestErrors.push(`patch: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Only proceed to creates if patch didn't throw at request level. If patch
  // returned 207 with per-item failures, those are data — continue.
  const patchRequestFailed = patchItems.length > 0 && patchRes === null
  if (createItems.length > 0 && !patchRequestFailed) {
    try {
      createRes = await bulkBindDiscovered(createItems)
    } catch (e) {
      requestErrors.push(`create: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const results: BatchResultItem[] = []
  if (patchRes) results.push(...patchRes.results)
  if (createRes) results.push(...createRes.results)

  // Snapshot truth: take the LAST successful call's snapshot. create ran
  // second if both ran, so its snapshot already reflects patch's writes.
  const snapshot = createRes?.snapshot ?? patchRes?.snapshot

  // Nothing ran AND request-level errors: escalate so the UI shows the real
  // cause, not an empty result list.
  if (results.length === 0 && requestErrors.length > 0) {
    throw new Error(requestErrors.join(' · '))
  }

  const allOk = results.every(r => r.ok) && requestErrors.length === 0
  return {
    schemaVersion: (patchRes ?? createRes)?.schemaVersion ?? 1,
    ok: allOk,
    // Expose request-level error messages as synthetic result items so the
    // shared BatchResultList surfaces them like any other failure.
    results: requestErrors.length > 0
      ? [...results, ...requestErrors.map((msg, i) => ({
          id: `__request_error_${i}`,
          ok: false as const,
          error: { code: 'request_error', message: msg },
        }))]
      : results,
    snapshot,
  }
}
