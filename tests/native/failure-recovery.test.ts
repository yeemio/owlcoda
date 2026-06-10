import { describe, it, expect } from 'vitest'
import {
  classifyRecoveryInput,
  classifyFailureRecoveryAction,
  type RecoveryInputKind,
} from '../../src/native/failure-recovery.js'
import type { ConversationRuntimeFailure, ConversationRuntimeFailureKind } from '../../src/native/conversation.js'

const kinds: ConversationRuntimeFailureKind[] = [
  'timeout',
  'pre_first_token_stream_close',
  'empty_provider_response',
  'post_token_stream_close',
  'http_error',
  'provider_error',
  'abort',
  'stream_idle_timeout',
]

const failure = (kind: ConversationRuntimeFailureKind): ConversationRuntimeFailure => ({
  kind,
  phase: 'request',
  retryable: kind !== 'abort',
  message: 'test',
} as any)

describe('classifyRecoveryInput', () => {
  const cases: [string, RecoveryInputKind][] = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['/retry', 'explicit_retry'],
    ['  /retry  ', 'explicit_retry'],
    ['/clear', 'slash_other'],
    ['/model gpt-5', 'slash_other'],
    ['继续', 'short_recovery'],                // exact CONTINUATION phrase
    ['请继续', 'short_recovery'],               // POLITE_CONTINUATION_RETRY_RE match
    ['continue', 'short_recovery'],             // exact CONTINUATION phrase
    ['?', 'short_recovery'],                    // SHORT_QUESTION_ONLY_RE
    ['？？', 'short_recovery'],                 // SHORT_QUESTION_ONLY_RE
    // 0.13.96: dropped SHORT_FAILURE_RECOVERY_RE keyword-anywhere fallback.
    // The following used to be short_recovery (keyword present) but are now
    // long_fresh — they're real follow-up prompts mentioning the topic.
    ['为什么中断了', 'long_fresh'],
    ['timeout?', 'long_fresh'],
    ['超时怎么办', 'long_fresh'],
    ['重试一下试试', 'long_fresh'],
    ['Now refactor the auth middleware to use the new session store and add tests', 'long_fresh'],
    ['a'.repeat(200), 'long_fresh'],
    // 0.13.95: structural-shape filters reject multi-line / list / colon
    // before reaching keyword check.
    [
      '但在进入编码前，建议先闭环以下四个问题：1. 网络信任 2. 超时算术',
      'long_fresh',
    ],
    ['1. 这个超时是怎么回事', 'long_fresh'],
    ['继续\n超时怎么办', 'long_fresh'],
    ['为什么\n', 'long_fresh'],                // \n → reject early
    ['失败原因：context 太大', 'long_fresh'],
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input.slice(0, 40))} → ${expected}`, () => {
      expect(classifyRecoveryInput(input)).toBe(expected)
    })
  }
})

describe('classifyFailureRecoveryAction matrix', () => {
  for (const kind of kinds) {
    it(`${kind} × explicit_retry → force_resubmit_failed_turn`, () => {
      expect(classifyFailureRecoveryAction({ failure: failure(kind), inputKind: 'explicit_retry' }))
        .toEqual({ kind: 'force_resubmit_failed_turn' })
    })
    it(`${kind} × slash_other → slash_passthrough`, () => {
      expect(classifyFailureRecoveryAction({ failure: failure(kind), inputKind: 'slash_other' }))
        .toEqual({ kind: 'slash_passthrough' })
    })
    it(`${kind} × long_fresh → submit_as_new_turn`, () => {
      expect(classifyFailureRecoveryAction({ failure: failure(kind), inputKind: 'long_fresh' }))
        .toEqual({ kind: 'submit_as_new_turn' })
    })
    if (kind !== 'abort') {
      it(`${kind} × short_recovery → block_with_local_guidance`, () => {
        const action = classifyFailureRecoveryAction({ failure: failure(kind), inputKind: 'short_recovery' })
        expect(action.kind).toBe('block_with_local_guidance')
        if (action.kind === 'block_with_local_guidance') {
          expect(action.guidance.length).toBeGreaterThan(20)
        }
      })
    } else {
      it(`abort × short_recovery → submit_as_new_turn (abort already consumed)`, () => {
        expect(classifyFailureRecoveryAction({ failure: failure('abort'), inputKind: 'short_recovery' }))
          .toEqual({ kind: 'submit_as_new_turn' })
      })
    }
  }

  it('no failure × explicit_retry still forces resubmit (legacy /retry semantics)', () => {
    expect(classifyFailureRecoveryAction({ failure: null, inputKind: 'explicit_retry' }))
      .toEqual({ kind: 'force_resubmit_failed_turn' })
  })

  it('no failure × short_recovery → submit_as_new_turn (no recovery state to honour)', () => {
    expect(classifyFailureRecoveryAction({ failure: null, inputKind: 'short_recovery' }))
      .toEqual({ kind: 'submit_as_new_turn' })
  })
})

describe('0.13.97 buildLocalRecoveryGuidance wording', () => {
  // Helper to extract guidance text from a block_with_local_guidance action.
  function guideFor(failure: ConversationRuntimeFailure): string {
    const action = classifyFailureRecoveryAction({ failure, inputKind: 'short_recovery' })
    if (action.kind !== 'block_with_local_guidance') throw new Error('expected block')
    return action.guidance
  }

  it('stream_idle_timeout guidance mentions partial output is preserved + suggests follow-up', () => {
    const text = guideFor({
      kind: 'stream_idle_timeout',
      phase: 'request',
      retryable: true,
      message: 'test',
      diagnostic: {
        provider: 'kimi-code',
        model: 'kimi',
        kind: 'stream_idle_timeout',
        message: 'idle',
        retryable: true,
        detail: 'idle',
        partialOutputSeen: true,
      },
    })
    expect(text).toContain('partial output')
    expect(text).toContain('preserved in the transcript')
    expect(text).not.toContain('before a usable response')
  })

  it('post_token_stream_close + partialOutputSeen=true gives "preserved" wording', () => {
    const text = guideFor({
      kind: 'post_token_stream_close',
      phase: 'request',
      retryable: true,
      message: 'test',
      diagnostic: {
        provider: 'kimi',
        model: 'kimi',
        kind: 'stream_interrupted',
        message: 'closed',
        retryable: true,
        detail: 'closed',
        partialOutputSeen: true,
      },
    })
    expect(text).toContain('partial output')
    expect(text).toContain('preserved')
    expect(text).not.toContain('before a usable response')
  })

  it('post_token_stream_close + partialOutputSeen=false gives non-partial wording', () => {
    const text = guideFor({
      kind: 'post_token_stream_close',
      phase: 'request',
      retryable: true,
      message: 'test',
      diagnostic: {
        provider: 'kimi',
        model: 'kimi',
        kind: 'stream_interrupted',
        message: 'closed',
        retryable: true,
        detail: 'closed',
        partialOutputSeen: false,
      },
    })
    expect(text).not.toContain('partial output')
    expect(text).toContain('Last request closed mid-stream')
  })

  it('pre_first_token_stream_close (incl. proxy first-token watchdog) does NOT mention "before a usable response"', () => {
    const text = guideFor({
      kind: 'pre_first_token_stream_close',
      phase: 'request',
      retryable: true,
      message: 'test',
    })
    expect(text).not.toContain('before a usable response')
    expect(text).toContain('did not produce any output')
  })

  it('non-streaming timeout (kind=timeout) wording reflects "non-streaming budget", no "before a usable response"', () => {
    // 0.13.97: streaming no longer maps to kind='timeout'. The 'timeout'
    // kind is now reserved for the non-streaming wall-clock budget. The
    // wording should say so explicitly and offer streaming as the way out.
    const text = guideFor({
      kind: 'timeout',
      phase: 'request',
      retryable: true,
      message: 'test',
    })
    expect(text).not.toContain('before a usable response')
    expect(text).toContain('non-streaming')
    expect(text).toContain('streaming')
  })
})
