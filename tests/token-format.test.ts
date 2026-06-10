/**
 * Canonical compact token formatter + the status-bar CTX cell that uses it.
 *
 * Regression target: a 2M context window (e.g. 2*1024*1024 = 2_097_152) used
 * to render in the status bar as "2097.2k" — a misread-prone number. The fix
 * routes both the status-bar CTX cell and the model-window labels through one
 * canonical formatter that collapses clean M-multiples to whole "2M".
 */
import { describe, it, expect } from 'vitest'
import { formatTokenCompact, formatContextWindowShort } from '../src/model-capabilities.js'
import { renderComposerRail } from '../src/native/tui/message.js'
import { stripAnsi } from '../src/native/tui/colors.js'

describe('formatTokenCompact', () => {
  it('renders sub-1k counts raw', () => {
    expect(formatTokenCompact(0)).toBe('0')
    expect(formatTokenCompact(512)).toBe('512')
    expect(formatTokenCompact(999)).toBe('999')
  })

  it('renders k-scale with ≤1 decimal, dropping trailing .0', () => {
    expect(formatTokenCompact(1000)).toBe('1k')
    expect(formatTokenCompact(1800)).toBe('1.8k')
    expect(formatTokenCompact(103600)).toBe('103.6k')
    expect(formatTokenCompact(204800)).toBe('204.8k')
    expect(formatTokenCompact(256000)).toBe('256k')
  })

  it('renders M-scale, collapsing clean binary/decimal multiples to whole M', () => {
    expect(formatTokenCompact(1_000_000)).toBe('1M') // decimal 1M
    expect(formatTokenCompact(1_048_576)).toBe('1M') // binary 1Mi
    expect(formatTokenCompact(2_000_000)).toBe('2M') // decimal 2M
    expect(formatTokenCompact(2_097_152)).toBe('2M') // binary 2Mi — the "2M model" case
    expect(formatTokenCompact(1_500_000)).toBe('1.5M')
  })

  it('REGRESSION: a 2M window never renders as a big-k number', () => {
    const out = formatTokenCompact(2_097_152)
    expect(out).toBe('2M')
    expect(out).not.toMatch(/k$/)
    expect(out).not.toContain('2097')
  })
})

describe('formatContextWindowShort delegates to the canonical formatter', () => {
  it('appends " ctx" and stays consistent with formatTokenCompact', () => {
    expect(formatContextWindowShort(2_097_152)).toBe('2M ctx')
    expect(formatContextWindowShort(1_048_576)).toBe('1M ctx')
    expect(formatContextWindowShort(204800)).toBe('204.8k ctx')
    expect(formatContextWindowShort(256000)).toBe('256k ctx')
    expect(formatContextWindowShort(512)).toBe('512 ctx')
  })
})

describe('status-bar CTX cell (renderComposerRail) uses the canonical formatter', () => {
  const baseOpts = { model: 'kimi-code', columns: 200, contextTokens: 1800 }

  it('renders a 256k window as ".../256k"', () => {
    const rail = stripAnsi(renderComposerRail({ ...baseOpts, contextMax: 256_000 } as Parameters<typeof renderComposerRail>[0]))
    expect(rail).toContain('1.8k/256k')
  })

  it('REGRESSION: renders a 2M window as ".../2M", not "2097.2k"', () => {
    const rail = stripAnsi(renderComposerRail({ ...baseOpts, contextMax: 2_097_152 } as Parameters<typeof renderComposerRail>[0]))
    expect(rail).toContain('1.8k/2M')
    expect(rail).not.toContain('2097')
  })

  it('renders a 1M window as ".../1M"', () => {
    const rail = stripAnsi(renderComposerRail({ ...baseOpts, contextMax: 1_048_576 } as Parameters<typeof renderComposerRail>[0]))
    expect(rail).toContain('1.8k/1M')
  })
})
