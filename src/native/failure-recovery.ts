import type { ConversationRuntimeFailure } from './conversation.js'

// Local input-shape detection. Mirrors repl-shared's regexes verbatim so that
// existing semantics are preserved. Inlined here to break the import cycle:
// repl-shared.ts now imports the classifier from this module, so this module
// must not import back from repl-shared.ts.
const CONTINUATION_RETRY_PHRASES = new Set([
  '继续', '续跑', '接着',
  '继续一下', '继续总结', '继续说', '继续写', '继续写下去', '继续完成',
  '接着写', '接着说',
  'continue', 'resume', 'go on', 'carry on', 'keep going', 'keep writing',
])
const POLITE_CONTINUATION_RETRY_RE = /^(?:(?:请|请你|麻烦|麻烦你)\s*(?:继续|续跑|接着|继续一下|继续总结|继续说)(?:\s*[吧呀啊嘛])?|(?:please\s+)(?:continue|resume|go on|carry on)(?:\s*please)?)$/i
const SHORT_QUESTION_ONLY_RE = /^[\s?？!！。…]+$/

function normalize(text: string): string {
  return text.trim().replace(/[.!?。！？…]+$/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function isShortRecoveryInputLocal(trimmed: string): boolean {
  // 0.13.96: only block when the input is *exactly* a recovery phrase, not
  // when it merely contains a keyword. Pre-0.13.96 logic was "≤40 chars +
  // SHORT_FAILURE_RECOVERY_RE.test(trimmed)" — `超时怎么办`、`重试一下试试`
  // were intercepted because `超时` / `重试` appeared anywhere. Real follow-up
  // prompts that touch the same topic must reach the model.
  //
  // The remaining gates (multi-line / list-marker / structural-colon / >40
  // chars) are kept as cheap reject-fast filters; the *positive* match is now
  // only one of:
  //   - normalized input is in CONTINUATION_RETRY_PHRASES (whitelist set)
  //   - normalized input matches POLITE_CONTINUATION_RETRY_RE (anchored)
  //   - trimmed is pure punctuation (SHORT_QUESTION_ONLY_RE, anchored)
  //
  // We dropped the SHORT_FAILURE_RECOVERY_RE.test(trimmed) clause entirely —
  // its "any keyword anywhere" semantics is what caused the over-trigger.
  if (/\n/.test(trimmed)) return false
  if (/\d+\.\s/.test(trimmed)) return false
  if (/[:：]\s*\S/.test(trimmed)) return false
  if (trimmed.length > 40) return false
  const normalized = normalize(trimmed)
  if (CONTINUATION_RETRY_PHRASES.has(normalized)) return true
  if (POLITE_CONTINUATION_RETRY_RE.test(normalized)) return true
  if (SHORT_QUESTION_ONLY_RE.test(trimmed)) return true
  return false
}

export type RecoveryInputKind =
  | 'empty'
  | 'explicit_retry'
  | 'slash_other'
  | 'short_recovery'
  | 'long_fresh'

export type RecoveryAction =
  | { kind: 'force_resubmit_failed_turn' }
  | { kind: 'submit_as_new_turn' }
  | { kind: 'block_with_local_guidance'; guidance: string }
  | { kind: 'slash_passthrough' }

export function classifyRecoveryInput(text: string): RecoveryInputKind {
  const trimmed = text.trim()
  if (trimmed === '') return 'empty'
  if (trimmed === '/retry') return 'explicit_retry'
  if (trimmed.startsWith('/')) return 'slash_other'
  if (isShortRecoveryInputLocal(trimmed)) return 'short_recovery'
  return 'long_fresh'
}

export function classifyFailureRecoveryAction(options: {
  failure: ConversationRuntimeFailure | null | undefined
  inputKind: RecoveryInputKind
}): RecoveryAction {
  const { failure, inputKind } = options
  if (inputKind === 'empty') return { kind: 'submit_as_new_turn' }
  if (inputKind === 'slash_other') return { kind: 'slash_passthrough' }
  if (inputKind === 'explicit_retry') return { kind: 'force_resubmit_failed_turn' }
  if (!failure) return { kind: 'submit_as_new_turn' }
  if (inputKind === 'short_recovery') {
    if (failure.kind === 'abort') return { kind: 'submit_as_new_turn' }
    return { kind: 'block_with_local_guidance', guidance: buildLocalRecoveryGuidance(failure) }
  }
  return { kind: 'submit_as_new_turn' }
}

// 0.13.97: takes the full failure (was: just the kind) so partial-output
// branching can read `failure.diagnostic?.partialOutputSeen`. The phrase
// "before a usable response" is reserved for cases where partialOutputSeen
// is structurally false (no streaming) — never used when partial output
// reached the user.
export function buildLocalRecoveryGuidance(failure: ConversationRuntimeFailure): string {
  const partial = failure.diagnostic?.partialOutputSeen === true
  switch (failure.kind) {
    case 'timeout':
      // Non-streaming wall-clock budget exhausted. By construction no SSE,
      // so partialOutputSeen is structurally false here.
      return 'Last request hit the non-streaming server budget without a response. Use /retry to force a resend, /model to switch, or enable streaming for long-running tasks.'
    case 'pre_first_token_stream_close':
      // Includes proxy stream_first_token_timeout (90s default watchdog) and
      // upstream socket close before any chunk. User has nothing yet.
      return 'Last request did not produce any output before the stream stalled. Use /retry to force a resend, /model to switch to a faster route, or send a smaller batched request.'
    case 'stream_idle_timeout':
      // 0.13.97: per-chunk idle watchdog AFTER first chunk. partial is true
      // by construction (createStreamIdleTimeoutDiagnostic always stamps it).
      return 'Last request stalled mid-stream after partial output (which is preserved in the transcript). Use /retry to resend the full prompt, OR send a follow-up instruction to continue from where it left off without resending the large context.'
    case 'empty_provider_response':
      return 'Last request returned no usable content. Use /retry to force a resend, or /model to switch.'
    case 'post_token_stream_close':
      // Stream closed (upstream socket dropped) AFTER first token.
      return partial
        ? 'Last request closed mid-stream — partial output is preserved in the transcript. Use /retry to resend, OR send a follow-up instruction to continue from where it left off.'
        : 'Last request closed mid-stream. Use /retry to force a resend, or send a smaller batched request.'
    case 'http_error':
    case 'provider_error':
      return 'Last request failed with a transport / provider error. Use /retry to force a resend, or /model to switch.'
    case 'abort':
      return 'Last request was aborted. Use /retry to force a resend, or send a new message.'
  }
}
