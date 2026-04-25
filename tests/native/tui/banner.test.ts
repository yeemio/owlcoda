import { describe, it, expect } from 'vitest'
import { renderBanner, type BannerKind } from '../../../src/native/tui/banner.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

function expectWithinColumns(output: string, columns: number): void {
  for (const line of output.split('\n')) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
  }
}

describe('renderBanner', () => {
  it('renders all banner kinds with compact symbols', () => {
    const cases: Array<[BannerKind, string]> = [
      ['info', 'ⓘ'],
      ['ok', '✓'],
      ['warn', '⚠'],
      ['err', '✗'],
    ]

    for (const [kind, symbol] of cases) {
      const result = renderBanner({ kind, title: `${kind} title`, columns: 60 })
      const plain = stripAnsi(result)
      expect(plain).toContain(symbol)
      expect(plain).toContain(`${kind} title`)
      expectWithinColumns(result, 60)
    }
  })

  it('renders body text on the primary line when it fits', () => {
    const result = renderBanner({
      kind: 'info',
      title: 'Update available',
      body: 'Restart to use the new terminal UI',
      columns: 80,
    })

    const plain = stripAnsi(result)
    expect(plain).toContain('Update available')
    expect(plain).toContain('Restart to use the new terminal UI')
    expect(result.split('\n')).toHaveLength(1)
    expectWithinColumns(result, 80)
  })

  it('renders actions on the first line when width allows', () => {
    const result = renderBanner({
      kind: 'ok',
      title: 'Ready',
      actions: [
        { key: 'enter', label: 'continue', primary: true },
        { key: 'esc', label: 'dismiss' },
      ],
      columns: 80,
    })

    const plain = stripAnsi(result)
    expect(plain).toContain('[enter] continue')
    expect(plain).toContain('[esc] dismiss')
    expect(result.split('\n')).toHaveLength(1)
    expectWithinColumns(result, 80)
  })

  it('moves actions to a second line when the first line is full', () => {
    const result = renderBanner({
      kind: 'warn',
      title: 'Context nearly full',
      body: 'Compaction may be needed before the next long task',
      actions: [
        { key: 'c', label: 'compact', primary: true },
        { key: 'i', label: 'ignore' },
      ],
      columns: 44,
    })

    const lines = result.split('\n')
    const plain = stripAnsi(result)
    expect(lines).toHaveLength(2)
    expect(plain).toContain('Context nearly full')
    expect(plain).toContain('[c] compact')
    expectWithinColumns(result, 44)
  })

  it('truncates long body text at narrow widths', () => {
    const result = renderBanner({
      kind: 'err',
      title: 'Connection failed',
      body: 'The daemon did not respond before the terminal operation timed out',
      columns: 32,
    })

    const lines = result.split('\n')
    expect(lines).toHaveLength(1)
    expect(stripAnsi(result)).toContain('…')
    expectWithinColumns(result, 32)
  })

  it('clips very narrow action lines to the requested columns', () => {
    const result = renderBanner({
      kind: 'info',
      title: 'A very long title for a tight terminal',
      actions: [
        { key: 'return', label: 'accept and continue', primary: true },
        { key: 'escape', label: 'cancel' },
      ],
      columns: 18,
    })

    expect(result.split('\n').length).toBeLessThanOrEqual(2)
    expect(stripAnsi(result)).toContain('…')
    expectWithinColumns(result, 18)
  })
})
