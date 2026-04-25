import { describe, it, expect } from 'vitest'
import { renderBox, renderSeparator, renderDivider, BORDER_STYLES, type BorderStyleName } from '../../../src/native/tui/box.js'
import { stripAnsi } from '../../../src/native/tui/colors.js'

describe('renderBox', () => {
  it('renders a basic box with content', () => {
    const result = renderBox(['Hello', 'World'])
    expect(result).toContain('Hello')
    expect(result).toContain('World')
    // Should have round borders by default
    expect(result).toContain('╭')
    expect(result).toContain('╰')
  })

  it('respects border style', () => {
    const result = renderBox(['test'], { border: 'sharp' })
    expect(result).toContain('┌')
    expect(result).toContain('└')
  })

  it('renders title in top border', () => {
    const result = renderBox(['content'], { title: 'My Title' })
    expect(stripAnsi(result)).toContain('My Title')
  })

  it('renders with specified width', () => {
    const result = renderBox(['line'], { width: 40 })
    const lines = result.split('\n')
    const topLine = stripAnsi(lines[0]!)
    expect(topLine.length).toBe(40)
  })

  it('handles empty content', () => {
    const result = renderBox([])
    expect(result).toContain('╭')
    expect(result).toContain('╰')
  })

  it('supports all border styles', () => {
    const styles: BorderStyleName[] = ['round', 'sharp', 'double', 'heavy', 'dashed', 'ascii', 'none']
    for (const style of styles) {
      const result = renderBox(['test'], { border: style })
      expect(result).toContain('test')
    }
  })
})

describe('renderSeparator', () => {
  it('renders a separator line', () => {
    const result = renderSeparator(20)
    expect(stripAnsi(result).length).toBeGreaterThanOrEqual(20)
  })
})

describe('BORDER_STYLES', () => {
  it('has all expected styles', () => {
    expect(BORDER_STYLES).toHaveProperty('round')
    expect(BORDER_STYLES).toHaveProperty('sharp')
    expect(BORDER_STYLES).toHaveProperty('double')
    expect(BORDER_STYLES).toHaveProperty('heavy')
    expect(BORDER_STYLES).toHaveProperty('ascii')
  })
})

describe('renderDivider', () => {
  it('renders a plain divider', () => {
    const result = renderDivider({ width: 40 })
    const plain = stripAnsi(result)
    expect(plain).toMatch(/^─{40}$/)
  })

  it('renders a divider with title centered', () => {
    const result = renderDivider({ width: 40, title: 'Hello' })
    const plain = stripAnsi(result)
    expect(plain).toContain(' Hello ')
    expect(plain).toContain('─')
    expect(plain.length).toBe(40)
  })

  it('uses custom character', () => {
    const result = renderDivider({ width: 20, char: '═' })
    const plain = stripAnsi(result)
    expect(plain).toMatch(/^═{20}$/)
  })
})
