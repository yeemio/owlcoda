import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ProviderProbe,
  extractModelDescriptors,
  resolveModelDescriptor,
} from '../src/provider-probe.js'

// The Test-connection probe should surface the endpoint's REAL model (its
// /models display_name) — not just echo back the user-typed backendModel.
// Single-model coding endpoints (e.g. Kimi) ignore the model field and only
// reveal their true version ("K2.7 Code") via GET /models.

describe('extractModelDescriptors', () => {
  it('captures id + display_name from an OpenAI-style /models body', () => {
    const body = JSON.stringify({
      data: [
        { id: 'kimi-for-coding', display_name: 'K2.7 Code' },
        { id: 'kimi-vl', display_name: 'K2.7 Vision' },
      ],
    })
    expect(extractModelDescriptors(body)).toEqual([
      { id: 'kimi-for-coding', displayName: 'K2.7 Code' },
      { id: 'kimi-vl', displayName: 'K2.7 Vision' },
    ])
  })

  it('prefers display_name, then name, then id-only', () => {
    const body = JSON.stringify({
      data: [
        { id: 'a', display_name: 'Display A', name: 'Name A' },
        { id: 'b', name: 'Name B' },
        { id: 'c' },
      ],
    })
    expect(extractModelDescriptors(body)).toEqual([
      { id: 'a', displayName: 'Display A' },
      { id: 'b', displayName: 'Name B' },
      { id: 'c' },
    ])
  })

  it('dedupes by id and returns [] for empty / invalid bodies', () => {
    const dup = JSON.stringify({ data: [{ id: 'x', display_name: 'First' }, { id: 'x', display_name: 'Second' }] })
    expect(extractModelDescriptors(dup)).toEqual([{ id: 'x', displayName: 'First' }])
    expect(extractModelDescriptors('')).toEqual([])
    expect(extractModelDescriptors('not json')).toEqual([])
  })
})

describe('resolveModelDescriptor', () => {
  it('returns the sole descriptor for a single-model endpoint', () => {
    expect(resolveModelDescriptor([{ id: 'kimi-for-coding', displayName: 'K2.7 Code' }], 'whatever-the-user-typed'))
      .toEqual({ id: 'kimi-for-coding', displayName: 'K2.7 Code' })
  })

  it('matches backendModel id among multiple descriptors', () => {
    const list = [
      { id: 'glm-4.5', displayName: 'GLM-4.5' },
      { id: 'glm-4.6', displayName: 'GLM-4.6' },
    ]
    expect(resolveModelDescriptor(list, 'glm-4.6')).toEqual({ id: 'glm-4.6', displayName: 'GLM-4.6' })
  })

  it('returns undefined when multi-model has no match or list is empty', () => {
    const list = [{ id: 'a' }, { id: 'b' }]
    expect(resolveModelDescriptor(list, 'nope')).toBeUndefined()
    expect(resolveModelDescriptor(list, undefined)).toBeUndefined()
    expect(resolveModelDescriptor([], 'a')).toBeUndefined()
  })
})

describe('ProviderProbe resolvedModel', () => {
  const fetchMock = vi.fn()
  let now = 1_000

  beforeEach(() => {
    fetchMock.mockReset()
    now = 1_000
  })

  function createProbe() {
    return new ProviderProbe({
      deps: {
        fetch: fetchMock as unknown as typeof fetch,
        now: () => {
          now += 25
          return now
        },
      },
    })
  }

  it('surfaces the real model via a best-effort GET /models after a chat probe', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // chat probe
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'glm-4.6', display_name: 'GLM-4.6' }] }), { status: 200 }),
      ) // GET /models

    const result = await createProbe().test({
      provider: 'openai-compat',
      id: 'glm',
      backendModel: 'glm-4.6',
      endpoint: 'https://api.z.ai/v1',
      apiKey: 'sk-test',
      testMode: 'chat',
      testPath: '/chat/completions',
    })

    expect(result.ok).toBe(true)
    expect(result.resolvedModel).toEqual({ id: 'glm-4.6', displayName: 'GLM-4.6' })
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.z.ai/v1/models')
  })

  it('resolves a single-model kimi endpoint to its true display_name (not the chat URL)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // chat probe
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding', display_name: 'K2.7 Code' }] }), { status: 200 }),
      )

    const result = await createProbe().test({
      provider: 'kimi',
      id: 'kimi-code',
      backendModel: 'kimi-k2.8', // user typed something that the endpoint ignores
      endpoint: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
      testMode: 'chat',
      testPath: '/chat/completions',
    })

    expect(result.ok).toBe(true)
    expect(result.resolvedModel).toEqual({ id: 'kimi-for-coding', displayName: 'K2.7 Code' })
    // Must hit /models, NOT be rewritten to /chat/completions by the kimi-special URL path.
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.kimi.com/coding/v1/models')
  })

  it('stays ok with no resolvedModel when the /models fetch fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // chat probe ok
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) // /models fails

    const result = await createProbe().test({
      provider: 'openai-compat',
      id: 'glm',
      backendModel: 'glm-4.6',
      endpoint: 'https://api.z.ai/v1',
      apiKey: 'sk-test',
      testMode: 'chat',
      testPath: '/chat/completions',
    })

    expect(result.ok).toBe(true)
    expect(result.resolvedModel).toBeUndefined()
  })

  it('populates resolvedModel from a multi-model /models probe without a second fetch', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'a', display_name: 'Model A' }, { id: 'glm-4.6', display_name: 'GLM-4.6' }] }),
        { status: 200 },
      ),
    )

    const result = await createProbe().test({
      provider: 'openai-compat',
      id: 'glm',
      backendModel: 'glm-4.6',
      endpoint: 'https://api.z.ai/v1',
      apiKey: 'sk-test',
      testPath: '/models',
      testMode: 'models',
    })

    expect(result.ok).toBe(true)
    expect(result.resolvedModel).toEqual({ id: 'glm-4.6', displayName: 'GLM-4.6' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
