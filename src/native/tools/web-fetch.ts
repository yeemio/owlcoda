/**
 * OwlCoda Native WebFetch Tool
 *
 * Fetches content from a URL and returns it as text/markdown.
 * Native implementation: direct HTTP fetch + regex-based HTML-to-text.
 * Avoids remote domain-check dependencies and secondary model calls.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface WebFetchInput {
  /** The URL to fetch */
  url: string
  /** HTTP method. Only GET and HEAD are supported. Defaults to GET. */
  method?: 'GET' | 'HEAD' | string
  /** Optional prompt — included as context but not processed by a secondary model */
  prompt?: string
}

const MAX_CONTENT_LENGTH = 100_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_LLMSTXT_FALLBACK_CANDIDATES = 3

const COMMON_DOC_PATH_SEGMENTS = new Set([
  'api',
  'apis',
  'app',
  'apps',
  'doc',
  'docs',
  'documentation',
  'en',
  'guide',
  'guides',
  'help',
  'learn',
  'overview',
  'reference',
])

/** Strip HTML tags and decode basic entities into readable text. */
export function htmlToText(html: string): string {
  let text = html

  // Remove <script> and <style> blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|aside|main|table)\b[^>]*>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  return text
}

function fetchHeaders(): Record<string, string> {
  return {
    'User-Agent': 'OwlCoda/0.5.0 (native web-fetch)',
    Accept: 'text/html, application/json, text/plain, */*',
  }
}

function renderFetchedContent(args: {
  responseUrl: string
  contentType: string
  raw: string
  prompt?: string
  fallback?: { llmsTxtUrl: string; originalUrl: string }
}): ToolResult {
  let content: string
  if (args.contentType.includes('application/json')) {
    // JSON: pretty-print
    try {
      content = JSON.stringify(JSON.parse(args.raw), null, 2)
    } catch {
      content = args.raw
    }
  } else if (args.contentType.includes('text/html')) {
    content = htmlToText(args.raw)
  } else {
    // text/plain or other
    content = args.raw
  }

  // Truncate if too long
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
  }

  const fallbackHeader = args.fallback
    ? `Original-URL: ${args.fallback.originalUrl}\nFallback: ${args.fallback.llmsTxtUrl}\n`
    : ''
  const header = `URL: ${args.responseUrl}\n${fallbackHeader}Content-Type: ${args.contentType}\nLength: ${content.length} chars\n`
  const promptNote = args.prompt ? `\nPrompt: ${args.prompt}\n` : ''

  return {
    output: `${header}${promptNote}\n${content}`,
    isError: false,
    metadata: {
      url: args.responseUrl,
      contentType: args.contentType,
      length: content.length,
      ...(args.fallback
        ? {
            originalUrl: args.fallback.originalUrl,
            llmsTxtUrl: args.fallback.llmsTxtUrl,
            llmsTxtFallback: true,
          }
        : {}),
    },
  }
}

function extractDocPathSegments(url: URL): Set<string> {
  const segments = url.pathname
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(segment => segment.trim())
    .filter(segment => segment.length >= 3 && !COMMON_DOC_PATH_SEGMENTS.has(segment))

  return new Set(segments)
}

function cleanLlmsTxtHref(href: string): string {
  return href
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[),.;]+$/g, '')
}

export function extractLlmsTxtCandidateUrls(llmsTxt: string, baseUrl: URL): URL[] {
  const candidates = new Map<string, URL>()

  const addCandidate = (rawHref: string) => {
    const href = cleanLlmsTxtHref(rawHref)
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return

    try {
      const candidate = new URL(href, baseUrl)
      if (!['http:', 'https:'].includes(candidate.protocol)) return
      if (!/\.(mdx?|txt)$/i.test(candidate.pathname)) return
      candidates.set(candidate.href, candidate)
    } catch {
      // Ignore malformed candidate links from third-party llms.txt files.
    }
  }

  for (const match of llmsTxt.matchAll(/\[[^\]]*]\(([^)\s]+)\)/g)) {
    addCandidate(match[1] ?? '')
  }

  for (const match of llmsTxt.matchAll(/https?:\/\/[^\s<>)"']+/g)) {
    addCandidate(match[0] ?? '')
  }

  for (const match of llmsTxt.matchAll(/(?:^|\s)((?:\.{0,2}\/|\/)?[A-Za-z0-9._~/-]+\.(?:mdx?|txt))(?:\s|$)/g)) {
    addCandidate(match[1] ?? '')
  }

  return [...candidates.values()]
}

function scoreLlmsTxtCandidate(candidate: URL, original: URL): number {
  const originalSegments = extractDocPathSegments(original)
  const candidateSegments = extractDocPathSegments(candidate)
  let score = 0

  for (const segment of originalSegments) {
    if (candidateSegments.has(segment)) score += 10
  }

  if (candidate.origin === original.origin) score += 3
  if (/\.mdx?$/i.test(candidate.pathname)) score += 5
  if (/\/llms(?:-full)?\.txt$/i.test(candidate.pathname)) score -= 4

  return score
}

async function tryLlmsTxtFallback(originalUrl: string, originalParsed: URL, prompt?: string): Promise<ToolResult | null> {
  const llmsTxtUrl = new URL('/llms.txt', originalParsed.origin)

  let llmsTxtRes: Response
  try {
    llmsTxtRes = await fetch(llmsTxtUrl.href, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: fetchHeaders(),
      redirect: 'follow',
    })
  } catch {
    return null
  }

  if (!llmsTxtRes.ok) return null

  const llmsTxt = await llmsTxtRes.text()
  const rankedCandidates = extractLlmsTxtCandidateUrls(llmsTxt, llmsTxtUrl)
    .map(candidate => ({ candidate, score: scoreLlmsTxtCandidate(candidate, originalParsed) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LLMSTXT_FALLBACK_CANDIDATES)

  for (const { candidate } of rankedCandidates) {
    try {
      const candidateRes = await fetch(candidate.href, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: fetchHeaders(),
        redirect: 'follow',
      })

      if (!candidateRes.ok) continue

      const contentType = candidateRes.headers.get('content-type') ?? ''
      const raw = await candidateRes.text()
      return renderFetchedContent({
        responseUrl: candidate.href,
        contentType,
        raw,
        prompt,
        fallback: { llmsTxtUrl: llmsTxtUrl.href, originalUrl },
      })
    } catch {
      // Try the next candidate. If all candidates fail, preserve the original 404.
    }
  }

  return null
}

export function createWebFetchTool(): NativeToolDef<WebFetchInput> {
  return {
    name: 'WebFetch',
    description:
      'Fetch the content of a URL and return it as text. Useful for reading web pages, documentation, or API responses.',

    async execute(input: WebFetchInput): Promise<ToolResult> {
      const { url, prompt } = input
      const method = normalizeMethod(input.method)

      if (!url || typeof url !== 'string') {
        return { output: 'Error: url is required', isError: true }
      }
      if (method === null) {
        return { output: 'Error: WebFetch only supports GET and HEAD methods', isError: true }
      }

      // Basic URL validation
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { output: `Error: invalid URL "${url}"`, isError: true }
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { output: `Error: only HTTP/HTTPS URLs are supported (got ${parsed.protocol})`, isError: true }
      }

      try {
        const res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: fetchHeaders(),
          redirect: 'follow',
        })

        if (!res.ok) {
          if (res.status === 404 && method === 'GET') {
            const fallback = await tryLlmsTxtFallback(url, parsed, prompt)
            if (fallback) return fallback
          }

          if (res.status === 403) {
            const contentType = res.headers.get('content-type') ?? ''
            const raw = method === 'HEAD' ? '' : await safeReadResponseText(res)
            const responseBodySnippet = responseSnippet(raw, contentType)
            const snippetLine = responseBodySnippet
              ? `\nResponse snippet: ${responseBodySnippet}`
              : ''
            return {
              output:
                `Error: HTTP ${res.status} ${res.statusText} fetching ${url}\n` +
                'Recovery: recoverable fetch block; try BrowserJob with provider=chrome_headless, use a documented API endpoint, or record this URL as blocked evidence instead of repeatedly retrying WebFetch.' +
                snippetLine,
              isError: true,
              metadata: {
                failureCategory: 'remote:blocked_source',
                httpStatus: res.status,
                statusText: res.statusText,
                url,
                contentType,
                recoverable: true,
                blockedSource: true,
                blockedSourceKind: 'http_403',
                ...(responseBodySnippet ? { responseBodySnippet } : {}),
              },
            }
          }

          return {
            output: `Error: HTTP ${res.status} ${res.statusText} fetching ${url}`,
            isError: true,
          }
        }

        const contentType = res.headers.get('content-type') ?? ''
        const raw = method === 'HEAD' ? '' : await res.text()
        return renderFetchedContent({ responseUrl: url, contentType, raw, prompt })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('TimeoutError') || msg.includes('abort')) {
          return { output: `Error: request timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching ${url}`, isError: true }
        }
        return { output: `Error fetching ${url}: ${msg}`, isError: true }
      }
    },
  }
}

async function safeReadResponseText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function responseSnippet(raw: string, contentType: string): string {
  const text = contentType.includes('text/html') ? htmlToText(raw) : raw.trim()
  return text.replace(/\s+/g, ' ').slice(0, 500)
}

function normalizeMethod(value: unknown): 'GET' | 'HEAD' | null {
  if (value === undefined) return 'GET'
  if (typeof value !== 'string') return null
  const method = value.trim().toUpperCase()
  if (method === 'GET' || method === 'HEAD') return method
  return null
}
