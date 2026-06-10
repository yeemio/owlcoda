import { afterEach, describe, expect, it } from 'vitest'
import {
  stringWidth,
  setAmbiguousWidthWide,
  isAmbiguousWidthWide,
  interpretAmbiguousWidthProbe,
  applyAmbiguousWidthLocaleFallback,
} from '../../src/ink/stringWidth.js'

// ─── East-Asian Ambiguous width is terminal-dependent ───────────────
//
// Dogfood 2026-06-03: a pasted rubric echoed after send showed table
// rows with ambiguous glyphs (→ ≤ ⚠ │ ● …) garbled/cut while a
// neighboring row with none rendered cleanly. Root cause: stringWidth
// hardcoded ambiguousAsWide:false, but a CJK-locale terminal renders
// those glyphs at width 2. owlcoda's pad/wrap/table-column math then
// under-counts those rows by 1-2 cells, desyncing the virtual screen
// from the physical terminal → drift, truncation, duplication.
//
// The width must be SETTABLE (default narrow, unchanged) so a startup
// probe (or env override) can match the actual terminal.

describe('ambiguous-width setting', () => {
  afterEach(() => setAmbiguousWidthWide(false))

  it('defaults to narrow (width 1) — preserves existing Western behavior', () => {
    setAmbiguousWidthWide(false)
    expect(stringWidth('→')).toBe(1)
    expect(stringWidth('≤')).toBe(1)
    expect(stringWidth('●')).toBe(1)
    expect(isAmbiguousWidthWide()).toBe(false)
  })

  it('treats ambiguous glyphs as wide (width 2) when set — matches a CJK terminal', () => {
    setAmbiguousWidthWide(true)
    expect(stringWidth('→')).toBe(2)
    expect(stringWidth('≤')).toBe(2)
    expect(stringWidth('●')).toBe(2)
    expect(isAmbiguousWidthWide()).toBe(true)
  })

  it('keeps box-drawing + block-element chrome NARROW even in wide mode', () => {
    // These are East-Asian Ambiguous too, but terminals render them narrow
    // even in CJK locale (otherwise TUI boxes break), and owlcoda's
    // table-border / accent-bar math hardcodes width 1. They must NOT follow
    // the wide flag — only "real" ambiguous symbols (→ ≤ ● …) do.
    setAmbiguousWidthWide(true)
    expect(stringWidth('│')).toBe(1) // box-drawing vertical (U+2502)
    expect(stringWidth('─')).toBe(1) // box-drawing horizontal (U+2500)
    expect(stringWidth('┌')).toBe(1) // box-drawing corner (U+250C)
    expect(stringWidth('├')).toBe(1) // box-drawing tee (U+251C)
    expect(stringWidth('▎')).toBe(1) // block element / accent bar (U+258E)
    expect(stringWidth('█')).toBe(1) // full block (U+2588)
  })

  it('does not affect unambiguous widths (ASCII narrow, CJK wide) either way', () => {
    for (const wide of [false, true]) {
      setAmbiguousWidthWide(wide)
      expect(stringWidth('a')).toBe(1) // ASCII narrow
      expect(stringWidth('恒')).toBe(2) // CJK wide
      expect(stringWidth('（')).toBe(2) // fullwidth paren wide
    }
  })

  it('shifts a whole ambiguous-laden row by its ambiguous-glyph count', () => {
    // The actual rubric row 16 that got cut, vs row 15 that did not.
    const row16 = '| 16 | 恒隆→详细（两步） | **上下文连贯** | 单命中能接上；多命中反问=已知行为 |'
    const row15 = '| 15 | 纸杯 | 多命中 | 列多个工单 + 提示『详细+工单号』 |'
    setAmbiguousWidthWide(false)
    const n16 = stringWidth(row16)
    const n15 = stringWidth(row15)
    setAmbiguousWidthWide(true)
    // row 16 has one ambiguous glyph (→) and one ambiguous '=' is ASCII (narrow
    // both ways); width grows by exactly the ambiguous-glyph count.
    expect(stringWidth(row16)).toBe(n16 + 1)
    // row 15 has no ambiguous glyphs — width is identical under both settings.
    expect(stringWidth(row15)).toBe(n15)
  })
})

describe('interpretAmbiguousWidthProbe', () => {
  // The probe writes ONE ambiguous glyph at a known column and reads the
  // cursor column back via DSR. delta === 2 → terminal renders ambiguous wide.
  it('reports wide when the cursor advanced 2 columns', () => {
    expect(interpretAmbiguousWidthProbe(10, 12)).toBe(true)
  })
  it('reports narrow when the cursor advanced 1 column', () => {
    expect(interpretAmbiguousWidthProbe(10, 11)).toBe(false)
  })
  it('returns null (undetermined) for an implausible delta — caller keeps default', () => {
    expect(interpretAmbiguousWidthProbe(10, 10)).toBe(null)
    expect(interpretAmbiguousWidthProbe(10, 14)).toBe(null)
    expect(interpretAmbiguousWidthProbe(5, 2)).toBe(null) // wrapped/garbage
  })
})

describe('applyAmbiguousWidthLocaleFallback', () => {
  afterEach(() => setAmbiguousWidthWide(false))

  it('switches to wide for CJK locales when the terminal probe is undetermined', () => {
    setAmbiguousWidthWide(false)

    expect(
      applyAmbiguousWidthLocaleFallback({
        LC_CTYPE: 'zh_CN.UTF-8',
      }),
    ).toBe(true)
    expect(isAmbiguousWidthWide()).toBe(true)
    expect(stringWidth('→')).toBe(2)
  })

  it('keeps narrow for non-CJK locales when the terminal probe is undetermined', () => {
    setAmbiguousWidthWide(false)

    expect(
      applyAmbiguousWidthLocaleFallback({
        LANG: 'en_US.UTF-8',
      }),
    ).toBe(false)
    expect(isAmbiguousWidthWide()).toBe(false)
    expect(stringWidth('→')).toBe(1)
  })
})
