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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function getHtmlAttr(tag: string, attr: string): string | null {
  const pattern = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(tag)
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '') : null
}

function hasClass(tag: string, className: string): boolean {
  const classes = getHtmlAttr(tag, 'class')
  if (!classes) return false
  return classes.split(/\s+/).includes(className)
}

function normalizeResultUrl(raw: string): string {
  const decoded = decodeHtmlEntities(raw)
  const absolute = decoded.startsWith('//') ? `https:${decoded}` : decoded

  try {
    const parsed = new URL(absolute, 'https://duckduckgo.com')
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg')
      if (uddg) return uddg
    }
    return absolute
  } catch {
    return absolute
  }
}

/**
 * Parse DuckDuckGo lite HTML results into structured search results.
 * DDG lite returns a simple HTML table with results.
 */
export function parseDdgResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // DDG lite format: each result has an <a> link in a table row, followed by
  // a snippet row. The live page has used both single-quoted and double-quoted
  // attrs, plus redirect URLs shaped like //duckduckgo.com/l/?uddg=<target>.
  // Parse attributes structurally instead of assuming one exact quote style.
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi
  const tdPattern = /<td\b[^>]*>[\s\S]*?<\/td>/gi

  const links: { url: string; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = anchorPattern.exec(html)) !== null) {
    const fullTag = match[0]!
    if (!hasClass(fullTag, 'result-link')) continue
    const href = getHtmlAttr(fullTag, 'href')
    const url = href ? normalizeResultUrl(href) : ''
    const title = stripTags(fullTag)
    if (url && title) links.push({ url, title })
  }

  const snippets: string[] = []
  while ((match = tdPattern.exec(html)) !== null) {
    const fullTag = match[0]!
    if (!hasClass(fullTag, 'result-snippet')) continue
    snippets.push(stripTags(fullTag))
  }

  // If DDG lite parsing fails, try a more generic pattern
  if (links.length === 0) {
    // Fallback: extract any http links that look like results
    const genericPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi
    while ((match = genericPattern.exec(html)) !== null) {
      const fullTag = match[0]!
      const href = getHtmlAttr(fullTag, 'href')
      if (!href || !/^https?:\/\//i.test(href)) continue
      const url = normalizeResultUrl(href)
      const title = stripTags(fullTag)
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
