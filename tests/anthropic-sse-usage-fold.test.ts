import { describe, it, expect } from 'vitest'
import { foldAnthropicSseUsage } from '../src/endpoints/messages.js'

// The cloud passthrough folds usage across SSE events. input + cache are
// request-fixed and output is cumulative, so the running total must take the
// MAX, not the sum. message_start carries input; message_delta now ALSO carries
// the real input (and the cumulative output) — summing double-counts input and
// inflates output by message_start's leading 1.
describe('foldAnthropicSseUsage — no double-count across message_start + message_delta', () => {
  it('keeps input request-fixed and output cumulative (max, not sum)', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    const afterStart = foldAnthropicSseUsage(zero, {
      type: 'message_start',
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } },
    })
    const afterDelta = foldAnthropicSseUsage(afterStart, {
      type: 'message_delta',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    expect(afterDelta).toEqual({ input: 100, output: 50, cacheRead: 20, cacheCreation: 5 })
  })
})
