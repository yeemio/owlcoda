/**
 * Display helpers for the pre-computed ModelAvailability union.
 *
 * IMPORTANT: this module maps server-computed availability values to display
 * strings. It DOES NOT compute availability — the server decides what each
 * model's availability is; we only render it.
 */

import type { ModelAvailability, ModelStatus } from '../api/types'

export function availabilityPhrase(a: ModelAvailability): string {
  switch (a.kind) {
    case 'ok': return 'Ready'
    case 'missing_key': return a.envName ? `Missing key (env ${a.envName})` : 'Missing API key'
    case 'endpoint_down': return `Endpoint down — ${a.reason}`
    case 'router_missing': return a.reason ?? 'Not visible in runtime truth'
    case 'orphan_discovered': return 'Found locally, not in config'
    case 'alias_conflict': return `Alias conflict with "${a.with}"`
    case 'warming': return 'Warming up…'
    case 'unknown': return a.reason || 'Status unknown'
  }
}

export function availabilityShortTag(a: ModelAvailability): string {
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

export type AvailabilityTone = 'ok' | 'warn' | 'err' | 'info' | 'muted'

export function availabilityTone(a: ModelAvailability): AvailabilityTone {
  switch (a.kind) {
    case 'ok': return 'ok'
    case 'warming': return 'info'
    case 'missing_key':
    case 'router_missing':
      return 'warn'
    case 'endpoint_down':
    case 'alias_conflict':
      return 'err'
    case 'orphan_discovered':
      return 'info'
    case 'unknown':
      return 'muted'
  }
}

export function availabilityFixHints(a: ModelAvailability): string[] {
  switch (a.kind) {
    case 'ok': return []
    case 'missing_key':
      return a.envName
        ? [`Set env ${a.envName}`, 'Or: fill key inline via the key editor']
        : ['Add apiKey inline', 'Or: bind apiKeyEnv']
    case 'endpoint_down':
      return ['Check endpoint is reachable', 'Verify backend process is up', 'Or: remove from config']
    case 'router_missing':
      if (a.deprecatedFallback) {
        return [
          'Deprecated router fallback is still active for visibility truth',
          'Cut this runtime over to owlmlx direct visibility surfaces when available',
          'Do not treat router /v1/models as the long-term source of truth',
        ]
      }
      if (a.visibilityRule === 'runtime_gate_required_before_visible' || a.truthSurface === '/v1/openai/models') {
        const hints = [
          'Use owlmlx /v1/openai/models as the availability truth',
          'Use owlmlx /v1/runtime/model-visibility for diagnostics',
          'Treat owlmlx /v1/models as loaded inventory only',
        ]
        if (a.blockReason) hints.unshift(`Runtime visibility blocker: ${a.blockReason}`)
        return hints
      }
      if (a.visibilityRule === 'gate_required_before_visible') {
        const hints = ['Wait for the platform visibility gate to admit this model', 'Use router /v1/models as the availability truth, not catalog-only state']
        if (a.gateStatus && a.gateStatus !== 'ready') hints.unshift(`Platform gate status: ${a.gateStatus}`)
        return hints
      }
      return ['Restart the router', 'Or: remove stale entry from config']
    case 'orphan_discovered':
      return ['Bind to config (Phase γ)', 'Or: ignore']
    case 'alias_conflict':
      return [`Rename one of the aliases (conflict key: "${a.with}")`]
    case 'warming':
      return ['Wait — no action needed']
    case 'unknown':
      return ['Check runtime / router status']
  }
}

// ─── Sort / filter / aggregate (pure; no truth re-computation) ───────

export function statusSortRank(s: ModelStatus): number {
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

export function sortStatuses(statuses: ModelStatus[]): ModelStatus[] {
  return [...statuses].sort((a, b) => {
    const ra = statusSortRank(a)
    const rb = statusSortRank(b)
    if (ra !== rb) return ra - rb
    return a.id.localeCompare(b.id)
  })
}

export function filterIssues(statuses: ModelStatus[]): ModelStatus[] {
  return statuses.filter(s => s.availability.kind !== 'ok')
}

export interface OverviewCounts {
  total: number
  ok: number
  blocked: number
  orphan: number
  local: number
  cloud: number
}

export function overviewCounts(statuses: ModelStatus[]): OverviewCounts {
  let ok = 0, blocked = 0, orphan = 0, local = 0, cloud = 0
  for (const s of statuses) {
    if (s.availability.kind === 'ok') ok++
    else if (s.availability.kind === 'orphan_discovered') orphan++
    else blocked++
    if (s.providerKind === 'local') local++
    else if (s.providerKind === 'cloud') cloud++
  }
  return { total: statuses.length, ok, blocked, orphan, local, cloud }
}
