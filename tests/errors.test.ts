import { describe, it, expect } from 'vitest'
import { mapHttpStatusToAnthropicError, makeAnthropicError } from '../src/utils/errors.js'

describe('error mapping', () => {
  it('maps 400 to invalid_request_error', () => {
    const result = mapHttpStatusToAnthropicError(400, 'bad request')
    expect(result.httpStatus).toBe(400)
    expect(result.body.error.type).toBe('invalid_request_error')
  })

  it('maps 503 to overloaded_error with 529 status', () => {
    const result = mapHttpStatusToAnthropicError(503, 'backend down')
    expect(result.httpStatus).toBe(529)
    expect(result.body.error.type).toBe('overloaded_error')
  })

  it('maps 429 to rate_limit_error', () => {
    const result = mapHttpStatusToAnthropicError(429, 'too many requests')
    expect(result.httpStatus).toBe(429)
    expect(result.body.error.type).toBe('rate_limit_error')
  })

  it('extracts detail from JSON error body', () => {
    const result = mapHttpStatusToAnthropicError(502, '{"detail":"upstream failed"}')
    expect(result.body.error.message).toBe('upstream failed')
  })

  it('truncates long messages', () => {
    const longMsg = 'x'.repeat(1000)
    const result = mapHttpStatusToAnthropicError(500, longMsg)
    expect(result.body.error.message.length).toBeLessThanOrEqual(500)
  })

  it('makeAnthropicError creates correct structure', () => {
    const result = makeAnthropicError(400, 'invalid_request_error', 'test message')
    expect(result.httpStatus).toBe(400)
    expect(result.body.type).toBe('error')
    expect(result.body.error.type).toBe('invalid_request_error')
    expect(result.body.error.message).toBe('test message')
  })
})
