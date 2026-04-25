import { useEffect, useMemo, useState } from 'react'
import { bulkPatchModels } from '../api/client'
import type { BulkPatchItem, ModelStatus, ModelTruthSnapshot } from '../api/types'
import { BatchResultList } from '../components/BatchResultList'
import { useBatchMutation } from '../hooks/useBatchMutation'

interface Props {
  snapshot: ModelTruthSnapshot
  onSnapshotUpdate: (snapshot: ModelTruthSnapshot) => void
  /** Handoff target — alias to focus (highlight its group). */
  initialFocus?: string
}

type Decision = 'keep' | 'drop-conflicting' | 'rename'

interface Plan {
  modelId: string
  decision: Decision
  /** alias key that conflicts (the contested alias) */
  conflictAlias: string
  /** for 'rename' — new alias name */
  renameTo: string
}

/**
 * Group conflicts by the contested alias key so the user sees "who's fighting
 * over this alias" at a glance. For each group we show all claimants and
 * let the user pick a plan per-model:
 *
 *   - keep             → leave aliases untouched (do nothing)
 *   - drop-conflicting → remove the contested alias from this model
 *   - rename           → remove the contested alias + add a new one
 *
 * Applying = bulk PATCH with the resulting aliases arrays.
 */
export function AliasConflictsPage({ snapshot, onSnapshotUpdate, initialFocus }: Props) {
  const conflicts = useMemo(() => extractAliasConflicts(snapshot.statuses), [snapshot.statuses])

  // Handoff: resolve focused alias. If `initialFocus` is a model id (not an
  // alias key), look up the conflict groups it participates in and pick the
  // first alias. This way the sender can pass either form.
  const focusedAlias = useMemo<string | null>(() => {
    if (!initialFocus) return null
    if (conflicts.has(initialFocus)) return initialFocus
    for (const [alias, group] of conflicts) {
      if (group.some(s => s.id === initialFocus)) return alias
    }
    return null
  }, [conflicts, initialFocus])

  useEffect(() => {
    if (!focusedAlias) return
    if (typeof document === 'undefined') return
    const el = document.querySelector<HTMLElement>(`[data-testid="conflict-group-${focusedAlias}"]`)
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [focusedAlias])
  const [plans, setPlans] = useState<Record<string, Plan>>(() => seedPlans(conflicts))

  const batch = useBatchMutation<[BulkPatchItem[]]>(async (items) => bulkPatchModels(items))

  // Rehydrate plans if conflict set changes after a successful run.
  useMemo(() => {
    setPlans(prev => {
      const next: Record<string, Plan> = {}
      for (const [alias, group] of conflicts) {
        for (const s of group) {
          const key = planKey(alias, s.id)
          next[key] = prev[key] ?? seedPlan(alias, s.id)
        }
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts])

  function updatePlan(alias: string, modelId: string, patch: Partial<Plan>) {
    const key = planKey(alias, modelId)
    setPlans(prev => ({ ...prev, [key]: { ...(prev[key] ?? seedPlan(alias, modelId)), ...patch } }))
  }

  const proposed = useMemo(() => buildPatchItems(conflicts, plans, snapshot.statuses), [conflicts, plans, snapshot.statuses])

  async function execute() {
    if (proposed.length === 0) return
    const res = await batch.run(proposed)
    if (res?.snapshot) onSnapshotUpdate(res.snapshot)
  }

  if (conflicts.size === 0) {
    return (
      <section className="panel full" data-testid="alias-conflicts-empty">
        <div className="empty">
          <span className="tone-ok">●</span> No alias conflicts. Nothing to fix here.
        </div>
        <BatchResultList results={batch.results} testId="alias-batch-results" />
      </section>
    )
  }

  return (
    <section className="panel full" data-testid="alias-conflicts-page">
      <header className="page-header">
        <h2>Alias conflicts</h2>
        <div className="tone-muted" style={{ fontSize: 12 }}>
          Each contested alias is claimed by more than one model. Pick a plan per model; applying runs a single bulk PATCH.
        </div>
      </header>

      <div className="conflict-groups">
        {[...conflicts.entries()].map(([alias, models]) => (
          <div
            key={alias}
            className={`conflict-group${focusedAlias === alias ? ' focused' : ''}`}
            data-testid={`conflict-group-${alias}`}
            data-focused={focusedAlias === alias ? 'true' : 'false'}
          >
            <h3 className="conflict-alias">
              <code>{alias}</code>{' '}
              <span className="tone-muted" style={{ fontSize: 12 }}>
                claimed by {models.length} models
              </span>
            </h3>
            <ul className="conflict-models">
              {models.map(m => {
                const plan = plans[planKey(alias, m.id)] ?? seedPlan(alias, m.id)
                const proposedAliases = projectedAliases(m, plan)
                return (
                  <li key={m.id} className="conflict-model" data-testid={`conflict-model-${alias}-${m.id}`}>
                    <div className="conflict-model-header">
                      <strong>{m.label}</strong>{' '}
                      <span className="tone-muted">{m.id}</span>
                      {m.isDefault && <span className="tone-ok" style={{ marginLeft: 8 }}>★ default</span>}
                    </div>
                    <div className="conflict-plan-row">
                      <label>
                        <input
                          type="radio"
                          name={`plan-${alias}-${m.id}`}
                          checked={plan.decision === 'keep'}
                          onChange={() => updatePlan(alias, m.id, { decision: 'keep' })}
                          data-testid={`plan-${alias}-${m.id}-keep`}
                        />
                        Keep (no change)
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`plan-${alias}-${m.id}`}
                          checked={plan.decision === 'drop-conflicting'}
                          onChange={() => updatePlan(alias, m.id, { decision: 'drop-conflicting' })}
                          data-testid={`plan-${alias}-${m.id}-drop`}
                        />
                        Drop <code>{alias}</code>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`plan-${alias}-${m.id}`}
                          checked={plan.decision === 'rename'}
                          onChange={() => updatePlan(alias, m.id, { decision: 'rename' })}
                          data-testid={`plan-${alias}-${m.id}-rename`}
                        />
                        Rename to
                      </label>
                      <input
                        type="text"
                        className="field-input inline"
                        value={plan.renameTo}
                        onChange={e => updatePlan(alias, m.id, { renameTo: e.target.value, decision: 'rename' })}
                        disabled={plan.decision !== 'rename'}
                        data-testid={`plan-${alias}-${m.id}-rename-input`}
                        placeholder="new alias"
                      />
                    </div>
                    <div className="conflict-preview tone-muted" data-testid={`preview-${alias}-${m.id}`}>
                      aliases after: <code>{proposedAliases.length > 0 ? proposedAliases.join(', ') : '(none)'}</code>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="batch-bar">
        <span className="tone-muted" data-testid="alias-proposed-count">
          {proposed.length} model{proposed.length === 1 ? '' : 's'} will be patched
        </span>
        <div className="spacer" />
        <button
          type="button"
          onClick={execute}
          disabled={proposed.length === 0 || batch.status === 'submitting'}
          data-testid="alias-execute"
        >
          {batch.status === 'submitting' ? 'Applying…' : 'Apply plan'}
        </button>
      </div>

      {batch.error && <div className="banner err" data-testid="alias-error">{batch.error}</div>}
      <BatchResultList
        results={batch.results}
        testId="alias-batch-results"
        labelFor={id => snapshot.byModelId[id]?.label}
      />
    </section>
  )
}

// ─── Pure helpers (tested separately) ────────────────────────────────

export function extractAliasConflicts(statuses: ModelStatus[]): Map<string, ModelStatus[]> {
  const byAlias = new Map<string, ModelStatus[]>()
  for (const s of statuses) {
    if (s.availability.kind !== 'alias_conflict') continue
    const alias = s.availability.with
    const list = byAlias.get(alias) ?? []
    list.push(s)
    byAlias.set(alias, list)
  }
  return byAlias
}

function seedPlans(conflicts: Map<string, ModelStatus[]>): Record<string, Plan> {
  const out: Record<string, Plan> = {}
  for (const [alias, models] of conflicts) {
    for (const m of models) {
      out[planKey(alias, m.id)] = seedPlan(alias, m.id)
    }
  }
  return out
}

function seedPlan(alias: string, modelId: string): Plan {
  return { modelId, decision: 'keep', conflictAlias: alias, renameTo: '' }
}

function planKey(alias: string, modelId: string): string {
  return `${alias}\u0000${modelId}`
}

export function projectedAliases(model: ModelStatus, plan: Plan): string[] {
  const current = model.raw.config?.aliases ?? []
  if (plan.decision === 'keep') return current
  const withoutContested = current.filter(a => a !== plan.conflictAlias)
  if (plan.decision === 'drop-conflicting') return withoutContested
  const next = plan.renameTo.trim()
  if (!next) return withoutContested
  return withoutContested.includes(next) ? withoutContested : [...withoutContested, next]
}

export function buildPatchItems(
  conflicts: Map<string, ModelStatus[]>,
  plans: Record<string, Plan>,
  statuses: ModelStatus[],
): BulkPatchItem[] {
  const patchPerModel = new Map<string, string[]>()
  for (const [alias, models] of conflicts) {
    for (const m of models) {
      const plan = plans[planKey(alias, m.id)]
      if (!plan || plan.decision === 'keep') continue
      // Compose across multiple conflicts on the same model: start from the
      // current (or already-patched) alias list and apply each decision.
      const prev = patchPerModel.get(m.id) ?? [...(m.raw.config?.aliases ?? [])]
      const filtered = prev.filter(a => a !== alias)
      if (plan.decision === 'rename' && plan.renameTo.trim()) {
        const next = plan.renameTo.trim()
        if (!filtered.includes(next)) filtered.push(next)
      }
      patchPerModel.set(m.id, filtered)
    }
  }
  const items: BulkPatchItem[] = []
  for (const [id, aliases] of patchPerModel) {
    const cur = statuses.find(s => s.id === id)?.raw.config?.aliases ?? []
    if (arraysEqual(cur, aliases)) continue
    items.push({ id, patch: { aliases } })
  }
  return items
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}
