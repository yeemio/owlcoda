import { describe, expect, it } from 'vitest'
import { parseApiError } from '../../src/native/slash-commands.js'
import { explainRequestFailure } from '../../src/native/conversation.js'
import {
  ProviderRequestError,
  createProviderHttpDiagnostic,
  formatProviderDiagnostic,
  type ProviderRequestDiagnostic,
} from '../../src/provider-error.js'

/**
 * Native user-facing error rendering: ensure the structured provider
 * diagnostic is the path of least resistance, the raw "fetch failed" string
 * never reaches the user, and abort stays distinct from provider failure.
 */

function diag(partial: Partial<ProviderRequestDiagnostic> & { provider: string; model: string }): ProviderRequestDiagnostic {
  return {
    kind: 'http_5xx',
    message: 'default message',
    detail: '',
    retryable: true,
    ...partial,
  } as ProviderRequestDiagnostic
}

describe('parseApiError', () => {
  it('unwraps a ProviderRequestDiagnostic inside an API error envelope', () => {
    const inner = createProviderHttpDiagnostic(502, 'upstream blew up', {
      provider: 'kimi',
      model: 'kimi-code',
      endpointUrl: 'https://api.kimi.com/coding',
      requestId: 'req-xyz-123',
    })
    const apiErrorString = `API error 502: ${JSON.stringify({ error: { diagnostic: inner } })}`
    const out = parseApiError(apiErrorString)
    expect(out).toContain('kimi-code')
    expect(out).toContain('req-xyz-123')
    expect(out).not.toContain('fetch failed')
  })

  it('maps "This operation was aborted" to a retryable provider abort, NOT user cancellation', () => {
    const out = parseApiError('This operation was aborted')
    expect(out).toContain('Request aborted before completion')
    expect(out).toContain('/retry')
    expect(out).not.toContain('cancelled')
    expect(out).not.toContain('fetch failed')
  })

  it('TLS errors map to a clear "SSL certificate" hint', () => {
    expect(parseApiError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toMatch(/SSL certificate/)
    expect(parseApiError('CERT_HAS_EXPIRED')).toMatch(/expired/i)
  })

  it('ECONNREFUSED maps to "Unable to connect to API"', () => {
    expect(parseApiError('connect ECONNREFUSED 127.0.0.1:8009')).toMatch(/Unable to connect/)
  })
})

describe('explainRequestFailure', () => {
  it('prefixes every branch with "<model> request failed:" — stable UX anchor', () => {
    const cases = [
      'fetch failed',
      'ETIMEDOUT',
      'HTTP 401 unauthorized',
      'HTTP 403 forbidden',
      'Rate limited (429)',
      'Bad gateway 502',
      'SSL certificate expired',
    ]
    for (const c of cases) {
      const out = explainRequestFailure(c, 'test-model')
      expect(out.startsWith('test-model request failed:')).toBe(true)
    }
  })

  it('each class carries an actionable next step', () => {
    expect(explainRequestFailure('fetch failed', 'm')).toMatch(/\/doctor|\/model/)
    expect(explainRequestFailure('ETIMEDOUT', 'm')).toMatch(/\/retry|\/model/)
    expect(explainRequestFailure('401 Unauthorized', 'm')).toMatch(/key|\/login|admin UI/i)
    expect(explainRequestFailure('429 too many requests', 'm')).toMatch(/\/retry|\/model/)
    expect(explainRequestFailure('502 bad gateway', 'm')).toMatch(/\/retry|\/model/)
    expect(explainRequestFailure('ssl handshake failed', 'm')).toMatch(/TLS|SSL|proxy/i)
  })

  it('does NOT coerce raw "fetch failed" to the user — always wrapped', () => {
    const out = explainRequestFailure('fetch failed', 'cloud-model')
    expect(out).not.toBe('fetch failed')
    expect(out).toContain('cloud-model')
  })
})

describe('formatProviderDiagnostic', () => {
  it('includes request id when asked', () => {
    const d = diag({
      provider: 'kimi',
      model: 'kimi-code',
      message: 'kimi-code request failed: upstream 502',
      requestId: 'req-abc',
    })
    const out = formatProviderDiagnostic(d, { includeRequestId: true })
    expect(out).toBe('kimi-code request failed: upstream 502 (request req-abc)')
  })

  it('falls back to upstream request id when no local request id', () => {
    const d = diag({
      provider: 'kimi',
      model: 'kimi-code',
      message: 'kimi-code request failed',
      upstreamRequestId: 'upstream-xyz',
    })
    const out = formatProviderDiagnostic(d, { includeRequestId: true })
    expect(out).toContain('upstream request upstream-xyz')
  })

  it('ProviderRequestError.message is pre-formatted — safe to surface directly', () => {
    const err = new ProviderRequestError(diag({
      provider: 'anthropic',
      model: 'claude-4',
      message: 'claude-4 request failed: upstream 529',
      requestId: 'req-1',
    }))
    expect(err.message).toBe('claude-4 request failed: upstream 529 (request req-1)')
    expect(err.diagnostic.requestId).toBe('req-1')
  })
})

describe('abort classification', () => {
  it('parseApiError("This operation was aborted") marks retryable abort, not user cancellation', () => {
    expect(parseApiError('This operation was aborted')).toContain('Request aborted before completion')
  })

  it('abort-like strings do NOT flow through explainRequestFailure ideally, but if they do, they still produce a useful message', () => {
    // Defensive: the loop intercepts abort before explainRequestFailure runs.
    // This test documents behavior if that guard is ever bypassed — no crash,
    // still a sensible string.
    const out = explainRequestFailure('The user aborted a request.', 'some-model')
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })
})
