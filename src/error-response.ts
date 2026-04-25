/**
 * Standardized error response builder.
 * Ensures all proxy error responses follow the Anthropic Messages API error format:
 * { type: "error", error: { type: "...", message: "..." } }
 */

import type { ServerResponse } from 'node:http'

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'

export interface AnthropicError {
  type: 'error'
  error: {
    type: ErrorType
    message: string
  }
}

/**
 * Map HTTP status codes to Anthropic error types.
 */
export function errorTypeForStatus(status: number): ErrorType {
  switch (status) {
    case 400: return 'invalid_request_error'
    case 401: return 'authentication_error'
    case 403: return 'permission_error'
    case 404: return 'not_found_error'
    case 429: return 'rate_limit_error'
    case 503: return 'overloaded_error'
    case 529: return 'overloaded_error'
    default: return 'api_error'
  }
}

/**
 * Build a standard Anthropic error response body.
 */
export function buildErrorBody(status: number, message: string, type?: ErrorType): AnthropicError {
  return {
    type: 'error',
    error: {
      type: type ?? errorTypeForStatus(status),
      message,
    },
  }
}

/**
 * Send a standard error response on a ServerResponse.
 */
export function sendError(res: ServerResponse, status: number, message: string, type?: ErrorType): void {
  const body = buildErrorBody(status, message, type)
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
  }
  res.end(JSON.stringify(body))
}

/**
 * Wrap an unknown error into a standard 500 response.
 */
export function sendInternalError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Internal server error'
  sendError(res, 500, message, 'api_error')
}
