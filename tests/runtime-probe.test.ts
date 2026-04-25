import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { probeRuntimeSurface } from '../src/runtime-probe.js'

const mockFetch = vi.fn()
let origFetch: typeof globalThis.fetch

beforeAll(() => {
  origFetch = globalThis.fetch
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = origFetch
})

describe('runtime probe', () => {
  it('uses owlmlx /v1/openai/models as the formal visibility surface', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
        health: { readiness: 'ready' },
        backend: { healthy: true, loaded_models: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-oss-20b-MXFP4-Q4' }, { id: 'Qwen3.6-27B' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rule: 'runtime_gate_required_before_visible',
        contract_version: 'runtime-owned-2',
        formal_surface: { endpoint: '/v1/openai/models' },
        diagnostic_surface: { endpoint: '/v1/runtime/model-visibility' },
        loaded_inventory_surface: {
          endpoint: '/v1/models',
          semantic_role: 'currently_loaded_inventory_only',
        },
        gate: {
          owner: 'owlmlx',
          kind: 'registered_base_model_config_present',
          models_root: '/var/lib/local-runtime/models',
        },
        visible_model_ids: ['gpt-oss-20b-MXFP4-Q4', 'Qwen3.6-27B'],
        blocked_model_ids: [],
        entries: [
          { model_id: 'gpt-oss-20b-MXFP4-Q4', visible: true, block_reason: null },
          { model_id: 'Qwen3.6-27B', visible: true, block_reason: null },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        active_model_id: 'gpt-oss-20b-MXFP4-Q4',
        inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
        visibility_contract: {
          loaded_inventory_surface: { semantic_role: 'currently_loaded_inventory_only' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await probeRuntimeSurface('http://127.0.0.1:8041')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('openai_models')
    expect(result.modelIds).toEqual(['gpt-oss-20b-MXFP4-Q4', 'Qwen3.6-27B'])
    expect(result.loadedModelIds).toEqual(['gpt-oss-20b-MXFP4-Q4'])
    expect(result.modelCount).toBe(2)
    expect(result.loadedModelCount).toBe(1)
    expect(result.localRuntimeProtocol).toBe('openai_chat')
    expect(result.platformVisibility?.source).toBe('owlmlx_runtime_model_visibility')
    expect(result.platformVisibility?.rule).toBe('runtime_gate_required_before_visible')
    expect(result.platformVisibility?.formalSurfaceEndpoint).toBe('/v1/openai/models')
    expect(result.platformVisibility?.diagnosticSurfaceEndpoint).toBe('/v1/runtime/model-visibility')
    expect(result.platformVisibility?.loadedInventoryEndpoint).toBe('/v1/models')
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8041/v1/runtime/status')
    expect(mockFetch.mock.calls[1]?.[0]).toBe('http://127.0.0.1:8041/v1/openai/models')
    expect(mockFetch.mock.calls[2]?.[0]).toBe('http://127.0.0.1:8041/v1/runtime/model-visibility')
    expect(mockFetch.mock.calls[3]?.[0]).toBe('http://127.0.0.1:8041/v1/models')
  })

  it('marks /v1/models-only owlmlx replies as loaded inventory only', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
        health: { readiness: 'ready' },
        backend: { healthy: true, loaded_models: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
        visibility_contract: {
          loaded_inventory_surface: { endpoint: '/v1/models', semantic_role: 'currently_loaded_inventory_only' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rule: 'runtime_gate_required_before_visible',
        contract_version: 'runtime-owned-2',
        formal_surface: { endpoint: '/v1/openai/models' },
        diagnostic_surface: { endpoint: '/v1/runtime/model-visibility' },
        loaded_inventory_surface: {
          endpoint: '/v1/models',
          semantic_role: 'currently_loaded_inventory_only',
        },
        gate: {
          owner: 'owlmlx',
          kind: 'registered_base_model_config_present',
          models_root: '/var/lib/local-runtime/models',
        },
        visible_model_ids: ['Qwen3.6-27B'],
        blocked_model_ids: [],
        entries: [{ model_id: 'Qwen3.6-27B', visible: true, block_reason: null }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await probeRuntimeSurface('http://127.0.0.1:8041')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('loaded_inventory_only')
    expect(result.modelIds).toEqual([])
    expect(result.loadedModelIds).toEqual(['gpt-oss-20b-MXFP4-Q4'])
    expect(result.loadedModelCount).toBe(1)
    expect(result.localRuntimeProtocol).toBe('openai_chat')
    expect(result.detail).toContain('loaded inventory only')
  })

  it('falls back to deprecated router /v1/models only when the legacy contract is present', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-oss-20b-MXFP4-Q4' }, { id: 'Qwen3.6-27B' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rule: 'gate_required_before_visible',
        formal_surface: { endpoint: '/v1/models' },
        gate: {
          status: 'ready',
          status_reason: 'ok',
          status_registry: 'model_fleet/status.json',
          requires_backend_advertisement: true,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await probeRuntimeSurface('http://127.0.0.1:8009')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('deprecated_router_models')
    expect(result.modelIds).toEqual(['gpt-oss-20b-MXFP4-Q4', 'Qwen3.6-27B'])
    expect(result.platformVisibility?.deprecatedFallback).toBe(true)
    expect(result.platformVisibility?.source).toBe('legacy_router_platform_model_visibility')
  })

  it('uses generic /v1/models when no owlmlx or legacy router contract is present', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'fake-a' }, { id: 'fake-b' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    const result = await probeRuntimeSurface('http://127.0.0.1:1234/v1')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('models')
    expect(result.modelIds).toEqual(['fake-a', 'fake-b'])
    expect(result.platformVisibility).toBeNull()
  })

  it('falls back to runtime status when no formal visibility surface is reachable', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        inventory: { model_count: 1, entries: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
        health: { readiness: 'ready' },
        backend: { healthy: true, loaded_models: [{ model_id: 'gpt-oss-20b-MXFP4-Q4' }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    const result = await probeRuntimeSurface('http://127.0.0.1:8041')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('runtime_status')
    expect(result.modelIds).toEqual([])
    expect(result.loadedModelIds).toEqual(['gpt-oss-20b-MXFP4-Q4'])
    expect(result.localRuntimeProtocol).toBe('anthropic_messages')
  })

  it('falls back to /healthz when runtime status and models are unavailable', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    const result = await probeRuntimeSurface('http://127.0.0.1:8041')

    expect(result.ok).toBe(true)
    expect(result.source).toBe('healthz')
    expect(result.localRuntimeProtocol).toBeUndefined()
    expect(result.platformVisibility).toBeNull()
  })
})
