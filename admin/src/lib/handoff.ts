/**
 * OwlCoda Admin handoff URL contract.
 *
 * Wire shape mirrors `src/admin-delivery.ts#AdminHandoffContext`:
 *
 *     /admin/?token=<one-shot>#/<route>?<params>
 *
 * where `<route>` is one of: start | models | aliases | orphans | catalog
 * and `<params>` supports:
 *   - select=<modelId | alias>
 *   - view=<issues | all | overview | …>   route-specific hint
 *   - provider=<templateId>                 add-model provider preset
 *
 * For backward compatibility with in-app nav links written before this
 * contract solidified, we also accept `/issues`, `/issues/aliases`,
 * `/issues/orphans` paths — these are not emitted by any sender now but
 * may appear in user bookmarks or tests.
 *
 * This module is pure parsing. It does NOT mutate history or call network.
 */

export type HandoffRoute = 'start' | 'models' | 'issues' | 'aliases' | 'orphans' | 'catalog'

export interface HandoffContext {
  route: HandoffRoute
  /** Model id, alias, or catalog id to pre-select / focus. */
  select?: string
  /** Add-model provider preset to pre-select. */
  provider?: string
  /** Models-page filter override (maps to `view=issues|all`). */
  filter?: 'all' | 'issues'
  /** Raw `view` param — page-specific hint beyond filter. */
  view?: string
  /** Alias-conflicts focus (may duplicate `select`). */
  focus?: string
  /** True iff the URL carried a one-shot token on first paint. */
  arrivedFromHandoff: boolean
}

export interface ParsedHash {
  path: string
  params: URLSearchParams
}

export function parseHash(hash: string): ParsedHash {
  const stripped = hash.replace(/^#\/?/, '')
  const queryIndex = stripped.indexOf('?')
  if (queryIndex === -1) {
    return { path: stripped, params: new URLSearchParams() }
  }
  return {
    path: stripped.slice(0, queryIndex),
    params: new URLSearchParams(stripped.slice(queryIndex + 1)),
  }
}

export function pathToRoute(path: string): HandoffRoute {
  if (path === 'start' || path.startsWith('start/')) return 'start'
  // Canonical handoff routes (from src/admin-delivery.ts).
  if (path === 'models' || path.startsWith('models/')) return 'models'
  if (path === 'aliases' || path.startsWith('aliases/')) return 'aliases'
  if (path === 'orphans' || path.startsWith('orphans/')) return 'orphans'
  if (path === 'catalog' || path.startsWith('catalog/')) return 'catalog'
  // Back-compat in-app links.
  if (path.startsWith('issues/aliases')) return 'aliases'
  if (path.startsWith('issues/orphans')) return 'orphans'
  if (path.startsWith('issues')) return 'issues'
  return 'start'
}

export function readHandoff(
  url: { hash: string; search: string } = typeof window !== 'undefined' ? window.location : { hash: '', search: '' },
): HandoffContext {
  const { path, params } = parseHash(url.hash ?? '')
  const route = pathToRoute(path)
  const selectRaw = params.get('select') ?? undefined
  const providerRaw = params.get('provider') ?? undefined
  const focusRaw = params.get('focus') ?? undefined
  const viewRaw = params.get('view') ?? undefined
  const filter: HandoffContext['filter'] =
    viewRaw === 'issues' || viewRaw === 'all' ? viewRaw : undefined
  const arrivedFromHandoff = new URLSearchParams(url.search ?? '').has('token')

  return {
    route,
    select: selectRaw?.trim() || undefined,
    provider: providerRaw?.trim() || undefined,
    focus: focusRaw?.trim() || undefined,
    view: viewRaw?.trim() || undefined,
    filter,
    arrivedFromHandoff,
  }
}

/** Build a canonical handoff hash (matches server `buildAdminHandoffHash`). */
export function buildHash(ctx: Partial<HandoffContext> & { route: HandoffRoute }): string {
  const path = routeToPath(ctx.route)
  const params = new URLSearchParams()
  if (ctx.select) params.set('select', ctx.select)
  if (ctx.provider) params.set('provider', ctx.provider)
  if (ctx.focus) params.set('focus', ctx.focus)
  if (ctx.view) params.set('view', ctx.view)
  else if (ctx.filter) params.set('view', ctx.filter)
  const qs = params.toString()
  return qs ? `#${path}?${qs}` : `#${path}`
}

function routeToPath(route: HandoffRoute): string {
  switch (route) {
    case 'start': return '/start'
    case 'aliases': return '/aliases'
    case 'orphans': return '/orphans'
    case 'catalog': return '/catalog'
    case 'issues': return '/issues'
    case 'models': return '/models'
  }
}
