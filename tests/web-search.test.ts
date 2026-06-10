import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { webSearch, checkSearXNG } from '../src/web-search.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('web search', () => {
  describe('webSearch', () => {
    it('returns search results from SearXNG', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'First result', engine: 'google' },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Second result', engine: 'bing' },
          ],
          number_of_results: 2,
        }),
      })

      const result = await webSearch('test query')
      expect(result.query).toBe('test query')
      expect(result.results).toHaveLength(2)
      expect(result.results[0].title).toBe('Result 1')
      expect(result.results[0].url).toBe('https://example.com/1')
      expect(result.duration).toBeGreaterThanOrEqual(0)

      // Verify fetch was called with correct URL
      const fetchUrl = mockFetch.mock.calls[0][0] as string
      expect(fetchUrl).toContain('/search?')
      expect(fetchUrl).toContain('q=test+query')
      expect(fetchUrl).toContain('format=json')
    })

    it('respects limit option', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: Array.from({ length: 20 }, (_, i) => ({
            title: `Result ${i}`, url: `https://example.com/${i}`, content: `Content ${i}`, engine: 'google',
          })),
          number_of_results: 20,
        }),
      })

      const result = await webSearch('test', { limit: 3 })
      expect(result.results).toHaveLength(3)
    })

    it('passes language parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], number_of_results: 0 }),
      })

      await webSearch('测试', { language: 'zh-CN' })
      const fetchUrl = mockFetch.mock.calls[0][0] as string
      expect(fetchUrl).toContain('language=zh-CN')
    })

    it('throws on SearXNG error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })

      await expect(webSearch('test')).rejects.toThrow('SearXNG error: 503')
    })

    it('uses custom SearXNG URL from env', async () => {
      vi.stubEnv('OWLCODA_SEARXNG_URL', 'http://custom:9999')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], number_of_results: 0 }),
      })

      await webSearch('test')
      const fetchUrl = mockFetch.mock.calls[0][0] as string
      expect(fetchUrl.startsWith('http://custom:9999/')).toBe(true)
    })

    it('handles missing fields gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: '', url: '', content: '', engine: '' },
          ],
        }),
      })

      const result = await webSearch('test')
      expect(result.results).toHaveLength(1)
      expect(result.results[0].title).toBe('')
      expect(result.results[0].url).toBe('')
    })
  })

  describe('checkSearXNG', () => {
    it('returns available when reachable', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      const status = await checkSearXNG()
      expect(status.available).toBe(true)
      expect(status.url).toContain('localhost')
    })

    it('returns unavailable on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const status = await checkSearXNG()
      expect(status.available).toBe(false)
      expect(status.error).toContain('ECONNREFUSED')
    })
  })
})
