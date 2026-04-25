/**
 * PII sanitizer tests.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeText, sanitizeMessages } from '../src/data/sanitize.js'

describe('sanitizeText', () => {
  it('redacts OpenAI keys', () => {
    const result = sanitizeText('My key is sk-abc123def456ghi789jkl012mno345')
    expect(result.text).toContain('[REDACTED]')
    expect(result.text).not.toContain('abc123')
    expect(result.replacements).toBeGreaterThan(0)
    expect(result.types).toContain('api_key')
  })

  it('redacts GitHub PATs', () => {
    const result = sanitizeText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234')
    expect(result.text).toContain('ghp_[REDACTED]')
    expect(result.types).toContain('api_key')
  })

  it('redacts Bearer tokens', () => {
    const result = sanitizeText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig')
    expect(result.text).toContain('Bearer [REDACTED]')
  })

  it('redacts JWT tokens', () => {
    const result = sanitizeText('token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')
    expect(result.text).toContain('[REDACTED]')
    expect(result.types).toContain('api_key')
  })

  it('redacts email addresses', () => {
    const result = sanitizeText('Contact john.doe@example.com for help')
    expect(result.text).toBe('Contact [EMAIL] for help')
    expect(result.types).toContain('email')
  })

  it('redacts home directory paths', () => {
    const result = sanitizeText('File at /Users/johndoe/projects/secret')
    expect(result.text).toBe('File at /home/[USER]/projects/secret')
    expect(result.types).toContain('path')
  })

  it('redacts Linux home paths', () => {
    const result = sanitizeText('Dir: /home/ubuntu/.ssh/config')
    expect(result.text).toBe('Dir: /home/[USER]/.ssh/config')
  })

  it('redacts IP addresses', () => {
    const result = sanitizeText('Server at 192.168.1.100:8080')
    expect(result.text).toContain('[IP]')
    expect(result.types).toContain('ip_address')
  })

  it('preserves localhost IP', () => {
    const result = sanitizeText('Listening on 127.0.0.1:8019')
    expect(result.text).toBe('Listening on 127.0.0.1:8019')
    expect(result.replacements).toBe(0)
  })

  it('redacts auth URL params', () => {
    const result = sanitizeText('https://api.example.com?token=abc123def456ghi789')
    expect(result.text).toContain('token=[REDACTED]')
    expect(result.types).toContain('auth_param')
  })

  it('redacts AWS access keys', () => {
    const result = sanitizeText('AWS key: AKIAIOSFODNN7EXAMPLE')
    expect(result.text).toContain('[REDACTED]')
  })

  it('handles text with no PII', () => {
    const result = sanitizeText('Hello, this is a clean message about TypeScript.')
    expect(result.text).toBe('Hello, this is a clean message about TypeScript.')
    expect(result.replacements).toBe(0)
    expect(result.types).toHaveLength(0)
  })

  it('handles multiple PII types in one text', () => {
    const result = sanitizeText(
      'User john@example.com on /Users/john/work with key sk-abcdef1234567890abcdef1234'
    )
    expect(result.text).toContain('[EMAIL]')
    expect(result.text).toContain('/home/[USER]')
    expect(result.text).toContain('[REDACTED]')
    expect(result.types.length).toBeGreaterThanOrEqual(3)
  })

  it('respects sanitizePaths=false', () => {
    const result = sanitizeText('/Users/test/file', { sanitizePaths: false })
    expect(result.text).toBe('/Users/test/file')
  })

  it('respects sanitizeEmails=false', () => {
    const result = sanitizeText('test@example.com', { sanitizeEmails: false })
    expect(result.text).toBe('test@example.com')
  })
})

describe('sanitizeMessages', () => {
  it('sanitizes string content', () => {
    const messages = [
      { role: 'user', content: 'My email is test@example.com' },
      { role: 'assistant', content: 'Got it' },
    ]
    const { totalReplacements } = sanitizeMessages(messages)
    expect(totalReplacements).toBe(1)
    expect(messages[0].content).toBe('My email is [EMAIL]')
  })

  it('sanitizes array content blocks', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Key is sk-abc123def456ghi789jkl012mno345' },
      ]},
    ]
    const { totalReplacements } = sanitizeMessages(messages)
    expect(totalReplacements).toBeGreaterThan(0)
    const block = (messages[0].content as any[])[0]
    expect(block.text).toContain('[REDACTED]')
  })
})
