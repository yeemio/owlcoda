import { describe, it, expect } from 'vitest'
import { extractAnthropicSseUsageDelta } from '../src/endpoints/messages.js'

describe('extractAnthropicSseUsageDelta', () => {
  it('pulls input/output AND cache tokens from a message_start event', () => {
    const d = extractAnthropicSseUsageDelta({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 120,
          output_tokens: 0,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 30,
        },
      },
    })
    expect(d).toEqual({ input: 120, output: 0, cacheRead: 900, cacheCreation: 30 })
  })

  it('pulls output from a message_delta event (no cache there)', () => {
    const d = extractAnthropicSseUsageDelta({ type: 'message_delta', usage: { output_tokens: 42 } })
    expect(d).toEqual({ input: 0, output: 42, cacheRead: 0, cacheCreation: 0 })
  })

  it('treats missing cache fields as zero (Anthropic without caching / other events)', () => {
    const d = extractAnthropicSseUsageDelta({
      type: 'message_start',
      message: { usage: { input_tokens: 50, output_tokens: 0 } },
    })
    expect(d).toEqual({ input: 50, output: 0, cacheRead: 0, cacheCreation: 0 })
  })

  it('returns all-zero for events without usage', () => {
    expect(extractAnthropicSseUsageDelta({ type: 'content_block_delta' })).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
    })
    expect(extractAnthropicSseUsageDelta(null)).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
    })
  })
})
