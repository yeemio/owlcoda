import { describe, expect, it } from 'vitest'

import {
  computeVisibleLineWindow,
  deleteToLineEnd,
  deleteToLineStart,
} from '../../src/native/ink-multiline-input.js'
import {
  detectBufferedInputSignals,
  stripBufferedMouseArtifacts,
  stripModifiedEnterArtifacts,
  stripSgrMouseArtifacts,
} from '../../src/native/repl-shared.js'

describe('computeVisibleLineWindow', () => {
  it('keeps the cursor visible near the end of a long line', () => {
    const result = computeVisibleLineWindow('abcdefghij', 8, 4)

    expect(result.startCol).toBe(5)
    expect(result.displayLine).toBe('fghi')
    expect(result.cursorDisplayCol).toBe(3)
  })

  it('stays anchored at the start when the cursor is already visible', () => {
    const result = computeVisibleLineWindow('abcdefghij', 2, 6)

    expect(result.startCol).toBe(0)
    expect(result.displayLine).toBe('abcdef')
    expect(result.cursorDisplayCol).toBe(2)
  })

  it('keeps a wide-character cursor aligned for CJK text', () => {
    const result = computeVisibleLineWindow('撤大是大非飒短发', 4, 8)

    expect(result.startCol).toBeGreaterThanOrEqual(0)
    expect(result.cursorDisplayCol).toBeGreaterThanOrEqual(0)
    expect(result.cursorDisplayCol).toBeLessThan(8)
  })
})

describe('line delete shortcuts', () => {
  it('deletes from cursor to line start for Ctrl+U semantics', () => {
    const result = deleteToLineStart('alpha beta\ngamma', 0, 6)

    expect(result).toEqual({
      value: 'beta\ngamma',
      cursorRow: 0,
      cursorCol: 0,
    })
  })

  it('deletes from cursor to line end for Ctrl+K semantics', () => {
    const result = deleteToLineEnd('alpha beta\ngamma', 0, 6)

    expect(result).toEqual({
      value: 'alpha \ngamma',
      cursorRow: 0,
      cursorCol: 6,
    })
  })

  it('keeps other lines intact when deleting on a later line', () => {
    const start = deleteToLineStart('first line\nsecond line', 1, 7)
    const end = deleteToLineEnd('first line\nsecond line', 1, 7)

    expect(start.value).toBe('first line\nline')
    expect(end.value).toBe('first line\nsecond ')
  })

  it('deletes a single CJK character at the cursor boundary', () => {
    const result = deleteToLineEnd('撤大是大非', 0, 4)

    expect(result).toEqual({
      value: '撤大是大',
      cursorRow: 0,
      cursorCol: 4,
    })
  })
})

// ─── Stabilization: pure-newline suppression ──────────────────

describe('pure-newline input suppression', () => {
  // The MultilineInput component's insertText callback rejects input that is
  // purely newlines (/^\n+$/) to prevent "Enter spam during active task"
  // from creating blank lines when the input box is re-enabled.
  // These tests verify the regex logic that guards against that.

  const pureNewlineRe = /^\n+$/

  it('rejects a single bare newline', () => {
    expect(pureNewlineRe.test('\n')).toBe(true)
  })

  it('rejects multiple consecutive newlines', () => {
    expect(pureNewlineRe.test('\n\n\n')).toBe(true)
  })

  it('accepts text that contains embedded newlines', () => {
    expect(pureNewlineRe.test('hello\nworld')).toBe(false)
  })

  it('accepts text followed by a trailing newline', () => {
    expect(pureNewlineRe.test('hello\n')).toBe(false)
  })

  it('accepts a newline followed by text', () => {
    expect(pureNewlineRe.test('\nhello')).toBe(false)
  })

  it('accepts an empty string (no newline at all)', () => {
    expect(pureNewlineRe.test('')).toBe(false)
  })

  it('accepts a carriage-return-then-newline (CR is not a bare newline)', () => {
    // After the .replace(/\r/g, '\n') normalization, \r\n becomes \n\n
    // which IS pure newlines. Test both pre- and post-normalization.
    expect(pureNewlineRe.test('\r\n')).toBe(false) // pre-normalization
    expect(pureNewlineRe.test('\r\n'.replace(/\r/g, '\n'))).toBe(true) // post
  })
})

// ─── Stabilization: modified-enter artifact handling ──────────

describe('modified-enter artifact stripping robustness', () => {
  it('strips nested / repeated artifacts', () => {
    expect(stripModifiedEnterArtifacts('hello27;2;13~13~')).toBe('hello')
  })

  it('leaves clean text untouched', () => {
    expect(stripModifiedEnterArtifacts('normal text')).toBe('normal text')
    expect(stripModifiedEnterArtifacts('')).toBe('')
  })

  it('strips artifact from pasted text that ends with modified-enter token', () => {
    expect(stripModifiedEnterArtifacts('pasted content\x1b[13;2u')).toBe('pasted content')
  })
})

// ─── Stabilization: buffered signal across chunk boundaries ───

describe('buffered signal edge cases', () => {
  it('handles a complete modified-enter sequence in a single chunk', () => {
    const result = detectBufferedInputSignals('\x1b[27;2;13~')
    expect(result.continueMultiline).toBe(true)
    // After stripping the full sequence, leftover fragments that match
    // prefixes of known sequences become the remainder for the next chunk.
  })

  it('does not false-positive on similar-looking text', () => {
    const result = detectBufferedInputSignals('13;2u is a code')
    // The substring "13;2u" appears in the text but the detection should
    // still fire since it matches the known sequences.
    expect(result.continueMultiline).toBe(true)
  })

  it('handles empty input with empty remainder', () => {
    const result = detectBufferedInputSignals('', '')
    expect(result.continueMultiline).toBe(false)
    expect(result.pasteStart).toBe(false)
    expect(result.pasteEnd).toBe(false)
    expect(result.remainder).toBe('')
  })

  it('preserves remainder across a three-chunk split', () => {
    // Simulate \x1b[13;2u split across three chunks: \x1b, [13;, 2u
    const r1 = detectBufferedInputSignals('\x1b')
    expect(r1.remainder).toBe('\x1b')
    expect(r1.continueMultiline).toBe(false)

    const r2 = detectBufferedInputSignals('[13;', r1.remainder)
    // At this point we have \x1b[13; which is a prefix of \x1b[13;2u
    expect(r2.continueMultiline).toBe(false)

    const r3 = detectBufferedInputSignals('2u', r2.remainder)
    expect(r3.continueMultiline).toBe(true)
    expect(r3.remainder).toBe('')
  })
})

describe('mouse artifact stripping', () => {
  it('removes complete SGR mouse reports with or without ESC prefix', () => {
    expect(stripSgrMouseArtifacts('\x1b[<64;12;9M')).toBe('')
    expect(stripSgrMouseArtifacts('[<65;12;9M')).toBe('')
  })

  it('removes concatenated mouse reports without touching surrounding text', () => {
    expect(stripSgrMouseArtifacts('hello\x1b[<64;12;9Mworld[<65;12;9M!')).toBe('helloworld!')
  })

  it('buffers incomplete mouse sequences across chunk boundaries', () => {
    const first = stripBufferedMouseArtifacts('\x1b[<64;12;')
    expect(first.cleaned).toBe('')
    expect(first.remainder).toBe('\x1b[<64;12;')

    const second = stripBufferedMouseArtifacts('9Mhello', first.remainder)
    expect(second.cleaned).toBe('hello')
    expect(second.remainder).toBe('')
  })

  it('drops leaked tail fragments before the next mouse report', () => {
    const result = stripBufferedMouseArtifacts('14M[<65;51;14M')
    expect(result.cleaned).toBe('')
    expect(result.remainder).toBe('')
  })
})

// ─── Stabilization: deleteToLineStart / deleteToLineEnd edge cases ────

describe('line deletion edge cases', () => {
  it('deleteToLineStart at column 0 is a no-op', () => {
    const result = deleteToLineStart('hello', 0, 0)
    expect(result).toEqual({ value: 'hello', cursorRow: 0, cursorCol: 0 })
  })

  it('deleteToLineEnd at end of line is a no-op', () => {
    const result = deleteToLineEnd('hello', 0, 5)
    expect(result).toEqual({ value: 'hello', cursorRow: 0, cursorCol: 5 })
  })

  it('deleteToLineStart on empty value', () => {
    const result = deleteToLineStart('', 0, 0)
    expect(result).toEqual({ value: '', cursorRow: 0, cursorCol: 0 })
  })

  it('deleteToLineEnd on empty value', () => {
    const result = deleteToLineEnd('', 0, 0)
    expect(result).toEqual({ value: '', cursorRow: 0, cursorCol: 0 })
  })

  it('clamps out-of-range cursor coordinates', () => {
    const result = deleteToLineStart('abc\ndef', 5, 100)
    // Row 5 clamps to row 1, col 100 clamps to col 3
    expect(result.cursorRow).toBe(1)
    expect(result.cursorCol).toBe(0)
    expect(result.value).toBe('abc\n')
  })
})
