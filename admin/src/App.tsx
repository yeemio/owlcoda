import { useEffect, useState } from 'react'
import { ModelsPage } from './pages/ModelsPage'
import { AliasConflictsPage } from './pages/AliasConflictsPage'
import { OrphansPage } from './pages/OrphansPage'
import { CatalogPage } from './pages/CatalogPage'
import { StartPage } from './pages/StartPage'
import { RunsPage } from './pages/RunsPage'
import { useSnapshot } from './hooks/useSnapshot'
import { bootstrapAuth } from './auth/session'
import { readHandoff, type HandoffRoute } from './lib/handoff'

type AuthState =
  | { status: 'pending' }
  | { status: 'ready'; hadOneShot: boolean }
  | { status: 'failed'; reason: string }

function urlHasOneShot(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('token')
}

export function App() {
  // Handoff is read once on mount. Subsequent hash changes (user navigating
  // via nav links) update `route` but don't re-trigger handoff select/filter —
  // those are only applied as *initial* props, not sticky overrides.
  const [handoff] = useState(() => readHandoff())
  const [route, setRoute] = useState<HandoffRoute>(handoff.route)
  const [auth, setAuth] = useState<AuthState>({ status: 'pending' })
  const [handoffChipDismissed, setHandoffChipDismissed] = useState(false)
  // Defer initial snapshot fetch until auth bootstrap resolves. If we let
  // useSnapshot auto-fetch on mount, it races the exchange POST and always
  // loses — the server replies 401 "Missing admin session" because the
  // session cookie hasn't been set yet. We kick off refresh() manually below
  // once bootstrapAuth finishes (even if exchange failed — maybe cookie is
  // still valid from a prior handoff, or a stale session works read-only).
  const { snapshot, error, loading, refresh, applyFreshSnapshot } = useSnapshot({ autoFetch: false })

  useEffect(() => {
    const hadOneShot = urlHasOneShot()
    bootstrapAuth().then(result => {
      if (result.ok) {
        setAuth({ status: 'ready', hadOneShot: true })
      } else if (hadOneShot) {
        setAuth({ status: 'failed', reason: result.reason ?? 'Unknown auth error' })
      } else {
        setAuth({ status: 'ready', hadOneShot: false })
      }
      // Regardless of exchange outcome, attempt the snapshot. Success with a
      // stale cookie is a valid read-only state; 401 here surfaces via the
      // snapshot error banner (distinct from the handoff banner above).
      refresh()
    })
  }, [refresh])

  useEffect(() => {
    const onHashChange = () => {
      const next = readHandoff()
      setRoute(next.route)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Show a muted "Opened from OwlCoda" chip for arrivals via handoff, until
  // the user dismisses it or navigates to a different tab than the landing
  // one. Quiet by design — not a full-width banner.
  const showHandoffChip = handoff.arrivedFromHandoff && !handoffChipDismissed

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">🦉 OwlCoda Admin</span>
        <nav>
          <NavLink href="#/start" active={route === 'start'}>Start</NavLink>
          <NavLink href="#/models" active={route === 'models' || route === 'issues'}>Models</NavLink>
          <NavLink href="#/aliases" active={route === 'aliases'}>Aliases</NavLink>
          <NavLink href="#/orphans" active={route === 'orphans'}>Orphans</NavLink>
          <NavLink href="#/catalog" active={route === 'catalog'}>Catalog</NavLink>
          <NavLink href="#/runs" active={route === 'runs'}>Runs</NavLink>
        </nav>
        <span className="spacer" />
        {showHandoffChip && (
          <span
            className="handoff-chip"
            data-testid="handoff-chip"
            title={handoffChipTitle(handoff.route, handoff.select ?? handoff.focus)}
          >
            <span className="dot" aria-hidden>•</span>
            {handoff.route === 'runs' ? 'opened from stress harness' : 'opened from OwlCoda'}
            <button
              type="button"
              className="handoff-chip-dismiss"
              aria-label="dismiss"
              data-testid="handoff-chip-dismiss"
              onClick={() => setHandoffChipDismissed(true)}
            >✕</button>
          </span>
        )}
        {!handoff.arrivedFromHandoff && snapshot && (
          <span
            className="handoff-chip"
            data-testid="freshness-chip"
            title={`Snapshot loaded ${new Date(snapshot.refreshedAt).toLocaleTimeString()} — refresh from each page to update.`}
          >
            <span className="dot" aria-hidden>•</span>
            snapshot · {formatSnapshotTime(snapshot.refreshedAt)}
          </span>
        )}
        <span className="meta">
          {auth.status === 'pending' ? 'bootstrapping…' : `v${ADMIN_DISPLAY_VERSION}`}
        </span>
      </header>

      {auth.status === 'failed' && (
        <div className="panel" style={{ borderRight: 0 }}>
          <div className="banner err" role="alert" data-testid="auth-error-banner">
            <strong>Admin handoff failed.</strong>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              {auth.reason}
              {' · '}
              Writes will be rejected until a fresh <code>owlcoda ui</code> handoff succeeds.
              You can still browse read-only state below
              {handoff.select && <> — landed on <code>{handoff.select}</code></>}.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="panel" style={{ borderRight: 0 }}>
          <div className="banner err" role="alert" data-testid="error-banner">
            {error}
          </div>
        </div>
      )}

      {!snapshot && loading && !error && (
        <div className="panel" style={{ borderRight: 0 }}>
          <div className="empty">Loading snapshot…</div>
        </div>
      )}

      {snapshot && route === 'start' && (
        <StartPage
          snapshot={snapshot}
          onSnapshotUpdate={applyFreshSnapshot}
          onRefresh={refresh}
          loading={loading}
        />
      )}
      {snapshot && route === 'aliases' && (
        <AliasConflictsPage
          snapshot={snapshot}
          onSnapshotUpdate={applyFreshSnapshot}
          initialFocus={handoff.route === 'aliases' ? handoff.focus ?? handoff.select : undefined}
        />
      )}
      {snapshot && route === 'orphans' && (
        <OrphansPage
          snapshot={snapshot}
          onSnapshotUpdate={applyFreshSnapshot}
          initialSelect={handoff.route === 'orphans' ? handoff.select : undefined}
        />
      )}
      {snapshot && route === 'catalog' && (
        <CatalogPage
          snapshot={snapshot}
          onSnapshotUpdate={applyFreshSnapshot}
          initialSelect={handoff.route === 'catalog' ? handoff.select : undefined}
        />
      )}
      {snapshot && route === 'runs' && (
        <RunsPage />
      )}
      {snapshot && (route === 'models' || route === 'issues') && (
        <ModelsPage
          snapshot={snapshot}
          onRefresh={refresh}
          onSnapshotUpdate={applyFreshSnapshot}
          loading={loading}
          initialFilter={
            (handoff.route === 'models' || handoff.route === 'issues') && handoff.filter
              ? handoff.filter
              : route === 'issues' ? 'issues' : 'all'
          }
          initialView={handoff.route === 'models' || handoff.route === 'issues' ? handoff.view : undefined}
          initialProvider={handoff.route === 'models' || handoff.route === 'issues' ? handoff.provider : undefined}
          initialSelect={
            handoff.route === 'models' || handoff.route === 'issues' ? handoff.select : undefined
          }
          // Intentionally NOT keying by route alone now — re-mounting every
          // handoff change would drop write context. Remount only when the
          // user navigates routes, not when snapshots refresh.
          key={route === 'issues' ? 'models-issues' : 'models-all'}
        />
      )}
    </div>
  )
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a href={href} className={active ? 'active' : ''}>{children}</a>
  )
}

function handoffChipTitle(route: HandoffRoute, target: string | undefined): string {
  const label = route === 'start' ? 'Start'
    : route === 'aliases' ? 'Alias conflicts'
    : route === 'orphans' ? 'Orphans'
      : route === 'catalog' ? 'Catalog'
        : route === 'runs' ? 'Runs'
          : 'Models'
  const source = route === 'runs' ? 'stress harness' : 'OwlCoda'
  return target ? `Opened from ${source} → ${label} · ${target}` : `Opened from ${source} → ${label}`
}

/**
 * Display version surfaced in the admin header chrome. Hardcoded to keep the
 * admin bundle decoupled from package.json reads at runtime; bump in lockstep
 * with package.json on each release. (Verified at build time by tests.)
 */
const ADMIN_DISPLAY_VERSION = '0.1.5'

/**
 * Render snapshot timestamp as relative-ish text. Under a minute we say
 * "just now"; otherwise we surface the wall-clock time the snapshot loaded
 * so users can verify whether they're looking at fresh data.
 */
function formatSnapshotTime(refreshedAtMs: number): string {
  const ageMs = Date.now() - refreshedAtMs
  if (ageMs < 60_000) return 'just now'
  return new Date(refreshedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
