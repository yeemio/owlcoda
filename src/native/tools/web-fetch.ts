/**
 * OwlCoda Native WebFetch Tool
 *
 * Fetches content from a URL and returns it as text/markdown.
 * Native implementation: direct HTTP fetch + regex-based HTML-to-text.
 * Avoids remote domain-check dependencies and secondary model calls.
 */

import { lookup } from 'node:dns/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { NativeToolDef, ToolResult } from './types.js'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface SafeFetchInit {
  method: 'GET' | 'HEAD'
  headers: Record<string, string>
  signal: AbortSignal
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>
export type PinnedRequest = (
  url: URL,
  addresses: ResolvedAddress[],
  init: SafeFetchInit,
) => Promise<Response>
export type NodeRequestTransport = (
  url: URL,
  options: http.RequestOptions,
  onResponse: (incoming: http.IncomingMessage) => void,
) => http.ClientRequest

export interface SafeFetchDependencies {
  resolveHost?: HostResolver
  request?: PinnedRequest
}

export interface SafeFetchResult {
  response: Response
  finalUrl: string
}

const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BLOCKED_IPV4 = createBlockList('ipv4', [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
const PUBLIC_IPV6 = createBlockList('ipv6', [['2000::', 3]])
const BLOCKED_IPV6 = createBlockList('ipv6', [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
])

export class NetworkTargetBlockedError extends Error {
  override name = 'NetworkTargetBlockedError'
}

export async function fetchWithNetworkBoundary(
  input: string,
  init: SafeFetchInit,
  dependencies: SafeFetchDependencies = {},
): Promise<SafeFetchResult> {
  const resolveHost = dependencies.resolveHost ?? resolveHostWithDns
  const request = dependencies.request ?? requestPinned
  let current = new URL(input)

  for (let redirects = 0; ; redirects += 1) {
    assertHttpProtocol(current)
    const addresses = await resolvePublicAddresses(current, resolveHost)
    const response = await request(current, addresses, init)
    const location = response.headers.get('location')

    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, finalUrl: redirects === 0 ? input : current.href }
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`too many redirects fetching ${input}`)
    }

    current = new URL(location, current)
  }
}

async function resolveHostWithDns(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(entry => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }))
}

async function resolvePublicAddresses(url: URL, resolveHost: HostResolver): Promise<ResolvedAddress[]> {
  const hostname = stripIpv6Brackets(url.hostname)
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolveHost(hostname)

  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`)
  }

  return addresses.map(entry => {
    const family = isIP(entry.address)
    if (family !== 4 && family !== 6) {
      throw new NetworkTargetBlockedError(
        `network target is not allowed: ${hostname} resolved to an invalid IP address`,
      )
    }
    if (!isPublicIpAddress(entry.address, family)) {
      throw new NetworkTargetBlockedError(
        `network target is not allowed: ${hostname} resolved to ${entry.address}`,
      )
    }
    return { address: entry.address, family: family as 4 | 6 }
  })
}

export function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'object' ? options.family : 0
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter(entry => entry.family === requestedFamily)
      : addresses

    if (eligible.length === 0) {
      const error = Object.assign(new Error('no vetted address for requested family'), {
        code: 'ENOTFOUND',
      })
      callback(error, '', 0)
      return
    }

    if (typeof options === 'object' && options.all) {
      callback(null, eligible)
      return
    }

    const selected = eligible[0]!
    callback(null, selected.address, selected.family)
  }
}

export function requestPinned(
  url: URL,
  addresses: ResolvedAddress[],
  init: SafeFetchInit,
  transportOverride?: NodeRequestTransport,
): Promise<Response> {
  const transport: NodeRequestTransport = transportOverride
    ?? (url.protocol === 'https:' ? https.request : http.request)
  const pinnedLookup = createPinnedLookup(addresses)

  return new Promise<Response>((resolve, reject) => {
    const request = transport(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      agent: false,
      lookup: pinnedLookup,
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      incoming.on('error', reject)
      incoming.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item)
          } else if (value !== undefined) {
            headers.set(name, value)
          }
        }

        const status = incoming.statusCode ?? 500
        const body = init.method === 'HEAD' || status === 204 || status === 205 || status === 304
          ? null
          : Buffer.concat(chunks)
        resolve(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers,
        }))
      })
    })

    request.on('error', reject)
    request.end()
  })
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkTargetBlockedError(
      `network target is not allowed: redirect uses ${url.protocol}`,
    )
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function isPublicIpAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return !BLOCKED_IPV4.check(address, 'ipv4')
  return PUBLIC_IPV6.check(address, 'ipv6') && !BLOCKED_IPV6.check(address, 'ipv6')
}

function createBlockList(
  type: 'ipv4' | 'ipv6',
  subnets: ReadonlyArray<readonly [network: string, prefix: number]>,
): BlockList {
  const blockList = new BlockList()
  for (const [network, prefix] of subnets) {
    blockList.addSubnet(network, prefix, type)
  }
  return blockList
}

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

async function tryLlmsTxtFallback(
  originalUrl: string,
  originalParsed: URL,
  prompt: string | undefined,
  dependencies: SafeFetchDependencies,
): Promise<ToolResult | null> {
  const llmsTxtUrl = new URL('/llms.txt', originalParsed.origin)

  let llmsTxtRes: Response
  try {
    const result = await fetchWithNetworkBoundary(llmsTxtUrl.href, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: fetchHeaders(),
    }, dependencies)
    llmsTxtRes = result.response
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
      const result = await fetchWithNetworkBoundary(candidate.href, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: fetchHeaders(),
      }, dependencies)
      const candidateRes = result.response

      if (!candidateRes.ok) continue

      const contentType = candidateRes.headers.get('content-type') ?? ''
      const raw = await candidateRes.text()
      return renderFetchedContent({
        responseUrl: result.finalUrl,
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

export function createWebFetchTool(
  dependencies: SafeFetchDependencies = {},
): NativeToolDef<WebFetchInput> {
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
        const result = await fetchWithNetworkBoundary(url, {
          method,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: fetchHeaders(),
        }, dependencies)
        const res = result.response

        if (!res.ok) {
          if (res.status === 404 && method === 'GET') {
            const fallback = await tryLlmsTxtFallback(url, parsed, prompt, dependencies)
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
        return renderFetchedContent({ responseUrl: result.finalUrl, contentType, raw, prompt })
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
