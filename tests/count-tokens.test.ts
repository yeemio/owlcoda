/**
 * Count-tokens endpoint tests — token estimation logic.
 */
import { describe, it, expect } from 'vitest'
import { handleCountTokens } from '../src/endpoints/count-tokens.js'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'

interface MockResponse {
  statusCode: number
  body: string
}

function createMockRes(): { res: ServerResponse; getResult: () => MockResponse } {
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

  return {
    res,
    getResult: () => ({ statusCode, body }),
  }
}

function createMockReq(body: string): IncomingMessage {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  // Simulate readable stream with body data
  const readable = new Readable({
    read() {
      this.push(body)
      this.push(null)
    },
  })
  req.on = readable.on.bind(readable) as any
  return req
}

function makeConfig() {
  return {
    models: [],
    routerUrl: 'http://localhost:11435/v1',
  } as any
}

describe('handleCountTokens', () => {
  it('estimates tokens for simple text message', async () => {
    // "Hello world" = 11 chars → ceil(11/4) = 3
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'Hello world' }],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const result = getResult()
    expect(result.statusCode).toBe(200)
    const parsed = JSON.parse(result.body)
    expect(parsed.input_tokens).toBe(3)
  })

  it('counts string system prompt', async () => {
    // system "abc" (3) + message "de" (2) = 5 chars → ceil(5/4) = 2
    const body = JSON.stringify({
      system: 'abc',
      messages: [{ role: 'user', content: 'de' }],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    expect(parsed.input_tokens).toBe(2)
  })

  it('counts array system prompt', async () => {
    // system [text "hello"] (5) + message "a" (1) = 6 chars → ceil(6/4) = 2
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'hello' }],
      messages: [{ role: 'user', content: 'a' }],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    expect(parsed.input_tokens).toBe(2)
  })

  it('counts tools JSON', async () => {
    const tools = [{ name: 'search', input_schema: { type: 'object' } }]
    const toolsStr = JSON.stringify(tools) // ~50 chars
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'x' }],
      tools,
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    // 1 char from message + tools length → > 1
    expect(parsed.input_tokens).toBeGreaterThan(1)
  })

  it('counts tool_result content in messages', async () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'result text here' },
        ]},
      ],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    // "result text here" = 16 chars → ceil(16/4) = 4
    expect(parsed.input_tokens).toBe(4)
  })

  it('returns minimum 1 token for very short content', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'a' }],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    expect(parsed.input_tokens).toBe(1)
  })

  it('returns error for invalid JSON', async () => {
    const req = createMockReq('not json')
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const result = getResult()
    expect(result.statusCode).toBe(400)
    const parsed = JSON.parse(result.body)
    expect(parsed.error.type).toBe('invalid_request_error')
  })

  it('handles empty messages array', async () => {
    const body = JSON.stringify({
      messages: [],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    // No content → 0 chars → max(1, 0) = 1
    expect(parsed.input_tokens).toBe(1)
  })

  it('handles array content blocks with text', async () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ]},
      ],
    })
    const req = createMockReq(body)
    const { res, getResult } = createMockRes()
    await handleCountTokens(req, res, makeConfig())
    const parsed = JSON.parse(getResult().body)
    // "hello" + "world" = 10 chars → ceil(10/4) = 3
    expect(parsed.input_tokens).toBe(3)
  })
})
