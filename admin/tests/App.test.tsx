import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/App'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { __resetAuthForTests } from '../src/auth/session'
import { mkSnapshot, mkStatus } from './fixtures'

/**
 * App-level bootstrap surfacing. Specifically: if the URL arrived with a
 * one-shot token but the exchange failed, the user MUST see a visible auth
 * banner — otherwise the first write just throws CSRF 403 and looks like a
 * random server bug.
 */

function mockFetch(handlers: Record<string, { status: number; body: unknown }>) {
  const real = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`
    const handler = handlers[key]
    if (!handler) {
      return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ok: false, error: { code: 'not_found', message: key } }), { status: 404 })
    }
    return new Response(JSON.stringify(handler.body), { status: handler.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

describe('App bootstrap surfacing', () => {
  let restore: () => void

  afterEach(() => {
    restore?.()
    __resetAuthForTests()
    // Reset URL
    window.history.replaceState({}, '', '/admin/')
  })

  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/')
  })

  it('hides auth banner when URL has no one-shot token', async () => {
    restore = mockFetch({
      'GET /admin/api/snapshot': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot: mkSnapshot([mkStatus({ id: 'a' })]) },
      },
      'GET /admin/api/config': {
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          config: { models: [], routerUrl: 'http://127.0.0.1:8009', localRuntimeProtocol: 'auto', port: 8019 },
        },
      },
      'GET /admin/api/providers': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [] },
      },
    })

    render(<App />)
    await waitFor(() => expect(screen.getByTestId('start-page')).toBeInTheDocument())
    expect(screen.queryByTestId('auth-error-banner')).toBeNull()
  })

  it('shows auth banner when one-shot token exchange fails', async () => {
    // Arrive with a bad token
    window.history.replaceState({}, '', '/admin/?token=ots1.bad')

    restore = mockFetch({
      'POST /admin/api/auth/exchange': {
        status: 401,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: false,
          error: { code: 'authentication_error', message: 'Invalid or expired one-shot token' },
        },
      },
      'GET /admin/api/snapshot': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot: mkSnapshot([mkStatus({ id: 'a' })]) },
      },
      'GET /admin/api/config': {
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          config: { models: [], routerUrl: 'http://127.0.0.1:8009', localRuntimeProtocol: 'auto', port: 8019 },
        },
      },
      'GET /admin/api/providers': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [] },
      },
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('auth-error-banner')).toBeInTheDocument()
    })
    expect(screen.getByTestId('auth-error-banner')).toHaveTextContent('Invalid or expired')
    expect(screen.getByTestId('auth-error-banner')).toHaveTextContent('Writes will be rejected')
  })

  it('hides banner after a successful exchange', async () => {
    window.history.replaceState({}, '', '/admin/?token=ots1.good')

    restore = mockFetch({
      'POST /admin/api/auth/exchange': {
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          ok: true,
          csrfToken: 'csrf-xyz',
        },
      },
      'GET /admin/api/snapshot': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, snapshot: mkSnapshot([mkStatus({ id: 'a' })]) },
      },
      'GET /admin/api/config': {
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          config: { models: [], routerUrl: 'http://127.0.0.1:8009', localRuntimeProtocol: 'auto', port: 8019 },
        },
      },
      'GET /admin/api/providers': {
        status: 200,
        body: { schemaVersion: ADMIN_API_SCHEMA_VERSION, providers: [] },
      },
    })

    render(<App />)
    await waitFor(() => expect(screen.getByTestId('start-page')).toBeInTheDocument())
    expect(screen.queryByTestId('auth-error-banner')).toBeNull()
  })

  it('opens the add-model flow with a provider preset from the hash', async () => {
    window.history.replaceState({}, '', '/admin/#/models?view=add&provider=bailian')

    restore = mockFetch({
      'GET /admin/api/snapshot': {
        status: 200,
        body: {
          schemaVersion: ADMIN_API_SCHEMA_VERSION,
          snapshot: mkSnapshot([mkStatus({ id: 'kimi-code', providerKind: 'cloud', isDefault: true })]),
        },
      },
      'GET /admin/api/providers': {
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
      },
    })

    render(<App />)

    await waitFor(() => expect(screen.getByTestId('add-model-dialog')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('provider-template-bailian')).toBeInTheDocument())
    expect((screen.getByTestId('field-provider') as HTMLSelectElement).value).toBe('bailian')
    expect((screen.getByTestId('field-endpoint') as HTMLInputElement).value).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })
})
