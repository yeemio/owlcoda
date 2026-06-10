import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/App'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { __resetAuthForTests } from '../src/auth/session'
import { mkSnapshot, mkStatus } from './fixtures'

/**
 * End-to-end handoff: URL arrives with `?token=` + hash, browser parses,
 * exchanges token, lands on target route/selection, strips token from URL.
 */

function installFetchMock(handlers: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const journal: Array<{ method: string; path: string; body: unknown }> = []
  const real = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body) { try { body = JSON.parse(String(init.body)) } catch { body = init.body } }
    journal.push({ method, path: url, body })
    const handler = handlers[`${method} ${url}`]
    if (!handler) {
      return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: `no mock for ${method} ${url}` } }), { status: 404 })
    }
    const { status, body: resBody } = handler(body)
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { journal, restore: () => { globalThis.fetch = real } }
}

const handoffSnapshot = () => mkSnapshot([
  mkStatus({ id: 'model-alpha-7', label: 'Model Alpha 7', isDefault: true }),
  mkStatus({ id: 'kimi-k2', label: 'Kimi K2', availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' }, raw: { config: { id: 'kimi-k2', label: 'Kimi K2', backendModel: 'kimi-k2', aliases: [] } as any } }),
  mkStatus({ id: 'model-a', label: 'A', availability: { kind: 'alias_conflict', with: 'shared-alias' }, raw: { config: { id: 'model-a', label: 'A', backendModel: 'model-a', aliases: ['shared-alias'] } as any } }),
  mkStatus({ id: 'model-b', label: 'B', availability: { kind: 'alias_conflict', with: 'shared-alias' }, raw: { config: { id: 'model-b', label: 'B', backendModel: 'model-b', aliases: ['shared-alias'] } as any } }),
  mkStatus({ id: 'llama3-8b', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'llama3-8b', label: 'Llama 3 8B', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' } } }),
])

function mockSuccessfulExchange() {
  return installFetchMock({
    'POST /admin/api/auth/exchange': () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, csrfToken: 'csrf-xyz' },
    }),
    'GET /admin/api/snapshot': () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot: handoffSnapshot() },
    }),
    'GET /admin/api/catalog': () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        items: [
          { id: 'kimi-k2', backend: 'cloud', endpoint: 'https://api.kimi.com/v1' },
          { id: 'new-cloud', backend: 'cloud', endpoint: 'https://example.com/v1' },
        ],
        aliases: {},
        defaultModel: null,
        catalogVersion: '1',
      },
    }),
  })
}

function go(hash: string, search = '?token=ots1.good') {
  window.history.replaceState({}, '', `/admin/${search}${hash}`)
}

describe('Handoff landing', () => {
  let restore: (() => void) | null = null

  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/')
  })

  afterEach(() => {
    restore?.()
    restore = null
    __resetAuthForTests()
    window.history.replaceState({}, '', '/admin/')
  })

  // ─── Route landing (4 routes) ────────────────────────────────────

  it('lands on Models with selected id from handoff', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/models?select=kimi-k2')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('model-list')).toBeInTheDocument())
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Kimi K2')
  })

  it('lands on Aliases with focused group from handoff', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/aliases?select=shared-alias')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('conflict-group-shared-alias')).toBeInTheDocument())
    expect(screen.getByTestId('conflict-group-shared-alias')).toHaveAttribute('data-focused', 'true')
  })

  it('lands on Aliases via /issues/aliases back-compat path too', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/issues/aliases')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('alias-conflicts-page')).toBeInTheDocument())
  })

  it('lands on Orphans with checkbox pre-checked from handoff', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/orphans?select=llama3-8b')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('orphan-llama3-8b')).toBeInTheDocument())
    const checkbox = screen.getByTestId('orphan-check-llama3-8b') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('lands on Catalog with select, auto-switching filter when target is not under default filter', async () => {
    restore = mockSuccessfulExchange().restore
    // kimi-k2 is already configured (snapshot has raw.config) so it's status="configured"
    // under the default "not-imported" filter it would be hidden — page must flip to "all".
    go('#/catalog?select=kimi-k2')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('catalog-row-kimi-k2')).toBeInTheDocument())
    expect(screen.getByTestId('catalog-filter-all')).toHaveClass('active')
  })

  // ─── Token cleanup ───────────────────────────────────────────────

  it('strips ?token=... from URL after successful exchange, preserving hash', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/aliases?select=shared-alias')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('alias-conflicts-page')).toBeInTheDocument())
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#/aliases?select=shared-alias')
  })

  // ─── Handoff chip ────────────────────────────────────────────────

  it('shows muted "opened from OwlCoda" chip only on handoff arrival', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/models?select=kimi-k2')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('handoff-chip')).toBeInTheDocument())
    expect(screen.getByTestId('handoff-chip')).toHaveAttribute(
      'title',
      expect.stringContaining('Models'),
    )
  })

  it('hides chip when no ?token= arrives', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/models', '')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('model-list')).toBeInTheDocument())
    expect(screen.queryByTestId('handoff-chip')).toBeNull()
  })

  // ─── Auth failure preserves route/selection ──────────────────────

  it('auth failure: banner appears AND target route is still reached', async () => {
    restore = installFetchMock({
      'POST /admin/api/auth/exchange': () => ({
        status: 401,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'authentication_error', message: 'one-shot expired' } },
      }),
      'GET /admin/api/snapshot': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot: handoffSnapshot() },
      }),
    }).restore
    go('#/orphans?select=llama3-8b')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('auth-error-banner')).toBeInTheDocument())
    // Even with auth down, the user landed on the right page.
    expect(screen.getByTestId('orphan-llama3-8b')).toBeInTheDocument()
    const checkbox = screen.getByTestId('orphan-check-llama3-8b') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    // Banner mentions the landed object.
    expect(screen.getByTestId('auth-error-banner')).toHaveTextContent('llama3-8b')
  })

  // ─── Fallback when target id not in snapshot ─────────────────────

  it('select=<unknown-id> falls back without crashing; selection reverts to default pick', async () => {
    restore = mockSuccessfulExchange().restore
    go('#/models?select=does-not-exist')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('model-list')).toBeInTheDocument())
    // Falls back to default model
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Model Alpha 7')
  })

  it('Models view=issues + select of an ok model: flips to "all" rather than dropping context', async () => {
    restore = mockSuccessfulExchange().restore
    // model-alpha-7 is ok — under view=issues it would be hidden; expected behavior
    // is to flip filter to 'all' so the user sees their target.
    go('#/models?view=issues&select=model-alpha-7')
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('model-list')).toBeInTheDocument())
    expect(screen.getByTestId('filter-all')).toHaveClass('active')
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Model Alpha 7')
  })
})
