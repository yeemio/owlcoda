import { describe, expect, it } from 'vitest'
import { fallbackSplitIfLong } from '../../src/native/repl-shared.js'

// Cut 1 (Bug 3 #1): fallbackSplitIfLong must decide "is a sentence segment long
// enough to break apart" by TERMINAL DISPLAY WIDTH (cells), not JS `.length`
// (UTF-16 code units). The old code used `line.length` with a split
// 40(CJK)/80(non-CJK) threshold — a codepoint-count approximation that
// mis-measures mixed CJK+ASCII, ANSI-wrapped, and multi-codepoint-grapheme
// (emoji ZWJ) lines. The correct single threshold is ~80 display cells.
describe('fallbackSplitIfLong — width is measured in display cells, not code units', () => {
  // ---- RED-driving cases (fail under the old `.length` implementation) ----

  it('does not count ANSI escape bytes toward the width decision', () => {
    // Two visually short sentences (~19 cells each) heavily wrapped in SGR color
    // codes. `.length` counts the ~85 invisible escape bytes per segment and
    // wrongly trips the threshold; display width (ANSI stripped) is ~19.
    const sgr = '\x1b[38;2;200;100;50m'.repeat(5) // 85 code units, 0 display cells
    const input = `${sgr}Short sentence one. ${sgr}Short sentence two.`
    expect(fallbackSplitIfLong(input)).toBe(input) // unchanged: nothing is actually wide
  })

  it('does not over-split a mixed CJK+ASCII line that is under 80 cells', () => {
    // ~63 cells, but 61 code units with 2 CJK chars. Old code: any CJK present
    // → threshold collapses to 40 code units → 61 > 40 → wrongly splits.
    const input = 'This english sentence mentions 中文 inline and stays well under. Tail.'
    expect(fallbackSplitIfLong(input)).toBe(input)
  })

  it('counts emoji ZWJ sequences as their display width, not surrogate length', () => {
    // 8 family emoji: each is 1 grapheme = 11 UTF-16 units but 2 display cells.
    // `.length` of the segment is ~92 (trips 80); display width is ~20.
    const input = `${'👨‍👩‍👧‍👦'.repeat(8)} ok. Second sentence here.`
    expect(fallbackSplitIfLong(input)).toBe(input)
  })

  // ---- Anchors (correct behavior, must keep working) ----

  it('splits a pure-CJK line wider than 80 cells', () => {
    // 45 CJK chars in the first sentence = 90 cells > 80 → split.
    const input = '这是一个故意写得非常长的中文句子用来确保它的显示宽度明显超过八十个单元从而应当被切开。短句。'
    expect(fallbackSplitIfLong(input)).toContain('\n')
  })

  it('splits a pure-ASCII line wider than 80 cells', () => {
    const input = `${'word '.repeat(20)}stop. A short tail.`
    expect(fallbackSplitIfLong(input)).toContain('\n')
  })

  it('leaves a short pure-ASCII multi-sentence line unsplit', () => {
    const input = 'Short one. Short two.'
    expect(fallbackSplitIfLong(input)).toBe(input)
  })
})
