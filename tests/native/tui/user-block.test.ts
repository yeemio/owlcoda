import { describe, it, expect } from 'vitest'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../../../src/ink/stringWidth.js'
import { renderUserBlock } from '../../../src/native/tui/user-block.js'

function withCols<T>(cols: number, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true })
  try {
    return fn()
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'columns', desc)
  }
}

describe('renderUserBlock', () => {
  it('does not use the legacy ❯ prefix', () => {
    const out = renderUserBlock('hello')
    expect(out).not.toContain('❯')
  })

  it('uses the ▎ left accent bar', () => {
    const out = renderUserBlock('hello')
    expect(out).toContain('▎')
  })

  it('single-line input produces one row with accent + bg + space-pad + text', () => {
    const out = renderUserBlock('hello')
    // 256-color foreground set (accent)
    expect(out).toMatch(/\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/)
    // 256-color or 24-bit truecolor background set
    expect(out).toMatch(/\x1b\[48;(?:5;\d+|2;\d+;\d+;\d+)m/)
    // bg reset at end of row
    expect(out).toContain('\x1b[49m')
    // the text itself survives
    expect(out).toContain('hello')
    // space-padded to extend bg to row end (no longer EL)
    expect(out).not.toContain('\x1b[K')
    // trailing spaces before bgReset (pad to current cols)
    expect(out).toMatch(/hello {2,}\x1b\[49m/)
  })

  it('multi-line input produces stacked rows — one accent bar per line', () => {
    const out = renderUserBlock('line one\nline two\nline three')
    const barCount = (out.match(/▎/g) ?? []).length
    expect(barCount).toBe(3)
    expect(out).toContain('line one')
    expect(out).toContain('line two')
    expect(out).toContain('line three')
  })

  it('multi-line output stacks rows with newline separators', () => {
    const out = renderUserBlock('a\nb')
    // Two content rows → exactly one row-separator \n between them.
    const newlineCount = (out.match(/\n/g) ?? []).length
    expect(newlineCount).toBeGreaterThanOrEqual(1)
  })

  it('does NOT start with a leading \\n (would clash with Ink Static commit cursor)', () => {
    const out = renderUserBlock('x')
    expect(out.startsWith('\n')).toBe(false)
  })

  it('every short-content row has display width exactly cols-2 (matches ScrollableTranscript transcriptCols)', () => {
    // A2 regression guard for the re-wrap cropping: if a row's display
    // width exceeds transcriptCols (= cols - 2), getDisplayLines wraps
    // it, inflating line count and pushing older rows out of the
    // viewport budget. Keeping every row exactly at transcriptCols
    // stops the inflation at source.
    for (const cols of [60, 100, 160]) {
      withCols(cols, () => {
        const out = renderUserBlock('alpha\nbeta\ngamma')
        const rows = out.split('\n')
        expect(rows).toHaveLength(3)
        for (const row of rows) {
          const width = stringWidth(stripAnsi(row))
          expect(width).toBe(cols - 2)
        }
      })
    }
  })

  it('three-line input: every logical line emits exactly one row with its own ▎ — first row is not dropped', () => {
    // A2 regression guard. Previously the leading `\n` caused the
    // first content row to overlap with the previous transcript item
    // when Ink Static committed to scrollback, making alpha disappear
    // from the submitted user block while beta / gamma remained.
    const out = renderUserBlock('alpha line\nbeta line\ngamma line')
    // Split on \n first — every resulting row must contain a ▎ AND
    // the expected content in the expected order.
    const emittedRows = out.split('\n')
    expect(emittedRows).toHaveLength(3)
    expect(emittedRows[0]).toContain('▎')
    expect(emittedRows[0]).toContain('alpha line')
    expect(emittedRows[1]).toContain('▎')
    expect(emittedRows[1]).toContain('beta line')
    expect(emittedRows[2]).toContain('▎')
    expect(emittedRows[2]).toContain('gamma line')
  })

  it('preserves text content unchanged (no escape / no truncation)', () => {
    const weird = 'weird "chars" & <brackets> / slashes'
    const out = renderUserBlock(weird)
    expect(out).toContain(weird)
  })

  it('emits a full SGR reset at the end of every row so bg never bleeds into the next transcript item', () => {
    const out = renderUserBlock('a\nb\nc')
    // One \x1b[0m per row (three rows → three full resets).
    const fullResets = (out.match(/\x1b\[0m/g) ?? []).length
    expect(fullResets).toBe(3)
    // And bg-only reset precedes each full reset — order matters.
    expect(out).toMatch(/\x1b\[49m\x1b\[0m/)
  })

  it('bolds heading-like lines (end with : or ： and short) — adds \\x1b[1m around the label', () => {
    const out = renderUserBlock('新分发表：\n- item one\n- item two')
    // The heading line got bold; list items did not.
    const boldOns = (out.match(/\x1b\[1m/g) ?? []).length
    expect(boldOns).toBe(1)
    // And bold-off closes inside the bg span before the bg reset.
    expect(out).toMatch(/\x1b\[1m新分发表：\x1b\[22m/)
  })

  it('does not bold long sentences that happen to end with :', () => {
    const long = 'this is a long sentence that ends with a colon even though it is not really a section label:'
    const out = renderUserBlock(long)
    expect(out).not.toContain('\x1b[1m')
  })

  it('does not bold list-marker lines even when they end with : ', () => {
    const out = renderUserBlock('- 注意：')
    expect(out).not.toContain('\x1b[1m')
  })

  it('pre-wraps long logical lines so every emitted row has display width ≤ cols', () => {
    const longPath = 'gitrep/owlmom/prompts/OWLAPDS_2_EXECUTOR_DISPATCH_20260418.md:1 trailing'
    // Pad test across three column widths that commonly appear in the wild.
    for (const cols of [60, 100, 160]) {
      withCols(cols, () => {
        const out = renderUserBlock(longPath)
        // Split into emitted rows. Each row must be ≤ cols in display width.
        const rows = out.split('\n')
        for (const row of rows) {
          const width = stringWidth(stripAnsi(row))
          expect(width).toBeLessThanOrEqual(cols)
        }
        // And for a line that wraps, we must have produced at least two rows.
        if (longPath.length > cols) expect(rows.length).toBeGreaterThanOrEqual(2)
      })
    }
  })
})
