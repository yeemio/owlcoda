/**
 * Search route unit tests — validation, response shape, error handling.
 * Tests handleSearch in isolation using mock req/res (no real HTTP server needed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleSearch } from '../src/routes/search.js'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'

function makeConfig(routerUrl = 'http://localhost:11435/v1') {
  return {
    models: [],
    routerUrl,
  } as any
}

interface MockResult { statusCode: number; body: string }

function createMockRes(): { res: ServerResponse; getResult: () => MockResult } {
  const socket = new Socket()
  const res = new ServerResponse(new IncomingMessage(socket))
  let body = ''
  let statusCode = 200

  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = function (code: number, ...args: any[]) {
    statusCode = code
    return origWriteHead(code, ...args)
  } as any

  const origEnd = res.end.bind(res)
  res.end = function (data?: any) {
    if (data) body = typeof data === 'string' ? data : data.toString()
    return origEnd(data)
  } as any

  // setHeader needed for CORS
  res.setHeader = function () { return res } as any

  return { res, getResult: () => ({ statusCode, body }) }
}

function createMockReq(body: string): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  const readable = new Readable({
    read() { this.push(body); this.push(null) },
  })
  req.on = readable.on.bind(readable) as any
  req.headers = { 'content-type': 'application/json' }
  return req
}

describe('search route validation', () => {
  it('rejects invalid JSON body', async () => {
    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq('not json'), res, makeConfig())
    expect(getResult().statusCode).toBe(400)
    expect(getResult().body).toContain('Invalid JSON')
  })

  it('rejects missing query', async () => {
    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({})), res, makeConfig())
    expect(getResult().statusCode).toBe(400)
    expect(getResult().body).toContain('query')
  })

  it('rejects empty query string', async () => {
    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: '  ' })), res, makeConfig())
    expect(getResult().statusCode).toBe(400)
  })

  it('rejects negative max_results', async () => {
    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test', max_results: -1 })), res, makeConfig())
    expect(getResult().statusCode).toBe(400)
    expect(getResult().body).toContain('max_results')
  })

  it('rejects non-numeric max_results', async () => {
    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test', max_results: 'abc' })), res, makeConfig())
    expect(getResult().statusCode).toBe(400)
  })
})

describe('search route router interaction', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns results from router', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      query: 'test',
      provider: 'duckduckgo_html',
      results: [{ title: 'Result 1', url: 'https://example.com' }],
      result_count: 1,
    }), { status: 200 }))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test' })), res, makeConfig())
    const result = getResult()
    expect(result.statusCode).toBe(200)
    const parsed = JSON.parse(result.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].snippet).toBe('') // normalized
  })

  it('handles router 500', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Error', { status: 500 }))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test' })), res, makeConfig())
    expect(getResult().statusCode).toBe(502)
  })

  it('handles router unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test' })), res, makeConfig())
    expect(getResult().statusCode).toBe(503)
    expect(getResult().body).toContain('unavailable')
  })

  it('handles upstream failure (ok=false)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error: { message: 'rate limited', type: 'rate_limit' },
    }), { status: 200 }))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test' })), res, makeConfig())
    expect(getResult().statusCode).toBe(503)
    expect(getResult().body).toContain('rate limited')
  })

  it('clamps max_results to 10', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true, query: 'test', provider: 'duckduckgo_html',
      results: [], result_count: 0,
    }), { status: 200 }))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test', max_results: 50 })), res, makeConfig())
    expect(getResult().statusCode).toBe(200)
    // Verify the fetch URL has max_results=10
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const fetchUrl = fetchSpy.mock.calls[0][0] as string
    expect(fetchUrl).toContain('max_results=10')
  })

  it('defaults max_results to 5', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true, query: 'test', provider: 'duckduckgo_html',
      results: [], result_count: 0,
    }), { status: 200 }))

    const { res, getResult } = createMockRes()
    await handleSearch(createMockReq(JSON.stringify({ query: 'test' })), res, makeConfig())
    expect(getResult().statusCode).toBe(200)
    const fetchUrl = fetchSpy.mock.calls[0][0] as string
    expect(fetchUrl).toContain('max_results=5')
  })
})
