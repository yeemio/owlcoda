import { describe, it, expect } from 'vitest'
import { LogUpdate } from '../../src/ink/log-update.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
} from '../../src/ink/screen.js'

// Shared pools so the frames we build are internally consistent.
const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrame(opts: {
  rows: number
  cols: number
  staticCommit?: { text: string; rowCount: number }
}): Frame {
  const base = emptyFrame(opts.rows, opts.cols, stylePool, charPool, hyperlinkPool)
  return {
    ...base,
    viewport: { width: opts.cols, height: opts.rows },
    staticCommit: opts.staticCommit,
  }
}

function newLog(): LogUpdate {
  return new LogUpdate({ isTTY: true, stylePool })
}

describe('log.render staticCommit handling', () => {
  it('prepends CUP-positioned commit text when next.staticCommit is set', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'hello\nworld', rowCount: 2 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // CUP to (1,1) absolute top
    expect(ansi).toMatch(/\x1b\[1;1H/)
    // The commit text itself
    expect(ansi).toContain('hello')
    expect(ansi).toContain('world')
  })

  it('emits rowCount newlines at absolute bottom to scroll viewport down', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'line1\nline2\nline3', rowCount: 3 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // CUP to bottom row (H with row = viewport.height)
    expect(ansi).toMatch(/\x1b\[3;1H/)
    // rowCount consecutive newlines (3 in this case) after the bottom-CUP
    expect(ansi).toMatch(/\x1b\[3;1H[\s\S]*\n\n\n/)
  })

  it('forces full-reset (clearTerminal patch) for dynamic region after commit', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'x', rowCount: 1 },
    })
    const diff = log.render(prev, next)
    // Must include a clearTerminal patch signaling the dynamic region
    // gets repainted from scratch (scrollback-preserving clear per Task A).
    const hasClear = diff.some(p => p.type === 'clearTerminal')
    expect(hasClear).toBe(true)
  })

  it('does nothing special when next.staticCommit is absent (existing incremental diff path)', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({ rows: 3, cols: 10 })
    const diff = log.render(prev, next)
    // No static-commit-related CUP(1,1) should appear
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // Positive assertion: no CUP(1,1) from the commit prepend path
    expect(ansi).not.toMatch(/\x1b\[1;1H/)
    // Must not force a full-reset clearTerminal on an identical-frame input
    const hasClear = diff.some(p => p.type === 'clearTerminal')
    expect(hasClear).toBe(false)
  })

  it('prepends RESET_SCROLL_REGION (\\x1b[r) defensively before commit ANSI', () => {
    // Guards against a DECSTBM scroll region being set upstream: without
    // \x1b[r, the CUP-to-bottom + \n trick would loop inside the sub-
    // region rather than scrolling into terminal scrollback.
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'hi', rowCount: 1 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // \x1b[r must appear BEFORE the CUP(1,1) that positions the commit
    const resetIdx = ansi.indexOf('\x1b[r')
    const cupTopIdx = ansi.indexOf('\x1b[1;1H')
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(cupTopIdx).toBeGreaterThan(resetIdx)
  })

  // ── P0 commit-line contamination guard ──
  //
  // Without \x1b[K termination, each commit line overwrites only the
  // columns it physically emits into; any stale characters past the
  // commit text's width on the target row persist. When the \n burst
  // scrolls those rows into terminal scrollback, the stale tail is
  // baked in permanently as "<commit text><old row tail>" smear.
  // Real-machine QA reproduced this as "loopsmpted the model to
  // produce…" — a short summary line with the tail of a previously-
  // painted tool-status row showing through behind it.
  //
  // Fix: every commit line must end with \x1b[K (erase-in-line to
  // end of row) BEFORE the \n separator. Assert this in the emitted
  // ANSI so any future refactor that drops the padding fails the
  // test rather than silently re-introducing the smear.

  it('terminates every commit line with \\x1b[K so scrollback gets clean rows', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 5, cols: 40 })
    const next = makeFrame({
      rows: 5,
      cols: 40,
      staticCommit: { text: 'alpha\nbeta\ngamma', rowCount: 3 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // Each line followed by \x1b[K before the \n (or at end for the last).
    expect(ansi).toContain('alpha\x1b[K\n')
    expect(ansi).toContain('beta\x1b[K\n')
    // Last line has its \x1b[K terminator too (before the extra \n below).
    expect(ansi).toContain('gamma\x1b[K')
  })

  it('pads single-line commit text with \\x1b[K as well', () => {
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 20 })
    const next = makeFrame({
      rows: 3,
      cols: 20,
      staticCommit: { text: 'solo', rowCount: 1 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    expect(ansi).toContain('solo\x1b[K')
  })

  it('skips the commit path entirely when rowCount === 0 (no-op, no flicker)', () => {
    // An empty commit should not pay the full-reset flicker cost.
    // The incremental-diff path below is taken instead.
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: '', rowCount: 0 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // No CUP(1,1) from the commit prepend path
    expect(ansi).not.toMatch(/\x1b\[1;1H/)
    // No defensive \x1b[r either — the commit path wasn't entered
    expect(ansi).not.toContain('\x1b[r')
    // No forced full-reset
    const hasClear = diff.some(p => p.type === 'clearTerminal')
    expect(hasClear).toBe(false)
  })
})
