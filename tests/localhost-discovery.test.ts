import { describe, it, expect, vi, beforeEach } from 'vitest'
import { discoverLocalRuntimes } from '../src/localhost-discovery.js'

describe('discoverLocalRuntimes', () => {
  const fetchMock = vi.fn()
  let now = 1_000

  beforeEach(() => {
    fetchMock.mockReset()
    now = 1_000
  })

  function makeDeps() {
    return {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    }
  }

  it('returns one entry per local-tier template in the PROVIDER_TEMPLATES order', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await discoverLocalRuntimes({ deps: makeDeps() })
    expect(result.map(entry => entry.templateId)).toEqual([
      'ollama',
      'lm-studio',
      'vllm',
      'owlmlx',
    ])
  })

  it('marks reachable=true with HTTP status when fetch returns 2xx', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await discoverLocalRuntimes({ deps: makeDeps() })
    for (const entry of result) {
      expect(entry.reachable).toBe(true)
      expect(entry.status).toBe(200)
      expect(entry.latencyMs).toBeGreaterThanOrEqual(0)
      expect(entry.detail).toContain('reachable')
    }
  })

  it('marks reachable=false when response is non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    const result = await discoverLocalRuntimes({ deps: makeDeps() })
    for (const entry of result) {
      expect(entry.reachable).toBe(false)
      expect(entry.status).toBe(503)
      expect(entry.detail).toContain('503')
    }
  })

  it('marks reachable=false and reports error when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await discoverLocalRuntimes({ deps: makeDeps() })
    for (const entry of result) {
      expect(entry.reachable).toBe(false)
      expect(entry.status).toBeUndefined()
      expect(entry.detail).toContain('ECONNREFUSED')
    }
  })

  it('targets each template at endpoint + testPath', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await discoverLocalRuntimes({ deps: makeDeps() })
    const urls = fetchMock.mock.calls.map(call => call[0] as string).sort()
    expect(urls).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:1234/v1/models',
      'http://localhost:8000/v1/models',
      'http://localhost:8066/v1/openai/models',
    ])
  })

  it('passes timeoutMs as AbortSignal.timeout', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await discoverLocalRuntimes({ timeoutMs: 250, deps: makeDeps() })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.signal).toBeDefined()
    expect(init?.method).toBe('GET')
  })
})
