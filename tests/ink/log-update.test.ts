import { describe, it, expect } from 'vitest'
import { LogUpdate } from '../../src/ink/log-update.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
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

/** Build a frame whose logical screen has explicit (width × height) cells.
 *  Use when a test needs to exercise LF-advance / overflow paths. */
function makeFrameWithScreen(opts: {
  viewportRows: number
  viewportCols: number
  screenRows: number
  screenCols: number
}): Frame {
  return {
    screen: createScreen(opts.screenCols, opts.screenRows, stylePool, charPool, hyperlinkPool),
    viewport: { width: opts.viewportCols, height: opts.viewportRows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

function writeRow(frame: Frame, y: number, text: string): void {
  let x = 0
  for (const char of text) {
    setCellAt(frame.screen, x, y, {
      char,
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
    x++
    if (x >= frame.screen.width) break
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

  it('bulk LF burst clamps to viewport.height - 1 so paddedCommit-induced natural scrolls aren\'t double-counted', () => {
    // For rowCount=3, viewport.height=3: paddedCommit's embedded \n's
    // already push line1 into scrollback via natural-scroll (the embedded
    // \n after writing line2 lands on row 3 = bottom = scroll). The bulk
    // LF burst at CUP-to-bottom only needs viewport.height - 1 = 2 more
    // \n's to push line2 and line3 into scrollback. Emitting the full
    // rowCount=3 would over-scroll one BLANK row into scrollback (visible
    // to users as a stray blank line trailing every Static commit).
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
    // CUP to bottom row + clamped bulk newlines (exactly viewport.height - 1 = 2).
    expect(ansi).toMatch(/\x1b\[3;1H\n\n(?!\n)/)
  })

  it('rowCount > viewport.height: bulk LF burst capped at viewport.height - 1 (no blank-row overshoot)', () => {
    // The user-visible bug this guards against: a long assistant answer
    // splitter-emits 80+ lines as scrollback items, the resulting
    // staticCommit has rowCount=80, viewport.height=10. Without clamp,
    // bulk LF emits 80 \n's after CUP-to-bottom — but paddedCommit's
    // embedded \n's already scrolled 70 lines into scrollback during
    // the write, so only 9 more LFs are needed at the bottom. Emitting
    // 80 means 71 land on an empty viewport, scrolling 71 BLANK rows into
    // scrollback. Users observed this as a long whitespace strip in
    // scrollback after every long Static commit.
    const log = newLog()
    const prev = makeFrame({ rows: 10, cols: 20 })
    const longText = Array.from({ length: 80 }, (_, i) => `line${i}`).join('\n')
    const next = makeFrame({
      rows: 10,
      cols: 20,
      staticCommit: { text: longText, rowCount: 80 },
    })
    const diff = log.render(prev, next)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // After CUP-to-bottom, the bulk \n run is exactly viewport.height - 1 = 9.
    const m = ansi.match(/\x1b\[10;1H(\n+)/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBe(9)
  })

  it('staticCommit emits flickerMarker (telemetry) + in-place repaint, never \\x1b[2J', () => {
    // Contract after the safeFullRepaint refactor:
    //   - flickerMarker patch is emitted to the diff stream so onRender
    //     can record the full-repaint event into flickers[] telemetry.
    //   - writeDiffToTerminal emits ZERO bytes for the marker — no \x1b[2J
    //     reaches the main-screen byte stream.
    //   - The actual repaint ANSI is in-place (CUP + EL + content per row).
    const log = newLog()
    const prev = makeFrame({ rows: 3, cols: 10 })
    const next = makeFrame({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'x', rowCount: 1 },
    })
    const diff = log.render(prev, next)
    const hasMarker = diff.some(p => p.type === 'flickerMarker')
    expect(hasMarker).toBe(true)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    expect(ansi).not.toContain('\x1b[2J')
    expect(ansi).toMatch(/\x1b\[K/)
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
    const hasMarker = diff.some(p => p.type === 'flickerMarker')
    expect(hasMarker).toBe(false)
  })

  it('forceFullRepaint=true triggers safeFullRepaint — flickerMarker + in-place ANSI, no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrameWithScreen({ viewportRows: 3, viewportCols: 10, screenRows: 3, screenCols: 10 })
    const next = makeFrameWithScreen({ viewportRows: 3, viewportCols: 10, screenRows: 3, screenCols: 10 })
    const diff = log.render(prev, next, false, true, true)

    // safeFullRepaint always prefixes with a flickerMarker for telemetry.
    const marker = diff.find(p => p.type === 'flickerMarker')
    expect(marker).toBeDefined()
    if (marker?.type === 'flickerMarker') {
      expect(marker.reason).toBe('safe_repaint')
    }

    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // Killer ANSI absent.
    expect(ansi).not.toContain('\x1b[2J')
    // DECAWM bracket.
    expect(ansi).toContain('\x1b[?7l')
    expect(ansi).toContain('\x1b[?7h')
    // CUP(1,1) anchor.
    expect(ansi).toMatch(/\x1b\[1;1H/)
    // EL present (pre-EL + post-EL per row).
    expect(ansi).toMatch(/\x1b\[K/)
    // For a 3-row screen, exactly 2 LF advances between rows (last row has
    // no trailing LF — guards against scrolling the visible-bottom row out).
    const lfCount = (ansi.match(/\n/g) ?? []).length
    expect(lfCount).toBe(2)
  })

  it('forceFullRepaint paints the visible overflow window without scrollback side effects', () => {
    // Regression: safe repaint previously walked all logical screen rows
    // and relied on natural LF overflow to push hidden rows into terminal
    // scrollback. That made repaint a second scrollback owner: streamed tail
    // rows could enter physical scrollback first, then appear again when
    // Static committed the assistant turn.
    const log = newLog()
    const prev = makeFrameWithScreen({ viewportRows: 5, viewportCols: 10, screenRows: 5, screenCols: 10 })
    // Frame logical screen is taller than the viewport — overflow = 5.
    const next = makeFrameWithScreen({ viewportRows: 5, viewportCols: 10, screenRows: 10, screenCols: 10 })
    writeRow(next, 0, 'top-row')
    writeRow(next, 5, 'tail-5')
    writeRow(next, 9, 'tail-9')
    const diff = log.render(prev, next, false, true, true)
    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')

    // Only the bottom viewport-sized slice is repainted. Top overflow rows
    // are left to Static ownership, not pushed by repaint.
    expect(ansi).not.toContain('top-row')
    expect(ansi).toContain('tail-5')
    expect(ansi).toContain('tail-9')

    // 5 visible rows -> 4 LF advances. A 10-row logical screen must NOT
    // produce 9 LFs here, because that would scroll repaint-owned copies
    // into terminal scrollback.
    const lfCount = (ansi.match(/\n/g) ?? []).length
    expect(lfCount).toBe(4)
  })

  it('staticCommit + forceFullRepaint repaints viewport in-place (no second scrollback push)', () => {
    // Regression: every Static commit used to chain commitPatches with
    // fullResetSequence_CAUSES_FLICKER, which emits \x1b[2J. On Terminal.app /
    // iTerm2 that pushes the visible viewport (still containing the dynamic
    // pre-commit content) into scrollback alongside the intentionally-committed
    // text — every line in the dynamic region ended up twice in scrollback.
    // In safe_repaint mode, the post-commit repaint must use the in-place path.
    const log = newLog()
    const prev = makeFrame({ rows: 4, cols: 12 })
    const next = makeFrame({
      rows: 4,
      cols: 12,
      staticCommit: { text: 'committed', rowCount: 1 },
    })
    const diff = log.render(prev, next, false, true, true) // forceFullRepaint=true

    // safeFullRepaint emits a flickerMarker (no-op byte-wise, telemetry only)
    // — but the ANSI byte stream below must NOT contain \x1b[2J.
    const hasMarker = diff.some(p => p.type === 'flickerMarker')
    expect(hasMarker).toBe(true)

    const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
      .map(p => p.content).join('')
    // The commit text + scroll burst still emit (those are intentional
    // and necessary to push the commit lines into scrollback).
    expect(ansi).toContain('committed')
    expect(ansi).toContain('\x1b[1;1H') // commit text CUP
    // But the post-commit repaint must not emit the killer ED 2.
    const ed2Count = (ansi.match(/\x1b\[2J/g) ?? []).length
    expect(ed2Count).toBe(0)
    // Each visible row of the in-place repaint gets CUP + EL.
    expect(ansi).toMatch(/\x1b\[K/)
    expect(ansi).toMatch(/\x1b\[1;1H/) // viewport row 1
    expect(ansi).toMatch(/\x1b\[4;1H/) // viewport row 4 (last of 4-row viewport)
  })

  it('staticCommit always uses in-place repaint regardless of forceFullRepaint', () => {
    // Both cell-diff and safe_repaint modes go through the same in-place
    // repaint path on Static commits. The old fullResetSequence (ED 2 + LF
    // paint) would push the visible viewport into scrollback every commit,
    // producing × 2 line duplication observed even in the cell-diff default.
    const log = newLog()
    const prev = makeFrame({ rows: 4, cols: 12 })
    const next = makeFrame({
      rows: 4,
      cols: 12,
      staticCommit: { text: 'committed', rowCount: 1 },
    })

    for (const forceFullRepaint of [false, true]) {
      const diff = log.render(prev, next, false, true, forceFullRepaint)
      // staticCommit always routes through safeFullRepaint, so a marker
      // is always present (telemetry); but the byte stream is in-place.
      const hasMarker = diff.some(p => p.type === 'flickerMarker')
      expect(hasMarker).toBe(true)
      const ansi = diff.filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
        .map(p => p.content).join('')
      expect(ansi).not.toContain('\x1b[2J')
    }
  })

  it('forceFullRepaint produces bounded bytes across identical frames (no scrollback growth)', () => {
    // Regression: the previous safe_repaint path wrote O(viewport.height)
    // rows-into-scrollback per frame via LF-induced scroll, accumulating
    // under a 60Hz spinner into hundreds of duplicates of every line.
    // The in-place path must produce a fixed-size diff per identical
    // frame. We assert no growth across 10 identical paints.
    const log = newLog()
    const prev = makeFrame({ rows: 5, cols: 20 })
    const next = makeFrame({ rows: 5, cols: 20 })

    const sizes: number[] = []
    for (let i = 0; i < 10; i++) {
      const diff = log.render(prev, next, false, true, true)
      const bytes = diff
        .filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
        .map(p => p.content)
        .join('')
        .length
      sizes.push(bytes)
    }

    // All paints emit the same number of bytes (deterministic).
    const first = sizes[0]
    for (const b of sizes) {
      expect(b).toBe(first)
    }
    // And the byte count is bounded — no LF, no per-row payload that grows.
    expect(first).toBeLessThan(500)
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
    // Each line followed by \x1b[K before the CRLF (or at end for the last).
    expect(ansi).toContain('alpha\x1b[K\r\n')
    expect(ansi).toContain('beta\x1b[K\r\n')
    // Last line has its \x1b[K terminator too (before the extra \n below).
    expect(ansi).toContain('gamma\x1b[K')
  })

  it('separates static commit rows with CRLF so raw terminals return to column zero', () => {
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

    expect(ansi).toContain('alpha\x1b[K\r\nbeta\x1b[K\r\ngamma\x1b[K')
    expect(ansi).not.toContain('alpha\x1b[K\nbeta')
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
    const hasMarker = diff.some(p => p.type === 'flickerMarker')
    expect(hasMarker).toBe(false)
  })
})
