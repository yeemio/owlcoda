import type { AnthropicErrorResponse } from '../types.js'

export function mapHttpStatusToAnthropicError(
  status: number,
  detail: string,
): { httpStatus: number; body: AnthropicErrorResponse } {
  let errorType: AnthropicErrorResponse['error']['type']
  let httpStatus: number

  if (status === 400 || status === 422) {
    errorType = 'invalid_request_error'
    httpStatus = 400
  } else if (status === 429) {
    errorType = 'rate_limit_error'
    httpStatus = 429
  } else if (status === 503) {
    errorType = 'overloaded_error'
    httpStatus = 529
  } else {
    errorType = 'api_error'
    httpStatus = 500
  }

  // Try to extract useful info from detail
  let message = detail
  try {
    const parsed = JSON.parse(detail)
    if (parsed.detail) message = parsed.detail
    else if (parsed.error) message = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
  } catch { /* keep original */ }

  return {
    httpStatus,
    body: { type: 'error', error: { type: errorType, message: message.slice(0, 500) } },
  }
}

export function makeAnthropicError(
  httpStatus: number,
  errorType: AnthropicErrorResponse['error']['type'],
  message: string,
): { httpStatus: number; body: AnthropicErrorResponse } {
  return {
    httpStatus,
    body: { type: 'error', error: { type: errorType, message } },
  }
}
