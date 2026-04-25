import { describe, it, expect } from 'vitest'
import { buildErrorBody, errorTypeForStatus, sendError } from '../src/error-response.js'
import { PassThrough } from 'node:stream'

function mockRes() {
  const res = new PassThrough() as any
  res.headersSent = false
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res._status = status
    res._headers = headers
    res.headersSent = true
  }
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  res.getBody = () => Buffer.concat(chunks).toString()
  return res
}

describe('error-response', () => {
  it('maps 400 to invalid_request_error', () => {
    expect(errorTypeForStatus(400)).toBe('invalid_request_error')
  })

  it('maps 401 to authentication_error', () => {
    expect(errorTypeForStatus(401)).toBe('authentication_error')
  })

  it('maps 429 to rate_limit_error', () => {
    expect(errorTypeForStatus(429)).toBe('rate_limit_error')
  })

  it('maps 503 to overloaded_error', () => {
    expect(errorTypeForStatus(503)).toBe('overloaded_error')
  })

  it('maps unknown status to api_error', () => {
    expect(errorTypeForStatus(418)).toBe('api_error')
  })

  it('buildErrorBody returns correct structure', () => {
    const body = buildErrorBody(400, 'bad input')
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toBe('bad input')
  })

  it('buildErrorBody allows custom type', () => {
    const body = buildErrorBody(500, 'overloaded', 'overloaded_error')
    expect(body.error.type).toBe('overloaded_error')
  })

  it('sendError writes correct response', () => {
    const res = mockRes()
    sendError(res, 404, 'model not found')
    const body = JSON.parse(res.getBody())
    expect(res._status).toBe(404)
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('not_found_error')
    expect(body.error.message).toBe('model not found')
  })

  it('sendError skips writeHead if headers already sent', () => {
    const res = mockRes()
    res.headersSent = true
    res.writeHead = () => { throw new Error('should not call') }
    sendError(res, 500, 'fail')
    const body = JSON.parse(res.getBody())
    expect(body.error.message).toBe('fail')
  })
})
