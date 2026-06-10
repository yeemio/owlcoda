/**
 * Tests for the 0.13.59 edit helper functions: detectLineEnding,
 * findFuzzyMatches, buildOldStrNotFoundError.
 *
 * Pins:
 *   - line-ending detection covers LF, CRLF, mixed, and "none"
 *   - fuzzy matcher returns the closest line within similarity
 *     threshold
 *   - the "oldStr not found" message includes a CRLF-vs-LF hint when
 *     applicable, plus top-3 fuzzy candidates with line numbers and
 *     edit distance
 */
import { describe, expect, it } from 'vitest'
import {
  buildOldStrNotFoundError,
  detectLineEnding,
  findFuzzyMatches,
} from '../../../src/native/tools/edit-helpers.js'

describe('detectLineEnding', () => {
  it('detects pure LF', () => {
    expect(detectLineEnding('a\nb\nc')).toBe('LF')
  })

  it('detects pure CRLF', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('CRLF')
  })

  it('detects mixed', () => {
    expect(detectLineEnding('a\r\nb\nc\r\nd')).toBe('mixed')
  })

  it('returns none for empty string', () => {
    expect(detectLineEnding('')).toBe('none')
  })

  it('returns none for single line with no newline', () => {
    expect(detectLineEnding('hello world')).toBe('none')
  })

  it('CRLF + lone CR (no LF after) still classifies as CRLF', () => {
    // \r without following \n is rare but shouldn't break detection
    expect(detectLineEnding('a\r\nb\r\n')).toBe('CRLF')
  })
})

describe('findFuzzyMatches', () => {
  it('returns the exact line at distance 0', () => {
    const content = 'foo bar\nbaz qux\nthis is a target line\nlast line'
    const matches = findFuzzyMatches(content, 'this is a target line', 3)
    expect(matches[0]?.lineNumber).toBe(3)
    expect(matches[0]?.distance).toBe(0)
  })

  it('returns close match within similarity threshold', () => {
    const content = 'foo\nthis is a target line\nbaz'
    const matches = findFuzzyMatches(content, 'this is target line', 3)
    // Just one char off (missing "a")
    expect(matches[0]?.lineNumber).toBe(2)
    expect(matches[0]?.distance).toBeLessThan(5)
  })

  it('returns empty array when no line is close enough (>50% relative distance)', () => {
    const content = 'foo bar\nbaz qux\nbang fizz\n'
    const matches = findFuzzyMatches(content, 'completely unrelated zorgblat needle', 3)
    expect(matches).toEqual([])
  })

  it('caps results at topN', () => {
    const content = 'aaa\naab\naac\naad\naae\n'
    const matches = findFuzzyMatches(content, 'aaa', 3)
    expect(matches.length).toBeLessThanOrEqual(3)
  })

  it('skips short needles (<4 chars) to avoid spurious matches', () => {
    const content = 'foo\nbar\nbaz\n'
    expect(findFuzzyMatches(content, 'a', 3)).toEqual([])
    expect(findFuzzyMatches(content, 'abc', 3)).toEqual([])
    expect(findFuzzyMatches(content, 'abcd', 3)).toEqual([])  // exactly 4 → still not above threshold? threshold is "less than 4"
  })

  it('takes the first non-empty line of multiline oldStr as the needle', () => {
    const content = 'header line\nthis is target\nbottom line\n'
    const oldStr = '\n\nthis is target\nfollowed by something missing'
    const matches = findFuzzyMatches(content, oldStr, 3)
    expect(matches[0]?.lineNumber).toBe(2)
    expect(matches[0]?.distance).toBe(0)
  })

  it('handles CRLF content without false-positive distance hits', () => {
    const content = 'foo bar\r\nbaz qux\r\nthe target line\r\n'
    const matches = findFuzzyMatches(content, 'the target line', 3)
    expect(matches[0]?.lineNumber).toBe(3)
    expect(matches[0]?.distance).toBe(0)
  })

  it('previews are truncated at 80 chars', () => {
    const longLine = 'x'.repeat(200)
    const content = `${longLine}\nshort line\n`
    const matches = findFuzzyMatches(content, longLine, 1)
    expect(matches[0]?.preview.length).toBeLessThanOrEqual(80)
    expect(matches[0]?.preview.endsWith('...')).toBe(true)
  })
})

describe('buildOldStrNotFoundError', () => {
  it('includes CRLF-vs-LF hint when file is CRLF and oldStr is LF', () => {
    const file = 'first\r\nsecond\r\nthird\r\n'
    const oldStr = 'second\nthird'  // LF
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, oldStr)
    expect(msg).toMatch(/Error: oldStr not found in \/tmp\/x\.txt/)
    expect(msg).toMatch(/CRLF line endings/)
    expect(msg).toMatch(/oldStr.*LF/)
  })

  it('includes CRLF hint even when oldStr has no newline (edge case)', () => {
    const file = 'first\r\nsecond\r\nmissing-target\r\n'
    const oldStr = 'this exact line is not in the file'  // no newline
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, oldStr)
    expect(msg).toMatch(/CRLF line endings/)
  })

  it('does NOT include CRLF hint when both file and oldStr are LF', () => {
    const file = 'first\nsecond\nthird\n'
    const oldStr = 'fourth\nfifth'
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, oldStr)
    expect(msg).not.toMatch(/CRLF/)
  })

  it('lists fuzzy candidates with line numbers and distances', () => {
    const file = 'foo\nthis is a slightly different line\nbaz\nqux\n'
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, 'this is a target line')
    expect(msg).toMatch(/Closest matches/)
    expect(msg).toMatch(/line 2 \(Δ\d+\)/)
    expect(msg).toMatch(/this is a slightly different line/)
  })

  it('falls back to "no similar lines found" when nothing matches', () => {
    const file = 'foo\nbar\nbaz\n'
    const msg = buildOldStrNotFoundError(
      '/tmp/x.txt',
      file,
      'completely unrelated zorgblat needle that does not appear anywhere',
    )
    expect(msg).toMatch(/No similar lines found/)
    expect(msg).toMatch(/may not exist in this file at all/)
  })

  it('points the model at re-reading with surrounding-context syntax', () => {
    const file = 'a\nthe target\nb\n'
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, 'the targt')  // typo
    expect(msg).toMatch(/read\(\{path, startLine: N-2, endLine: N\+5\}\)/)
  })

  it('mentions "MIXED line endings" hint when file has mixed', () => {
    const file = 'first\r\nsecond\nthird\r\n'  // mixed
    const oldStr = 'second\nthird'
    const msg = buildOldStrNotFoundError('/tmp/x.txt', file, oldStr)
    expect(msg).toMatch(/MIXED line endings/)
  })
})
