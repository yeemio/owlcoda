import { describe, it, expect } from 'vitest'
import { translateRequest } from '../src/translate/request.js'

// Without stream_options.include_usage a spec-conformant OpenAI upstream never
// emits the trailing usage chunk, so /cost falls back to estimates even though
// the translator can now read it. Request it whenever we stream.
describe('translateRequest — stream usage', () => {
  it('requests include_usage when streaming', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    } as never, 'y')
    expect(result.stream).toBe(true)
    expect((result as { stream_options?: unknown }).stream_options).toEqual({ include_usage: true })
  })

  it('omits stream_options for a non-streaming request', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    } as never, 'y')
    expect((result as { stream_options?: unknown }).stream_options).toBeUndefined()
  })
})
