/**
 * Request body validation for /v1/messages endpoint.
 * Returns structured validation result — never throws.
 */

export interface ValidatedMessagesBody {
  model: string
  messages: Array<{ role: string; content: unknown }>
  max_tokens: number
  stream?: boolean
  [key: string]: unknown
}

export type ValidationResult =
  | { valid: true; body: ValidatedMessagesBody }
  | { valid: false; error: string }

export function validateMessagesBody(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' }
  }

  const body = raw as Record<string, unknown>

  // model: required non-empty string
  if (!body.model || typeof body.model !== 'string') {
    return { valid: false, error: 'model: must be a non-empty string' }
  }

  // messages: required non-empty array
  if (!Array.isArray(body.messages)) {
    return { valid: false, error: 'messages: must be an array' }
  }
  if (body.messages.length === 0) {
    return { valid: false, error: 'messages: must be a non-empty array' }
  }

  // Each message must have role and content
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i]
    if (!msg || typeof msg !== 'object') {
      return { valid: false, error: `messages[${i}]: must be an object` }
    }
    const m = msg as Record<string, unknown>
    if (!m.role || typeof m.role !== 'string') {
      return { valid: false, error: `messages[${i}].role: must be a non-empty string` }
    }
    if (m.content === undefined || m.content === null) {
      return { valid: false, error: `messages[${i}].content: must be present` }
    }
  }

  // max_tokens: required positive integer
  if (body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0 || !Number.isFinite(body.max_tokens)) {
      return { valid: false, error: 'max_tokens: must be a positive number' }
    }
  }

  // stream: optional boolean
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { valid: false, error: 'stream: must be a boolean' }
  }

  return { valid: true, body: body as unknown as ValidatedMessagesBody }
}
