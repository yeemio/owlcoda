/**
 * Display helpers for the pre-computed ModelAvailability union.
 *
 * IMPORTANT: this module maps server-computed availability values to display
 * strings. It DOES NOT compute availability — the server decides what each
 * model's availability is; we only render it.
 */

import type { ModelAvailability, ModelStatus } from '../api/types'
import type { TranslationKey } from '../i18n'

type T = (key: TranslationKey, vars?: Record<string, string | number | undefined>) => string

const fallbackT: T = (key, vars) => {
  const fallbacks: Partial<Record<TranslationKey, string>> = {
    ready: 'Ready',
    missingKeyEnv: 'Missing key (env {env})',
    missingApiKey: 'Missing API key',
    endpointDown: 'Endpoint down - {reason}',
    runtimeMissing: 'Not visible in runtime truth',
    runtimeFoundUnconfigured: 'Found from runtime, not configured',
    aliasConflictWith: 'Alias conflict with "{alias}"',
    warming: 'Warming up...',
    statusUnknown: 'Status unknown',
    ok: 'ok',
    noKey: 'no key',
    down: 'down',
    legacyFallback: 'legacy-fallback',
    owlmlxGate: 'owlmlx-gate',
    gateWait: 'gate-wait',
    notVisibleTag: 'not-visible',
    notConfiguredTag: 'not-configured',
    aliasConflictTag: 'alias-conflict',
    unknown: 'unknown',
    setEnv: 'Set env {env}',
    fillKeyInline: 'Or: fill key inline via the key editor',
    addApiKeyInline: 'Add apiKey inline',
    bindApiKeyEnv: 'Or: bind apiKeyEnv',
    checkEndpoint: 'Check endpoint is reachable',
    verifyBackend: 'Verify backend process is up',
    removeFromConfig: 'Or: remove from config',
    deprecatedFallbackHint: 'Deprecated router fallback is still active for visibility truth',
    cutRuntimeOver: 'Cut this runtime over to owlmlx direct visibility surfaces when available',
    routerLongTerm: 'Do not treat router /v1/models as the long-term source of truth',
    owlmlxTruth: 'Use owlmlx /v1/openai/models as the availability truth',
    owlmlxDiagnostics: 'Use owlmlx /v1/runtime/model-visibility for diagnostics',
    owlmlxInventory: 'Treat owlmlx /v1/models as loaded inventory only',
    runtimeBlocker: 'Runtime visibility blocker: {reason}',
    waitGate: 'Wait for the platform visibility gate to admit this model',
    routerTruth: 'Use router /v1/models as the availability truth, not catalog-only state',
    platformGateStatus: 'Platform gate status: {status}',
    restartRouter: 'Restart the router',
    removeStaleConfig: 'Or: remove stale entry from config',
    saveRuntimeVisible: 'Save this runtime-visible model to config',
    leaveDiagnostics: 'Or: leave it in advanced diagnostics',
    renameAlias: 'Rename one of the aliases (conflict key: "{alias}")',
    waitNoAction: 'Wait - no action needed',
    checkRuntime: 'Check runtime / router status',
  }
  const template = fallbacks[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ''))
}

export function availabilityPhrase(a: ModelAvailability, t: T = fallbackT): string {
  switch (a.kind) {
    case 'ok': return t('ready')
    case 'missing_key': return a.envName ? t('missingKeyEnv', { env: a.envName }) : t('missingApiKey')
    case 'endpoint_down': return t('endpointDown', { reason: a.reason })
    case 'router_missing': return a.reason ?? t('runtimeMissing')
    case 'orphan_discovered': return t('runtimeFoundUnconfigured')
    case 'alias_conflict': return t('aliasConflictWith', { alias: a.with })
    case 'warming': return t('warming')
    case 'unknown': return a.reason || t('statusUnknown')
  }
}

export function availabilityShortTag(a: ModelAvailability, t: T = fallbackT): string {
  switch (a.kind) {
    case 'ok': return t('ok')
    case 'missing_key': return t('noKey')
    case 'endpoint_down': return t('down')
    case 'router_missing':
      if (a.deprecatedFallback) return t('legacyFallback')
      if (a.visibilityRule === 'runtime_gate_required_before_visible') return t('owlmlxGate')
      if (a.visibilityRule === 'gate_required_before_visible') return t('gateWait')
      return t('notVisibleTag')
    case 'orphan_discovered': return t('notConfiguredTag')
    case 'alias_conflict': return t('aliasConflictTag')
    case 'warming': return t('warming')
    case 'unknown': return t('unknown')
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

export function availabilityFixHints(a: ModelAvailability, t: T = fallbackT): string[] {
  switch (a.kind) {
    case 'ok': return []
    case 'missing_key':
      return a.envName
        ? [t('setEnv', { env: a.envName }), t('fillKeyInline')]
        : [t('addApiKeyInline'), t('bindApiKeyEnv')]
    case 'endpoint_down':
      return [t('checkEndpoint'), t('verifyBackend'), t('removeFromConfig')]
    case 'router_missing':
      if (a.deprecatedFallback) {
        return [
          t('deprecatedFallbackHint'),
          t('cutRuntimeOver'),
          t('routerLongTerm'),
        ]
      }
      if (a.visibilityRule === 'runtime_gate_required_before_visible' || a.truthSurface === '/v1/openai/models') {
        const hints = [
          t('owlmlxTruth'),
          t('owlmlxDiagnostics'),
          t('owlmlxInventory'),
        ]
        if (a.blockReason) hints.unshift(t('runtimeBlocker', { reason: a.blockReason }))
        return hints
      }
      if (a.visibilityRule === 'gate_required_before_visible') {
        const hints = [t('waitGate'), t('routerTruth')]
        if (a.gateStatus && a.gateStatus !== 'ready') hints.unshift(t('platformGateStatus', { status: a.gateStatus }))
        return hints
      }
      return [t('restartRouter'), t('removeStaleConfig')]
    case 'orphan_discovered':
      return [t('saveRuntimeVisible'), t('leaveDiagnostics')]
    case 'alias_conflict':
      return [t('renameAlias', { alias: a.with })]
    case 'warming':
      return [t('waitNoAction')]
    case 'unknown':
      return [t('checkRuntime')]
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
