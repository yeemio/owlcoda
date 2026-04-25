/**
 * Validation edge case tests — exercise validateMessagesBody boundary conditions.
 */
import { describe, it, expect } from 'vitest'
import { validateMessagesBody } from '../src/middleware/validate.js'

describe('validateMessagesBody edge cases', () => {
  // --- model field ---
  it('rejects null body', () => {
    const r = validateMessagesBody(null)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/JSON object/)
  })

  it('rejects non-object body (string)', () => {
    const r = validateMessagesBody('not an object')
    expect(r.valid).toBe(false)
  })

  it('rejects missing model', () => {
    const r = validateMessagesBody({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/model/)
  })

  it('rejects empty string model', () => {
    const r = validateMessagesBody({ model: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/model/)
  })

  it('rejects numeric model', () => {
    const r = validateMessagesBody({ model: 42, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/model/)
  })

  // --- messages field ---
  it('rejects missing messages', () => {
    const r = validateMessagesBody({ model: 'test' })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/messages/)
  })

  it('rejects empty messages array', () => {
    const r = validateMessagesBody({ model: 'test', messages: [] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/non-empty/)
  })

  it('rejects messages as a string', () => {
    const r = validateMessagesBody({ model: 'test', messages: 'hello' })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/array/)
  })

  it('rejects message without role', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ content: 'hi' }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/role/)
  })

  it('rejects message with null content', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: null }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/content/)
  })

  it('rejects message with undefined content', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user' }] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/content/)
  })

  it('accepts message with empty string content', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: '' }] })
    expect(r.valid).toBe(true)
  })

  it('accepts message with array content', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    expect(r.valid).toBe(true)
  })

  it('rejects non-object message entry', () => {
    const r = validateMessagesBody({ model: 'test', messages: ['hello'] })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/object/)
  })

  // --- max_tokens ---
  it('accepts missing max_tokens (optional)', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.valid).toBe(true)
  })

  it('rejects zero max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/max_tokens/)
  })

  it('rejects negative max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: -10 })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/max_tokens/)
  })

  it('rejects NaN max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: NaN })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/max_tokens/)
  })

  it('rejects Infinity max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: Infinity })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/max_tokens/)
  })

  it('rejects string max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: '100' })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/max_tokens/)
  })

  it('accepts valid positive max_tokens', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 })
    expect(r.valid).toBe(true)
  })

  // --- stream ---
  it('accepts stream: true', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(r.valid).toBe(true)
  })

  it('accepts stream: false', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: false })
    expect(r.valid).toBe(true)
  })

  it('rejects stream: "true" (string)', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: 'true' })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/stream/)
  })

  it('rejects stream: 1 (number)', () => {
    const r = validateMessagesBody({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: 1 })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/stream/)
  })

  // --- extra fields pass through ---
  it('passes through unknown fields', () => {
    const r = validateMessagesBody({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.7,
      custom_field: 'hello',
    })
    expect(r.valid).toBe(true)
    if (r.valid) {
      expect((r.body as any).temperature).toBe(0.7)
      expect((r.body as any).custom_field).toBe('hello')
    }
  })

  // --- multiple messages ---
  it('accepts multiple valid messages', () => {
    const r = validateMessagesBody({
      model: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'follow up' },
      ],
      max_tokens: 1024,
    })
    expect(r.valid).toBe(true)
  })

  it('detects invalid message at index 2', () => {
    const r = validateMessagesBody({
      model: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user' }, // missing content
      ],
    })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toMatch(/messages\[2\]/)
  })
})
