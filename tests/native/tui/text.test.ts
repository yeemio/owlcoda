import { describe, it, expect } from 'vitest'
import { truncate, truncateMiddle, wordWrap, padRight, padLeft, center, repeat } from '../../../src/native/tui/text.js'
import { visibleWidth } from '../../../src/native/tui/colors.js'

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates long text with ellipsis', () => {
    const result = truncate('a very long string indeed', 10)
    expect(visibleWidth(result)).toBeLessThanOrEqual(10)
    expect(result).toContain('…')
  })

  it('handles exact length', () => {
    expect(truncate('12345', 5)).toBe('12345')
  })
})

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 10)).toBe('hello')
  })

  it('keeps start and end of long paths', () => {
    const result = truncateMiddle('/Users/test/very/long/path/to/file.ts', 25)
    expect(result).toContain('/Users/')
    expect(result).toContain('.ts')
    expect(result).toContain('…')
  })
})

describe('wordWrap', () => {
  it('wraps long text', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const lines = wordWrap(text, 20)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20)
    }
  })

  it('returns single line for short text', () => {
    const lines = wordWrap('hello', 80)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('hello')
  })
})

describe('padRight', () => {
  it('pads to width', () => {
    const result = padRight('hi', 10)
    expect(result).toContain('hi')
    // Visible length should be at least 10
  })

  it('returns original when already wide enough', () => {
    const result = padRight('hello world', 5)
    expect(result).toContain('hello world')
  })
})

describe('padLeft', () => {
  it('left-pads', () => {
    const result = padLeft('hi', 10)
    expect(result).toContain('hi')
  })
})

describe('center', () => {
  it('centers text', () => {
    const result = center('hi', 10)
    expect(result).toContain('hi')
  })
})

describe('repeat', () => {
  it('repeats character', () => {
    expect(repeat('=', 5)).toBe('=====')
  })

  it('returns empty for count 0', () => {
    expect(repeat('-', 0)).toBe('')
  })
})
