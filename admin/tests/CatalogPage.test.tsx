import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CatalogPage } from '../src/pages/CatalogPage'
import { __resetAuthForTests, __setCsrfTokenForTests } from '../src/auth/session'
import { ADMIN_API_SCHEMA_VERSION, type ModelTruthSnapshot } from '../src/api/types'
import { mkSnapshot, mkStatus } from './fixtures'

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
    if (!handler) return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: 'missing' } }), { status: 404 })
    const { status, body: resBody } = handler(body)
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { journal, restore: () => { globalThis.fetch = real } }
}

describe('CatalogPage', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => { __setCsrfTokenForTests('csrf-test') })
  afterEach(() => { fx?.restore(); __resetAuthForTests(); vi.restoreAllMocks() })

  const snap = () => mkSnapshot([
    // 'already-here' corresponds to a catalog entry — shows as configured
    mkStatus({ id: 'already-here', label: 'Already', raw: { config: { id: 'already-here', label: 'Already', backendModel: 'already-here', aliases: [] } as any } }),
    mkStatus({ id: 'local-orphan', availability: { kind: 'orphan_discovered' } }),
  ])

  function Driver({ initial }: { initial: ModelTruthSnapshot }) {
    const [s, set] = useState(initial)
    return <CatalogPage snapshot={s} onSnapshotUpdate={set} />
  }

  const catalogBody = () => ({
    status: 200,
    body: {
      schemaVersion: ADMIN_API_SCHEMA_VERSION,
      items: [
        { id: 'already-here', backend: 'router', priority_role: 'chat' },
        { id: 'local-orphan', backend: 'ollama', priority_role: 'coding' },
        { id: 'not-yet', backend: 'cloud', endpoint: 'https://example.com/v1', priority_role: 'balanced' },
        { id: 'cloud-2', backend: 'cloud', endpoint: 'https://example.com/v1' },
      ],
      aliases: {},
      defaultModel: null,
      catalogVersion: '1.0',
    },
  })

  it('shows correct import status for each catalog row', async () => {
    fx = installFetchMock({
      'GET /admin/api/catalog': catalogBody,
    })
    render(<Driver initial={snap()} />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    // default filter = not-imported
    expect(screen.getByTestId('catalog-status-not-yet')).toHaveTextContent('import')
    expect(screen.getByTestId('catalog-status-cloud-2')).toHaveTextContent('import')
    // switch to 'all' to inspect other statuses
    fireEvent.click(screen.getByTestId('catalog-filter-all'))
    expect(screen.getByTestId('catalog-status-already-here')).toHaveTextContent('configured')
    expect(screen.getByTestId('catalog-status-local-orphan')).toHaveTextContent('orphan')
  })

  it('"not imported" filter excludes configured + orphan rows', async () => {
    fx = installFetchMock({ 'GET /admin/api/catalog': catalogBody })
    render(<Driver initial={snap()} />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())
    // Default filter is 'not-imported'
    expect(screen.queryByTestId('catalog-row-already-here')).toBeNull()
    expect(screen.queryByTestId('catalog-row-local-orphan')).toBeNull()
    expect(screen.getByTestId('catalog-row-not-yet')).toBeInTheDocument()
    expect(screen.getByTestId('catalog-row-cloud-2')).toBeInTheDocument()
  })

  it('batch imports selected endpoint-based catalog entries', async () => {
    const postSnap = mkSnapshot([
      mkStatus({ id: 'already-here' }),
      mkStatus({ id: 'local-orphan', availability: { kind: 'orphan_discovered' } }),
      mkStatus({ id: 'not-yet' }),
    ])
    fx = installFetchMock({
      'GET /admin/api/catalog': catalogBody,
      'POST /admin/api/bulk/create': () => ({
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: true,
          results: [{ id: 'not-yet', ok: true }],
          snapshot: postSnap,
        },
      }),
    })
    render(<Driver initial={snap()} />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('catalog-check-not-yet'))
    fireEvent.click(screen.getByTestId('catalog-execute'))

    await waitFor(() => {
      expect(screen.getByTestId('batch-result-not-yet')).toHaveAttribute('data-ok', 'true')
    })
    const sent = fx.journal.find(r => r.path === '/admin/api/bulk/create')!
    const body = sent.body as { items: Array<{ model: { id: string; endpoint: string } }> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.model).toMatchObject({ id: 'not-yet', endpoint: 'https://example.com/v1' })
  })

  it('partial success + failure surfaces per-item results', async () => {
    fx = installFetchMock({
      'GET /admin/api/catalog': catalogBody,
      'POST /admin/api/bulk/create': () => ({
        status: 207,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: false,
          results: [
            { id: 'not-yet', ok: true },
            { id: 'cloud-2', ok: false, error: { code: 'mutation_failed', message: 'duplicate' } },
          ],
          snapshot: snap(),
        },
      }),
    })
    render(<Driver initial={snap()} />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('catalog-check-not-yet'))
    fireEvent.click(screen.getByTestId('catalog-check-cloud-2'))
    fireEvent.click(screen.getByTestId('catalog-execute'))

    await waitFor(() => {
      expect(screen.getByTestId('batch-result-not-yet')).toHaveAttribute('data-ok', 'true')
      expect(screen.getByTestId('batch-result-cloud-2')).toHaveAttribute('data-ok', 'false')
      expect(screen.getByTestId('batch-result-cloud-2')).toHaveTextContent('duplicate')
    })
  })

  it('catalog load failure surfaces error banner', async () => {
    fx = installFetchMock({
      'GET /admin/api/catalog': () => ({
        status: 500,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'internal_error', message: 'catalog broke' } },
      }),
    })
    render(<Driver initial={snap()} />)
    await waitFor(() => expect(screen.getByTestId('catalog-load-error')).toHaveTextContent('catalog broke'))
  })

  // ─── Strict endpoint-only (δ cleanup) ───────────────────────────

  const snapForStrict = () => mkSnapshot([])

  const strictCatalogBody = () => ({
    status: 200,
    body: {
      schemaVersion: ADMIN_API_SCHEMA_VERSION,
      items: [
        { id: 'cloud-ok', backend: 'cloud', endpoint: 'https://example.com/v1', priority_role: 'balanced' },
        { id: 'local-mistral', backend: 'ollama', priority_role: 'coding' },
        { id: 'local-qwen', backend: 'lmstudio' },
      ],
      aliases: {},
      defaultModel: null,
      catalogVersion: '1',
    },
  })

  function StrictDriver() {
    const [s, set] = useState(snapForStrict())
    return <CatalogPage snapshot={s} onSnapshotUpdate={set} />
  }

  it('non-endpoint catalog entries have disabled checkbox + "local-only" status pill', async () => {
    fx = installFetchMock({ 'GET /admin/api/catalog': strictCatalogBody })
    render(<StrictDriver />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    const cloudCheck = screen.getByTestId('catalog-check-cloud-ok') as HTMLInputElement
    const localCheckA = screen.getByTestId('catalog-check-local-mistral') as HTMLInputElement
    const localCheckB = screen.getByTestId('catalog-check-local-qwen') as HTMLInputElement

    expect(cloudCheck).not.toBeDisabled()
    expect(localCheckA).toBeDisabled()
    expect(localCheckB).toBeDisabled()

    expect(screen.getByTestId('catalog-status-local-mistral')).toHaveTextContent('local-only')
    expect(screen.getByTestId('catalog-row-local-mistral')).toHaveAttribute('data-importable', 'false')
    expect(screen.getByTestId('catalog-unimportable-local-mistral')).toHaveTextContent('Orphans')
  })

  it('drawer for local-only entry shows "go to Orphans" guidance, no endpoint input', async () => {
    fx = installFetchMock({ 'GET /admin/api/catalog': strictCatalogBody })
    render(<StrictDriver />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('catalog-select-local-mistral'))
    expect(screen.getByTestId('catalog-note-no-endpoint')).toHaveTextContent('Orphans')
    // The endpoint draft input must not be offered
    expect(screen.queryByTestId('catalog-draft-endpoint')).toBeNull()
    // Link to Orphans must be present
    const link = screen.getByTestId('catalog-goto-orphans') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('#/orphans')
  })

  it('cannot sneak a local-only entry into batch by any means', async () => {
    fx = installFetchMock({
      'GET /admin/api/catalog': strictCatalogBody,
      'POST /admin/api/bulk/create': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [], snapshot: snapForStrict() },
      }),
    })
    render(<StrictDriver />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    // The check inputs are disabled, so fireEvent.click is a no-op. Even if
    // an attacker tried to force `selected: true` via drafts, the importable
    // guard in items useMemo rejects the row. We verify by selecting the ok
    // cloud one + trying the disabled locals (which will stay unchecked) and
    // asserting payload size.
    fireEvent.click(screen.getByTestId('catalog-check-cloud-ok'))
    // These calls target disabled inputs — React change ignored for [disabled]
    fireEvent.click(screen.getByTestId('catalog-check-local-mistral'))
    fireEvent.click(screen.getByTestId('catalog-check-local-qwen'))
    fireEvent.click(screen.getByTestId('catalog-execute'))

    await waitFor(() => expect(fx.journal.find(r => r.path === '/admin/api/bulk/create')).toBeDefined())
    const sent = fx.journal.find(r => r.path === '/admin/api/bulk/create')!
    const body = sent.body as { items: Array<{ model: { id: string; endpoint: string } }> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.model.id).toBe('cloud-ok')
    expect(body.items[0]!.model.endpoint).toBe('https://example.com/v1')
  })

  it('endpoint-based imports still work (no regression)', async () => {
    fx = installFetchMock({
      'GET /admin/api/catalog': strictCatalogBody,
      'POST /admin/api/bulk/create': () => ({
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: true,
          results: [{ id: 'cloud-ok', ok: true }],
          snapshot: mkSnapshot([mkStatus({ id: 'cloud-ok' })]),
        },
      }),
    })
    render(<StrictDriver />)
    await waitFor(() => expect(screen.getByTestId('catalog-list')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('catalog-check-cloud-ok'))
    fireEvent.click(screen.getByTestId('catalog-execute'))
    await waitFor(() => expect(screen.getByTestId('batch-result-cloud-ok')).toHaveAttribute('data-ok', 'true'))
  })
})
