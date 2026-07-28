import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  createPinnedLookup,
  createWebFetchTool,
  extractLlmsTxtCandidateUrls,
  htmlToText,
  requestPinned,
  type PinnedRequest,
} from '../../src/native/tools/web-fetch.js'

const dnsLookupMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  lookup: dnsLookupMock,
}))

describe('htmlToText', () => {
  it('strips simple HTML tags', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })

  it('removes script and style blocks', () => {
    const html = '<p>text</p><script>alert(1)</script><style>body{}</style><p>more</p>'
    const result = htmlToText(html)
    expect(result).toContain('text')
    expect(result).toContain('more')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('body{}')
  })

  it('decodes HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'')
  })

  it('converts block elements to newlines', () => {
    const html = '<p>first</p><p>second</p>'
    const result = htmlToText(html)
    expect(result).toContain('first')
    expect(result).toContain('second')
    expect(result.split('\n').length).toBeGreaterThanOrEqual(2)
  })

  it('handles <br> tags', () => {
    const html = 'line1<br/>line2<br>line3'
    const result = htmlToText(html)
    expect(result).toContain('line1')
    expect(result).toContain('line2')
    expect(result).toContain('line3')
  })

  it('collapses excess whitespace', () => {
    const html = '  lots   of    spaces  '
    expect(htmlToText(html)).toBe('lots of spaces')
  })

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('&#65;&#66;&#67;')).toBe('ABC')
  })
})

describe('createWebFetchTool', () => {
  const requestThroughFetch: PinnedRequest = (url, _addresses, init) => fetch(url.href, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    redirect: 'manual',
  })
  const tool = createWebFetchTool({ request: requestThroughFetch })

  beforeEach(() => {
    dnsLookupMock.mockReset()
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('WebFetch')
    expect(tool.description).toContain('Fetch')
  })

  it('rejects empty url', async () => {
    const result = await tool.execute({ url: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('url is required')
  })

  it('rejects invalid url', async () => {
    const result = await tool.execute({ url: 'not-a-url' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('invalid URL')
  })

  it('rejects non-HTTP protocols', async () => {
    const result = await tool.execute({ url: 'ftp://example.com/file' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('HTTP/HTTPS')
  })

  it('rejects unsupported HTTP methods', async () => {
    const result = await tool.execute({ url: 'http://127.0.0.1:3000/health', method: 'POST' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('GET and HEAD')
  })

  it.each([
    'http://127.0.0.1:3000/health',
    'http://10.23.45.67/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/health',
    'http://[2001::1]/teredo',
    'http://[2620:4f:8000::1]/special-purpose',
  ])('rejects direct private or link-local target %s before fetch', async url => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('internal secret'))

    const result = await tool.execute({ url })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('network target is not allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a hostname when any DNS answer is private', async () => {
    dnsLookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.23.45.67', family: 4 },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('internal secret'))

    const result = await tool.execute({ url: 'https://metadata.example.test/latest' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('network target is not allowed')
    expect(dnsLookupMock).toHaveBeenCalledWith('metadata.example.test', expect.objectContaining({ all: true }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a hostname when DNS returns an IPv6 special-purpose address', async () => {
    dnsLookupMock.mockResolvedValue([
      { address: '2001:3::1', family: 6 },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('special-purpose target'))

    const result = await tool.execute({ url: 'https://special.example.test/' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('network target is not allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates a redirect target before following it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.redirect === 'follow') {
        return new Response('instance credentials', { status: 200 })
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      })
    })

    const result = await tool.execute({ url: 'https://public.example.test/redirect' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('network target is not allowed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fetch a private llms.txt candidate', async () => {
    const candidateUrl = 'http://169.254.169.254/guides/install.md'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const requested = String(input)
      if (requested === 'https://docs.example.com/guides/install') {
        return new Response('missing', { status: 404, statusText: 'Not Found' })
      }
      if (requested === 'https://docs.example.com/llms.txt') {
        return new Response(`- [Install guide](${candidateUrl})`, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      if (requested === candidateUrl) {
        return new Response('instance credentials', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        })
      }
      throw new Error(`unexpected fetch ${requested}`)
    })

    const result = await tool.execute({ url: 'https://docs.example.com/guides/install' })

    expect(result.isError).toBe(true)
    expect(result.output).toBe('Error: HTTP 404 Not Found fetching https://docs.example.com/guides/install')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalledWith(candidateUrl, expect.anything())
  })

  it('passes HEAD through to fetch without reading a response body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    const result = await tool.execute({ url: 'https://public.example.test/health', method: 'HEAD' })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Length: 0 chars')
    expect(fetchMock).toHaveBeenCalledWith('https://public.example.test/health', expect.objectContaining({
      method: 'HEAD',
    }))
  })

  it('falls back to llms.txt markdown candidates when a docs URL returns 404', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const requested = String(input)
      if (requested === 'https://docs.example.com/guides/install') {
        return new Response('missing', { status: 404, statusText: 'Not Found' })
      }
      if (requested === 'https://docs.example.com/llms.txt') {
        return new Response(
          [
            '# Docs',
            '- [API reference](https://docs.example.com/reference/api.md)',
            '- [Install guide](https://docs.example.com/install.md)',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/plain' } },
        )
      }
      if (requested === 'https://docs.example.com/install.md') {
        return new Response('# Install\n\nUse the package manager.', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        })
      }
      throw new Error(`unexpected fetch ${requested}`)
    })

    const result = await tool.execute({ url: 'https://docs.example.com/guides/install', prompt: 'summarize' })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('URL: https://docs.example.com/install.md')
    expect(result.output).toContain('Original-URL: https://docs.example.com/guides/install')
    expect(result.output).toContain('Fallback: https://docs.example.com/llms.txt')
    expect(result.output).toContain('Use the package manager.')
    expect(result.metadata).toMatchObject({
      url: 'https://docs.example.com/install.md',
      originalUrl: 'https://docs.example.com/guides/install',
      llmsTxtFallback: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('preserves the original 404 when llms.txt has no matching candidate', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const requested = String(input)
      if (requested === 'https://docs.example.com/guides/install') {
        return new Response('missing', { status: 404, statusText: 'Not Found' })
      }
      if (requested === 'https://docs.example.com/llms.txt') {
        return new Response('- [Billing](https://docs.example.com/billing.md)', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      throw new Error(`unexpected fetch ${requested}`)
    })

    const result = await tool.execute({ url: 'https://docs.example.com/guides/install' })

    expect(result.isError).toBe(true)
    expect(result.output).toBe('Error: HTTP 404 Not Found fetching https://docs.example.com/guides/install')
  })

  it('preserves the original 404 when a matching llms.txt candidate also fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const requested = String(input)
      if (requested === 'https://docs.example.com/guides/install') {
        return new Response('missing', { status: 404, statusText: 'Not Found' })
      }
      if (requested === 'https://docs.example.com/llms.txt') {
        return new Response('- [Install guide](/install.md)', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      if (requested === 'https://docs.example.com/install.md') {
        return new Response('missing markdown', { status: 404, statusText: 'Not Found' })
      }
      throw new Error(`unexpected fetch ${requested}`)
    })

    const result = await tool.execute({ url: 'https://docs.example.com/guides/install' })

    expect(result.isError).toBe(true)
    expect(result.output).toBe('Error: HTTP 404 Not Found fetching https://docs.example.com/guides/install')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('marks HTTP 403 as a recoverable fetch block with response evidence and alternate capture hints', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Cloudflare says no', {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'text/html' },
    }))

    const result = await tool.execute({ url: 'https://docs.example.com/protected' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('HTTP 403 Forbidden')
    expect(result.output).toContain('recoverable fetch block')
    expect(result.output).toContain('BrowserJob')
    expect(result.output).toContain('Cloudflare says no')
    expect(result.metadata).toMatchObject({
      failureCategory: 'remote:blocked_source',
      httpStatus: 403,
      recoverable: true,
      blockedSource: true,
      blockedSourceKind: 'http_403',
      responseBodySnippet: 'Cloudflare says no',
    })
  })
})

describe('extractLlmsTxtCandidateUrls', () => {
  it('extracts markdown links, absolute URLs, and relative md paths', () => {
    const candidates = extractLlmsTxtCandidateUrls(
      [
        '- [Install](https://docs.example.com/install.md)',
        '- [Guide](/guide/intro.mdx)',
        'See ./reference/api.md for API details.',
        'Ignore https://docs.example.com/app',
      ].join('\n'),
      new URL('https://docs.example.com/llms.txt'),
    ).map(url => url.href)

    expect(candidates).toEqual([
      'https://docs.example.com/install.md',
      'https://docs.example.com/guide/intro.mdx',
      'https://docs.example.com/reference/api.md',
    ])
  })
})

describe('production DNS pinning', () => {
  it('returns only addresses admitted by the network-boundary resolution', async () => {
    const lookup = createPinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])

    const ipv4 = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup('rebound.example.test', { family: 4 }, (error, address, family) => {
        if (error) reject(error)
        else resolve({ address: String(address), family: Number(family) })
      })
    })
    const all = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookup('rebound.example.test', { all: true }, (error, addresses) => {
        if (error) reject(error)
        else resolve(addresses as Array<{ address: string; family: number }>)
      })
    })

    expect(ipv4).toEqual({ address: '93.184.216.34', family: 4 })
    expect(all).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])
    expect(dnsLookupMock).not.toHaveBeenCalled()
  })

  it('installs the vetted lookup on the production request before any network write', async () => {
    let capturedOptions: RequestOptions | undefined
    const transport = (
      _url: URL,
      options: RequestOptions,
      _onResponse: (incoming: IncomingMessage) => void,
    ): ClientRequest => {
      capturedOptions = options
      const request = new EventEmitter() as ClientRequest
      request.end = (() => {
        queueMicrotask(() => request.emit('error', new Error('deterministic transport stop')))
        return request
      }) as ClientRequest['end']
      return request
    }

    await expect(requestPinned(
      new URL('https://rebound.example.test/path'),
      [{ address: '93.184.216.34', family: 4 }],
      {
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
      },
      transport,
    )).rejects.toThrow('deterministic transport stop')

    expect(capturedOptions?.lookup).toBeTypeOf('function')
    const selected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      capturedOptions!.lookup!('rebound.example.test', { family: 4 }, (error, address, family) => {
        if (error) reject(error)
        else resolve({ address: String(address), family: Number(family) })
      })
    })
    expect(selected).toEqual({ address: '93.184.216.34', family: 4 })
    expect(dnsLookupMock).not.toHaveBeenCalled()
  })
})
