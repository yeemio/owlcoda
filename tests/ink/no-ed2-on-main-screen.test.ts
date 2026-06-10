import { describe, it, expect } from 'vitest'
import { LogUpdate } from '../../src/ink/log-update.js'
import { type Frame } from '../../src/ink/frame.js'
import { writeDiffToTerminal } from '../../src/ink/terminal.js'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
} from '../../src/ink/screen.js'

// ─── Main-screen \x1b[2J invariant ──────────────────────────────
//
// The contract we lock here:
//
//   The main screen never receives a literal \x1b[2J (ERASE_SCREEN, ED 2)
//   through the normal render path. ED 2 is only allowed via the explicit
//   exceptions: the user-driven /clear slash command and alt-screen lifecycle
//   (enter/exit/reenter alt). All other repaint scenarios — staticCommit,
//   forceFullRepaint, resize, offscreen drift detection, periodic_scrub,
//   forceRedraw — must route through safeFullRepaint() in log-update.ts and
//   produce in-place ANSI (CUP + EL + content per row).
//
// Each scenario below configures a real LogUpdate, drives it through
// log.render() with the conditions that historically triggered the
// fullResetSequence_CAUSES_FLICKER path, and asserts the byte stream is
// ED-2-free.

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrame(opts: {
  viewportRows: number
  viewportCols: number
  screenRows?: number
  screenCols?: number
  staticCommit?: { text: string; rowCount: number }
  cursorY?: number
}): Frame {
  const screenRows = opts.screenRows ?? opts.viewportRows
  const screenCols = opts.screenCols ?? opts.viewportCols
  return {
    screen: createScreen(screenCols, screenRows, stylePool, charPool, hyperlinkPool),
    viewport: { width: opts.viewportCols, height: opts.viewportRows },
    cursor: { x: 0, y: opts.cursorY ?? 0, visible: true },
    staticCommit: opts.staticCommit,
  }
}

function newLog(): LogUpdate {
  return new LogUpdate({ isTTY: true, stylePool })
}

function ansiOf(diff: ReturnType<LogUpdate['render']>): string {
  let output = ''
  writeDiffToTerminal(
    { stdout: { write: (chunk: string, cb?: () => void) => { output += chunk; cb?.(); return true } } } as never,
    diff,
    true,
  )
  return output
}

describe('main-screen \\x1b[2J invariant', () => {
  it('staticCommit (cell-diff mode) emits no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const next = makeFrame({
      viewportRows: 5,
      viewportCols: 20,
      staticCommit: { text: 'committed', rowCount: 1 },
    })
    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ false)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('staticCommit (safe_repaint mode) emits no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const next = makeFrame({
      viewportRows: 5,
      viewportCols: 20,
      staticCommit: { text: 'committed', rowCount: 1 },
    })
    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('forceFullRepaint (safe_repaint mode) emits no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const next = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('resize (viewport.height shrinks) emits no \\x1b[2J', () => {
    const log = newLog()
    // First render to seed prevFrame inside log-update
    const prev = makeFrame({ viewportRows: 8, viewportCols: 20 })
    const next = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const diff = log.render(prev, next, false, true, false)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('resize (viewport.width changes) emits no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const next = makeFrame({ viewportRows: 5, viewportCols: 30 })
    const diff = log.render(prev, next, false, true, false)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('offscreen drift (linesToClear > viewport) emits no \\x1b[2J', () => {
    const log = newLog()
    // prev.screen is taller than viewport — fakes overflow state
    const prev = makeFrame({
      viewportRows: 5,
      viewportCols: 20,
      screenRows: 30,
      cursorY: 30, // cursor at bottom of overflow
    })
    const next = makeFrame({ viewportRows: 5, viewportCols: 20, screenRows: 1 })
    const diff = log.render(prev, next, false, true, false)
    expect(ansiOf(diff)).not.toContain('\x1b[2J')
  })

  it('periodic_scrub (after SCRUB_EVERY_N_FRAMES frames) emits no \\x1b[2J', () => {
    const log = newLog()
    const prev = makeFrame({ viewportRows: 5, viewportCols: 20 })
    const next = makeFrame({ viewportRows: 5, viewportCols: 20 })
    // Drive enough renders to trigger the periodic_scrub branch
    // (SCRUB_EVERY_N_FRAMES = 240 currently). Past that, render must
    // still produce zero \x1b[2J.
    for (let i = 0; i < 250; i++) {
      const diff = log.render(prev, next, false, true, false)
      expect(ansiOf(diff)).not.toContain('\x1b[2J')
    }
  })

  it('all repaint paths emit a flickerMarker for telemetry but never byte-stream \\x1b[2J', () => {
    // Comprehensive: every scenario that emits a flickerMarker must NOT
    // emit \x1b[2J. Together this asserts the marker-vs-byte separation.
    const log = newLog()
    const scenarios: Array<{ label: string; run: () => ReturnType<LogUpdate['render']> }> = [
      {
        label: 'staticCommit',
        run: () => log.render(
          makeFrame({ viewportRows: 5, viewportCols: 20 }),
          makeFrame({
            viewportRows: 5,
            viewportCols: 20,
            staticCommit: { text: 'item', rowCount: 1 },
          }),
          false, true, false,
        ),
      },
      {
        label: 'forceFullRepaint',
        run: () => log.render(
          makeFrame({ viewportRows: 5, viewportCols: 20 }),
          makeFrame({ viewportRows: 5, viewportCols: 20 }),
          false, true, true,
        ),
      },
      {
        label: 'resize',
        run: () => log.render(
          makeFrame({ viewportRows: 8, viewportCols: 20 }),
          makeFrame({ viewportRows: 5, viewportCols: 20 }),
          false, true, false,
        ),
      },
    ]
    for (const { label, run } of scenarios) {
      const diff = run()
      const hasMarker = diff.some(p => p.type === 'flickerMarker')
      expect(hasMarker, `${label}: should emit flickerMarker`).toBe(true)
      const ansi = ansiOf(diff)
      expect(ansi, `${label}: byte stream contains \\x1b[2J`).not.toContain('\x1b[2J')
    }
  })
})
