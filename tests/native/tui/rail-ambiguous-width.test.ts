import { describe, expect, it, afterEach } from 'vitest'
import { visibleWidth } from '../../../src/native/tui/colors.js'
import { setAmbiguousWidthWide, isAmbiguousWidthWide } from '../../../src/ink/stringWidth.js'

// tui/colors.ts used the npm `string-width` package while the renderer and
// composer measure with owlcoda's ambiguous-width-aware src/ink/stringWidth.
// On CJK-locale terminals (East-Asian Ambiguous rendered WIDE) the rail's
// width ledger ran 1 column short per ambiguous glyph — the footer hint
// "enter send · shift+enter newline" computed as fitting but rendered one
// cell over, clipping the last character ("newlin"). One width authority:
// visibleWidth must respect the ambiguous-width setting.
describe('tui visibleWidth uses the ambiguous-width-aware stringWidth', () => {
  const original = isAmbiguousWidthWide()
  afterEach(() => setAmbiguousWidthWide(original))

  it('counts U+00B7 · as 2 cells when ambiguous renders wide', () => {
    setAmbiguousWidthWide(true)
    expect(visibleWidth('·')).toBe(2)
  })

  it('counts U+00B7 · as 1 cell when ambiguous renders narrow', () => {
    setAmbiguousWidthWide(false)
    expect(visibleWidth('·')).toBe(1)
  })

  it('strips ANSI before measuring either way', () => {
    setAmbiguousWidthWide(true)
    expect(visibleWidth('[31m·[0m')).toBe(2)
  })
})
