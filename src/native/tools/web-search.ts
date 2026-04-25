/**
 * OwlCoda Native WebSearch Tool
 *
 * Provides web search by fetching DuckDuckGo lite results.
 * This native implementation uses DuckDuckGo's HTML interface and does not
 * depend on a proprietary remote search API.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface WebSearchInput {
  /** The search query */
  query: string
  /** Maximum number of results to return (default: 8) */
  maxResults?: number
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const SEARCH_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESULTS = 8

/**
 * Parse DuckDuckGo lite HTML results into structured search results.
 * DDG lite returns a simple HTML table with results.
 */
export function parseDdgResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // DDG lite format: each result has an <a> link in a table row, followed by snippet
  // Attributes may appear in any order, so match class anywhere in the tag

  // Extract result links — DDG lite wraps each in class="result-link"
  const linkPattern = /<a\s[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
  const hrefPattern = /href="([^"]*)"/i
  const snippetPattern = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi

  const links: { url: string; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(html)) !== null) {
    const fullTag = match[0]!
    const hrefMatch = hrefPattern.exec(fullTag)
    const url = hrefMatch ? hrefMatch[1]!.replace(/&amp;/g, '&') : ''
    const title = match[1]!.replace(/<[^>]+>/g, '').trim()
    if (url && title) links.push({ url, title })
  }

  const snippets: string[] = []
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(match[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim())
  }

  // If DDG lite parsing fails, try a more generic pattern
  if (links.length === 0) {
    // Fallback: extract any http links that look like results
    const genericPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    while ((match = genericPattern.exec(html)) !== null) {
      const url = match[1]!.replace(/&amp;/g, '&')
      const title = match[2]!.replace(/<[^>]+>/g, '').trim()
      // Skip DuckDuckGo internal links
      if (url && title && !url.includes('duckduckgo.com') && title.length > 3) {
        links.push({ url, title })
      }
    }
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? '',
    })
  }

  return results
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Search: "${query}"\n\nNo results found.`
  }

  const lines = [`Search: "${query}"`, `Results: ${results.length}`, '']

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) {
      lines.push(`   ${r.snippet}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function createWebSearchTool(): NativeToolDef<WebSearchInput> {
  return {
    name: 'WebSearch',
    description:
      'Search the web for information. Returns a list of search results with titles, URLs, and snippets.',

    async execute(input: WebSearchInput): Promise<ToolResult> {
      const { query, maxResults = DEFAULT_MAX_RESULTS } = input

      if (!query || typeof query !== 'string' || query.trim().length < 2) {
        return { output: 'Error: query must be at least 2 characters', isError: true }
      }

      try {
        const encoded = encodeURIComponent(query.trim())
        const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`

        const res = await fetch(url, {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: {
            'User-Agent': 'OwlCoda/0.5.0 (native web-search)',
            Accept: 'text/html',
          },
        })

        if (!res.ok) {
          return {
            output: `Error: search returned HTTP ${res.status}`,
            isError: true,
          }
        }

        const html = await res.text()
        const results = parseDdgResults(html, maxResults)
        const formatted = formatSearchResults(query, results)

        return {
          output: formatted,
          isError: false,
          metadata: { query, resultCount: results.length },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('TimeoutError') || msg.includes('abort')) {
          return { output: `Error: search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`, isError: true }
        }
        return { output: `Error searching: ${msg}`, isError: true }
      }
    },
  }
}
