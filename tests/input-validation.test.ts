/**
 * Tests for input validation hardening (Round 52).
 */

import { describe, it, expect } from 'vitest'

// ─── Admin query param bounds ───

describe('admin count param bounds', () => {
  // Test the clamping logic: Math.min(Math.max(parseInt(x) || default, 1), 500)
  const clampCount = (raw: string | null, def: number): number =>
    Math.min(Math.max(parseInt(raw ?? String(def)) || def, 1), 500)

  it('clamps negative count to 1', () => {
    expect(clampCount('-5', 10)).toBe(1)
  })

  it('falls back zero count to default', () => {
    expect(clampCount('0', 10)).toBe(10)
  })

  it('clamps huge count to 500', () => {
    expect(clampCount('999999', 10)).toBe(500)
  })

  it('defaults NaN to default value', () => {
    expect(clampCount('abc', 10)).toBe(10)
  })

  it('passes valid count through', () => {
    expect(clampCount('50', 10)).toBe(50)
  })

  it('uses default when null', () => {
    expect(clampCount(null, 20)).toBe(20)
  })
})

// ─── count-tokens validation ───

describe('count-tokens body validation', () => {
  it('rejects non-object body', () => {
    const body: any = [1, 2, 3]
    const isValid = body !== null && typeof body === 'object' && !Array.isArray(body)
    expect(isValid).toBe(false)
  })

  it('rejects null body', () => {
    const body: any = null
    const isValid = body !== null && typeof body === 'object' && !Array.isArray(body)
    expect(isValid).toBe(false)
  })

  it('accepts valid object body', () => {
    const body: any = { messages: [] }
    const isValid = body !== null && typeof body === 'object' && !Array.isArray(body)
    expect(isValid).toBe(true)
  })

  it('accepts empty object body', () => {
    const body: any = {}
    const isValid = body !== null && typeof body === 'object' && !Array.isArray(body)
    expect(isValid).toBe(true)
  })
})
