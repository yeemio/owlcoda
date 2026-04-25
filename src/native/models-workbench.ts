/**
 * Model Workstation (`/models`) — Phase B frontend.
 *
 * Read-only 3-layer workbench consuming the Phase A ModelTruthAggregator.
 * This module DOES NOT compute availability itself; it only renders and
 * dispatches to the aggregator / mutator contracts.
 */

import * as readline from 'node:readline'
import { sgr, themeColor, dim, showPicker, truncate, type PickerItem } from './tui/index.js'
import { ModelTruthAggregator, type ModelStatus, type ModelTruthSnapshot, type ModelAvailability } from '../model-truth.js'
import { loadConfig } from '../config.js'
import type { AdminHandoffContext } from '../admin-delivery.js'

// ─── Singleton aggregator (shared across `/models` invocations) ───────

let sharedAggregator: ModelTruthAggregator | null = null

export function getModelTruthAggregator(): ModelTruthAggregator {
  if (!sharedAggregator) {
    sharedAggregator = new ModelTruthAggregator(() => loadConfig())
  }
  return sharedAggregator
}

/** Test hook — reset the singleton. */
export function __resetAggregatorForTests(): void {
  sharedAggregator = null
}

// ─── Width tiers ──────────────────────────────────────────────────────

export type WidthTier = 'narrow' | 'mid' | 'wide'

export function widthTier(columns: number): WidthTier {
  if (columns < 70) return 'narrow'
  if (columns < 130) return 'mid'
  return 'wide'
}

// ─── Availability mapping ─────────────────────────────────────────────

export function availabilityIcon(a: ModelAvailability): string {
  switch (a.kind) {
    case 'ok': return `${themeColor('success')}●${sgr.reset}`
    case 'missing_key': return `${themeColor('warning')}⚠${sgr.reset}`
    case 'endpoint_down': return `${themeColor('error')}✕${sgr.reset}`
    case 'router_missing': return `${themeColor('warning')}⚠${sgr.reset}`
    case 'orphan_discovered': return `${themeColor('info')}○${sgr.reset}`
    case 'alias_conflict': return `${themeColor('error')}✕${sgr.reset}`
    case 'warming': return `${themeColor('warningShimmer')}◐${sgr.reset}`
    case 'unknown': return dim('?')
  }
}

export function availabilityPhrase(a: ModelAvailability): string {
  switch (a.kind) {
    case 'ok': return 'ready'
    case 'missing_key': return a.envName ? `missing key (env ${a.envName})` : 'missing API key'
    case 'endpoint_down': return `endpoint down: ${a.reason}`
    case 'router_missing': return a.reason ?? 'not visible in runtime truth'
    case 'orphan_discovered': return 'found locally, not in config'
    case 'alias_conflict': return `alias conflict with "${a.with}"`
    case 'warming': return 'warming up…'
    case 'unknown': return a.reason || 'status unknown'
  }
}

/** Fix hints — read-only in Phase B, shown as next-step text. */
export function availabilityFixHints(a: ModelAvailability): string[] {
  switch (a.kind) {
    case 'ok': return []
    case 'missing_key':
      return a.envName
        ? [`set env ${a.envName}`, 'or: /login <model> to fill inline']
        : ['add apiKey via /login <model>', 'or: bind apiKeyEnv in config']
    case 'endpoint_down':
      return ['check the endpoint is reachable', 'verify backend process is up', 'or: remove from config']
    case 'router_missing':
      if (a.deprecatedFallback) {
        return [
          'deprecated router fallback is still active for visibility truth',
          'cut this runtime over to owlmlx direct visibility surfaces when available',
          'do not treat router /v1/models as the long-term source of truth',
        ]
      }
      if (a.visibilityRule === 'runtime_gate_required_before_visible' || a.truthSurface === '/v1/openai/models') {
        const hints = [
          'use owlmlx /v1/openai/models as the availability truth',
          'use owlmlx /v1/runtime/model-visibility for diagnostics',
          'treat owlmlx /v1/models as loaded inventory only',
        ]
        if (a.blockReason) hints.unshift(`runtime visibility blocker: ${a.blockReason}`)
        return hints
      }
      if (a.visibilityRule === 'gate_required_before_visible') {
        const hints = [
          'wait for the platform visibility gate to admit this model',
          'treat router /v1/models as the availability truth, not catalog-only state',
        ]
        if (a.gateStatus && a.gateStatus !== 'ready') hints.unshift(`platform gate status: ${a.gateStatus}`)
        return hints
      }
      return ['restart the router', 'or: remove stale entry from config']
    case 'orphan_discovered':
      return ['add to config (phase C: one-click bind)', 'or: ignore']
    case 'alias_conflict':
      return [`rename one of the aliases (conflict key: "${a.with}")`]
    case 'warming':
      return ['wait — no action needed']
    case 'unknown':
      return ['check /doctor for router/runtime status']
  }
}

export function browserRouteForStatus(status: ModelStatus): AdminHandoffContext['route'] {
  switch (status.availability.kind) {
    case 'alias_conflict':
      return 'aliases'
    case 'orphan_discovered':
      return 'orphans'
    default:
      return 'models'
  }
}

export function workbenchHandoffContext(
  mode: 'default' | 'issues' | 'overview' = 'default',
  status?: ModelStatus,
): AdminHandoffContext {
  if (status) {
    return {
      route: browserRouteForStatus(status),
      select: status.id,
      view: mode === 'issues' ? 'issues' : undefined,
    }
  }
  return {
    route: 'models',
    view: mode === 'issues' ? 'issues' : mode === 'overview' ? 'overview' : undefined,
  }
}

export function renderBrowserHandoffHint(context: AdminHandoffContext): string {
  const parts = [`owlcoda ui --route ${context.route ?? 'models'}`]
  if (context.select) parts.push(`--select ${context.select}`)
  if (context.view) parts.push(`--view ${context.view}`)
  return parts.join(' ')
}

// ─── Status ordering ──────────────────────────────────────────────────

function statusSortRank(s: ModelStatus): number {
  if (s.isDefault) return 0
  switch (s.availability.kind) {
    case 'ok': return 1
    case 'warming': return 2
    case 'missing_key':
    case 'endpoint_down':
    case 'router_missing':
    case 'alias_conflict':
    case 'unknown':
      return 3
    case 'orphan_discovered':
      return 4
  }
}

export function sortedStatuses(statuses: ModelStatus[]): ModelStatus[] {
  return [...statuses].sort((a, b) => {
    const ra = statusSortRank(a)
    const rb = statusSortRank(b)
    if (ra !== rb) return ra - rb
    return a.id.localeCompare(b.id)
  })
}

// ─── Overview layer ───────────────────────────────────────────────────

export interface OverviewCounts {
  total: number
  available: number
  blocked: number
  orphan: number
  local: number
  cloud: number
}

export function overviewCounts(statuses: ModelStatus[]): OverviewCounts {
  let available = 0, blocked = 0, orphan = 0, local = 0, cloud = 0
  for (const s of statuses) {
    if (s.availability.kind === 'ok') available++
    else if (s.availability.kind === 'orphan_discovered') orphan++
    else blocked++
    if (s.providerKind === 'local') local++
    else if (s.providerKind === 'cloud') cloud++
  }
  return { total: statuses.length, available, blocked, orphan, local, cloud }
}

export function renderOverview(snapshot: ModelTruthSnapshot, tier: WidthTier): string[] {
  const statuses = snapshot.statuses
  const counts = overviewCounts(statuses)
  const def = statuses.find(s => s.isDefault)
  const topIssues = sortedStatuses(statuses)
    .filter(s => s.availability.kind !== 'ok' && s.availability.kind !== 'orphan_discovered')
    .slice(0, 3)

  const lines: string[] = []
  lines.push(`${themeColor('owl')}🦉 Model Workstation${sgr.reset}`)
  lines.push('')

  // Default model line
  if (def) {
    const icon = availabilityIcon(def.availability)
    const phrase = availabilityPhrase(def.availability)
    lines.push(`  ${sgr.bold}default${sgr.reset}  ${icon} ${def.label} ${dim(`(${def.providerKind} · ${phrase})`)}`)
  } else {
    lines.push(`  ${sgr.bold}default${sgr.reset}  ${dim('(none set)')}`)
  }

  // Counts line — compressed on narrow
  if (tier === 'narrow') {
    lines.push(`  ${dim(`${counts.total} models · ${counts.available} ok · ${counts.blocked} blocked${counts.orphan ? ` · ${counts.orphan} orphan` : ''}`)}`)
  } else {
    lines.push(
      `  ${dim('total')} ${counts.total}` +
      `  ${dim('ok')} ${counts.available}` +
      `  ${dim('blocked')} ${counts.blocked}` +
      `  ${dim('orphan')} ${counts.orphan}` +
      `  ${dim('·')}  ${dim('local')} ${counts.local}` +
      `  ${dim('cloud')} ${counts.cloud}`,
    )
  }

  // Top issues
  if (topIssues.length > 0) {
    lines.push('')
    lines.push(`  ${sgr.bold}top issues${sgr.reset}`)
    for (const s of topIssues) {
      lines.push(`    ${availabilityIcon(s.availability)} ${s.label} ${dim('— ' + availabilityPhrase(s.availability))}`)
    }
  }

  // Refresh metadata
  const age = Math.max(0, Date.now() - snapshot.refreshedAt)
  const ageLabel = age < 1000 ? 'just now' : `${Math.floor(age / 1000)}s ago`
  lines.push('')
  lines.push(`  ${dim(`refreshed ${ageLabel}${snapshot.cacheHit ? ' (cache)' : ''}`)}`)

  return lines
}

// ─── Model row renderer ───────────────────────────────────────────────

function providerTag(kind: ModelStatus['providerKind']): string {
  switch (kind) {
    case 'cloud': return 'cloud'
    case 'local': return 'local'
    default: return '—'
  }
}

/**
 * Render a single model row for the picker label.
 * Must fit on ONE terminal line: picker concatenates label + description and
 * does NOT wrap — oversize labels corrupt redraw.
 *
 * Budget per tier (label visible chars, before picker's own prefix/desc):
 *   narrow: ≤ 34   mid: ≤ 40   wide: ≤ 52
 */
export function renderModelRowLabel(s: ModelStatus, tier: WidthTier, _columns: number): string {
  void _columns
  const icon = availabilityIcon(s.availability)
  const defaultTag = s.isDefault ? `${themeColor('owl')}★${sgr.reset}` : ' '
  const labelBudget = tier === 'narrow' ? 28 : tier === 'mid' ? 34 : 44
  const name = truncate(s.label, labelBudget)
  return `${icon} ${defaultTag} ${name}`
}

/**
 * Short per-row tag shown by picker right of the label.
 * Picker truncates description to 40 visible chars — keep it under that.
 */
export function renderModelRowDescription(s: ModelStatus, tier: WidthTier): string {
  const kind = providerTag(s.providerKind)
  if (s.availability.kind === 'ok') {
    return tier === 'narrow' ? kind : (s.role ? `${kind} · ${s.role}` : kind)
  }
  // non-ok: short status word, no phrase
  const short = shortAvailabilityTag(s.availability)
  return tier === 'narrow' ? `${kind} · ${short}` : `${kind} · ${short}`
}

function shortAvailabilityTag(a: ModelAvailability): string {
  switch (a.kind) {
    case 'ok': return 'ok'
    case 'missing_key': return 'no key'
    case 'endpoint_down': return 'down'
    case 'router_missing':
      if (a.deprecatedFallback) return 'legacy-fallback'
      if (a.visibilityRule === 'runtime_gate_required_before_visible') return 'owlmlx-gate'
      if (a.visibilityRule === 'gate_required_before_visible') return 'gate-wait'
      return 'not-visible'
    case 'orphan_discovered': return 'orphan'
    case 'alias_conflict': return 'alias-conflict'
    case 'warming': return 'warming'
    case 'unknown': return 'unknown'
  }
}

// ─── Preview pane (details + fix hints) ───────────────────────────────

export function renderDetails(s: ModelStatus): string[] {
  const lines: string[] = []

  // Headline: label + availability phrase
  lines.push(`${sgr.bold}${s.label}${sgr.reset}  ${dim(`(${s.id})`)}`)
  lines.push(`  ${availabilityIcon(s.availability)} ${availabilityPhrase(s.availability)}`)
  lines.push('')

  // Presence map
  const present = s.presentIn
  const presenceMap = [
    `config:${present.config ? '✓' : '–'}`,
    `visibility:${present.router ? '✓' : '–'}`,
    `discovered:${present.discovered ? '✓' : '–'}`,
    `catalog:${present.catalog ? '✓' : '–'}`,
  ].join('  ')
  lines.push(`  ${dim('present in')}  ${presenceMap}`)

  // Provider + default
  lines.push(`  ${dim('provider')}     ${providerTag(s.providerKind)}${s.isDefault ? `  ${themeColor('owl')}★ default${sgr.reset}` : ''}`)
  if (s.role) lines.push(`  ${dim('role')}         ${s.role}`)

  // Config details (always compact)
  if (s.raw.config) {
    const c = s.raw.config
    if (c.backendModel && c.backendModel !== s.id) lines.push(`  ${dim('backendModel')} ${c.backendModel}`)
    if (c.endpoint) lines.push(`  ${dim('endpoint')}     ${c.endpoint}`)
    if (c.aliases && c.aliases.length > 0) lines.push(`  ${dim('aliases')}      ${c.aliases.join(', ')}`)
    if (c.contextWindow) lines.push(`  ${dim('contextWindow')} ${c.contextWindow}`)
    if (c.apiKeyEnv) lines.push(`  ${dim('apiKeyEnv')}    ${c.apiKeyEnv} ${c.apiKey ? dim('(+ inline)') : ''}`)
    else if (c.apiKey) lines.push(`  ${dim('apiKey')}       ${dim('(inline set)')}`)
  }

  // Fix hints
  const hints = availabilityFixHints(s.availability)
  if (hints.length > 0) {
    lines.push('')
    lines.push(`  ${sgr.bold}next steps${sgr.reset}`)
    for (const h of hints) lines.push(`    ${dim('›')} ${h}`)
  }

  lines.push('')
  lines.push(`  ${sgr.bold}browser${sgr.reset}`)
  lines.push(`    ${dim('›')} Open in browser`)
  lines.push(`    ${dim('›')} ${renderBrowserHandoffHint(workbenchHandoffContext('default', s))}`)

  return lines
}

// ─── Issues layer ─────────────────────────────────────────────────────

export function renderIssuesDump(snapshot: ModelTruthSnapshot, tier: WidthTier): string[] {
  void tier
  const issues = sortedStatuses(snapshot.statuses).filter(s => s.availability.kind !== 'ok')
  const lines: string[] = []
  lines.push(`${themeColor('owl')}🦉 Model Issues${sgr.reset}`)
  lines.push('')
  if (issues.length === 0) {
    lines.push(`  ${themeColor('success')}●${sgr.reset} ${dim('no issues — all models OK')}`)
    return lines
  }

  for (const s of issues) {
    lines.push(`  ${availabilityIcon(s.availability)} ${sgr.bold}${s.label}${sgr.reset} ${dim(`(${s.id})`)}`)
    lines.push(`     ${dim('reason:')}  ${availabilityPhrase(s.availability)}`)
    // Impact
    const impact = s.isDefault ? `${themeColor('error')}blocks default${sgr.reset}` : (s.role ? dim(`role: ${s.role}`) : dim('no role assignment'))
    lines.push(`     ${dim('impact:')}  ${impact}`)
    for (const h of availabilityFixHints(s.availability)) {
      lines.push(`     ${dim('›')}       ${h}`)
    }
    lines.push('')
  }
  return lines
}

// ─── Entry ────────────────────────────────────────────────────────────

export interface RunWorkbenchOptions {
  mode?: 'default' | 'issues' | 'overview'
  refresh?: boolean
  rl?: readline.Interface
  stream?: NodeJS.WriteStream
  getColumns?: () => number
  aggregator?: ModelTruthAggregator
  picker?: typeof showPicker
  onBrowserHandoff?: (request: BrowserHandoffRequest) => Promise<void> | void
}

export interface BrowserHandoffRequest {
  context: AdminHandoffContext
  explicitOpen?: boolean
}

export async function runModelsWorkbench(opts: RunWorkbenchOptions = {}): Promise<void> {
  const stream = opts.stream ?? process.stdout
  const getColumns = opts.getColumns ?? (() => stream.columns ?? 100)
  const aggregator = opts.aggregator ?? getModelTruthAggregator()
  const picker = opts.picker ?? showPicker

  if (opts.refresh) aggregator.invalidate()

  const snapshot = await aggregator.getSnapshot({ skipCache: opts.refresh === true })
  const tier = widthTier(getColumns())

  // Non-interactive dumps — safe to print as text (no picker involved).
  if (opts.mode === 'overview') {
    stream.write(renderOverview(snapshot, tier).join('\n') + '\n')
    return
  }
  if (opts.mode === 'issues') {
    stream.write(renderIssuesDump(snapshot, tier).join('\n') + '\n')
    return
  }

  const sorted = sortedStatuses(snapshot.statuses)
  if (sorted.length === 0) {
    stream.write(dim('  no models configured — add models to ~/.owlcoda/config.json\n'))
    return
  }

  const counts = overviewCounts(sorted)
  const def = sorted.find(s => s.isDefault)
  const titleSummary = buildTitleSummary(def, counts, tier)

  const items: PickerItem<ModelAction>[] = [
    {
      label: `${themeColor('owl')}◆${sgr.reset} ${sgr.bold}Overview${sgr.reset}`,
      description: `default · counts · issues`,
      value: { kind: 'overview' },
    },
    {
      label: `${themeColor('warning')}⚠${sgr.reset} ${sgr.bold}Issues${sgr.reset}`,
      description: `${counts.blocked} blocked${counts.orphan ? ` · ${counts.orphan} orphan` : ''}`,
      value: { kind: 'issues' },
    },
    {
      label: `${dim('↻')} ${sgr.bold}Refresh${sgr.reset}`,
      description: `re-probe router + backends`,
      value: { kind: 'refresh' },
    },
    {
      label: `${themeColor('info')}↗${sgr.reset} ${sgr.bold}Admin Handoff${sgr.reset}`,
      description: `settings UI URL`,
      value: { kind: 'browser', context: workbenchHandoffContext(opts.mode ?? 'default') },
    },
    ...sorted.map<PickerItem<ModelAction>>(s => ({
      label: renderModelRowLabel(s, tier, getColumns()),
      description: renderModelRowDescription(s, tier),
      value: { kind: 'inspect', status: s },
    })),
  ]

  const result = await picker<ModelAction>({
    title: titleSummary,
    items,
    placeholder: 'Search models…',
    visibleCount: 12,
    stream,
    readline: opts.rl,
    renderPreview: item => {
      const v = item.value
      if (v.kind === 'inspect') return renderCompactDetails(v.status)
      if (v.kind === 'overview') return [...renderCompactOverview(snapshot).slice(0, 4), dim('Enter to open admin models.')]
      if (v.kind === 'issues') return [...renderCompactIssues(snapshot).slice(0, 4), dim('Enter to open admin issues.')]
      if (v.kind === 'refresh') return [dim('Enter to re-probe backends and router.')]
      if (v.kind === 'browser') return [dim('Enter to open browser admin.'), dim(renderBrowserHandoffHint(v.context))]
      return []
    },
  })

  if (result.cancelled || !result.item) return

  const action = result.item.value
  if (action.kind === 'refresh') {
    return runModelsWorkbench({ ...opts, refresh: true })
  }
  if (action.kind === 'browser') {
    await opts.onBrowserHandoff?.({ context: action.context, explicitOpen: true })
    return
  }
  if (action.kind === 'issues') {
    await opts.onBrowserHandoff?.({ context: workbenchHandoffContext('issues'), explicitOpen: true })
    return
  }
  if (action.kind === 'overview') {
    await opts.onBrowserHandoff?.({ context: workbenchHandoffContext('overview'), explicitOpen: true })
    return
  }
  if (action.kind === 'inspect') {
    await opts.onBrowserHandoff?.({ context: workbenchHandoffContext('default', action.status), explicitOpen: true })
    return
  }
}

type ModelAction =
  | { kind: 'refresh' }
  | { kind: 'issues' }
  | { kind: 'overview' }
  | { kind: 'browser'; context: AdminHandoffContext }
  | { kind: 'inspect'; status: ModelStatus }

function buildTitleSummary(def: ModelStatus | undefined, counts: OverviewCounts, tier: WidthTier): string {
  const defBudget = tier === 'narrow' ? 14 : tier === 'mid' ? 22 : 32
  const defText = def ? `default ${truncate(def.label, defBudget)}` : 'no default'
  const tail = tier === 'narrow'
    ? `${counts.available}/${counts.total} ok`
    : `${counts.available}/${counts.total} ok${counts.blocked ? ` · ${counts.blocked} blocked` : ''}${counts.orphan ? ` · ${counts.orphan} orphan` : ''}`
  return `🦉 Models · ${defText} · ${tail}`
}

/** Compact preview (≤5 lines) — for picker preview pane. */
export function renderCompactDetails(s: ModelStatus): string[] {
  const lines: string[] = []
  lines.push(`${sgr.bold}${truncate(s.label, 40)}${sgr.reset} ${dim(`(${truncate(s.id, 30)})`)}`)
  lines.push(`${availabilityIcon(s.availability)} ${availabilityPhrase(s.availability)}`)
  const providerLine = `${providerTag(s.providerKind)}${s.isDefault ? `  ${themeColor('owl')}★ default${sgr.reset}` : ''}${s.role ? `  ${dim('· ' + s.role)}` : ''}`
  lines.push(providerLine)
  const hints = availabilityFixHints(s.availability)
  if (hints.length > 0) {
    lines.push(`${dim('›')} ${hints[0]}`)
    lines.push(dim('Enter to open admin for this model.'))
  } else if (s.raw.config?.endpoint) {
    lines.push(dim(truncate(s.raw.config.endpoint, 56)))
    lines.push(dim('Enter to open admin for this model.'))
  } else {
    lines.push(dim('Enter to open admin for this model.'))
  }
  return lines
}

/** Compact overview (≤5 lines) for preview pane. */
export function renderCompactOverview(snapshot: ModelTruthSnapshot): string[] {
  const sorted = sortedStatuses(snapshot.statuses)
  const counts = overviewCounts(sorted)
  const def = sorted.find(s => s.isDefault)
  const topIssues = sorted
    .filter(s => s.availability.kind !== 'ok' && s.availability.kind !== 'orphan_discovered')
    .slice(0, 2)

  const lines: string[] = []
  lines.push(`${sgr.bold}Model truth${sgr.reset}  ${dim(`refreshed ${formatAge(snapshot.refreshedAt)}${snapshot.cacheHit ? ' (cache)' : ''}`)}`)
  if (def) {
    lines.push(`${dim('default')} ${availabilityIcon(def.availability)} ${truncate(def.label, 40)}`)
  } else {
    lines.push(`${dim('default')} ${dim('(none)')}`)
  }
  lines.push(`${dim('counts')}  ${counts.available}/${counts.total} ok · ${counts.blocked} blocked · ${counts.orphan} orphan · ${counts.local}L/${counts.cloud}C`)
  for (const s of topIssues) {
    lines.push(`${availabilityIcon(s.availability)} ${truncate(s.label, 26)} ${dim('— ' + shortAvailabilityTag(s.availability))}`)
  }
  return lines.slice(0, 5)
}

/** Compact issues preview (≤5 lines). */
export function renderCompactIssues(snapshot: ModelTruthSnapshot): string[] {
  const issues = sortedStatuses(snapshot.statuses).filter(s => s.availability.kind !== 'ok')
  if (issues.length === 0) return [`${themeColor('success')}●${sgr.reset} ${dim('no issues')}`]
  const lines: string[] = []
  lines.push(`${sgr.bold}${issues.length} issue${issues.length === 1 ? '' : 's'}${sgr.reset} ${dim('— Enter to expand')}`)
  for (const s of issues.slice(0, 4)) {
    lines.push(`${availabilityIcon(s.availability)} ${truncate(s.label, 26)} ${dim('— ' + shortAvailabilityTag(s.availability))}`)
  }
  return lines
}

function formatAge(t: number): string {
  const ms = Math.max(0, Date.now() - t)
  if (ms < 1000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  return `${Math.floor(ms / 60_000)}m ago`
}
