import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/App'
import { ADMIN_API_SCHEMA_VERSION } from '../src/api/types'
import { __resetAuthForTests } from '../src/auth/session'
import { mkSnapshot, mkStatus } from './fixtures'

function installFetchMock() {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const real = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body))
      } catch {
        body = init.body
      }
    }
    calls.push({ method, url, body })

    if (method === 'GET' && url === '/admin/api/snapshot') {
      return new Response(JSON.stringify({
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        snapshot: {
          ...mkSnapshot([
          mkStatus({ id: 'kimi-code', label: 'Kimi Code', providerKind: 'cloud', isDefault: true }),
          mkStatus({
            id: 'local-qwen',
            providerKind: 'local',
            availability: { kind: 'orphan_discovered' },
            presentIn: { config: false, router: false, discovered: true, catalog: false },
          }),
          mkStatus({
            id: 'stale-local',
            providerKind: 'local',
            availability: {
              kind: 'router_missing',
              reason: 'Not visible in owlmlx /v1/openai/models yet; runtime visibility gate blocked (base_model_config_missing)',
              visibilityRule: 'runtime_gate_required_before_visible',
              blockReason: 'base_model_config_missing',
              truthSurface: '/v1/openai/models',
              diagnosticSurface: '/v1/runtime/model-visibility',
              loadedInventorySurface: '/v1/models',
            },
          }),
        ]),
          platformVisibility: {
            endpoint: '/v1/runtime/model-visibility',
            source: 'owlmlx_runtime_model_visibility',
            rule: 'runtime_gate_required_before_visible',
            contractVersion: 'runtime-owned-2',
            gateStatus: null,
            gateReason: null,
            gateOwner: 'owlmlx',
            gateKind: 'registered_base_model_config_present',
            statusRegistry: null,
            requiresBackendAdvertisement: false,
            modelsRoot: '/var/lib/local-runtime/models',
            formalSurfaceEndpoint: '/v1/openai/models',
            diagnosticSurfaceEndpoint: '/v1/runtime/model-visibility',
            loadedInventoryEndpoint: '/v1/models',
            loadedInventorySemanticRole: 'currently_loaded_inventory_only',
            deprecatedFallback: false,
            visibleModelIds: ['kimi-code'],
            blockedModelIds: ['stale-local'],
            entriesByModelId: {
              'stale-local': {
                modelId: 'stale-local',
                visible: false,
                blockReason: 'base_model_config_missing',
              },
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (method === 'GET' && url === '/admin/api/config') {
      return new Response(JSON.stringify({
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        config: {
          models: [],
          routerUrl: 'http://127.0.0.1:11435/v1',
          localRuntimeProtocol: 'auto',
          port: 8019,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (method === 'GET' && url === '/admin/api/providers') {
      return new Response(JSON.stringify({
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
            family: 'multi-model',
            description: 'Alibaba Cloud Model Studio family.',
            featured: true,
          },
          {
            id: 'openrouter',
            provider: 'openai-compat',
            label: 'OpenRouter',
            endpoint: 'https://openrouter.ai/api/v1',
            family: 'multi-model',
            description: 'OpenRouter family.',
            featured: true,
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (method === 'PATCH' && url === '/admin/api/config/runtime') {
      return new Response(JSON.stringify({
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'runtime-settings', ok: true }],
        snapshot: mkSnapshot([mkStatus({ id: 'kimi-code', label: 'Kimi Code', providerKind: 'cloud', isDefault: true })]),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (method === 'POST' && url === '/admin/api/bulk/bind-discovered') {
      return new Response(JSON.stringify({
        schemaVersion: ADMIN_API_SCHEMA_VERSION,
        ok: true,
        results: [{ id: 'local-qwen', ok: true }],
        snapshot: mkSnapshot([
          mkStatus({ id: 'kimi-code', label: 'Kimi Code', providerKind: 'cloud', isDefault: true }),
          mkStatus({ id: 'local-qwen', label: 'local-qwen', providerKind: 'local', availability: { kind: 'ok' } }),
        ]),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      schemaVersion: ADMIN_API_SCHEMA_VERSION,
      ok: false,
      error: { code: 'not_found', message: `${method} ${url}` },
    }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return {
    calls,
    restore: () => { globalThis.fetch = real },
  }
}

describe('StartPage', () => {
  let restore: (() => void) | null = null

  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/')
  })

  afterEach(() => {
    restore?.()
    restore = null
    __resetAuthForTests()
    window.history.replaceState({}, '', '/admin/')
  })

  it('renders the onboarding surface on bare /admin and saves runtime settings', async () => {
    const fetchMock = installFetchMock()
    restore = fetchMock.restore

    render(<App />)

    await waitFor(() => expect(screen.getByTestId('start-page')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('start-provider-openai-compat')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('start-provider-link-bailian')).toBeInTheDocument())
    expect(screen.getByTestId('start-visibility-contract')).toHaveTextContent('runtime_gate_required_before_visible')
    expect(screen.getByTestId('start-visibility-contract')).toHaveTextContent('/v1/openai/models')
    expect((screen.getByTestId('start-router-url-input') as HTMLInputElement).value).toBe('http://127.0.0.1:11435/v1')
    expect(screen.getByTestId('start-provider-link-bailian')).toHaveAttribute('href', '#/models?view=add&provider=bailian')

    fireEvent.change(screen.getByTestId('start-router-url-input'), {
      target: { value: 'http://127.0.0.1:12345/v1' },
    })
    fireEvent.change(screen.getByTestId('start-runtime-protocol'), {
      target: { value: 'openai_chat' },
    })
    fireEvent.click(screen.getByTestId('start-runtime-save'))

    await waitFor(() => {
      expect(fetchMock.calls.some(call =>
        call.method === 'PATCH'
        && call.url === '/admin/api/config/runtime'
        && JSON.stringify(call.body).includes('http://127.0.0.1:12345/v1'),
      )).toBe(true)
    })
  })

  it('imports selected discovered local models from the start page', async () => {
    const fetchMock = installFetchMock()
    restore = fetchMock.restore

    render(<App />)

    await waitFor(() => expect(screen.getByTestId('start-orphan-local-qwen')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('start-local-import'))

    await waitFor(() => {
      expect(fetchMock.calls.some(call =>
        call.method === 'POST'
        && call.url === '/admin/api/bulk/bind-discovered'
        && JSON.stringify(call.body).includes('local-qwen'),
      )).toBe(true)
    })
  })
})
