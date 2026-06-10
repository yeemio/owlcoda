import { describe, it, expect } from 'vitest'
import { LogUpdate } from '../../src/ink/log-update.js'
import { type Frame } from '../../src/ink/frame.js'
import { writeDiffToTerminal } from '../../src/ink/terminal.js'
import {
  CharPool,
  CellWidth,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../../src/ink/screen.js'

// ─── Static commit row ownership ────────────────────────────────
//
// The contract:
//
//   When a Static commit fires, the commit text is owned by the SCROLLBACK
//   half of the frame. The dynamic viewport repaint that follows
//   (resetPatches via safeFullRepaint) must NOT reproduce the commit text
//   — its job is to paint the new visible-window content (which excludes
//   the just-committed items, since they've moved out of the visible
//   window into scrollback).
//
//   Concrete failure mode the test guards against: line × 2 duplication
//   in scrollback. Each Static commit used to push the commit text once
//   via the LF burst AND a viewport snapshot once via the resetPatches
//   ED 2. After safeFullRepaint replaced ED 2, the path emits the commit
//   text exactly once per commit and the dynamic repaint paints the new
//   frame.screen content (independent of the commit text).
//
//   The literal byte-stream invariant: the commit text appears exactly
//   ONCE in the rendered output for one commit.

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrameWithCommit(opts: {
  rows: number
  cols: number
  staticCommit: { text: string; rowCount: number }
  dynamicLines?: string[] // content for the visible window after commit
}): Frame {
  const screen = createScreen(opts.cols, opts.rows, stylePool, charPool, hyperlinkPool)
  if (opts.dynamicLines) {
    opts.dynamicLines.forEach((line, y) => {
      let x = 0
      for (const char of line) {
        if (x >= opts.cols) break
        setCellAt(screen, x, y, {
          char,
          styleId: stylePool.none,
          width: CellWidth.Narrow,
          hyperlink: undefined,
        })
        x += 1
      }
    })
  }
  return {
    screen,
    viewport: { width: opts.cols, height: opts.rows },
    cursor: { x: 0, y: 0, visible: true },
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

describe('Static commit row ownership', () => {
  it('commit text appears exactly once in the rendered byte stream (no double-write)', () => {
    const log = newLog()
    const prev = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: '', rowCount: 0 },
    })
    const next = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: 'COMMITTED_LINE', rowCount: 1 },
      dynamicLines: ['NEXT_VISIBLE_ROW'],
    })

    const diff = log.render(prev, next, false, true, false)
    const ansi = ansiOf(diff)

    // Commit text appears exactly once
    const commitMatches = ansi.match(/COMMITTED_LINE/g) ?? []
    expect(commitMatches.length).toBe(1)
    // The new visible content also appears (in the in-place repaint half)
    expect(ansi).toContain('NEXT_VISIBLE_ROW')
  })

  it('multi-line commit text does not duplicate any line', () => {
    const log = newLog()
    const prev = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: '', rowCount: 0 },
    })
    const next = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: 'LINE_A\nLINE_B\nLINE_C', rowCount: 3 },
    })

    const diff = log.render(prev, next, false, true, false)
    const ansi = ansiOf(diff)

    expect((ansi.match(/LINE_A/g) ?? []).length).toBe(1)
    expect((ansi.match(/LINE_B/g) ?? []).length).toBe(1)
    expect((ansi.match(/LINE_C/g) ?? []).length).toBe(1)
  })

  it('dynamic visible content does not echo the just-committed text', () => {
    // After Static commit, the committed item has logically moved from the
    // visible window into scrollback. The frame.screen passed to log.render
    // therefore should NOT contain the commit text — only the new visible
    // window's items. The repaint half must paint that new content
    // verbatim (independent of the commit text).
    const log = newLog()
    const prev = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: '', rowCount: 0 },
    })
    const next = makeFrameWithCommit({
      rows: 5,
      cols: 20,
      staticCommit: { text: 'OLD_ITEM', rowCount: 1 },
      dynamicLines: ['NEW_VISIBLE'],
    })

    const diff = log.render(prev, next, false, true, false)
    const ansi = ansiOf(diff)

    // The commit text appears once (from the commitPatches at top)
    expect((ansi.match(/OLD_ITEM/g) ?? []).length).toBe(1)
    // The new visible content appears in the repaint half
    expect(ansi).toContain('NEW_VISIBLE')
  })

  it('commit text and repaint go through one writeDiffToTerminal call (single buffered write)', () => {
    // The watermark-v2 invariant: commit ANSI and the post-commit repaint
    // ANSI ride in the SAME Diff, so writeDiffToTerminal sends them in one
    // buffered stdout.write — no race with the React reconciler's
    // commit-phase paint, no side-channel write that could land out of
    // order. Tests that the staticCommit branch returns a single Diff.
    const log = newLog()
    const prev = makeFrameWithCommit({
      rows: 3,
      cols: 10,
      staticCommit: { text: '', rowCount: 0 },
    })
    const next = makeFrameWithCommit({
      rows: 3,
      cols: 10,
      staticCommit: { text: 'X', rowCount: 1 },
    })

    const diff = log.render(prev, next, false, true, false)

    // Diff includes BOTH the commit ANSI and the safeFullRepaint marker.
    // They share the return value — caller emits in one buffered write.
    const hasCommit = diff.some(
      p => p.type === 'stdout' && p.content.includes('X'),
    )
    expect(hasCommit).toBe(true)
    const hasMarker = diff.some(p => p.type === 'flickerMarker')
    expect(hasMarker).toBe(true)
  })
})
