import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApiRequestError, SchemaVersionMismatchError, assertSchemaVersion, fetchSnapshot } from '../src/api/client'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { mkSnapshot, mkStatus } from './fixtures'

describe('assertSchemaVersion', () => {
  it('accepts matching version', () => {
    expect(() => assertSchemaVersion({ schemaVersion: ADMIN_API_SCHEMA_VERSION })).not.toThrow()
  })

  it('throws SchemaVersionMismatchError on mismatch', () => {
    expect(() => assertSchemaVersion({ schemaVersion: ADMIN_API_SCHEMA_VERSION + 99 }))
      .toThrow(SchemaVersionMismatchError)
  })

  it('throws when schemaVersion missing entirely', () => {
    expect(() => assertSchemaVersion({ foo: 1 })).toThrow(AdminApiRequestError)
  })
})

describe('fetchSnapshot', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // replaced per-test
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns parsed snapshot on 200 + matching schemaVersion', async () => {
    const snapshot = mkSnapshot([mkStatus({ id: 'a' })])
    const envelope = { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot }
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch

    const res = await fetchSnapshot()
    expect(res.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
    expect(res.snapshot.statuses[0]?.id).toBe('a')
  })

  it('rejects when server returns different schemaVersion', async () => {
    const envelope = { schemaVersion: ADMIN_API_SCHEMA_VERSION + 1, snapshot: {} }
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(envelope), { status: 200 }),
    ) as typeof fetch

    await expect(fetchSnapshot()).rejects.toBeInstanceOf(SchemaVersionMismatchError)
  })

  it('propagates HTTP error body code/message', async () => {
    const body = { schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'authentication_error', message: 'Missing admin session' } }
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status: 401 }),
    ) as typeof fetch

    await expect(fetchSnapshot()).rejects.toMatchObject({
      status: 401,
      code: 'authentication_error',
    })
  })
})
