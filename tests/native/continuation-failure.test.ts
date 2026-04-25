import { describe, expect, it } from 'vitest'
import {
  classifyConversationRuntimeFailure,
  shouldShowNoResponseFallback,
  type ConversationRuntimeFailure,
} from '../../src/native/conversation.js'
import {
  ProviderRequestError,
  createStreamInterruptedDiagnostic,
  formatContinuationFailure,
  formatProviderDiagnostic,
} from '../../src/provider-error.js'
import type { Conversation } from '../../src/native/protocol/types.js'

function makeConv(turns: Conversation['turns']): Conversation {
  return {
    id: 'conv',
    system: '',
    model: 'kimi-code',
    tools: [],
    maxTokens: 4096,
    turns,
  } as Conversation
}

function streamError(beforeFirstToken: boolean): Error {
  const err = new Error(beforeFirstToken ? 'stream closed before first token' : 'stream closed before completion')
  err.name = 'StreamInterruptedError'
  return err
}

describe('provider-error: stream_interrupted kinds', () => {
  it('createStreamInterruptedDiagnostic emits the pre-first-token kind when flagged', () => {
    const d = createStreamInterruptedDiagnostic(
      { model: 'kimi-code', endpointUrl: 'https://api.kimi.com/coding' },
      { beforeFirstToken: true },
    )
    expect(d.kind).toBe('stream_interrupted_before_first_token')
    expect(d.detail).toContain('first token')
    expect(d.retryable).toBe(true)
  })

  it('createStreamInterruptedDiagnostic keeps the generic kind otherwise', () => {
    const d = createStreamInterruptedDiagnostic(
      { model: 'kimi-code', endpointUrl: 'https://api.kimi.com/coding' },
      { beforeFirstToken: false },
    )
    expect(d.kind).toBe('stream_interrupted')
    expect(d.detail).toContain('before completion')
  })
})

describe('formatContinuationFailure', () => {
  const preFirstDiag = createStreamInterruptedDiagnostic(
    { model: 'kimi-code', endpointUrl: 'https://api.kimi.com/coding', requestId: 'req-xyz' },
    { beforeFirstToken: true },
  )

  it('tool-success context → "Tool completed" phrasing', () => {
    const out = formatContinuationFailure(preFirstDiag, 'tool-success', { includeRequestId: true })
    expect(out).toContain('Tool completed')
    expect(out).toContain('before first token')
    expect(out).toContain('/retry')
    expect(out).toContain('req-xyz')
  })

  it('user-continue context → continuation phrasing, mentions context preservation', () => {
    const out = formatContinuationFailure(preFirstDiag, 'user-continue', { includeRequestId: true })
    expect(out).toContain('kimi-code continuation failed')
    expect(out).toMatch(/context is intact/i)
    expect(out).toContain('req-xyz')
  })

  it('none (first request) context → plain request-failed phrasing', () => {
    const out = formatContinuationFailure(preFirstDiag, 'none', { includeRequestId: true })
    expect(out).toContain('kimi-code request failed')
    expect(out).toContain('before first token')
  })

  it('post-first-token stream interrupts get partial-response phrasing', () => {
    const d = createStreamInterruptedDiagnostic(
      { model: 'kimi-code', endpointUrl: 'https://api.kimi.com/coding' },
      { beforeFirstToken: false },
    )
    const out = formatContinuationFailure(d, 'none', { includeRequestId: true })
    expect(out).toContain('stream closed before completion')
    expect(out).toMatch(/partial response/i)
  })

  it('non-stream kinds delegate to formatProviderDiagnostic', () => {
    const d = {
      provider: 'kimi',
      model: 'kimi-code',
      kind: 'timeout' as const,
      message: 'kimi-code request failed: timeout after 60s',
      retryable: true,
      detail: 'timeout',
    }
    const out = formatContinuationFailure(d, 'tool-success', { includeRequestId: true })
    expect(out).toBe(formatProviderDiagnostic(d, { includeRequestId: true }))
  })
})

describe('classifyConversationRuntimeFailure — phase derivation', () => {
  it('classifies tool_continuation when the last user turn has a successful tool_result', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'write a file' }], timestamp: 0 },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write', input: {} }], timestamp: 1 },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done', is_error: false }],
        timestamp: 2,
      } as any,
    ])
    const failure = classifyConversationRuntimeFailure(
      new ProviderRequestError(createStreamInterruptedDiagnostic({ model: 'kimi-code' }, { beforeFirstToken: true })),
      conv,
      2,
    )
    expect(failure).not.toBeNull()
    expect(failure!.phase).toBe('tool_continuation')
    expect(failure!.kind).toBe('pre_first_token_stream_close')
    expect(failure!.message).toContain('Tool completed')
  })

  it('classifies continuation when the latest user prompt is "继续" / "continue"', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'initial ask' }], timestamp: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'partial thought' }], timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 2 },
    ])
    const failure = classifyConversationRuntimeFailure(
      new ProviderRequestError(createStreamInterruptedDiagnostic({ model: 'kimi-code' }, { beforeFirstToken: true })),
      conv,
      2,
    )
    expect(failure!.phase).toBe('continuation')
    expect(failure!.kind).toBe('pre_first_token_stream_close')
    expect(failure!.message).toContain('continuation failed')
    expect(failure!.message).toMatch(/context is intact/i)
  })

  it('classifies request phase on first iteration with no continuation signal', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 0 },
    ])
    const failure = classifyConversationRuntimeFailure(
      new ProviderRequestError(createStreamInterruptedDiagnostic({ model: 'kimi-code' }, { beforeFirstToken: true })),
      conv,
      1,
    )
    expect(failure!.phase).toBe('request')
    expect(failure!.kind).toBe('pre_first_token_stream_close')
    expect(failure!.message).toContain('request failed')
  })

  it('generic AbortError is retryable provider failure, not user cancellation', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ])
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const failure = classifyConversationRuntimeFailure(abortErr, conv, 1)
    expect(failure!.kind).toBe('provider_error')
    expect(failure!.retryable).toBe(true)
    expect(failure!.message).toContain('request aborted before completion')
  })

  it('post-first-token stream interrupt stays post_token_stream_close', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ])
    const failure = classifyConversationRuntimeFailure(
      new ProviderRequestError(createStreamInterruptedDiagnostic({ model: 'kimi-code' }, { beforeFirstToken: false })),
      conv,
      1,
    )
    expect(failure!.kind).toBe('post_token_stream_close')
  })

  it('plain Error with StreamInterruptedError name (before first token) still classifies correctly', () => {
    const conv = makeConv([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ])
    const failure = classifyConversationRuntimeFailure(streamError(true), conv, 1)
    expect(failure!.kind).toBe('pre_first_token_stream_close')
  })
})

describe('shouldShowNoResponseFallback', () => {
  const structuredFailure: ConversationRuntimeFailure = {
    kind: 'pre_first_token_stream_close',
    phase: 'tool_continuation',
    message: 'Tool completed, but kimi-code continuation failed',
    retryable: true,
  }

  it('returns false when a structured runtimeFailure was already emitted', () => {
    expect(shouldShowNoResponseFallback({
      finalText: '',
      stopReason: null,
      runtimeFailure: structuredFailure,
      aborted: false,
    })).toBe(false)
  })

  it('returns true only when finalText empty AND not aborted AND not stalled AND no runtimeFailure', () => {
    expect(shouldShowNoResponseFallback({
      finalText: '',
      stopReason: 'end_turn',
      runtimeFailure: null,
      aborted: false,
    })).toBe(true)
  })

  it('returns false when finalText is non-empty', () => {
    expect(shouldShowNoResponseFallback({
      finalText: 'hello',
      stopReason: 'end_turn',
      runtimeFailure: null,
      aborted: false,
    })).toBe(false)
  })

  it('returns false when aborted — cancellation is not a no-response', () => {
    expect(shouldShowNoResponseFallback({
      finalText: '',
      stopReason: null,
      runtimeFailure: null,
      aborted: true,
    })).toBe(false)
  })

  it('returns false when stopReason is stalled or tool_loop', () => {
    expect(shouldShowNoResponseFallback({
      finalText: '', stopReason: 'stalled', runtimeFailure: null, aborted: false,
    })).toBe(false)
    expect(shouldShowNoResponseFallback({
      finalText: '', stopReason: 'tool_loop', runtimeFailure: null, aborted: false,
    })).toBe(false)
  })

  it('returns false when stopReason is tool_use (tool-only turn is a real response)', () => {
    // Regression for 0.12.18: tool_use turns are valid model responses —
    // the model emitted tool calls, they got executed. If the NEXT
    // iteration fails (Server shutting down, etc.), that shows up via
    // runtimeFailure. Firing "(No response from model)" here stacked
    // a misleading "model didn't answer" line on top of the actual
    // upstream error, confusing the user (they saw both a red error
    // AND a "no response" notice for the same turn).
    expect(shouldShowNoResponseFallback({
      finalText: '', stopReason: 'tool_use', runtimeFailure: null, aborted: false,
    })).toBe(false)
  })

  it('returns false when stopReason is hard_stop (synthesis already surfaced)', () => {
    // hard_stop comes with its own runtime message ("Hard stop: …"); the
    // no-response banner would be redundant noise.
    expect(shouldShowNoResponseFallback({
      finalText: '', stopReason: 'hard_stop', runtimeFailure: null, aborted: false,
    })).toBe(false)
  })
})
