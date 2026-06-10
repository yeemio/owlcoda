import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ModelsPage } from '../src/pages/ModelsPage'
import { __resetAuthForTests, __setCsrfTokenForTests } from '../src/auth/session'
import { ADMIN_API_SCHEMA_VERSION, type ModelTruthSnapshot } from '../src/api/types'
import { mkSnapshot, mkStatus } from './fixtures'

/**
 * Request journal + JSON-route dispatcher shared across γ mutation tests.
 * Each test registers route handlers; the dispatcher records every call so we
 * can assert method, path, body, and headers (including CSRF).
 */

interface CapturedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

function installFetchMock() {
  const journal: CapturedRequest[] = []
  const routes = new Map<string, (body: unknown, headers: Record<string, string>) => { status: number; body: unknown }>()
  const realFetch = globalThis.fetch

  function register(method: string, path: string, handler: (body: unknown, headers: Record<string, string>) => { status: number; body: unknown }) {
    routes.set(`${method} ${path}`, handler)
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    const h = init?.headers
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => { headers[k.toLowerCase()] = v })
      else if (Array.isArray(h)) h.forEach(([k, v]) => { headers[k.toLowerCase()] = v })
      else Object.entries(h as Record<string, string>).forEach(([k, v]) => { headers[k.toLowerCase()] = v })
    }
    let body: unknown = null
    if (init?.body !== undefined && init.body !== null) {
      try { body = JSON.parse(String(init.body)) } catch { body = init.body }
    }
    journal.push({ method, path: url, headers, body })

    const handler = routes.get(`${method} ${url}`)
    if (!handler) {
      return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: `no mock for ${method} ${url}` } }), { status: 404 })
    }
    const result = handler(body, headers)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return {
    journal,
    register,
    restore: () => { globalThis.fetch = realFetch },
  }
}

describe('Phase γ mutations', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => {
    fx = installFetchMock()
    __setCsrfTokenForTests('csrf-test-token')
  })

  afterEach(() => {
    fx.restore()
    __resetAuthForTests()
    vi.restoreAllMocks()
  })

  function baseSnapshot() {
    return mkSnapshot([
      mkStatus({
        id: 'model-alpha-7',
        label: 'Model Alpha 7',
        providerKind: 'cloud',
        isDefault: true,
        raw: { config: { id: 'model-alpha-7', label: 'Model Alpha 7', backendModel: 'model-alpha-7', aliases: ['ma7'], endpoint: 'https://api.example.com', apiKey: { set: true } } as any },
      }),
      mkStatus({
        id: 'kimi-k2',
        label: 'Kimi K2',
        providerKind: 'cloud',
        role: 'coding',
        availability: { kind: 'missing_key', envName: 'KIMI_API_KEY' },
        raw: { config: { id: 'kimi-k2', label: 'Kimi K2', backendModel: 'kimi-k2', aliases: [], endpoint: 'https://api.kimi.com/coding', apiKeyEnv: 'KIMI_API_KEY' } as any },
      }),
    ])
  }

  function renderPage(onSnapshotUpdate = vi.fn()) {
    const snap = baseSnapshot()
    const utils = render(
      <ModelsPage snapshot={snap} onRefresh={vi.fn()} onSnapshotUpdate={onSnapshotUpdate} loading={false} />,
    )
    return { ...utils, onSnapshotUpdate, snap }
  }

  // ─── 1. Set default ──────────────────────────────────────────────

  it('Set default: calls POST /default, updates snapshot, default badge moves', async () => {
    fx.register('POST', '/admin/api/default', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'kimi-k2', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', label: 'Model Alpha 7', providerKind: 'cloud', isDefault: false }),
          mkStatus({ id: 'kimi-k2', label: 'Kimi K2', providerKind: 'cloud', isDefault: true, availability: { kind: 'ok' } }),
        ]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-set-default'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/default')!
    expect(sent.body).toEqual({ modelId: 'kimi-k2' })
    expect(sent.headers['x-owlcoda-token']).toBe('csrf-test-token')
  })

  // ─── 2. Edit fields ──────────────────────────────────────────────

  it('Edit fields: sends only changed whitelisted fields via PATCH', async () => {
    fx.register('PATCH', '/admin/api/models/kimi-k2', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'kimi-k2', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', isDefault: true }),
          mkStatus({ id: 'kimi-k2', label: 'Kimi Coder', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-edit'))

    const labelInput = screen.getByTestId('field-label') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'Kimi Coder' } })
    fireEvent.click(screen.getByTestId('edit-submit'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'PATCH')!
    expect(sent.body).toEqual({ patch: { label: 'Kimi Coder' } })
    expect(sent.headers['x-owlcoda-token']).toBe('csrf-test-token')
  })

  // ─── 2.1 Edit fields: advanced section collapse/expand ──────────

  it('Edit fields: advanced fields hidden by default, visible after toggle', async () => {
    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-edit'))

    // Essential fields are immediately visible
    expect(screen.getByTestId('field-label')).toBeInTheDocument()
    expect(screen.getByTestId('field-aliases')).toBeInTheDocument()
    expect(screen.getByTestId('field-backendModel')).toBeInTheDocument()
    expect(screen.getByTestId('field-endpoint')).toBeInTheDocument()

    // Advanced section starts collapsed — fields are in the DOM but section is hidden
    const advancedSection = screen.getByTestId('edit-advanced-section')
    expect(advancedSection).toHaveStyle({ display: 'none' })
    expect(screen.getByTestId('field-role')).toBeInTheDocument() // in DOM but hidden
    expect(screen.getByTestId('field-contextWindow')).toBeInTheDocument()
    expect(screen.getByTestId('field-timeoutMs')).toBeInTheDocument()
    expect(screen.getByTestId('field-headers')).toBeInTheDocument()

    // Clicking the toggle opens the section
    fireEvent.click(screen.getByTestId('edit-advanced-toggle'))
    expect(advancedSection).not.toHaveStyle({ display: 'none' })
  })

  it('Edit fields: expanding advanced → editing role+headers → PATCH contains correct fields', async () => {
    fx.register('PATCH', '/admin/api/models/kimi-k2', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'kimi-k2', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', isDefault: true }),
          mkStatus({ id: 'kimi-k2', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-edit'))

    // Expand advanced section first
    fireEvent.click(screen.getByTestId('edit-advanced-toggle'))

    // Edit role (kimi-k2 fixture has role='coding' from baseSnapshot; change it)
    const roleInput = screen.getByTestId('field-role') as HTMLInputElement
    fireEvent.change(roleInput, { target: { value: 'general' } })

    // Edit headers
    const headersInput = screen.getByTestId('field-headers') as HTMLTextAreaElement
    fireEvent.change(headersInput, { target: { value: '{"x-custom":"1"}' } })

    fireEvent.click(screen.getByTestId('edit-submit'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'PATCH' && r.path === '/admin/api/models/kimi-k2')!
    expect(sent).toBeDefined()
    const patch = (sent.body as { patch: Record<string, unknown> }).patch
    expect(patch.role).toBe('general')
    expect(patch.headers).toEqual({ 'x-custom': '1' })
    expect(sent.headers['x-owlcoda-token']).toBe('csrf-test-token')
  })

  // ─── 3. Replace key ──────────────────────────────────────────────

  it('Replace key: inline mode posts apiKey only (no apiKeyEnv)', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/key', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'kimi-k2', ok: true }], snapshot: mkSnapshot([]) },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-key'))
    fireEvent.click(screen.getByTestId('key-mode-inline'))
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-live-42' } })
    fireEvent.click(screen.getByTestId('key-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models/kimi-k2/key')
      expect(sent).toBeDefined()
      expect(sent!.body).toEqual({ apiKey: 'sk-live-42' })
    })
  })

  it('Replace key: env mode posts apiKeyEnv', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/key', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'kimi-k2', ok: true }] },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-key'))
    fireEvent.click(screen.getByTestId('key-mode-env'))
    fireEvent.change(screen.getByTestId('field-apiKeyEnv'), { target: { value: 'KIMI_SECRET' } })
    fireEvent.click(screen.getByTestId('key-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models/kimi-k2/key')
      expect(sent!.body).toEqual({ apiKeyEnv: 'KIMI_SECRET' })
    })
  })

  // ─── 4. Test connection ──────────────────────────────────────────

  it('Test connection: saved model shows ok/latency/detail on success', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/test', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        result: {
          ok: true,
          status: 200,
          latencyMs: 142,
          detail: 'Reachable',
          provider: 'kimi',
          endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
          backendModel: 'kimi-k2',
        },
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-test'))

    await waitFor(() => {
      const banner = screen.getByTestId('saved-test-result')
      expect(banner).toHaveTextContent('OK')
      expect(banner).toHaveTextContent('142ms')
      expect(banner).toHaveTextContent('Reachable')
      expect(screen.getByTestId('saved-test-route')).toHaveTextContent('model tested')
      expect(screen.getByTestId('saved-test-route')).toHaveTextContent('kimi-k2')
      expect(screen.getByTestId('saved-test-route')).toHaveTextContent('https://api.kimi.com/coding/v1/chat/completions')
    })
  })

  it('Test connection: saved model surfaces failure detail', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/test', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        result: {
          ok: false,
          status: 401,
          latencyMs: 89,
          detail: 'invalid api key',
          provider: 'kimi',
          endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
          backendModel: 'kimi-k2',
          bodySnippet: '{"error":"invalid api key"}',
        },
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-test'))

    await waitFor(() => {
      const banner = screen.getByTestId('saved-test-result')
      expect(banner).toHaveTextContent('Failed')
      expect(banner).toHaveTextContent('invalid api key')
      expect(screen.getByTestId('saved-test-body-snippet')).toHaveTextContent('invalid api key')
    })
  })

  // ─── 4b. Per-model mutation state isolation ─────────────────────

  it('Test result does NOT leak across selection change', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/test', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        result: { ok: true, status: 200, latencyMs: 142, detail: 'Reachable' },
      },
    }))

    renderPage()
    // 1) Select kimi-k2 and test it — see success banner
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-test'))
    await waitFor(() => expect(screen.getByTestId('saved-test-result')).toHaveTextContent('OK'))

    // 2) Switch to model-alpha-7 — the drawer must not show kimi's test result
    //    under the prior model's heading.
    fireEvent.click(screen.getByTestId('model-row-model-alpha-7'))
    expect(screen.getByTestId('drawer-label')).toHaveTextContent('Model Alpha 7')
    expect(screen.queryByTestId('saved-test-result')).toBeNull()
  })

  it('Edit/key/delete error state also clears on selection change', async () => {
    // Force kimi-k2 edit to fail
    fx.register('PATCH', '/admin/api/models/kimi-k2', () => ({
      status: 500,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: false,
        error: { code: 'internal_error', message: 'boom' },
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-edit'))
    fireEvent.change(screen.getByTestId('field-label'), { target: { value: 'NewName' } })
    fireEvent.click(screen.getByTestId('edit-submit'))
    await waitFor(() => expect(screen.getByTestId('edit-error')).toHaveTextContent('boom'))

    // Switch selection; the error belongs to kimi-k2's edit attempt and must
    // not follow us onto model-alpha-7.
    fireEvent.click(screen.getByTestId('model-row-model-alpha-7'))
    expect(screen.queryByTestId('edit-error')).toBeNull()
  })

  // ─── 5. Delete ───────────────────────────────────────────────────

  it('Delete: requires typing id; success removes from list', async () => {
    fx.register('DELETE', '/admin/api/models/kimi-k2', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'kimi-k2', ok: true }],
        snapshot: mkSnapshot([mkStatus({ id: 'model-alpha-7', isDefault: true })]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-delete'))

    // Submit disabled until user types the id
    expect(screen.getByTestId('confirm-delete-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('confirm-typed'), { target: { value: 'kimi-k2' } })
    expect(screen.getByTestId('confirm-delete-submit')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('confirm-delete-submit'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'DELETE')!
    expect(sent.path).toBe('/admin/api/models/kimi-k2')
  })

  // ─── 6. Add model ────────────────────────────────────────────────

  it('Add model: providers load + create POSTs to /models with whitelisted patch', async () => {
    // Use a custom-tier-only setup so the dialog opens on Lane 2-B where field-id
    // is in the essential section (brand lane no longer exposes field-id per spec §4).
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1', testPath: '/models' },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'new-model', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', isDefault: true }),
          mkStatus({ id: 'kimi-k2', availability: { kind: 'missing_key' } }),
          mkStatus({ id: 'new-model', providerKind: 'cloud' }),
        ]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('field-provider')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-id'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByTestId('field-label'), { target: { value: 'New Model' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')!
    const body = sent.body as { model: Record<string, unknown> }
    expect(body.model.id).toBe('new-model')
    expect(body.model.label).toBe('New Model')
    expect(body.model.endpoint).toBeTruthy() // auto-filled from provider template
    // Must not leak forbidden fields
    expect(body.model).not.toHaveProperty('default')
    expect(body.model).not.toHaveProperty('apiKey')
    expect(body.model).not.toHaveProperty('apiKeyEnv')
  })

  it('Add model: dry-run test uses /test-connection (no write)', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [{ id: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1' }] },
    }))
    fx.register('POST', '/admin/api/test-connection', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, result: { ok: true, status: 200, latencyMs: 55, detail: 'ok' } },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('field-id')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-id'), { target: { value: 'probe-me' } })
    fireEvent.click(screen.getByTestId('add-test-run'))

    await waitFor(() => {
      expect(screen.getByTestId('add-test-result')).toHaveTextContent('OK')
    })
    // Must not have written anything yet
    expect(fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')).toBeUndefined()
  })

  it('Add model: local runtime tiles show localhost discovery hints', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local', endpoint: 'http://localhost:11434/v1', family: 'multi-model' },
          { id: 'owlmlx', provider: 'openai-compat', label: 'owlmlx', tier: 'local', endpoint: 'http://localhost:8066/v1', family: 'multi-model' },
        ],
      },
    }))
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
          {
            templateId: 'owlmlx',
            label: 'owlmlx',
            endpoint: 'http://localhost:8066/v1',
            reachable: false,
            latencyMs: 3,
            detail: 'owlmlx unreachable',
          },
        ],
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))

    await waitFor(() => {
      expect(screen.getByTestId('provider-tile-detection-ollama')).toHaveTextContent('✓ detected · 12ms')
      expect(screen.getByTestId('provider-tile-detection-owlmlx')).toHaveTextContent('○ not running')
    })
    expect(screen.getByTestId('provider-tile-detection-ollama')).toHaveAttribute('title', 'Ollama reachable')
    expect(fx.journal.some(r => r.method === 'GET' && r.path === '/admin/api/local-runtimes')).toBe(true)
  })

  it('Add model: persists inline credentials when creating a single model', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1', family: 'multi-model' },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'secure-model', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', isDefault: true }),
          mkStatus({ id: 'secure-model', providerKind: 'cloud', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('field-id')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-id'), { target: { value: 'secure-model' } })
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-live-xyz' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')
      expect(sent).toBeDefined()
      expect((sent!.body as { model: Record<string, unknown> }).model.apiKey).toBe('sk-live-xyz')
    })
  })

  it('Add model: MiniMax preset fills the known working endpoint and model id', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1', family: 'multi-model' },
          {
            id: 'minimax',
            provider: 'anthropic',
            label: 'MiniMax',
            endpoint: 'https://api.minimaxi.com/anthropic',
            family: 'single-model',
            testPath: '/v1/messages',
            testMode: 'messages',
            defaultModelId: 'minimax-m27',
            defaultModelLabel: 'MiniMax M2.7-highspeed',
            defaultBackendModel: 'MiniMax-M2.7-highspeed',
            defaultAliases: ['minimax', 'm27'],
            defaultContextWindow: 204800,
          },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'minimax-m27', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'minimax-m27', providerKind: 'cloud', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    // Wait until the minimax tile is available (providers loaded) then select it
    await waitFor(() => expect(screen.getByTestId('provider-tile-minimax')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'minimax' } })
    await waitFor(() => expect(screen.getByTestId('provider-template-minimax')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-minimax-live' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')
      expect(sent).toBeDefined()
      expect((sent!.body as { model: Record<string, unknown> }).model).toMatchObject({
        id: 'minimax-m27',
        label: 'MiniMax M2.7-highspeed',
        backendModel: 'MiniMax-M2.7-highspeed',
        provider: 'anthropic',
        endpoint: 'https://api.minimaxi.com/anthropic',
        aliases: ['minimax', 'm27'],
        contextWindow: 204800,
        apiKey: 'sk-minimax-live',
      })
    })
  })

  it('Add model: Kimi preset saves the same provider and headers used by the working CLI route', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1', family: 'multi-model' },
          {
            id: 'kimi',
            provider: 'kimi',
            label: 'Kimi',
            endpoint: 'https://api.kimi.com/coding/v1',
            family: 'single-model',
            testPath: '/chat/completions',
            testMode: 'chat',
            defaultModelId: 'kimi-code',
            defaultModelLabel: 'Kimi Code',
            defaultBackendModel: 'kimi-for-coding',
            defaultAliases: ['kimi'],
            defaultContextWindow: 256000,
            headers: { 'User-Agent': 'KimiCLI/1.33.0' },
          },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'kimi-code', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'kimi-code', providerKind: 'cloud', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    // Wait until the kimi tile is available (providers loaded) then select it
    await waitFor(() => expect(screen.getByTestId('provider-tile-kimi')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'kimi' } })
    await waitFor(() => expect(screen.getByTestId('provider-template-kimi')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-kimi-live' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')
      expect(sent).toBeDefined()
      expect((sent!.body as { model: Record<string, unknown> }).model).toMatchObject({
        id: 'kimi-code',
        label: 'Kimi Code',
        backendModel: 'kimi-for-coding',
        provider: 'kimi',
        endpoint: 'https://api.kimi.com/coding/v1',
        aliases: ['kimi'],
        contextWindow: 256000,
        headers: { 'User-Agent': 'KimiCLI/1.33.0' },
        apiKey: 'sk-kimi-live',
      })
    })
  })

  it('Add model: provider family batch create posts /bulk/create with shared credentials', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          {
            id: 'gpt',
            provider: 'openai-compat',
            label: 'GPT',
            endpoint: 'https://api.openai.com/v1',
            family: 'single-model',
          },
          {
            id: 'openai-compat',
            provider: 'openai-compat',
            label: 'OpenAI-compatible',
            endpoint: '',
            testPath: '/chat/completions',
            testMode: 'chat',
            family: 'multi-model',
            requiresBackendModel: true,
          },
        ],
      },
    }))
    fx.register('POST', '/admin/api/bulk/create', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [
          { id: 'qwen-plus', ok: true },
          { id: 'deepseek-v3.1', ok: true },
        ],
        snapshot: mkSnapshot([
          mkStatus({ id: 'model-alpha-7', isDefault: true }),
          mkStatus({ id: 'qwen-plus', providerKind: 'cloud', availability: { kind: 'ok' } }),
          mkStatus({ id: 'deepseek-v3.1', providerKind: 'cloud', availability: { kind: 'ok' } }),
        ]),
      },
    }))

    const { onSnapshotUpdate } = renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('field-provider')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'openai-compat' } })
    await waitFor(() => expect(screen.getByTestId('field-batch-backendModels')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('field-endpoint'), { target: { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } })
    fireEvent.change(screen.getByTestId('field-batch-backendModels'), {
      target: { value: 'qwen-plus\ndeepseek-v3.1' },
    })
    fireEvent.click(screen.getByTestId('add-key-env'))
    fireEvent.change(screen.getByTestId('field-apiKeyEnv'), { target: { value: 'DASHSCOPE_API_KEY' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => expect(onSnapshotUpdate).toHaveBeenCalledOnce())
    const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/bulk/create')!
    expect(sent.body).toEqual({
      items: [
        {
          model: {
            id: 'qwen-plus',
            label: 'qwen-plus',
            backendModel: 'qwen-plus',
            provider: 'openai-compat',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKeyEnv: 'DASHSCOPE_API_KEY',
          },
        },
        {
          model: {
            id: 'deepseek-v3.1',
            label: 'deepseek-v3.1',
            backendModel: 'deepseek-v3.1',
            provider: 'openai-compat',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKeyEnv: 'DASHSCOPE_API_KEY',
          },
        },
      ],
    })
  })

  // ─── 6b. Two-lane dialog contract ───────────────────────────────

  it('Lane 1 (brand): shows apiKey field and hides endpoint/backendModel in essential', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/coding/v1', family: 'single-model', defaultModelId: 'kimi-code', defaultBackendModel: 'kimi-for-coding', defaultAliases: ['kimi'] },
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', tier: 'custom', endpoint: '', family: 'multi-model' },
        ],
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    // Lane 1 is active by default
    expect(screen.getByTestId('lane-brand')).toHaveClass('active')
    expect(screen.getByTestId('lane-custom')).not.toHaveClass('active')

    // apiKey field is visible in essential (keyMode=inline is default)
    expect(screen.getByTestId('field-apiKey')).toBeInTheDocument()

    // endpoint and backendModel are NOT in the essential section
    // (they are in Advanced, hidden but still in DOM)
    const advancedSection = screen.getByTestId('add-advanced-section')
    expect(advancedSection).toHaveStyle({ display: 'none' })

    // Tile grid shows cloud tiles only
    const grid = screen.getByTestId('provider-tile-grid')
    expect(grid).toBeInTheDocument()
    expect(screen.getByTestId('provider-tile-kimi')).toBeInTheDocument()
    // openai-compat is custom tier — should NOT appear as a tile in Lane 1
    expect(screen.queryByTestId('provider-tile-openai-compat')).toBeNull()
  })

  it('Lane 1 (brand): paste key + submit sends correct POST with template data', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          {
            id: 'deepseek', provider: 'anthropic', label: 'DeepSeek', tier: 'cloud',
            endpoint: 'https://api.deepseek.com/anthropic', family: 'single-model',
            testPath: '/v1/messages', testMode: 'messages',
            defaultModelId: 'deepseek', defaultBackendModel: 'deepseek-chat',
            defaultAliases: ['deepseek', 'ds'], defaultContextWindow: 128000,
          },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'deepseek', ok: true }],
        snapshot: mkSnapshot([mkStatus({ id: 'deepseek', providerKind: 'cloud', availability: { kind: 'ok' } })]),
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('provider-tile-deepseek')).toBeInTheDocument())

    // In Lane 1 with deepseek: apiKey is visible in essential
    expect(screen.getByTestId('field-apiKey')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-ds-live' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')
      expect(sent).toBeDefined()
      expect((sent!.body as { model: Record<string, unknown> }).model).toMatchObject({
        id: 'deepseek',
        endpoint: 'https://api.deepseek.com/anthropic',
        backendModel: 'deepseek-chat',
        provider: 'anthropic',
        apiKey: 'sk-ds-live',
      })
    })
  })

  it('Lane 2-A (local runtime): shows endpoint + backendModel with key default none', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local', endpoint: 'http://localhost:11434/v1', family: 'multi-model', requiresBackendModel: true },
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/coding/v1', family: 'single-model', defaultModelId: 'kimi-code' },
        ],
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    // Switch to Lane 2
    fireEvent.click(screen.getByTestId('lane-custom'))

    await waitFor(() => expect(screen.getByTestId('custom-sub-selector')).toBeInTheDocument())

    // Sub-mode A (local) is default
    expect(screen.getByTestId('sub-local')).toHaveClass('active')

    // endpoint and backendModel are visible in essential
    expect(screen.getByTestId('field-endpoint')).toBeInTheDocument()
    expect(screen.getByTestId('field-backendModel')).toBeInTheDocument()

    // keyMode defaults to none for local
    expect(screen.getByTestId('add-key-none')).toHaveClass('active')
    expect(screen.queryByTestId('field-apiKey')).toBeNull()

    // Local tiles visible in tile grid
    expect(screen.getByTestId('provider-tile-ollama')).toBeInTheDocument()
  })

  it('Lane 2-B (custom endpoint): shows protocol select + endpoint + backendModel + id + apiKey', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', tier: 'custom', endpoint: '', family: 'multi-model', requiresBackendModel: true },
          { id: 'anthropic', provider: 'anthropic', label: 'Anthropic-compatible', tier: 'custom', endpoint: '', family: 'multi-model' },
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/coding/v1', family: 'single-model', defaultModelId: 'kimi-code' },
        ],
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    // Switch to Lane 2, then sub-mode B
    fireEvent.click(screen.getByTestId('lane-custom'))
    await waitFor(() => expect(screen.getByTestId('custom-sub-selector')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('sub-endpoint'))

    await waitFor(() => expect(screen.getByTestId('protocol-select')).toBeInTheDocument())

    // protocol select visible
    expect(screen.getByTestId('protocol-select')).toBeInTheDocument()
    // All essential fields visible
    expect(screen.getByTestId('field-endpoint')).toBeInTheDocument()
    expect(screen.getByTestId('field-backendModel')).toBeInTheDocument()
    expect(screen.getByTestId('field-id')).toBeInTheDocument()
    // apiKey default inline
    expect(screen.getByTestId('add-key-inline')).toHaveClass('active')
    expect(screen.getByTestId('field-apiKey')).toBeInTheDocument()

    // Advanced toggle present
    expect(screen.getByTestId('add-advanced-toggle')).toBeInTheDocument()
  })

  it('Lane 1 (brand): switching provider refreshes template-derived id/backendModel', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          {
            id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud',
            endpoint: 'https://api.kimi.com/coding/v1', family: 'single-model',
            defaultModelId: 'kimi-code', defaultModelLabel: 'Kimi Code',
            defaultBackendModel: 'kimi-for-coding', defaultAliases: ['kimi'],
            defaultContextWindow: 256000,
          },
          {
            id: 'gpt', provider: 'openai-compat', label: 'GPT', tier: 'cloud',
            endpoint: 'https://api.openai.com/v1', family: 'single-model',
            defaultModelId: 'gpt', defaultModelLabel: 'GPT',
            defaultBackendModel: 'gpt-5.1', defaultAliases: ['gpt'],
            defaultContextWindow: 128000,
          },
        ],
      },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'gpt', ok: true }],
        snapshot: mkSnapshot([mkStatus({ id: 'gpt', providerKind: 'cloud', availability: { kind: 'ok' } })]),
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    // Wait for providers; kimi tile should appear first (default cloud selection)
    await waitFor(() => expect(screen.getByTestId('provider-tile-kimi')).toBeInTheDocument())

    // Select kimi — template fills id/backendModel with kimi defaults
    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'kimi' } })
    await waitFor(() => expect(screen.getByTestId('provider-template-kimi')).toBeInTheDocument())

    // Now switch to gpt — template-derived values should refresh
    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'gpt' } })
    await waitFor(() => expect(screen.getByTestId('provider-template-gpt')).toBeInTheDocument())

    // Paste a key and submit
    fireEvent.change(screen.getByTestId('field-apiKey'), { target: { value: 'sk-gpt-live' } })
    fireEvent.click(screen.getByTestId('add-submit'))

    await waitFor(() => {
      const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/models')
      expect(sent).toBeDefined()
      const model = (sent!.body as { model: Record<string, unknown> }).model
      // Must have gpt's values, NOT kimi's stale values
      expect(model.id).toBe('gpt')
      expect(model.backendModel).toBe('gpt-5.1')
      expect(model.id).not.toBe('kimi-code')
      expect(model.backendModel).not.toBe('kimi-for-coding')
    })
  })

  it('Lane 2 (local): switching from a cloud brand clears cloud-derived model fields', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          {
            id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud',
            endpoint: 'https://api.kimi.com/coding/v1', family: 'single-model',
            defaultModelId: 'kimi-code', defaultModelLabel: 'Kimi Code',
            defaultBackendModel: 'kimi-for-coding', defaultAliases: ['kimi'],
            defaultContextWindow: 256000,
          },
          {
            id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local',
            endpoint: 'http://localhost:11434/v1', family: 'multi-model',
            requiresBackendModel: true,
          },
        ],
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('lane-custom'))
    await waitFor(() => expect(screen.getByTestId('sub-local')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('field-backendModel')).toBeInTheDocument())

    expect((screen.getByTestId('field-endpoint') as HTMLInputElement).value).toBe('http://localhost:11434/v1')
    expect((screen.getByTestId('field-backendModel') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('add-key-none')).toHaveClass('active')

    fireEvent.click(screen.getByTestId('add-advanced-toggle'))
    await waitFor(() => expect(screen.getByTestId('field-id')).toBeInTheDocument())
    expect((screen.getByTestId('field-id') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('field-aliases') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('field-contextWindow') as HTMLInputElement).value).toBe('')
  })

  // ─── 7. schemaVersion mismatch still enforced ────────────────────

  it('Write rejects response with wrong schemaVersion', async () => {
    fx.register('POST', '/admin/api/default', () => ({
      status: 200,
      body: { schemaVersion: 999, ok: true, results: [] },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-set-default'))

    await waitFor(() => {
      expect(screen.getByTestId('set-default-error')).toHaveTextContent(/schemaVersion/i)
    })
  })

  // ─── 8. Error banner visibility ──────────────────────────────────

  it('Write failure surfaces inline error banner', async () => {
    fx.register('POST', '/admin/api/default', () => ({
      status: 403,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'csrf_mismatch', message: 'Missing X-OwlCoda-Token' } },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-set-default'))

    await waitFor(() => {
      expect(screen.getByTestId('set-default-error')).toHaveTextContent('Missing X-OwlCoda-Token')
    })
  })

  // ─── Happy path ──────────────────────────────────────────────────

  it('Happy path: add → dry-run → create → set default → all steps succeed', async () => {
    let snapshotAfterCreate = mkSnapshot([
      mkStatus({ id: 'model-alpha-7', isDefault: true }),
      mkStatus({ id: 'kimi-k2', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'new-model', providerKind: 'cloud', isDefault: false }),
    ])
    const snapshotAfterDefault = mkSnapshot([
      mkStatus({ id: 'model-alpha-7', isDefault: false }),
      mkStatus({ id: 'kimi-k2', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'new-model', providerKind: 'cloud', isDefault: true }),
    ])

    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [{ id: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1' }] },
    }))
    fx.register('POST', '/admin/api/test-connection', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, result: { ok: true, status: 200, latencyMs: 30, detail: 'ok' } },
    }))
    fx.register('POST', '/admin/api/models', () => ({
      status: 201,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'new-model', ok: true }], snapshot: snapshotAfterCreate },
    }))
    fx.register('POST', '/admin/api/default', () => ({
      status: 200,
      body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'new-model', ok: true }], snapshot: snapshotAfterDefault },
    }))

    function Driver() {
      const [snap, setSnap] = useState<ModelTruthSnapshot>(baseSnapshot())
      return (
        <ModelsPage
          snapshot={snap}
          onRefresh={() => {}}
          onSnapshotUpdate={setSnap}
          loading={false}
        />
      )
    }

    render(<Driver />)

    // 1. Open Add dialog
    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('field-id')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('field-id'), { target: { value: 'new-model' } })

    // 2. Dry-run test
    fireEvent.click(screen.getByTestId('add-test-run'))
    await waitFor(() => expect(screen.getByTestId('add-test-result')).toHaveTextContent('OK'))

    // 3. Create
    fireEvent.click(screen.getByTestId('add-submit'))
    await waitFor(() => {
      // After success, dialog closed, new-model present in list
      const list = screen.getByTestId('model-list')
      expect(within(list).queryByTestId('model-row-new-model')).not.toBeNull()
    })

    // 4. Set default on new model
    fireEvent.click(screen.getByTestId('model-row-new-model'))
    fireEvent.click(screen.getByTestId('action-set-default'))
    await waitFor(() => {
      expect(screen.getByTestId('drawer-default-badge')).toBeInTheDocument()
    })
  })

  // ─── 2.2 Discovery-driven backendModel picker ────────────────────

  it('Discovery picker: shows local-discovered-select when orphans are in snapshot; select fills field-backendModel', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local', endpoint: 'http://localhost:11434/v1', family: 'multi-model', requiresBackendModel: true },
        ],
      },
    }))

    const snapWithOrphan = mkSnapshot([
      mkStatus({ id: 'model-alpha-7', isDefault: true }),
      mkStatus({
        id: 'llama3-8b',
        availability: { kind: 'orphan_discovered' },
        raw: { discovered: { id: 'llama3-8b', label: 'Llama 3 8B', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434', contextWindow: 8192 } },
      }),
    ])

    render(
      <ModelsPage
        snapshot={snapWithOrphan}
        onRefresh={vi.fn()}
        onSnapshotUpdate={vi.fn()}
        loading={false}
      />,
    )

    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    // Switch to Lane 2-A (local runtime)
    fireEvent.click(screen.getByTestId('lane-custom'))
    await waitFor(() => expect(screen.getByTestId('sub-local')).toBeInTheDocument())
    // sub-local should already be active — if not, click it
    if (!screen.getByTestId('sub-local').classList.contains('active')) {
      fireEvent.click(screen.getByTestId('sub-local'))
    }

    await waitFor(() => expect(screen.getByTestId('local-discovered-select')).toBeInTheDocument())

    // The select lists the discovered model
    const select = screen.getByTestId('local-discovered-select') as HTMLSelectElement
    const options = Array.from(select.options).map(o => o.value)
    expect(options).toContain('llama3-8b')

    // Selecting it fills field-backendModel
    fireEvent.change(select, { target: { value: 'llama3-8b' } })
    const backendInput = screen.getByTestId('field-backendModel') as HTMLInputElement
    expect(backendInput.value).toBe('llama3-8b')
  })

  it('Discovery picker: absent when no orphans in snapshot; manual field-backendModel still works', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local', endpoint: 'http://localhost:11434/v1', family: 'multi-model', requiresBackendModel: true },
        ],
      },
    }))

    // baseSnapshot() has no orphan_discovered items
    render(
      <ModelsPage
        snapshot={baseSnapshot()}
        onRefresh={vi.fn()}
        onSnapshotUpdate={vi.fn()}
        loading={false}
      />,
    )

    fireEvent.click(screen.getByTestId('add-model-open'))
    await waitFor(() => expect(screen.getByTestId('lane-brand')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('lane-custom'))
    await waitFor(() => expect(screen.getByTestId('sub-local')).toBeInTheDocument())

    // Wait for providers so the lane renders fully
    await waitFor(() => expect(screen.getByTestId('field-backendModel')).toBeInTheDocument())

    // No discovery picker
    expect(screen.queryByTestId('local-discovered-select')).toBeNull()

    // Manual field still works
    fireEvent.change(screen.getByTestId('field-backendModel'), { target: { value: 'my-manual-model' } })
    expect((screen.getByTestId('field-backendModel') as HTMLInputElement).value).toBe('my-manual-model')
  })

  // ─── 2.3 Deep-link lane derivation ──────────────────────────────

  it('Deep-link provider=kimi (cloud) → lane-brand has class active', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/v1', family: 'single-model', defaultModelId: 'kimi-code' },
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', tier: 'custom', endpoint: '', family: 'multi-model' },
        ],
      },
    }))

    render(
      <ModelsPage
        snapshot={baseSnapshot()}
        onRefresh={vi.fn()}
        onSnapshotUpdate={vi.fn()}
        loading={false}
        initialView="add"
        initialProvider="kimi"
      />,
    )

    await waitFor(() => expect(screen.getByTestId('add-model-dialog')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('provider-tile-kimi')).toBeInTheDocument())

    expect(screen.getByTestId('lane-brand')).toHaveClass('active')
    expect(screen.getByTestId('lane-custom')).not.toHaveClass('active')
  })

  it('Deep-link provider=ollama (local) → lane-custom active AND sub-local active', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'ollama', provider: 'openai-compat', label: 'Ollama', tier: 'local', endpoint: 'http://localhost:11434/v1', family: 'multi-model', requiresBackendModel: true },
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/v1', family: 'single-model', defaultModelId: 'kimi-code' },
        ],
      },
    }))

    render(
      <ModelsPage
        snapshot={baseSnapshot()}
        onRefresh={vi.fn()}
        onSnapshotUpdate={vi.fn()}
        loading={false}
        initialView="add"
        initialProvider="ollama"
      />,
    )

    await waitFor(() => expect(screen.getByTestId('add-model-dialog')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('sub-local')).toBeInTheDocument())

    expect(screen.getByTestId('lane-custom')).toHaveClass('active')
    expect(screen.getByTestId('lane-brand')).not.toHaveClass('active')
    expect(screen.getByTestId('sub-local')).toHaveClass('active')
    expect(screen.getByTestId('sub-endpoint')).not.toHaveClass('active')
  })

  it('Deep-link provider=openai-compat (custom) → lane-custom active AND sub-endpoint active, protocol-select present', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', provider: 'openai-compat', label: 'OpenAI Compatible', tier: 'custom', endpoint: '', family: 'multi-model', requiresBackendModel: true },
          { id: 'anthropic', provider: 'anthropic', label: 'Anthropic-compatible', tier: 'custom', endpoint: '', family: 'multi-model' },
          { id: 'kimi', provider: 'kimi', label: 'Kimi', tier: 'cloud', endpoint: 'https://api.kimi.com/v1', family: 'single-model', defaultModelId: 'kimi-code' },
        ],
      },
    }))

    render(
      <ModelsPage
        snapshot={baseSnapshot()}
        onRefresh={vi.fn()}
        onSnapshotUpdate={vi.fn()}
        loading={false}
        initialView="add"
        initialProvider="openai-compat"
      />,
    )

    await waitFor(() => expect(screen.getByTestId('add-model-dialog')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('protocol-select')).toBeInTheDocument())

    expect(screen.getByTestId('lane-custom')).toHaveClass('active')
    expect(screen.getByTestId('lane-brand')).not.toHaveClass('active')
    expect(screen.getByTestId('sub-endpoint')).toHaveClass('active')
    expect(screen.getByTestId('sub-local')).not.toHaveClass('active')
    expect(screen.getByTestId('protocol-select')).toBeInTheDocument()
  })
})
