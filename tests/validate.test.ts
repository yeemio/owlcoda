import { describe, it, expect } from 'vitest'
import { validateMessagesBody } from '../src/middleware/validate.js'

describe('validateMessagesBody', () => {
  it('accepts a valid body', () => {
    const result = validateMessagesBody({
      model: 'default',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    })
    expect(result.valid).toBe(true)
  })

  it('rejects non-object body', () => {
    const result = validateMessagesBody('string')
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('JSON object')
  })

  it('rejects null body', () => {
    const result = validateMessagesBody(null)
    expect(result.valid).toBe(false)
  })

  it('rejects missing model', () => {
    const result = validateMessagesBody({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('model')
  })

  it('rejects empty model', () => {
    const result = validateMessagesBody({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects missing messages', () => {
    const result = validateMessagesBody({ model: 'x', max_tokens: 100 })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('messages')
  })

  it('rejects empty messages array', () => {
    const result = validateMessagesBody({ model: 'x', messages: [], max_tokens: 100 })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('non-empty')
  })

  it('rejects non-array messages', () => {
    const result = validateMessagesBody({ model: 'x', messages: 'not-array', max_tokens: 100 })
    expect(result.valid).toBe(false)
  })

  it('rejects message without role', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ content: 'hello' }],
      max_tokens: 100,
    })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('role')
  })

  it('rejects message without content', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ role: 'user' }],
      max_tokens: 100,
    })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('content')
  })

  it('rejects negative max_tokens', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: -5,
    })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('max_tokens')
  })

  it('rejects non-boolean stream', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      stream: 'yes',
    })
    expect(result.valid).toBe(false)
    expect((result as any).error).toContain('stream')
  })

  it('allows extra fields to pass through', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.7,
      custom_field: true,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect((result.body as any).temperature).toBe(0.7)
    }
  })

  it('allows max_tokens to be omitted', () => {
    const result = validateMessagesBody({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.valid).toBe(true)
  })
})
