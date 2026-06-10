import { describe, it, expect } from 'vitest'
import {
  sgr, fg, bg, fg256, bg256,
  stripAnsi, visibleWidth,
  getTheme, getThemeName, setTheme, resolveThemeSetting,
  themeColor, THEME_NAMES,
} from '../../../src/native/tui/colors.js'

describe('sgr', () => {
  it('has basic SGR codes', () => {
    expect(sgr.reset).toBe('\x1b[0m')
    expect(sgr.bold).toBe('\x1b[1m')
    expect(sgr.dim).toBe('\x1b[2m')
  })
})

describe('fg/bg', () => {
  it('generates truecolor foreground', () => {
    const result = fg(255, 0, 0)
    expect(result).toBe('\x1b[38;2;255;0;0m')
  })

  it('generates truecolor background', () => {
    const result = bg(0, 128, 255)
    expect(result).toBe('\x1b[48;2;0;128;255m')
  })
})

describe('fg256/bg256', () => {
  it('generates 256-color foreground', () => {
    expect(fg256(196)).toBe('\x1b[38;5;196m')
  })

  it('generates 256-color background', () => {
    expect(bg256(46)).toBe('\x1b[48;5;46m')
  })
})

describe('stripAnsi', () => {
  it('strips ANSI codes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello')
  })

  it('handles nested codes', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m')).toBe('bold green')
  })
})

describe('visibleWidth', () => {
  it('returns length for plain text', () => {
    expect(visibleWidth('hello')).toBe(5)
  })

  it('ignores ANSI codes', () => {
    expect(visibleWidth('\x1b[31mhello\x1b[0m')).toBe(5)
  })

  it('handles empty string', () => {
    expect(visibleWidth('')).toBe(0)
  })
})

describe('themes', () => {
  it('has 6 themes including daltonized', () => {
    expect(THEME_NAMES.length).toBe(6)
    expect(THEME_NAMES).toContain('dark-daltonized')
    expect(THEME_NAMES).toContain('light-daltonized')
  })

  it('can get/set theme', () => {
    const original = getThemeName()
    setTheme('light')
    expect(getThemeName()).toBe('light')
    setTheme(original)
  })

  it('can switch to daltonized themes', () => {
    const original = getThemeName()
    setTheme('dark-daltonized')
    expect(getThemeName()).toBe('dark-daltonized')
    setTheme('light-daltonized')
    expect(getThemeName()).toBe('light-daltonized')
    setTheme(original)
  })

  it('themeColor returns ANSI escape', () => {
    const color = themeColor('owl')
    expect(color).toContain('\x1b[')
  })

  it('themeColor returns string for all semantic tokens', () => {
    const tokens = ['text', 'textDim', 'owl', 'owlShimmer', 'success', 'warning', 'error', 'info'] as const
    for (const token of tokens) {
      expect(typeof themeColor(token)).toBe('string')
    }
  })

  it('daltonized themes use blue/orange instead of green/red', () => {
    const original = getThemeName()
    setTheme('dark-daltonized')
    const theme = getTheme()
    // Success should be blue-ish (not green)
    expect(theme.success).toMatch(/rgb\(\d+,\s*1[67]\d,\s*2[23]\d\)/)
    // Error should be orange-ish (not red)
    expect(theme.error).toMatch(/rgb\(2[23]\d,\s*1[56]\d,\s*[456]\d\)/)
    setTheme(original)
  })

  it('resolveThemeSetting handles auto', () => {
    const result = resolveThemeSetting('auto')
    expect(THEME_NAMES).toContain(result)
  })

  it('all themes have permission/planMode/bashBorder/spinnerBase tokens', () => {
    const original = getThemeName()
    for (const name of THEME_NAMES) {
      setTheme(name)
      const theme = getTheme()
      expect(theme.permission).toBeTruthy()
      expect(theme.bashBorder).toBeTruthy()
      expect(theme.planMode).toBeTruthy()
      expect(theme.fastMode).toBeTruthy()
      expect(theme.spinnerBase).toBeTruthy()
      expect(theme.spinnerStall).toBeTruthy()
      expect(theme.inlineCode).toBeTruthy()
      expect(theme.inlineCodeBg).toBeTruthy()
      // New R66 tokens
      expect(theme.subtle).toBeTruthy()
      expect(theme.suggestion).toBeTruthy()
      expect(theme.warningShimmer).toBeTruthy()
      expect(theme.merged).toBeTruthy()
      expect(theme.diffAddedDim).toBeTruthy()
      expect(theme.diffRemovedDim).toBeTruthy()
      expect(theme.promptBorderShimmer).toBeTruthy()
      expect(theme.userMsgBgHover).toBeTruthy()
      expect(theme.bashMsgBg).toBeTruthy()
      expect(theme.memoryBg).toBeTruthy()
      expect(theme.permissionShimmer).toBeTruthy()
      expect(theme.fastModeShimmer).toBeTruthy()
      expect(theme.autoAccept).toBeTruthy()
      expect(theme.briefLabelYou).toBeTruthy()
      expect(theme.briefLabelAssist).toBeTruthy()
      expect(theme.rateLimitFill).toBeTruthy()
      expect(theme.rateLimitEmpty).toBeTruthy()
    }
    setTheme(original)
  })

  it('themeColor resolves new tokens to ANSI escapes', () => {
    const tokens = [
      'permission', 'bashBorder', 'planMode', 'fastMode', 'spinnerBase', 'spinnerStall',
      'inlineCode', 'inlineCodeBg', 'subtle', 'suggestion', 'warningShimmer', 'merged',
      'diffAddedDim', 'diffRemovedDim', 'promptBorderShimmer', 'userMsgBgHover',
      'bashMsgBg', 'memoryBg', 'permissionShimmer', 'fastModeShimmer', 'autoAccept',
      'briefLabelYou', 'briefLabelAssist', 'rateLimitFill', 'rateLimitEmpty',
    ] as const
    for (const token of tokens) {
      const color = themeColor(token)
      expect(color).toContain('\x1b[')
    }
  })
})
