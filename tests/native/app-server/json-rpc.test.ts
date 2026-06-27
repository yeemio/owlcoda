import { describe, it, expect } from 'vitest'
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcError,
  parseJsonRpcRequest,
  JsonRpcError,
} from '../../../src/native/app-server/json-rpc.js'

describe('json-rpc types and validation', () => {
  it('accepts a valid request with positional params', () => {
    const req = {
      jsonrpc: '2.0',
      id: 1,
      method: 'diagnostic/health',
      params: [],
    }
    expect(isJsonRpcRequest(req)).toBe(true)
    expect(parseJsonRpcRequest(req)).toEqual(req)
  })

  it('accepts a valid request with named params', () => {
    const req = {
      jsonrpc: '2.0',
      id: 'abc',
      method: 'project/list',
      params: { limit: 10 },
    }
    expect(isJsonRpcRequest(req)).toBe(true)
    expect(parseJsonRpcRequest(req)).toEqual(req)
  })

  it('rejects request without jsonrpc field', () => {
    const req = { id: 1, method: 'diagnostic/health' }
    expect(isJsonRpcRequest(req)).toBe(false)
    expect(() => parseJsonRpcRequest(req)).toThrow('Invalid JSON-RPC request')
  })

  it('rejects request with wrong jsonrpc version', () => {
    const req = { jsonrpc: '1.0', id: 1, method: 'diagnostic/health' }
    expect(isJsonRpcRequest(req)).toBe(false)
  })

  it('rejects request without method field', () => {
    const req = { jsonrpc: '2.0', id: 1 }
    expect(isJsonRpcRequest(req)).toBe(false)
  })

  it('rejects request with non-string method', () => {
    const req = { jsonrpc: '2.0', id: 1, method: 123 }
    expect(isJsonRpcRequest(req)).toBe(false)
  })

  it('accepts notification (no id)', () => {
    const req = { jsonrpc: '2.0', method: 'event/subscribe', params: {} }
    expect(isJsonRpcRequest(req)).toBe(true)
  })

  it('validates a successful response', () => {
    const res = { jsonrpc: '2.0', id: 1, result: { status: 'ok' } }
    expect(isJsonRpcResponse(res)).toBe(true)
  })

  it('validates an error response', () => {
    const res = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    }
    expect(isJsonRpcError(res)).toBe(true)
  })

  it('rejects response missing result and error', () => {
    const res = { jsonrpc: '2.0', id: 1 }
    expect(isJsonRpcResponse(res)).toBe(false)
  })

  it('JsonRpcError serializes to standard shape', () => {
    const err = new JsonRpcError(-32600, 'Invalid Request', { detail: 'x' })
    expect(err.code).toBe(-32600)
    expect(err.message).toBe('Invalid Request')
    expect(err.data).toEqual({ detail: 'x' })
    expect(err.toJSON()).toEqual({
      code: -32600,
      message: 'Invalid Request',
      data: { detail: 'x' },
    })
  })
})
