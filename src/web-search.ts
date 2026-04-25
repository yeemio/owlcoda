/**
 * Local web search via SearXNG.
 * SearXNG instance expected at OWLCODA_SEARXNG_URL or http://localhost:8888
 */

export interface SearchResult {
  title: string
  url: string
  content: string
  engine: string
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  number_of_results: number
  duration: number
}

const DEFAULT_SEARXNG_URL = 'http://localhost:8888'

function getSearXNGUrl(): string {
  return process.env.OWLCODA_SEARXNG_URL || DEFAULT_SEARXNG_URL
}

export async function webSearch(
  query: string,
  options: { language?: string; limit?: number; categories?: string } = {},
): Promise<SearchResponse> {
  const baseUrl = getSearXNGUrl()
  const params = new URLSearchParams({
    q: query,
    format: 'json',
  })
  if (options.language) params.set('language', options.language)
  if (options.categories) params.set('categories', options.categories)

  const startTime = performance.now()

  const response = await fetch(`${baseUrl}/search?${params}`)
  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as Record<string, unknown>
  const duration = (performance.now() - startTime) / 1000

  const rawResults = Array.isArray(data.results) ? data.results : []
  const limit = options.limit || 10

  const results: SearchResult[] = rawResults.slice(0, limit).map((r: Record<string, unknown>) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    content: String(r.content || ''),
    engine: String(r.engine || ''),
  }))

  return {
    query,
    results,
    number_of_results: typeof data.number_of_results === 'number' ? data.number_of_results : results.length,
    duration,
  }
}

/**
 * Check if SearXNG is reachable.
 */
export async function checkSearXNG(): Promise<{ available: boolean; url: string; error?: string }> {
  const url = getSearXNGUrl()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return { available: res.ok, url }
  } catch (err) {
    return { available: false, url, error: String(err) }
  }
}
