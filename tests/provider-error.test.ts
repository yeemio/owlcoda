import { describe, expect, it } from 'vitest'
import {
  classifyProviderRequestError,
  createProviderHttpDiagnostic,
  createStreamFirstTokenTimeoutDiagnostic,
  createStreamIdleTimeoutDiagnostic,
  createStreamInterruptedDiagnostic,
  diagnosticToAnthropicError,
  formatProviderDiagnostic,
  parseProviderDiagnosticFromPayload,
  parseProviderDiagnosticFromString,
} from '../src/provider-error.js'

describe('provider-error diagnostics', () => {
  it('classifies fetch failures with cause.code as dns errors', () => {
    const err = new TypeError('fetch failed') as TypeError & { cause?: unknown }
    err.cause = { code: 'ENOTFOUND', errno: 'ENOTFOUND', syscall: 'getaddrinfo' }

    const diagnostic = classifyProviderRequestError(err, {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-dns',
    })

    expect(diagnostic.kind).toBe('dns_error')
    expect(diagnostic.retryable).toBe(true)
    expect(diagnostic.rawCauseCode).toBe('ENOTFOUND')
    expect(diagnostic.syscall).toBe('getaddrinfo')
    expect(formatProviderDiagnostic(diagnostic, { includeRequestId: true })).toContain('req-dns')
  })

  it('classifies AbortError as retryable provider abort, not user cancellation', () => {
    const err = new Error('This operation was aborted')
    err.name = 'AbortError'

    const diagnostic = classifyProviderRequestError(err, {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
    })

    expect(diagnostic.kind).toBe('unknown_fetch_error')
    expect(diagnostic.retryable).toBe(true)
    expect(diagnostic.message).toContain('request aborted before completion')
    expect(diagnostic.message).not.toContain('cancelled by user')
  })

  it('classifies timeout-like errors', () => {
    const err = new Error('Request timed out after 60000ms')
    const diagnostic = classifyProviderRequestError(err, {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-timeout',
    })

    expect(diagnostic.kind).toBe('timeout')
    expect(diagnostic.retryable).toBe(true)
    expect(diagnostic.message).toContain('timeout after 60s')
  })

  it('classifies upstream 4xx responses', () => {
    const diagnostic = createProviderHttpDiagnostic(404, '{"error":{"message":"model not found"}}', {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-404',
    })

    expect(diagnostic.kind).toBe('http_4xx')
    expect(diagnostic.status).toBe(404)
    expect(diagnostic.retryable).toBe(false)
    expect(diagnostic.detail).toContain('model not found')
  })

  it('classifies upstream 5xx responses as retryable', () => {
    const diagnostic = createProviderHttpDiagnostic(502, 'bad gateway', {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-502',
    })

    expect(diagnostic.kind).toBe('http_5xx')
    expect(diagnostic.retryable).toBe(true)
    expect(diagnostic.message).toContain('upstream 502')
  })

  it('2026-05-28: treats 400 + cluster rate-limit detail as retryable (mimo-v25-pro shape)', () => {
    // mimo-v25-pro real production response (audit log evidence):
    //   status=400, detail="Cluster rate limit exceeded, request queued but not admitted"
    // Pre-fix: retryable=false → 5 fan-out sub-agents all hard-fail when
    // burst-limited. Post-fix: detail-text inference flips retryable=true so
    // the native conversation auto-retry path can recover.
    const diagnostic = createProviderHttpDiagnostic(
      400,
      'Cluster rate limit exceeded, request queued but not admitted',
      { model: 'mimo-v25-pro', endpointUrl: 'https://api.example/openai', requestId: 'req-rl-400' },
    )

    expect(diagnostic.status).toBe(400)
    expect(diagnostic.kind).toBe('http_4xx')
    expect(diagnostic.retryable).toBe(true)
    expect(diagnostic.detail).toContain('Cluster rate limit')
  })

  it('400 with non-rate-limit detail stays non-retryable', () => {
    const diagnostic = createProviderHttpDiagnostic(
      400,
      'Invalid request: missing "messages" field',
      { model: 'mimo-v25-pro', endpointUrl: 'https://api.example/openai', requestId: 'req-bad-shape' },
    )

    expect(diagnostic.retryable).toBe(false)
  })

  it('recognises Chinese rate-limit phrasings in detail text', () => {
    for (const phrase of ['请求过多，请稍后重试', '当前已被限流', '超出配额', '频率限制：每分钟最多 60 次']) {
      const d = createProviderHttpDiagnostic(400, phrase, { model: 'mimo-v25-pro' })
      expect(d.retryable).toBe(true)
    }
  })

  it('classifies stream early close as pre-first-token kind when flagged', () => {
    // createStreamInterruptedDiagnostic now emits a distinct pre-first-token
    // kind when the stream closes before any content reached the client.
    // runConversationLoop uses this specifically to drive the "继续 / retry"
    // UX without confusing it with mid-stream interrupts. The generic kind
    // is asserted in the `beforeFirstToken: false` case below.
    const diagnostic = createStreamInterruptedDiagnostic({
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-stream',
    }, {
      beforeFirstToken: true,
    })

    expect(diagnostic.kind).toBe('stream_interrupted_before_first_token')
    expect(diagnostic.message).toContain('stream closed before first token')
    expect(diagnostic.retryable).toBe(true)

    // Mid-stream interrupt still uses the generic kind.
    const midStream = createStreamInterruptedDiagnostic({
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
    }, { beforeFirstToken: false })
    expect(midStream.kind).toBe('stream_interrupted')
  })

  it('0.13.97: createStreamFirstTokenTimeoutDiagnostic stamps partialOutputSeen=false', () => {
    const diag = createStreamFirstTokenTimeoutDiagnostic({
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-fto',
    }, { timeoutMs: 90_000 })
    expect(diag.kind).toBe('stream_first_token_timeout')
    expect(diag.partialOutputSeen).toBe(false)
    expect(diag.retryable).toBe(true)
    expect(diag.status).toBe(504)
    expect(diag.detail).toContain('90000ms')
  })

  it('0.13.97: createStreamIdleTimeoutDiagnostic stamps partialOutputSeen=true', () => {
    const diag = createStreamIdleTimeoutDiagnostic({
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-idle',
    }, { timeoutMs: 90_000 })
    expect(diag.kind).toBe('stream_idle_timeout')
    expect(diag.partialOutputSeen).toBe(true)
    expect(diag.retryable).toBe(true)
    expect(diag.status).toBe(504)
    expect(diag.detail).toContain('90000ms')
    // Wording contract: must NOT use "before a usable response" (we DID see usable output).
    expect(diag.message).not.toContain('before a usable response')
  })

  it('keeps unknown fetch errors honest without surfacing bare fetch failed', () => {
    const diagnostic = classifyProviderRequestError(new Error('fetch failed'), {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
    })

    expect(diagnostic.kind).toBe('unknown_fetch_error')
    expect(diagnostic.message).toContain('transport failed before more detail was available')
    expect(diagnostic.message).not.toContain('fetch failed')
  })

  it('embeds diagnostics into anthropic error payloads and parses them back', () => {
    const diagnostic = createProviderHttpDiagnostic(503, '{"error":{"message":"overloaded"}}', {
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-503',
    })
    const mapped = diagnosticToAnthropicError(diagnostic)

    expect(mapped.body.error.diagnostic?.kind).toBe('http_5xx')
    expect(parseProviderDiagnosticFromPayload(mapped.body)).toEqual(diagnostic)
    expect(parseProviderDiagnosticFromString(`API error 503: ${JSON.stringify(mapped.body)}`)).toEqual(diagnostic)
  })
})
