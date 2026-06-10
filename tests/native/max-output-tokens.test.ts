/**
 * Tests for the 0.13.65 max_tokens default + env override.
 *
 * Pin: default is 32_768 (matches external coding-assistant), env
 * `OWLCODA_MAX_OUTPUT_TOKENS` overrides, invalid values fall back to
 * default. The createConversation() default-arm path picks up the
 * resolver so all four legacy 4096-default call sites get the new
 * value.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  createConversation,
  resolveDefaultMaxOutputTokens,
} from '../../src/native/conversation.js'

afterEach(() => {
  delete process.env['OWLCODA_MAX_OUTPUT_TOKENS']
})

describe('resolveDefaultMaxOutputTokens (0.13.65)', () => {
  it('returns 32_768 by default', () => {
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
  })

  it('honors OWLCODA_MAX_OUTPUT_TOKENS when set to a positive integer', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '8192'
    expect(resolveDefaultMaxOutputTokens()).toBe(8192)
  })

  it('honors very large overrides for high-output models', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '128000'
    expect(resolveDefaultMaxOutputTokens()).toBe(128_000)
  })

  it('falls back to default on empty string', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = ''
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
  })

  it('falls back to default on whitespace-only', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '   '
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
  })

  it('falls back to default on non-numeric junk', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = 'unlimited'
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
  })

  it('falls back to default on zero / negative values (defensive)', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '0'
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '-1024'
    expect(resolveDefaultMaxOutputTokens()).toBe(32_768)
  })

  it('floors fractional values to integers', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '16000.7'
    expect(resolveDefaultMaxOutputTokens()).toBe(16_000)
  })
})

describe('createConversation max_tokens default (0.13.65)', () => {
  it('picks up the new 32_768 default when caller omits maxTokens', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(conv.maxTokens).toBe(32_768)
  })

  it('explicit caller value still wins over the default resolver', () => {
    const conv = createConversation({ system: 'test', model: 'm', maxTokens: 4096 })
    expect(conv.maxTokens).toBe(4096)
  })

  it('env override takes effect through createConversation', () => {
    process.env['OWLCODA_MAX_OUTPUT_TOKENS'] = '12345'
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(conv.maxTokens).toBe(12_345)
  })
})
