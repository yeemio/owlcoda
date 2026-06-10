import { describe, it, expect } from 'vitest'
import { authoringTokensFor } from '../../../src/native/tui/theme-tokens.js'
import { THEME_NAMES } from '../../../src/native/tui/colors.js'

describe('authoringTokensFor', () => {
  it('returns non-empty tokens for every ThemeName', () => {
    for (const name of THEME_NAMES) {
      const tokens = authoringTokensFor(name)
      expect(tokens.accent.length).toBeGreaterThan(0)
      expect(tokens.bg.length).toBeGreaterThan(0)
      expect(tokens.bgReset).toBe('\x1b[49m')
      expect(tokens.dim.length).toBeGreaterThan(0)
    }
  })

  it('accent and bg differ — they are different ANSI escapes', () => {
    const tokens = authoringTokensFor(THEME_NAMES[0]!)
    expect(tokens.accent).not.toBe(tokens.bg)
  })

  it('accent uses a 256-color or 24-bit truecolor foreground escape', () => {
    const tokens = authoringTokensFor(THEME_NAMES[0]!)
    expect(tokens.accent).toMatch(/^\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m$/)
  })

  it('bg uses a 256-color or 24-bit truecolor background escape', () => {
    const tokens = authoringTokensFor(THEME_NAMES[0]!)
    expect(tokens.bg).toMatch(/^\x1b\[48;(?:5;\d+|2;\d+;\d+;\d+)m$/)
  })
})
