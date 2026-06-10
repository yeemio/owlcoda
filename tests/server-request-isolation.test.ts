/**
 * Tests for request-handler crash isolation (P1).
 *
 * server.ts wires `http.createServer((req,res) => handleRequest(...))` with no
 * outer guard. handleRequest is synchronous; a throw in its dispatch path
 * (parse / routing / requestId) escapes the callback → uncaughtException →
 * whole-daemon shutdown for ALL clients. dispatchRequestSafely isolates such a
 * throw to a 500 for that one request and keeps the daemon serving.
 *
 * NOTE: this is synthetic fault injection — it does NOT reproduce the original
 * production crash (which left no log; that is what P0 fixes). It proves the
 * structural property: a thrown request handler can no longer reach
 * uncaughtException.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { dispatchRequestSafely } from '../src/server.js'

function makeRes(headersSent = false): ServerResponse {
  return {
    headersSent,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse
}

describe('dispatchRequestSafely', () => {
  it('isolates a synchronous throw: 500s the request and does not rethrow', () => {
    const res = makeRes()
    const onError = vi.fn()
    expect(() =>
      dispatchRequestSafely(() => { throw new Error('boom') }, res, onError),
    ).not.toThrow()
    expect(onError).toHaveBeenCalledOnce()
    expect(res.writeHead as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ 'content-type': 'application/json' }),
    )
    const end = res.end as unknown as ReturnType<typeof vi.fn>
    expect(end).toHaveBeenCalledOnce()
    expect(String(end.mock.calls[0][0])).toContain('api_error')
  })

  it('does not re-send headers if the response already started', () => {
    const res = makeRes(true) // headersSent
    expect(() =>
      dispatchRequestSafely(() => { throw new Error('late') }, res, vi.fn()),
    ).not.toThrow()
    expect(res.writeHead as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(res.end as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
  })

  it('is transparent on the happy path (no throw → response untouched)', () => {
    const res = makeRes()
    const handler = vi.fn()
    dispatchRequestSafely(handler, res, vi.fn())
    expect(handler).toHaveBeenCalledOnce()
    expect(res.writeHead as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(res.end as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('never rethrows even if res.end itself throws (response already gone)', () => {
    const res = {
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(() => { throw new Error('socket gone') }),
    } as unknown as ServerResponse
    expect(() =>
      dispatchRequestSafely(() => { throw new Error('boom') }, res, vi.fn()),
    ).not.toThrow()
  })
})
