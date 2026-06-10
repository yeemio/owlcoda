import { describe, it, expect } from 'vitest'
import { stringWidth } from '../../src/ink/stringWidth.js'

// Regression: bare default-text-presentation symbols (e.g. ⚠ U+26A0) render as
// width 1 in terminals (text presentation), but owlcoda's JS fallback routed
// every emoji-regex match through getEmojiWidth() → unconditional width 2.
// That over-counted ⚠ by one column, desyncing Ink's cell layout from the
// terminal and (in the scrollback commit pre-wrap) miscounting rowCount on any
// ⚠-bearing line near the viewport width.
//
// East Asian Width already encodes the correct default: default-text symbols are
// Narrow (1), default-emoji symbols are Wide (2). Only an explicit VS16 (U+FE0F)
// emoji-presentation selector forces width 2 on an otherwise-text symbol.
describe('stringWidth — emoji vs text presentation', () => {
  it('bare default-text symbols are width 1', () => {
    expect(stringWidth('⚠')).toBe(1) // U+26A0 WARNING SIGN, text default
  })

  it('VS16 forces emoji presentation → width 2', () => {
    expect(stringWidth('⚠️')).toBe(2) // ⚠️ emoji presentation
  })

  it('default-emoji-presentation BMP symbols stay width 2', () => {
    expect(stringWidth('⌚')).toBe(2) // U+231A WATCH
    expect(stringWidth('⭐')).toBe(2) // U+2B50 STAR
    expect(stringWidth('✅')).toBe(2) // U+2705 CHECK MARK BUTTON
  })

  it('astral emoji stay width 2', () => {
    expect(stringWidth('📝')).toBe(2) // U+1F4DD
  })

  it('owlcoda chrome glyphs keep width 1', () => {
    // These already passed; lock them so the fix does not regress chrome.
    for (const g of ['⎿', '✓', '✗', '▸', '●', '…', '↳', '│', '▎', 'ⓘ', '—']) {
      expect(stringWidth(g), `glyph ${g}`).toBe(1)
    }
  })

  it('a chrome line with ⚠ measures consistently (no off-by-one)', () => {
    // `⚠ MCP:` style warning line — width must match its visible cells.
    expect(stringWidth('⚠ x')).toBe(3) // 1 + 1(space) + 1
  })
})
