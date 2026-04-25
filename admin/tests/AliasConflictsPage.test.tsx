import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AliasConflictsPage, buildPatchItems, extractAliasConflicts, projectedAliases } from '../src/pages/AliasConflictsPage'
import { __resetAuthForTests, __setCsrfTokenForTests } from '../src/auth/session'
import { ADMIN_API_SCHEMA_VERSION, type ModelTruthSnapshot } from '../src/api/types'
import { mkSnapshot, mkStatus } from './fixtures'
import { useState } from 'react'

function installFetchMock(handlers: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const journal: Array<{ method: string; path: string; body: unknown }> = []
  const real = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body) {
      try { body = JSON.parse(String(init.body)) } catch { body = init.body }
    }
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

describe('alias conflict helpers (pure)', () => {
  const a = mkStatus({ id: 'a', label: 'A', availability: { kind: 'alias_conflict', with: 'kimi' }, raw: { config: { id: 'a', label: 'A', backendModel: 'a', aliases: ['kimi', 'legacy-a'] } as any } })
  const b = mkStatus({ id: 'b', label: 'B', availability: { kind: 'alias_conflict', with: 'kimi' }, raw: { config: { id: 'b', label: 'B', backendModel: 'b', aliases: ['kimi'] } as any } })
  const c = mkStatus({ id: 'c', label: 'C', availability: { kind: 'ok' } })

  it('extractAliasConflicts groups by contested alias', () => {
    const g = extractAliasConflicts([a, b, c])
    expect(g.size).toBe(1)
    expect(g.get('kimi')?.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('projectedAliases drops contested alias for drop-conflicting plan', () => {
    const projected = projectedAliases(a, { modelId: 'a', decision: 'drop-conflicting', conflictAlias: 'kimi', renameTo: '' })
    expect(projected).toEqual(['legacy-a'])
  })

  it('projectedAliases replaces with renameTo on rename plan', () => {
    const projected = projectedAliases(a, { modelId: 'a', decision: 'rename', conflictAlias: 'kimi', renameTo: 'kimi-2' })
    expect(projected).toEqual(['legacy-a', 'kimi-2'])
  })

  it('buildPatchItems only emits models whose plan actually changes aliases', () => {
    const conflicts = extractAliasConflicts([a, b])
    const plans = {
      [`kimi\u0000a`]: { modelId: 'a', decision: 'keep' as const, conflictAlias: 'kimi', renameTo: '' },
      [`kimi\u0000b`]: { modelId: 'b', decision: 'drop-conflicting' as const, conflictAlias: 'kimi', renameTo: '' },
    }
    const items = buildPatchItems(conflicts, plans, [a, b])
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({ id: 'b', patch: { aliases: [] } })
  })
})

describe('AliasConflictsPage rendering + execute', () => {
  let fx: ReturnType<typeof installFetchMock>

  beforeEach(() => {
    __setCsrfTokenForTests('csrf-test')
  })

  afterEach(() => {
    fx?.restore()
    __resetAuthForTests()
    vi.restoreAllMocks()
  })

  const conflictSnapshot = () => mkSnapshot([
    mkStatus({ id: 'model-a', label: 'Model A', availability: { kind: 'alias_conflict', with: 'kimi' }, raw: { config: { id: 'model-a', label: 'Model A', backendModel: 'model-a', aliases: ['kimi', 'legacy-a'] } as any } }),
    mkStatus({ id: 'model-b', label: 'Model B', availability: { kind: 'alias_conflict', with: 'kimi' }, raw: { config: { id: 'model-b', label: 'Model B', backendModel: 'model-b', aliases: ['kimi'] } as any } }),
    mkStatus({ id: 'ok', label: 'OK', availability: { kind: 'ok' } }),
  ])

  function Driver({ initial }: { initial: ModelTruthSnapshot }) {
    const [snap, setSnap] = useState(initial)
    return <AliasConflictsPage snapshot={snap} onSnapshotUpdate={setSnap} />
  }

  it('lists only alias_conflict entries grouped by alias', () => {
    fx = installFetchMock({})
    render(<Driver initial={conflictSnapshot()} />)
    expect(screen.getByTestId('conflict-group-kimi')).toBeInTheDocument()
    const group = screen.getByTestId('conflict-group-kimi')
    expect(within(group).getByTestId('conflict-model-kimi-model-a')).toBeInTheDocument()
    expect(within(group).getByTestId('conflict-model-kimi-model-b')).toBeInTheDocument()
    expect(screen.queryByTestId('conflict-model-kimi-ok')).toBeNull()
  })

  it('execute disabled when every plan is "keep"', () => {
    fx = installFetchMock({})
    render(<Driver initial={conflictSnapshot()} />)
    expect(screen.getByTestId('alias-execute')).toBeDisabled()
    expect(screen.getByTestId('alias-proposed-count')).toHaveTextContent('0 models')
  })

  it('applies plan and renders per-item batch results on 207 partial', async () => {
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 207,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: false,
          results: [
            { id: 'model-a', ok: true },
            { id: 'model-b', ok: false, error: { code: 'mutation_failed', message: 'boom' } },
          ],
          snapshot: mkSnapshot([mkStatus({ id: 'ok' })]),
        },
      }),
    })
    render(<Driver initial={conflictSnapshot()} />)
    fireEvent.click(screen.getByTestId('plan-kimi-model-a-drop'))
    fireEvent.click(screen.getByTestId('plan-kimi-model-b-drop'))
    fireEvent.click(screen.getByTestId('alias-execute'))
    await waitFor(() => {
      expect(screen.getByTestId('batch-result-model-a')).toHaveAttribute('data-ok', 'true')
      expect(screen.getByTestId('batch-result-model-b')).toHaveAttribute('data-ok', 'false')
      expect(screen.getByTestId('batch-result-model-b')).toHaveTextContent('boom')
    })
    const sent = fx.journal.find(r => r.method === 'POST' && r.path === '/admin/api/bulk/patch')!
    const body = sent.body as { items: Array<{ id: string; patch: { aliases: string[] } }> }
    expect(body.items.find(i => i.id === 'model-a')?.patch.aliases).toEqual(['legacy-a'])
    expect(body.items.find(i => i.id === 'model-b')?.patch.aliases).toEqual([])
  })

  it('shows empty state when no conflicts exist', () => {
    fx = installFetchMock({})
    render(<Driver initial={mkSnapshot([mkStatus({ id: 'ok' })])} />)
    expect(screen.getByTestId('alias-conflicts-empty')).toBeInTheDocument()
  })

  it('schemaVersion mismatch surfaces error', async () => {
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 200,
        body: { schemaVersion: 999, ok: true, results: [] },
      }),
    })
    render(<Driver initial={conflictSnapshot()} />)
    fireEvent.click(screen.getByTestId('plan-kimi-model-a-drop'))
    fireEvent.click(screen.getByTestId('alias-execute'))
    await waitFor(() => expect(screen.getByTestId('alias-error')).toHaveTextContent(/schemaVersion/i))
  })

  it('HTTP 403 surfaces error (not per-item success)', async () => {
    fx = installFetchMock({
      'POST /admin/api/bulk/patch': () => ({
        status: 403,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'csrf_mismatch', message: 'bad csrf' } },
      }),
    })
    render(<Driver initial={conflictSnapshot()} />)
    fireEvent.click(screen.getByTestId('plan-kimi-model-a-drop'))
    fireEvent.click(screen.getByTestId('alias-execute'))
    await waitFor(() => expect(screen.getByTestId('alias-error')).toHaveTextContent('bad csrf'))
  })
})
