export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown[] | Record<string, unknown>
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: T
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcErrorObject
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse

export class JsonRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }

  toJSON(): JsonRpcErrorObject {
    const base: JsonRpcErrorObject = {
      code: this.code,
      message: this.message,
    }
    if (this.data !== undefined) base.data = this.data
    return base
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false
  if (value['jsonrpc'] !== '2.0') return false
  if (typeof value['method'] !== 'string' || value['method'].length === 0) return false
  if ('id' in value && !isJsonRpcId(value['id'])) return false
  if ('params' in value && !isJsonRpcParams(value['params'])) return false
  return true
}

export function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isJsonRpcRequest(value)) {
    throw new JsonRpcError(-32600, 'Invalid JSON-RPC request')
  }
  return value
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value)) return false
  if (value['jsonrpc'] !== '2.0') return false
  if (!('id' in value) || !isJsonRpcId(value['id'])) return false
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error')
  if (hasResult === hasError) return false
  if (hasError) return isJsonRpcError(value)
  return true
}

export function isJsonRpcError(value: unknown): value is JsonRpcErrorResponse {
  if (!isRecord(value)) return false
  if (value['jsonrpc'] !== '2.0') return false
  if (!('id' in value) || !isJsonRpcId(value['id'])) return false
  if (!isRecord(value['error'])) return false
  const error = value['error']
  return typeof error['code'] === 'number' && typeof error['message'] === 'string'
}

export function createJsonRpcSuccess<T>(id: JsonRpcId | undefined, result: T): JsonRpcSuccessResponse<T> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  }
}

export function createJsonRpcFailure(id: JsonRpcId | undefined, error: JsonRpcError): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: error.toJSON(),
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function isJsonRpcParams(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) || isRecord(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
