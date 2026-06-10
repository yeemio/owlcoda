import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrphansPage, extractOrphans } from '../src/pages/OrphansPage'
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
    if (!handler) return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: 'missing mock' } }), { status: 404 })
    const { status, body: resBody } = handler(body)
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { journal, restore: () => { globalThis.fetch = real } }
}

describe('extractOrphans', () => {
  it('filters only orphan_discovered', () => {
    const out = extractOrphans([
      mkStatus({ id: 'a' }),
      mkStatus({ id: 'b', availability: { kind: 'orphan_discovered' } }),
      mkStatus({ id: 'c', availability: { kind: 'missing_key' } }),
      mkStatus({ id: 'd', availability: { kind: 'orphan_discovered' } }),
    ])
    expect(out.map(s => s.id)).toEqual(['b', 'd'])
  })
})

describe('OrphansPage', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => { __setCsrfTokenForTests('csrf-test') })
  afterEach(() => { fx?.restore(); __resetAuthForTests(); vi.restoreAllMocks() })

  const orphanSnapshot = () => mkSnapshot([
    mkStatus({ id: 'keep', availability: { kind: 'ok' } }),
    mkStatus({
      id: 'llama3-8b',
      label: 'Llama 3 8B',
      providerKind: 'local',
      availability: { kind: 'orphan_discovered' },
      raw: { discovered: { id: 'llama3-8b', label: 'Llama 3 8B', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434', parameterSize: '8B' } },
    }),
    mkStatus({
      id: 'qwen-coder',
      label: 'Qwen Coder',
      providerKind: 'local',
      availability: { kind: 'orphan_discovered' },
      raw: { discovered: { id: 'qwen-coder', label: 'Qwen Coder', backend: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' } },
    }),
  ])

  function Driver({ initial }: { initial: ModelTruthSnapshot }) {
    const [snap, setSnap] = useState(initial)
    return <OrphansPage snapshot={snap} onSnapshotUpdate={setSnap} />
  }

  it('only shows orphan rows with their discovered facts', () => {
    fx = installFetchMock({})
    render(<Driver initial={orphanSnapshot()} />)
    expect(screen.getByTestId('orphan-llama3-8b')).toBeInTheDocument()
    expect(screen.getByTestId('orphan-qwen-coder')).toBeInTheDocument()
    expect(screen.queryByTestId('orphan-keep')).toBeNull()
    expect(screen.getByTestId('orphan-backend-llama3-8b')).toHaveTextContent('ollama')
  })

  it('executes bulk bind with per-item payload and refreshes snapshot', async () => {
    const newSnap = mkSnapshot([
      mkStatus({ id: 'keep' }),
      mkStatus({ id: 'llama3-8b', availability: { kind: 'ok' } }),
      mkStatus({ id: 'qwen-coder', availability: { kind: 'orphan_discovered' } }),
    ])
    fx = installFetchMock({
      'POST /admin/api/bulk/bind-discovered': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'llama3-8b', ok: true }], snapshot: newSnap },
      }),
    })
    render(<Driver initial={orphanSnapshot()} />)

    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.change(screen.getByTestId('orphan-aliases-llama3-8b'), { target: { value: 'llama, ll-8b' } })
    fireEvent.change(screen.getByTestId('orphan-role-llama3-8b'), { target: { value: 'coding' } })
    fireEvent.click(screen.getByTestId('orphans-execute'))

    await waitFor(() => {
      expect(screen.getByTestId('batch-result-llama3-8b')).toHaveAttribute('data-ok', 'true')
    })
    const sent = fx.journal.find(r => r.path === '/admin/api/bulk/bind-discovered')!
    const body = sent.body as { items: Array<{ discoveredId: string; patch: { aliases?: string[]; role?: string; backendModel?: string } }> }
    expect(body.items[0]).toMatchObject({
      discoveredId: 'llama3-8b',
      patch: { aliases: ['llama', 'll-8b'], role: 'coding', backendModel: 'llama3-8b' },
    })
    // After snapshot update, the bound orphan is gone from the list
    expect(screen.queryByTestId('orphan-llama3-8b')).toBeNull()
    expect(screen.getByTestId('orphan-qwen-coder')).toBeInTheDocument()
  })

  it('select-all / select-none buttons work', () => {
    fx = installFetchMock({})
    render(<Driver initial={orphanSnapshot()} />)
    fireEvent.click(screen.getByTestId('orphans-select-all'))
    expect(screen.getByTestId('orphans-selected-count')).toHaveTextContent('2')
    fireEvent.click(screen.getByTestId('orphans-select-none'))
    expect(screen.getByTestId('orphans-selected-count')).toHaveTextContent('0')
  })

  // ─── Bind-to-existing (δ cleanup) ───────────────────────────────

  const mixedSnapshot = () => mkSnapshot([
    // A LOCAL config model — valid bind target.
    mkStatus({ id: 'local-placeholder', label: 'Local Placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'Local Placeholder', backendModel: 'old-backend', aliases: [] } as any } }),
    // A CLOUD config model — must NOT appear in the target picker.
    mkStatus({ id: 'existing-cloud', label: 'Existing Cloud', providerKind: 'cloud', raw: { config: { id: 'existing-cloud', label: 'Existing Cloud', backendModel: 'cloud-backend', aliases: [], endpoint: 'https://api.example.com/v1' } as any } }),
    mkStatus({ id: 'another-cfg', label: 'Another Config', providerKind: 'local', raw: { config: { id: 'another-cfg', label: 'Another Config', backendModel: 'another-cfg', aliases: [] } as any } }),
    mkStatus({
      id: 'llama3-8b',
      label: 'Llama 3 8B',
      providerKind: 'local',
      availability: { kind: 'orphan_discovered' },
      raw: { discovered: { id: 'llama3-8b', label: 'Llama 3 8B', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' } },
    }),
  ])

  it('renders bind-to-existing mode + target selector, disabled until checked', () => {
    fx = installFetchMock({})
    render(<Driver initial={mixedSnapshot()} />)
    const modeExisting = screen.getByTestId('orphan-mode-existing-llama3-8b') as HTMLInputElement
    expect(modeExisting).toBeDisabled()
    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    expect(modeExisting).not.toBeDisabled()
  })

  it('Apply button blocks until target picked when mode=existing', () => {
    fx = installFetchMock({})
    render(<Driver initial={mixedSnapshot()} />)
    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-llama3-8b'))
    expect(screen.getByTestId('orphans-execute')).toBeDisabled()
    expect(screen.getByTestId('orphans-incomplete')).toBeInTheDocument()
  })

  it('bind-to-existing calls bulk/patch with backendModel redirect, not bulk/bind-discovered', async () => {
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: true,
          results: [{ id: 'local-placeholder', ok: true }],
          snapshot: mkSnapshot([
            mkStatus({ id: 'local-placeholder' }),
            mkStatus({ id: 'another-cfg' }),
          ]),
        },
      }),
    })
    render(<Driver initial={mixedSnapshot()} />)

    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-llama3-8b'))
    fireEvent.change(screen.getByTestId('orphan-target-llama3-8b'), { target: { value: 'local-placeholder' } })
    expect(screen.getByTestId('orphan-bind-preview-llama3-8b')).toHaveTextContent('local-placeholder')
    fireEvent.click(screen.getByTestId('orphans-execute'))

    await waitFor(() => {
      expect(screen.getByTestId('batch-result-local-placeholder')).toHaveAttribute('data-ok', 'true')
    })
    // Must have gone through /bulk/patch
    const patched = fx.journal.find(r => r.path === '/admin/api/bulk/patch')
    expect(patched).toBeDefined()
    const body = patched!.body as { items: Array<{ id: string; patch: { backendModel: string } }> }
    expect(body.items).toEqual([{ id: 'local-placeholder', patch: { backendModel: 'llama3-8b' } }])
    // Must NOT have touched bind-discovered
    expect(fx.journal.find(r => r.path === '/admin/api/bulk/bind-discovered')).toBeUndefined()
  })

  it('mixed batch: dispatches patch then create SERIALLY, merges results, returns create snapshot', async () => {
    const postPatchSnap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'orphan-b', aliases: [] } as any } }),
    ])
    const postCreateSnap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'orphan-b', aliases: [] } as any } }),
      mkStatus({ id: 'orphan-a', providerKind: 'local', raw: { config: { id: 'orphan-a', label: 'A', backendModel: 'orphan-a', aliases: [] } as any } }),
    ])
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'local-placeholder', ok: true }], snapshot: postPatchSnap },
      }),
      'POST /admin/api/bulk/bind-discovered': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'orphan-a', ok: true }], snapshot: postCreateSnap },
      }),
    })
    const snap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'old', aliases: [] } as any } }),
      mkStatus({ id: 'orphan-a', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'orphan-a', label: 'A', backend: 'ollama', baseUrl: 'http://x' } } }),
      mkStatus({ id: 'orphan-b', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'orphan-b', label: 'B', backend: 'ollama', baseUrl: 'http://x' } } }),
    ])
    const onSnapshotUpdate = vi.fn()
    render(<OrphansPage snapshot={snap} onSnapshotUpdate={onSnapshotUpdate} />)

    fireEvent.click(screen.getByTestId('orphan-check-orphan-a'))
    // orphan-a stays on default mode 'create'
    fireEvent.click(screen.getByTestId('orphan-check-orphan-b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-orphan-b'))
    fireEvent.change(screen.getByTestId('orphan-target-orphan-b'), { target: { value: 'local-placeholder' } })

    fireEvent.click(screen.getByTestId('orphans-execute'))

    await waitFor(() => {
      expect(fx.journal.find(r => r.path === '/admin/api/bulk/bind-discovered')).toBeDefined()
      expect(fx.journal.find(r => r.path === '/admin/api/bulk/patch')).toBeDefined()
    })

    // Both calls went out
    const bindBody = fx.journal.find(r => r.path === '/admin/api/bulk/bind-discovered')!.body as { items: Array<{ discoveredId: string }> }
    expect(bindBody.items[0]!.discoveredId).toBe('orphan-a')
    const patchBody = fx.journal.find(r => r.path === '/admin/api/bulk/patch')!.body as { items: Array<{ id: string }> }
    expect(patchBody.items[0]!.id).toBe('local-placeholder')

    // Serial order: patch before create
    const patchIdx = fx.journal.findIndex(r => r.path === '/admin/api/bulk/patch')
    const bindIdx = fx.journal.findIndex(r => r.path === '/admin/api/bulk/bind-discovered')
    expect(patchIdx).toBeLessThan(bindIdx)

    // Snapshot truth: single unified result = create's (which ran last + reflects both writes)
    expect(onSnapshotUpdate).toHaveBeenCalledTimes(1)
    const delivered = onSnapshotUpdate.mock.calls[0]![0] as { statuses: Array<{ id: string }> }
    expect(delivered.statuses.map(s => s.id)).toEqual(['local-placeholder', 'orphan-a'])

    // Per-item results for BOTH operations are visible
    expect(screen.getByTestId('batch-result-local-placeholder')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('batch-result-orphan-a')).toHaveAttribute('data-ok', 'true')
  })

  it('snapshot refreshes after bind-to-existing success', async () => {
    const afterSnap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'llama3-8b', aliases: [] } as any } }),
      mkStatus({ id: 'another-cfg', providerKind: 'local', raw: { config: { id: 'another-cfg', label: 'Another', backendModel: 'another-cfg', aliases: [] } as any } }),
      // llama3-8b orphan is gone from snapshot (bound now).
    ])
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'local-placeholder', ok: true }], snapshot: afterSnap },
      }),
    })
    render(<Driver initial={mixedSnapshot()} />)

    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-llama3-8b'))
    fireEvent.change(screen.getByTestId('orphan-target-llama3-8b'), { target: { value: 'local-placeholder' } })
    fireEvent.click(screen.getByTestId('orphans-execute'))

    await waitFor(() => {
      // llama3-8b orphan row disappears after snapshot refresh
      expect(screen.queryByTestId('orphan-llama3-8b')).toBeNull()
    })
  })

  // ─── Correctness Cleanup tests ──────────────────────────────────

  it('target picker only lists LOCAL config models (cloud filtered out)', () => {
    fx = installFetchMock({})
    render(<Driver initial={mixedSnapshot()} />)
    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-llama3-8b'))
    const select = screen.getByTestId('orphan-target-llama3-8b') as HTMLSelectElement
    const optionValues = Array.from(select.options).map(o => o.value)
    expect(optionValues).toContain('local-placeholder')
    expect(optionValues).toContain('another-cfg')
    expect(optionValues).not.toContain('existing-cloud')
  })

  it('shows empty-state + disables select when no local targets exist', () => {
    const cloudOnlySnap = mkSnapshot([
      mkStatus({ id: 'only-cloud', providerKind: 'cloud', raw: { config: { id: 'only-cloud', label: 'Only Cloud', backendModel: 'c', aliases: [], endpoint: 'https://x.com' } as any } }),
      mkStatus({ id: 'orphan-1', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'orphan-1', label: 'O', backend: 'ollama', baseUrl: 'http://x' } } }),
    ])
    fx = installFetchMock({})
    render(<Driver initial={cloudOnlySnap} />)
    fireEvent.click(screen.getByTestId('orphan-check-orphan-1'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-orphan-1'))
    expect(screen.getByTestId('orphan-no-local-targets-orphan-1')).toBeInTheDocument()
    expect(screen.getByTestId('orphan-target-orphan-1')).toBeDisabled()
  })

  it('submit-time guard rejects cloud target if snapshot flipped mid-flight', async () => {
    // User initially sees local-placeholder in picker, but snapshot re-renders
    // and it becomes cloud before submit. Guard must catch it.
    fx = installFetchMock({})
    const Harness = () => {
      const [snap, setSnap] = useState(mixedSnapshot())
      return (
        <>
          <button
            type="button"
            data-testid="flip-to-cloud"
            onClick={() => setSnap(mkSnapshot(snap.statuses.map(s => (
              s.id === 'local-placeholder'
                ? { ...s, providerKind: 'cloud' as const, raw: { config: { ...s.raw.config!, endpoint: 'https://evil.example/v1' } as any } }
                : s
            ))))}
          >
            flip
          </button>
          <OrphansPage snapshot={snap} onSnapshotUpdate={setSnap} />
        </>
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByTestId('orphan-check-llama3-8b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-llama3-8b'))
    fireEvent.change(screen.getByTestId('orphan-target-llama3-8b'), { target: { value: 'local-placeholder' } })

    // Now flip that target to cloud + try to submit.
    fireEvent.click(screen.getByTestId('flip-to-cloud'))

    expect(screen.getByTestId('orphans-cloud-rejected')).toBeInTheDocument()
    expect(screen.getByTestId('orphans-execute')).toBeDisabled()
    // Neither endpoint was called.
    expect(fx.journal.find(r => r.path === '/admin/api/bulk/patch')).toBeUndefined()
    expect(fx.journal.find(r => r.path === '/admin/api/bulk/bind-discovered')).toBeUndefined()
  })

  it('mixed batch: create request fails (network) — patch result still visible + error surfaced', async () => {
    const patchSnap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'orphan-b', aliases: [] } as any } }),
    ])
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, results: [{ id: 'local-placeholder', ok: true }], snapshot: patchSnap },
      }),
      'POST /admin/api/bulk/bind-discovered': () => ({
        status: 500,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'internal_error', message: 'boom' } },
      }),
    })
    const snap = mkSnapshot([
      mkStatus({ id: 'local-placeholder', providerKind: 'local', raw: { config: { id: 'local-placeholder', label: 'LP', backendModel: 'old', aliases: [] } as any } }),
      mkStatus({ id: 'orphan-a', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'orphan-a', label: 'A', backend: 'ollama', baseUrl: 'http://x' } } }),
      mkStatus({ id: 'orphan-b', availability: { kind: 'orphan_discovered' }, raw: { discovered: { id: 'orphan-b', label: 'B', backend: 'ollama', baseUrl: 'http://x' } } }),
    ])
    render(<Driver initial={snap} />)

    fireEvent.click(screen.getByTestId('orphan-check-orphan-a'))
    fireEvent.click(screen.getByTestId('orphan-check-orphan-b'))
    fireEvent.click(screen.getByTestId('orphan-mode-existing-orphan-b'))
    fireEvent.change(screen.getByTestId('orphan-target-orphan-b'), { target: { value: 'local-placeholder' } })
    fireEvent.click(screen.getByTestId('orphans-execute'))

    await waitFor(() => {
      // Patch's per-item success is visible.
      expect(screen.getByTestId('batch-result-local-placeholder')).toHaveAttribute('data-ok', 'true')
    })
    // Create's request-level failure surfaces as a synthetic result item.
    const errorResult = screen.getByTestId('batch-result-__request_error_0')
    expect(errorResult).toHaveAttribute('data-ok', 'false')
    expect(errorResult).toHaveTextContent('boom')
  })
})
