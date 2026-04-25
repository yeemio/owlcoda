/**
 * Retry with exponential backoff for upstream requests.
 * Only retries on 5xx, timeout, or connection errors. Never retries 4xx.
 */

import { logWarn } from '../logger.js'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
  retryableStatuses?: number[]
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  timeoutMs: 60000,
  retryableStatuses: [500, 502, 503, 504, 529],
}

export { DEFAULT_OPTIONS as RETRY_DEFAULTS }

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return msg.includes('timeout') ||
           msg.includes('econnrefused') ||
           msg.includes('econnreset') ||
           msg.includes('enotfound') ||
           msg.includes('fetch failed') ||
           msg.includes('network') ||
           msg.includes('stream closed') ||
           err.name === 'AbortError'
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Add ±25% jitter to a delay value. */
function jitter(ms: number): number {
  const factor = 0.75 + Math.random() * 0.5 // 0.75 to 1.25
  return Math.round(ms * factor)
}

/**
 * Execute an async function with retry logic.
 * The function should return a Response object.
 * Supports per-request timeout via AbortSignal.
 */
export async function withRetry(
  fn: (signal?: AbortSignal) => Promise<Response>,
  options?: RetryOptions,
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: unknown = null

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = opts.timeoutMs > 0
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : null

    try {
      const response = await fn(controller.signal)
      if (timer) clearTimeout(timer)

      // Don't retry on success or client errors (4xx)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response
      }

      // Check if this status is retryable
      if (!opts.retryableStatuses.includes(response.status)) {
        return response
      }

      // Retryable server error
      lastError = new Error(`HTTP ${response.status}`)

      if (attempt < opts.maxRetries) {
        const delay = jitter(Math.min(
          opts.baseDelayMs * Math.pow(2, attempt),
          opts.maxDelayMs,
        ))
        logWarn('retry', `Attempt ${attempt + 1}/${opts.maxRetries} failed`, { status: response.status, delayMs: delay })
        await sleep(delay)
        continue
      }
      return response
    } catch (err) {
      if (timer) clearTimeout(timer)
      lastError = err

      // Map AbortError to timeout message
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${opts.timeoutMs}ms`)
      }

      if (!isRetryableError(err)) {
        throw err
      }

      if (attempt < opts.maxRetries) {
        const delay = jitter(Math.min(
          opts.baseDelayMs * Math.pow(2, attempt),
          opts.maxDelayMs,
        ))
        logWarn('retry', `Attempt ${attempt + 1}/${opts.maxRetries} failed`, { error: err instanceof Error ? err.message : 'unknown', delayMs: delay })
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('All retry attempts exhausted')
}
