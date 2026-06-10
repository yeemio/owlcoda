/**
 * Request ID middleware — generates a UUID per request and attaches as header.
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

/**
 * Generate a new request ID and set it on the response.
 */
export function assignRequestId(res: ServerResponse): string {
  const id = randomUUID()
  res.setHeader('x-request-id', id)
  return id
}

/**
 * Structured log line with request ID.
 */
export function logWithId(requestId: string, level: string, message: string): void {
  const ts = new Date().toISOString()
  console.error(`[${ts}] [${requestId.slice(0, 8)}] [${level}] ${message}`)
}
