import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAuthForTests, bootstrapAuth, getCsrfToken } from '../src/auth/session'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'

describe('bootstrapAuth', () => {
  beforeEach(() => __resetAuthForTests())
  afterEach(() => __resetAuthForTests())

  it('no-op when no ?token= in URL', async () => {
    const fetchImpl = vi.fn()
    const res = await bootstrapAuth({ search: '', fetchImpl: fetchImpl as any })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('no one-shot')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getCsrfToken()).toBeNull()
  })

  it('exchanges one-shot token and stores csrfToken', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: true, csrfToken: 'csrf-xyz' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const clear = vi.fn()
    const res = await bootstrapAuth({
      search: '?token=ots1.abc',
      onClearUrl: clear,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(true)
    expect(getCsrfToken()).toBe('csrf-xyz')
    expect(clear).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = (fetchImpl as any).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ token: 'ots1.abc' })
  })

  it('rejects mismatched schemaVersion', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ schemaVersion: 999, ok: true, csrfToken: 'csrf-xyz' }),
      { status: 200 },
    ))
    const res = await bootstrapAuth({
      search: '?token=ots1.abc',
      onClearUrl: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/schemaVersion/i)
    expect(getCsrfToken()).toBeNull()
  })

  it('surfaces server error message', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'authentication_error', message: 'Invalid or expired one-shot token' } }),
      { status: 401 },
    ))
    const res = await bootstrapAuth({
      search: '?token=ots1.bad',
      onClearUrl: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('Invalid or expired')
  })
})
