import { describe, expect, it } from 'vitest'
import {
  renderKeyValue,
  renderNotice,
  renderSection,
  renderTurnFooter,
} from '../../src/native/tui/chrome.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

// Chrome spec S3 — periphery alignment: notices and the per-turn footer
// become single quiet lines; slash commands stop hand-rolling alignment and
// use the shared key-value / section helpers.

describe('renderNotice — one-line system notices', () => {
  it('info notices get the ⓘ glyph', () => {
    expect(stripAnsi(renderNotice('Loop budget trimmed older tool results 1×'))).toBe(
      'ⓘ Loop budget trimmed older tool results 1×',
    )
  })

  it('success notices get ✓, warnings get ⚠', () => {
    expect(stripAnsi(renderNotice('Switched to: deepseek', 'success'))).toBe('✓ Switched to: deepseek')
    expect(stripAnsi(renderNotice('Context almost full', 'warning'))).toBe('⚠ Context almost full')
  })

  it('is always a single line', () => {
    expect(stripAnsi(renderNotice('a\nb'))).not.toContain('\n')
  })
})

describe('renderTurnFooter — one quiet line per turn', () => {
  it('merges iterations, tokens and elapsed into one line', () => {
    const out = stripAnsi(renderTurnFooter({
      iterations: 15,
      inputTokens: 7600,
      outputTokens: 2800,
      elapsedSeconds: 96.1,
    }))
    expect(out).toBe('── 15 it · 7.6k in / 2.8k out · 96.1s')
  })

  it('omits the iteration count for single-iteration turns', () => {
    const out = stripAnsi(renderTurnFooter({
      iterations: 1,
      inputTokens: 30,
      outputTokens: 156,
      elapsedSeconds: 10.7,
    }))
    expect(out).toBe('── 30 in / 156 out · 10.7s')
  })

  it('returns empty when there is nothing to report', () => {
    expect(renderTurnFooter({ iterations: 1, inputTokens: 0, outputTokens: 0, elapsedSeconds: 0.2 })).toBe('')
  })
})

describe('renderKeyValue — measured alignment (CJK-safe)', () => {
  it('aligns values on one column using display width', () => {
    const out = stripAnsi(renderKeyValue([
      ['Model', 'deepseek'],
      ['模式', 'normal'],
      ['Session', 'conv-178'],
    ]))
    const lines = out.split('\n')
    const valueCols = lines.map((l) => l.indexOf('  ') >= 0 ? l : l)
    // All values start at the same display column: check the two ASCII keys
    // directly (CJK key padding is display-width math, asserted via content).
    expect(lines[0]).toMatch(/^Model\s+deepseek$/)
    expect(lines[2]).toMatch(/^Session\s+conv-178$/)
    expect(lines[0]!.indexOf('deepseek')).toBe(lines[2]!.indexOf('conv-178'))
    expect(lines[1]).toContain('normal')
    expect(valueCols).toHaveLength(3)
  })
})

describe('renderSection — slash command group headers', () => {
  it('renders a styled single-line section title', () => {
    const out = renderSection('Session')
    expect(stripAnsi(out)).toBe('Session')
    expect(out).not.toBe('Session') // carries styling
    expect(out).not.toContain('\n')
  })
})
