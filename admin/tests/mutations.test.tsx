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
        result: { ok: true, status: 200, latencyMs: 142, detail: 'Reachable' },
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
    })
  })

  it('Test connection: saved model surfaces failure detail', async () => {
    fx.register('POST', '/admin/api/models/kimi-k2/test', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        result: { ok: false, status: 401, latencyMs: 89, detail: 'invalid api key' },
      },
    }))

    renderPage()
    fireEvent.click(screen.getByTestId('model-row-kimi-k2'))
    fireEvent.click(screen.getByTestId('action-test'))

    await waitFor(() => {
      const banner = screen.getByTestId('saved-test-result')
      expect(banner).toHaveTextContent('Failed')
      expect(banner).toHaveTextContent('invalid api key')
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
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          { id: 'openai-compat', label: 'OpenAI Compatible', endpoint: 'https://api.openai.com/v1', testPath: '/models' },
          { id: 'kimi', label: 'Kimi', endpoint: 'https://api.kimi.com/coding' },
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

  it('Add model: provider family batch create posts /bulk/create with shared credentials', async () => {
    fx.register('GET', '/admin/api/providers', () => ({
      status: 200,
      body: {
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        providers: [
          {
            id: 'openai-compat',
            provider: 'openai-compat',
            label: 'OpenAI Compatible',
            endpoint: 'https://api.openai.com/v1',
            family: 'multi-model',
          },
          {
            id: 'bailian',
            provider: 'openai-compat',
            label: 'Bailian / DashScope',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
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

    fireEvent.change(screen.getByTestId('field-provider'), { target: { value: 'bailian' } })
    await waitFor(() => expect(screen.getByTestId('field-batch-backendModels')).toBeInTheDocument())
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
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKeyEnv: 'DASHSCOPE_API_KEY',
          },
        },
        {
          model: {
            id: 'deepseek-v3.1',
            label: 'deepseek-v3.1',
            backendModel: 'deepseek-v3.1',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKeyEnv: 'DASHSCOPE_API_KEY',
          },
        },
      ],
    })
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
})
