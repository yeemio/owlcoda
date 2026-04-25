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
  /** Optional prompt — included as context but not processed by a secondary model */
  prompt?: string
}

const MAX_CONTENT_LENGTH = 100_000
const FETCH_TIMEOUT_MS = 30_000

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

export function createWebFetchTool(): NativeToolDef<WebFetchInput> {
  return {
    name: 'WebFetch',
    description:
      'Fetch the content of a URL and return it as text. Useful for reading web pages, documentation, or API responses.',

    async execute(input: WebFetchInput): Promise<ToolResult> {
      const { url, prompt } = input

      if (!url || typeof url !== 'string') {
        return { output: 'Error: url is required', isError: true }
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
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            'User-Agent': 'OwlCoda/0.5.0 (native web-fetch)',
            Accept: 'text/html, application/json, text/plain, */*',
          },
          redirect: 'follow',
        })

        if (!res.ok) {
          return {
            output: `Error: HTTP ${res.status} ${res.statusText} fetching ${url}`,
            isError: true,
          }
        }

        const contentType = res.headers.get('content-type') ?? ''
        const raw = await res.text()

        let content: string
        if (contentType.includes('application/json')) {
          // JSON: pretty-print
          try {
            content = JSON.stringify(JSON.parse(raw), null, 2)
          } catch {
            content = raw
          }
        } else if (contentType.includes('text/html')) {
          content = htmlToText(raw)
        } else {
          // text/plain or other
          content = raw
        }

        // Truncate if too long
        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
        }

        const header = `URL: ${url}\nContent-Type: ${contentType}\nLength: ${content.length} chars\n`
        const promptNote = prompt ? `\nPrompt: ${prompt}\n` : ''

        return {
          output: `${header}${promptNote}\n${content}`,
          isError: false,
          metadata: { url, contentType, length: content.length },
        }
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
