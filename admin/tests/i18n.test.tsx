import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/App'
import { I18nProvider } from '../src/i18n'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { __resetAuthForTests } from '../src/auth/session'
import { mkSnapshot, mkStatus } from './fixtures'

function mockFetch() {
  const real = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url === '/admin/api/snapshot') {
      return json({ snapshot: mkSnapshot([mkStatus({ id: 'kimi-code', label: 'Kimi Code', providerKind: 'cloud', isDefault: true })]) })
    }
    if (method === 'GET' && url === '/admin/api/config') {
      return json({
        config: {
          models: [],
          routerUrl: 'http://127.0.0.1:11435/v1',
          localRuntimeProtocol: 'auto',
          port: 8019,
        },
      })
    }
    if (method === 'GET' && url === '/admin/api/providers') {
      return json({ providers: [] })
    }
    return json({ ok: false, error: { code: 'not_found', message: `${method} ${url}` } }, 404)
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ schemaVersion: ADMIN_API_SCHEMA_VERSION, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderAdmin() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  )
}

describe('Admin i18n', () => {
  let restore: (() => void) | null = null

  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState({}, '', '/admin/')
    restore = mockFetch()
  })

  afterEach(() => {
    restore?.()
    restore = null
    __resetAuthForTests()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/admin/')
  })

  it('defaults to English and keeps the route stable when toggling languages', async () => {
    window.history.replaceState({}, '', '/admin/#/models')
    renderAdmin()
    await waitFor(() => expect(screen.getByTestId('overview')).toBeInTheDocument())

    expect(screen.getByRole('link', { name: 'Models' })).toHaveClass('active')
    expect(screen.getByTestId('language-toggle')).toHaveTextContent('EN')

    fireEvent.click(screen.getByRole('button', { name: '中文' }))

    expect(window.localStorage.getItem('owlcoda.admin.lang')).toBe('zh')
    expect(window.location.hash).toBe('#/models')
    expect(screen.getByRole('link', { name: '模型' })).toHaveClass('active')
    expect(screen.getByTestId('filter-all')).toHaveTextContent('全部')
  })

  it('restores Chinese from localStorage on first render', async () => {
    window.localStorage.setItem('owlcoda.admin.lang', 'zh')

    renderAdmin()
    // Start page removed — default landing is now Models.
    await waitFor(() => expect(screen.getByTestId('filter-all')).toBeInTheDocument())

    // Models nav link is active and shows Chinese label.
    expect(screen.getByRole('link', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByTestId('filter-all')).toHaveTextContent('全部')
  })
})
