/**
 * Tests for OwlCoda TUI Fuzzy Picker
 */

import { describe, it, expect } from 'vitest'
import { fuzzyMatch, highlightMatch, isReadlinePickerSettling, resetReadlineInputState } from '../../../src/native/tui/picker.js'

describe('Fuzzy Picker', () => {
  describe('fuzzyMatch', () => {
    it('matches exact string', () => {
      expect(fuzzyMatch('hello', 'hello')).toBeGreaterThanOrEqual(0)
    })

    it('matches case-insensitive', () => {
      expect(fuzzyMatch('Hello', 'hello')).toBeGreaterThanOrEqual(0)
      expect(fuzzyMatch('abc', 'ABC')).toBeGreaterThanOrEqual(0)
    })

    it('matches subsequence', () => {
      expect(fuzzyMatch('abc', 'a-b-c-d')).toBeGreaterThanOrEqual(0)
    })

    it('returns -1 for no match', () => {
      expect(fuzzyMatch('xyz', 'hello')).toBe(-1)
    })

    it('returns -1 for empty target', () => {
      expect(fuzzyMatch('abc', '')).toBe(-1)
    })

    it('matches empty query to anything', () => {
      expect(fuzzyMatch('', 'anything')).toBeGreaterThanOrEqual(0)
    })

    it('scores tighter matches lower (better)', () => {
      const tight = fuzzyMatch('abc', 'abc')
      const loose = fuzzyMatch('abc', 'a---b---c')
      expect(tight).toBeLessThan(loose)
    })

    it('matches fuzzy model names', () => {
      expect(fuzzyMatch('qwen', 'qwen2.5-coder:32b')).toBeGreaterThanOrEqual(0)
      expect(fuzzyMatch('heavy', 'gpt-oss-120b-MXFP4-Q4 heavy')).toBeGreaterThanOrEqual(0)
      expect(fuzzyMatch('gpt', 'gpt-oss-20b-MXFP4-Q4')).toBeGreaterThanOrEqual(0)
    })
  })

  describe('highlightMatch', () => {
    it('returns label unchanged with empty query', () => {
      const result = highlightMatch('hello', '')
      expect(result).toBe('hello')
    })

    it('highlights matched characters', () => {
      const result = highlightMatch('hello', 'hlo')
      // Should contain ANSI codes for highlighted characters
      expect(result).toContain('h')
      expect(result).toContain('l')
      expect(result).toContain('o')
      // Should still contain all chars
      expect(result).toContain('e')
    })

    it('handles case-insensitive highlighting', () => {
      const result = highlightMatch('Hello World', 'hw')
      expect(result).toContain('H')
      expect(result).toContain('W')
    })
  })

  describe('PickerOptions', () => {
    it('accepts optional readline interface', () => {
      // Type-level test: PickerOptions should accept a readline property
      const opts: import('../../../src/native/tui/picker.js').PickerOptions<string> = {
        items: [{ label: 'A', value: 'a' }],
        readline: undefined,
      }
      expect(opts.readline).toBeUndefined()
    })
  })

  describe('resetReadlineInputState', () => {
    it('clears buffered readline input without needing a full interface', () => {
      const rl = { line: '/model', cursor: 6 } as any
      resetReadlineInputState(rl)
      expect(rl.line).toBe('')
      expect(rl.cursor).toBe(0)
    })
  })

  describe('isReadlinePickerSettling', () => {
    it('treats active picker marker as settling', () => {
      const rl = { __owlPickerActive: true } as any
      expect(isReadlinePickerSettling(rl)).toBe(true)
    })

    it('treats recent ignore-until timestamp as settling', () => {
      const rl = { __owlIgnoreLinesUntil: Date.now() + 1000 } as any
      expect(isReadlinePickerSettling(rl)).toBe(true)
    })

    it('returns false when no picker marker is set', () => {
      expect(isReadlinePickerSettling({} as any)).toBe(false)
    })
  })
})
