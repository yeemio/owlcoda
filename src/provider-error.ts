import { normalizeProviderKind } from './provider-kind.js'

export type ProviderFailureKind =
  | 'dns_error'
  | 'connect_error'
  | 'tls_error'
  | 'timeout'
  | 'abort'
  | 'http_4xx'
  | 'http_5xx'
  /** Stream closed BEFORE the provider sent any token — typical "half-stop"
   *  failure in continuation / tool-result follow-up turns. Caller should
   *  surface it as a continuation failure, not a no-response. */
  | 'stream_interrupted_before_first_token'
  /** Stream closed AFTER some content had already streamed. Partial output
   *  may still be worth keeping; this is generally retryable for the
   *  remainder. */
  | 'stream_interrupted'
  | 'unknown_fetch_error'

export interface ProviderRequestDiagnostic {
  provider: string
  model: string
  kind: ProviderFailureKind
  message: string
  status?: number
  requestId?: string
  retryable: boolean
  detail: string
  rawCauseCode?: string
  errno?: string | number
  syscall?: string
  upstreamRequestId?: string
}

export interface ProviderDiagnosticContext {
  provider?: string
  model?: string
  endpointUrl?: string
  headers?: Record<string, string>
  requestId?: string
  status?: number
  detail?: string
  retryable?: boolean
  upstreamRequestId?: string
}

export class ProviderRequestError extends Error {
  readonly diagnostic: ProviderRequestDiagnostic

  constructor(diagnostic: ProviderRequestDiagnostic) {
    super(formatProviderDiagnostic(diagnostic, { includeRequestId: true }))
    this.name = 'ProviderRequestError'
    this.diagnostic = diagnostic
  }
}

type ErrorFrame = {
  name?: string
  message?: string
  code?: string
  errno?: string | number
  syscall?: string
  cause?: unknown
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH'])
const TLS_CODES = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL',
  'ERR_TLS',
  'CERT_',
]

export function inferProviderName(context: Pick<ProviderDiagnosticContext, 'provider' | 'endpointUrl' | 'headers'>): string {
  if (context.provider) return context.provider
  if (!context.endpointUrl) return 'router'
  if (isLocalEndpoint(context.endpointUrl)) return 'router'
  return normalizeProviderKind({
    endpoint: context.endpointUrl,
    headers: context.headers,
  })
}

export function createProviderHttpDiagnostic(
  status: number,
  rawDetail: string,
  context: ProviderDiagnosticContext = {},
): ProviderRequestDiagnostic {
  const provider = inferProviderName(context)
  const model = context.model ?? 'unknown-model'
  const detail = summarizeDetail(rawDetail)
  const requestId = context.requestId
  const upstreamRequestId = context.upstreamRequestId
  const kind: ProviderFailureKind = status >= 500 ? 'http_5xx' : 'http_4xx'
  const retryable = context.retryable ?? (status === 429 || status >= 500)

  return {
    provider,
    model,
    kind,
    message: `${model} request failed: upstream ${status} from provider`,
    status,
    requestId,
    retryable,
    detail,
    upstreamRequestId,
  }
}

export function createStreamInterruptedDiagnostic(
  context: ProviderDiagnosticContext = {},
  options: { beforeFirstToken?: boolean; detail?: string } = {},
): ProviderRequestDiagnostic {
  const provider = inferProviderName(context)
  const model = context.model ?? 'unknown-model'
  const beforeFirst = options.beforeFirstToken === true
  const kind: ProviderFailureKind = beforeFirst
    ? 'stream_interrupted_before_first_token'
    : 'stream_interrupted'
  // Use the verbatim stream detail only when we're keeping the kind generic.
  // For the pre-first-token case we emit a stable short phrase that the UI
  // layer expands with continuation context (tool-success vs plain continue).
  const detail = beforeFirst
    ? 'stream closed before first token'
    : (options.detail?.trim() || 'stream closed before completion')
  return {
    provider,
    model,
    kind,
    message: `${model} request failed: ${detail}`,
    status: context.status ?? 502,
    requestId: context.requestId,
    retryable: true,
    detail,
    upstreamRequestId: context.upstreamRequestId,
  }
}

export function classifyProviderRequestError(
  error: unknown,
  context: ProviderDiagnosticContext = {},
): ProviderRequestDiagnostic {
  if (error instanceof ProviderRequestError) {
    return {
      ...error.diagnostic,
      requestId: error.diagnostic.requestId ?? context.requestId,
    }
  }

  const frames = flattenErrorFrames(error)
  const top = frames[0] ?? {}
  const message = top.message ?? String(error)
  const code = firstString(frames, 'code')
  const errno = firstValue(frames, 'errno')
  const syscall = firstString(frames, 'syscall')
  const provider = inferProviderName(context)
  const model = context.model ?? 'unknown-model'
  const requestId = context.requestId
  const upstreamRequestId = context.upstreamRequestId
  const host = safeHost(context.endpointUrl) ?? hostFromMessage(message)

  if (top.name === 'TimeoutError' || /\bETIMEDOUT\b/i.test(message) || /\btimed out\b/i.test(message)) {
    const timeoutDetail = timeoutDetailFromMessage(message) ?? context.detail ?? 'timeout'
    return {
      provider,
      model,
      kind: 'timeout',
      message: `${model} request failed: ${timeoutDetail}`,
      status: context.status ?? 504,
      requestId,
      retryable: true,
      detail: timeoutDetail,
      rawCauseCode: code,
      errno,
      syscall,
      upstreamRequestId,
    }
  }

  if (top.name === 'AbortError' || message === 'This operation was aborted' || message === 'Request aborted') {
    const abortDetail = context.detail ?? 'request aborted before completion'
    return {
      provider,
      model,
      kind: 'unknown_fetch_error',
      message: `${model} request failed: ${abortDetail}`,
      status: context.status ?? 502,
      requestId,
      retryable: true,
      detail: abortDetail,
      rawCauseCode: code,
      errno,
      syscall,
      upstreamRequestId,
    }
  }

  if (top.name === 'StreamInterruptedError' || /\bstream closed\b/i.test(message)) {
    return createStreamInterruptedDiagnostic(context, {
      beforeFirstToken: /before first token/i.test(message),
      detail: message,
    })
  }

  if ((code && DNS_CODES.has(code)) || /getaddrinfo|dns|lookup failed|name or service not known/i.test(message)) {
    const hostDetail = host ? `DNS lookup failed for ${host}` : 'DNS lookup failed'
    return {
      provider,
      model,
      kind: 'dns_error',
      message: `${model} request failed: ${hostDetail}`,
      status: context.status ?? 502,
      requestId,
      retryable: true,
      detail: hostDetail,
      rawCauseCode: code,
      errno,
      syscall,
      upstreamRequestId,
    }
  }

  if (isTlsFailure(code, message)) {
    const tlsDetail = host ? `TLS handshake failed for ${host}` : 'TLS handshake failed'
    return {
      provider,
      model,
      kind: 'tls_error',
      message: `${model} request failed: ${tlsDetail}`,
      status: context.status ?? 502,
      requestId,
      retryable: false,
      detail: tlsDetail,
      rawCauseCode: code,
      errno,
      syscall,
      upstreamRequestId,
    }
  }

  if ((code && CONNECT_CODES.has(code)) || syscall === 'connect' || /socket|connect|econnrefused|econnreset/i.test(message)) {
    const connectDetail = host ? `unable to connect to ${host}` : 'unable to connect to upstream'
    return {
      provider,
      model,
      kind: 'connect_error',
      message: `${model} request failed: ${connectDetail}`,
      status: context.status ?? 502,
      requestId,
      retryable: true,
      detail: connectDetail,
      rawCauseCode: code,
      errno,
      syscall,
      upstreamRequestId,
    }
  }

  return {
    provider,
    model,
    kind: 'unknown_fetch_error',
    message: `${model} request failed: ${unknownDetail(message)}`,
    status: context.status,
    requestId,
    retryable: context.retryable ?? false,
    detail: unknownDetail(message),
    rawCauseCode: code,
    errno,
    syscall,
    upstreamRequestId,
  }
}

export function diagnosticToAnthropicError(
  diagnostic: ProviderRequestDiagnostic,
): {
  httpStatus: number
  body: {
    type: 'error'
    error: {
      type: 'invalid_request_error' | 'api_error' | 'overloaded_error' | 'rate_limit_error' | 'not_found_error'
      message: string
      diagnostic: ProviderRequestDiagnostic
    }
  }
} {
  const httpStatus = diagnostic.status ?? defaultStatusForKind(diagnostic.kind)
  const errorType = mapDiagnosticToAnthropicType(httpStatus)
  return {
    httpStatus,
    body: {
      type: 'error',
      error: {
        type: errorType,
        message: diagnostic.message,
        diagnostic,
      },
    },
  }
}

export function formatProviderDiagnostic(
  diagnostic: ProviderRequestDiagnostic,
  options: { includeRequestId?: boolean } = {},
): string {
  const base = diagnostic.message || `${diagnostic.model} request failed`
  if (options.includeRequestId) {
    if (diagnostic.requestId) {
      return `${base} (request ${diagnostic.requestId})`
    }
    if (diagnostic.upstreamRequestId) {
      return `${base} (upstream request ${diagnostic.upstreamRequestId})`
    }
  }
  return base
}

/**
 * Continuation context for stream-interrupted-before-first-token failures.
 * Captures whether the preceding turn had tool results (the "tool completed
 * but model continuation failed" case) vs a plain user continue prompt.
 */
export type ContinuationContext = 'tool-success' | 'user-continue' | 'none'

/**
 * Single-line user-facing sentence for a provider failure, contextualised
 * with continuation semantics. Exists so every call site — REPL transcript,
 * slash output, agent tool — emits identical phrasing for the same failure
 * class, with no duplicate trailing "(No response from …) · No tokens
 * reported" tail that used to slip in from the REPL fallback path.
 */
export function formatContinuationFailure(
  diagnostic: ProviderRequestDiagnostic,
  continuation: ContinuationContext = 'none',
  options: { includeRequestId?: boolean } = {},
): string {
  const { model } = diagnostic
  const requestId = options.includeRequestId
    ? (diagnostic.requestId || diagnostic.upstreamRequestId)
    : undefined
  const requestTag = requestId
    ? ` (request ${requestId})`
    : ''

  // Pre-first-token is the load-bearing case — that's why this helper exists.
  if (diagnostic.kind === 'stream_interrupted_before_first_token') {
    if (continuation === 'tool-success') {
      return `Tool completed, but model continuation failed before first token; no response content was produced. Use /retry to resume or /model to switch.${requestTag}`
    }
    if (continuation === 'user-continue') {
      return `${model} continuation failed: stream closed before first token; no response content was produced. Context is intact — use /retry to resume or /model to switch.${requestTag}`
    }
    return `${model} request failed: stream closed before first token; no response content was produced. Use /retry or /model to switch.${requestTag}`
  }

  // Post-first-token stream interruptions keep partial intent language.
  if (diagnostic.kind === 'stream_interrupted') {
    return `${model} request failed: stream closed before completion (partial response may be visible above). Use /retry or /model to switch.${requestTag}`
  }

  // All other kinds — delegate to the plain formatter so this helper stays
  // a thin continuation-specific overlay.
  return formatProviderDiagnostic(diagnostic, { includeRequestId: true })
}

export function parseProviderDiagnosticFromPayload(payload: unknown): ProviderRequestDiagnostic | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const nested = record['error']
  if (nested && typeof nested === 'object') {
    const diagnostic = (nested as Record<string, unknown>)['diagnostic']
    if (isProviderDiagnostic(diagnostic)) return diagnostic
  }
  if (isProviderDiagnostic(record['diagnostic'])) return record['diagnostic']
  return null
}

export function parseProviderDiagnosticFromString(raw: string): ProviderRequestDiagnostic | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const direct = tryParseJson(trimmed)
  if (direct) return parseProviderDiagnosticFromPayload(direct)

  const apiMatch = trimmed.match(/^API error \d+:\s*(.+)$/s)
  if (apiMatch?.[1]) {
    const parsed = tryParseJson(apiMatch[1].trim())
    if (parsed) return parseProviderDiagnosticFromPayload(parsed)
  }

  return null
}

export function upstreamRequestIdFromHeaders(headers: Headers | undefined): string | undefined {
  if (!headers) return undefined
  return headers.get('x-request-id')
    ?? headers.get('request-id')
    ?? headers.get('anthropic-request-id')
    ?? headers.get('x-amzn-requestid')
    ?? headers.get('cf-ray')
    ?? undefined
}

function flattenErrorFrames(error: unknown): ErrorFrame[] {
  const frames: ErrorFrame[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== 'object') break
    const frame = current as ErrorFrame
    frames.push(frame)
    current = frame.cause
  }
  if (frames.length === 0) {
    frames.push({ message: String(error) })
  }
  return frames
}

function firstString(frames: ErrorFrame[], key: 'code' | 'syscall'): string | undefined {
  for (const frame of frames) {
    const value = frame[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function firstValue(frames: ErrorFrame[], key: 'errno'): string | number | undefined {
  for (const frame of frames) {
    const value = frame[key]
    if ((typeof value === 'string' || typeof value === 'number') && value !== '') return value
  }
  return undefined
}

function defaultStatusForKind(kind: ProviderFailureKind): number {
  switch (kind) {
    case 'timeout':
      return 504
    case 'abort':
      return 499
    case 'http_4xx':
      return 400
    case 'http_5xx':
    case 'dns_error':
    case 'connect_error':
    case 'tls_error':
    case 'stream_interrupted':
    case 'stream_interrupted_before_first_token':
    case 'unknown_fetch_error':
      return 502
  }
}

function mapDiagnosticToAnthropicType(
  httpStatus: number,
): 'invalid_request_error' | 'api_error' | 'overloaded_error' | 'rate_limit_error' | 'not_found_error' {
  if (httpStatus === 404) return 'not_found_error'
  if (httpStatus === 429) return 'rate_limit_error'
  if (httpStatus === 400 || httpStatus === 422) return 'invalid_request_error'
  if (httpStatus === 503 || httpStatus === 529) return 'overloaded_error'
  return 'api_error'
}

function summarizeDetail(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return ''
  const parsed = tryParseJson(trimmed)
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    const nestedError = record['error']
    if (nestedError && typeof nestedError === 'object') {
      const msg = (nestedError as Record<string, unknown>)['message']
      if (typeof msg === 'string' && msg.trim()) return truncate(msg.trim())
      return truncate(JSON.stringify(nestedError))
    }
    if (typeof record['message'] === 'string' && record['message'].trim()) {
      return truncate(record['message'].trim())
    }
  }
  return truncate(trimmed.replace(/\s+/g, ' '))
}

function unknownDetail(detail: string): string {
  const summarized = summarizeDetail(detail)
  if (!summarized) return 'unknown fetch error'
  if (/^(?:typeerror:\s*)?fetch failed$/i.test(summarized)) {
    return 'transport failed before more detail was available'
  }
  return summarized
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function safeHost(endpointUrl?: string): string | undefined {
  if (!endpointUrl) return undefined
  try {
    return new URL(endpointUrl).host
  } catch {
    return undefined
  }
}

function hostFromMessage(message: string): string | undefined {
  const urlMatch = message.match(/https?:\/\/([^/\s]+)/i)
  if (urlMatch?.[1]) return urlMatch[1]
  const hostMatch = message.match(/\b([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\b/i)
  return hostMatch?.[1]
}

function isTlsFailure(code: string | undefined, message: string): boolean {
  if (code && TLS_CODES.some(prefix => code.includes(prefix))) return true
  return /ssl|tls|certificate|self[- ]signed|hostname mismatch/i.test(message)
}

function timeoutDetailFromMessage(message: string): string | undefined {
  const ms = message.match(/after (\d+)ms/i)
  if (ms?.[1]) {
    return `timeout after ${formatDuration(Number(ms[1]))}`
  }
  const seconds = message.match(/after (\d+)s\b/i)
  if (seconds?.[1]) {
    return `timeout after ${seconds[1]}s`
  }
  if (/timed out/i.test(message)) {
    return truncate(message.replace(/\s+/g, ' '))
  }
  return undefined
}

function formatDuration(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function isLocalEndpoint(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

function isProviderDiagnostic(value: unknown): value is ProviderRequestDiagnostic {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['provider'] === 'string'
    && typeof record['model'] === 'string'
    && typeof record['kind'] === 'string'
    && typeof record['message'] === 'string'
    && typeof record['retryable'] === 'boolean'
    && typeof record['detail'] === 'string'
}
