/**
 * Task 2: Models empty state.
 * Task 3: Local-runtime section in ModelDrawer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelsPage } from '../src/pages/ModelsPage'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { __resetAuthForTests, __setCsrfTokenForTests } from '../src/auth/session'
import { mkSnapshot, mkStatus } from './fixtures'

interface CapturedRequest {
  method: string
  path: string
  body: unknown
}

function installFetchMock() {
  const journal: CapturedRequest[] = []
  const routes = new Map<string, (body: unknown) => { status: number; body: unknown }>()
  const realFetch = globalThis.fetch

  function register(method: string, path: string, handler: (body: unknown) => { status: number; body: unknown }) {
    routes.set(`${method} ${path}`, handler)
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body !== undefined && init.body !== null) {
      try { body = JSON.parse(String(init.body)) } catch { body = init.body }
    }
    journal.push({ method, path: url, body })

    const handler = routes.get(`${method} ${url}`)
    if (!handler) {
      return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: `no mock for ${method} ${url}` } }), { status: 404 })
    }
    const result = handler(body)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return { journal, register, restore: () => { globalThis.fetch = realFetch } }
}

// Snapshot with one local config model (router_missing).
function localModelSnap() {
  return mkSnapshot([
    mkStatus({
      id: 'stale-local',
      providerKind: 'local',
      presentIn: { config: true, router: false, discovered: false, catalog: false },
      availability: { kind: 'router_missing' },
      raw: { config: { id: 'stale-local', label: 'Stale Local', backendModel: 'stale-local', aliases: [] } as any },
    }),
  ])
}

// Snapshot with one cloud config model (ok).
function cloudModelSnap() {
  return mkSnapshot([
    mkStatus({
      id: 'gpt-cloud',
      label: 'GPT Cloud',
      providerKind: 'cloud',
      presentIn: { config: true, router: true, discovered: false, catalog: false },
      availability: { kind: 'ok' },
      raw: { config: { id: 'gpt-cloud', label: 'GPT Cloud', backendModel: 'gpt-4', aliases: [], endpoint: 'https://api.openai.com/v1' } as any },
    }),
  ])
}

// ─── Task 2: empty state ─────────────────────────────────────────────────────

describe('Task 2 — Models empty state', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => {
    __setCsrfTokenForTests('csrf-test-token')
    fx = installFetchMock()
    // Default mocks needed by ModelsPage on mount.
    fx.register('GET', '/admin/api/config', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, config: { models: [], routerUrl: '', localRuntimeProtocol: 'auto', port: 8019 } },
    }))
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, runtimes: [] },
    }))
    fx.register('GET', '/admin/api/endpoint-health', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, samples: [] },
    }))
  })

  afterEach(() => {
    fx.restore()
    __resetAuthForTests()
    vi.restoreAllMocks()
  })

  it('shows empty state when there are 0 configured models (presentIn.config = false for all)', () => {
    // Snapshot has a model but it is not in config — only orphan_discovered.
    const snap = mkSnapshot([
      mkStatus({
        id: 'orphan-local',
        providerKind: 'local',
        availability: { kind: 'orphan_discovered' },
        presentIn: { config: false, router: false, discovered: true, catalog: false },
      }),
    ])
    render(<ModelsPage snapshot={snap} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    expect(screen.getByTestId('models-empty')).toBeInTheDocument()
    expect(screen.getByTestId('models-empty-add')).toBeInTheDocument()
    // Toolbar/filter should NOT be shown.
    expect(screen.queryByTestId('filter-all')).toBeNull()
  })

  it('shows empty state when snapshot has 0 statuses at all', () => {
    const snap = mkSnapshot([])
    render(<ModelsPage snapshot={snap} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    expect(screen.getByTestId('models-empty')).toBeInTheDocument()
  })

  it('clicking add CTA in empty state opens the add dialog', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [] },
    }))

    const snap = mkSnapshot([])
    render(<ModelsPage snapshot={snap} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)

    const addLink = screen.getByTestId('models-empty-add')
    fireEvent.click(addLink)

    await waitFor(() => expect(screen.getByTestId('add-model-dialog')).toBeInTheDocument())
  })

  it('does NOT show empty state when >= 1 model has presentIn.config = true', () => {
    const snap = mkSnapshot([
      mkStatus({
        id: 'gpt',
        providerKind: 'cloud',
        presentIn: { config: true, router: true, discovered: false, catalog: false },
      }),
    ])
    render(<ModelsPage snapshot={snap} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    expect(screen.queryByTestId('models-empty')).toBeNull()
    expect(screen.getByTestId('filter-all')).toBeInTheDocument()
  })
})

// ─── Task 3: drawer local runtime section ────────────────────────────────────

describe('Task 3 — Drawer local runtime section', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => {
    __setCsrfTokenForTests('csrf-test-token')
    fx = installFetchMock()
    fx.register('GET', '/admin/api/config', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, config: { models: [], routerUrl: 'http://127.0.0.1:11435/v1', localRuntimeProtocol: 'auto', port: 8019 } },
    }))
    fx.register('GET', '/admin/api/endpoint-health', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, samples: [] },
    }))
  })

  afterEach(() => {
    fx.restore()
    __resetAuthForTests()
    vi.restoreAllMocks()
  })

  it('shows drawer-runtime for a local model with router_missing', async () => {
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, runtimes: [] },
    }))
    render(<ModelsPage snapshot={localModelSnap()} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-stale-local'))
    await waitFor(() => expect(screen.getByTestId('drawer-runtime')).toBeInTheDocument())
  })

  it('does NOT show drawer-runtime for a cloud model', async () => {
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, runtimes: [] },
    }))
    render(<ModelsPage snapshot={cloudModelSnap()} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-gpt-cloud'))
    await waitFor(() => expect(screen.getByTestId('drawer-label')).toHaveTextContent('GPT Cloud'))
    expect(screen.queryByTestId('drawer-runtime')).toBeNull()
  })

  it('shows drawer-runtime-detect and drawer-runtime-connect when a reachable runtime is detected', async () => {
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        runtimes: [
          {
            templateId: 'ollama',
            label: 'Ollama',
            endpoint: 'http://localhost:11434/v1',
            reachable: true,
            latencyMs: 12,
            status: 200,
            detail: 'Ollama reachable',
          },
        ],
      },
    }))
    render(<ModelsPage snapshot={localModelSnap()} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-stale-local'))

    await waitFor(() => expect(screen.getByTestId('drawer-runtime-detect')).toBeInTheDocument())
    expect(screen.getByTestId('drawer-runtime-connect')).toBeInTheDocument()
  })

  it('clicking drawer-runtime-connect POSTs to the runtime-settings endpoint with the routerUrl', async () => {
    const detectedEndpoint = 'http://localhost:11434/v1'
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        runtimes: [
          {
            templateId: 'ollama',
            label: 'Ollama',
            endpoint: detectedEndpoint,
            reachable: true,
            latencyMs: 12,
            detail: 'Ollama reachable',
          },
        ],
      },
    }))
    fx.register('PATCH', '/admin/api/config/runtime', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [],
        snapshot: localModelSnap(),
      },
    }))
    render(<ModelsPage snapshot={localModelSnap()} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-stale-local'))

    await waitFor(() => expect(screen.getByTestId('drawer-runtime-connect')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('drawer-runtime-connect'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'PATCH' && r.path === '/admin/api/config/runtime')
      expect(sent).toBeDefined()
      expect(JSON.stringify(sent!.body)).toContain(detectedEndpoint)
    })
  })

  it('shows drawer-runtime-manual toggle when not connected (no runtimes found)', async () => {
    fx.register('GET', '/admin/api/local-runtimes', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, runtimes: [] },
    }))
    render(<ModelsPage snapshot={localModelSnap()} onRefresh={vi.fn()} onSnapshotUpdate={vi.fn()} loading={false} />)
    fireEvent.click(screen.getByTestId('model-row-stale-local'))

    await waitFor(() => expect(screen.getByTestId('drawer-runtime-manual')).toBeInTheDocument())
  })
})
