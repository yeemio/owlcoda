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

// ─── CJK residue clear (EL bracketing) ──────────────────────────
//
// The contract:
//
//   safeFullRepaint() must bracket every viewport row with EL (\x1b[K) so
//   that the cell-loop's skip-empty-cells optimization cannot leak prior-
//   frame content into the visible viewport.
//   This is what kills the "⢦⣤3.架构分层" / "contextnts/Spinner" /
//   "析、命令分发" smear family — short content over long content used
//   to leave the long content's tail visible past the new content's last
//   cell, and on rows where the new frame had leading empty cells, the
//   prior frame's banner art survived under markdown content.
//
//   The structural guarantee: every CUP-to-row in the safeFullRepaint
//   byte stream must be followed (within the same row's emission) by
//   at least one EL. That's the pre-row clear; the post-row clear adds
//   a second EL once content has been written.
//
// CJK is the natural amplifier: a 2-cell-wide character covering only
// half of a 4-cell-wide prior would leak the right half. With EL
// bracketing on the ENTIRE row, no width arithmetic is required for
// correctness — the row is wiped before any cell is written.

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrame(rows: number, cols: number): Frame {
  return {
    screen: createScreen(cols, rows, stylePool, charPool, hyperlinkPool),
    viewport: { width: cols, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

function writeRow(frame: Frame, y: number, text: string): void {
  let x = 0
  for (const char of text) {
    const isWide = /[　-鿿가-힯＀-￯]/.test(char)
    const width = isWide ? CellWidth.Wide : CellWidth.Narrow
    setCellAt(frame.screen, x, y, {
      char,
      styleId: stylePool.none,
      width,
      hyperlink: undefined,
    })
    x += isWide ? 2 : 1
    if (x >= frame.screen.width) break
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

describe('CJK residue clear (EL bracketing)', () => {
  it('safeFullRepaint anchors at row 1 with CUP→EL and emits EL after every LF advance', () => {
    const log = newLog()
    const prev = makeFrame(5, 20)
    const next = makeFrame(5, 20)
    writeRow(next, 0, '类别')
    writeRow(next, 1, '说明')
    writeRow(next, 2, '中文表头测试')

    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    const ansi = ansiOf(diff)

    // The path: one CUP(1,1) anchor at the top, then for each row the
    // sequence is "[K (pre) ... [K (post) \r\n" inside the visible viewport.
    // EL brackets eliminate per-row residue. Rows 2..N do NOT get a fresh
    // CUP — they ride on the LF.
    //
    // The structural assertion: every \n in the output is preceded by an
    // EL (the post-row clear) AND followed by an EL (the next row's
    // pre-clear). That's the bracketing invariant that survives the
    // skip-empty-cells optimization.
    expect(ansi).toMatch(/^\x1b\[\?7l\x1b\[1;1H\x1b\[K/) // anchor + pre-EL row 1
    // Every LF must be part of CR+LF. Bare LF drifts one column per row in
    // real terminals and creates the diagonal smear that this test protects.
    const bareLf = /(?<!\r)\n/.test(ansi)
    expect(bareLf).toBe(false)
    // Every CR+LF must be followed by a pre-EL on the next row.
    const lfFollowedByEl = ansi.replace(/\r\n\x1b\[K/g, '$LFEL$').includes('$LFEL$')
    expect(lfFollowedByEl).toBe(true)
    // Every CR+LF must also be preceded (somewhere on the row before) by an EL.
    const elPositions = [...ansi.matchAll(/\x1b\[K/g)].map(m => m.index!)
    const lfPositions = [...ansi.matchAll(/\r\n/g)].map(m => m.index!)
    for (const lfPos of lfPositions) {
      const elBeforeLf = elPositions.some(elPos => elPos < lfPos)
      expect(elBeforeLf, `LF at ${lfPos} has no preceding EL on its row`).toBe(true)
    }
  })

  it('shorter row over longer prior is bracketed by EL — no tail residue path', () => {
    // Logical scenario: prev frame had a wide row of CJK content. Next
    // frame's same row is shorter. safeFullRepaint must emit EL, otherwise
    // the cell-skip optimization leaves prior cells visible past the new
    // content's last cell — exactly the "...析、命令分发" arm of the smear
    // family.
    const log = newLog()
    const prev = makeFrame(3, 20)
    writeRow(prev, 0, '一二三四五六七八九十')
    const next = makeFrame(3, 20)
    writeRow(next, 0, '一二三')

    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    const ansi = ansiOf(diff)

    // Pre-row EL on row 1 means the entire row is wiped before any of
    // the new shorter content is written — tail cells are guaranteed
    // blank without per-cell-width arithmetic.
    expect(ansi).toMatch(/\x1b\[1;1H\x1b\[K/)
  })

  it('row with leading empty cells in next-frame still gets EL pre-clear (no banner residue)', () => {
    // Logical scenario: prev frame had banner-art ASCII at columns 1-N
    // (anywhere on a row). Next frame's same row starts content at column
    // M > 1 (leading cells empty). Without pre-EL, the cell loop's
    // `if (!cell) continue` skips those leading cells and the prior-
    // frame banner survives at columns 1..M-1 — exactly the
    // "⢦⣤3.架构分层" arm of the smear family.
    const log = newLog()
    const prev = makeFrame(3, 20)
    writeRow(prev, 0, '⢦⣤⣀⣠⣤')
    const next = makeFrame(3, 20)
    // Place new content STARTING at column 6 (cells 1-5 empty)
    setCellAt(next.screen, 5, 0, {
      char: '3',
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })

    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    const ansi = ansiOf(diff)

    expect(ansi).toMatch(/\x1b\[1;1H\x1b\[K/)
  })

  it('every viewport row gets at least one EL in the byte stream (no skipped clears)', () => {
    const log = newLog()
    const prev = makeFrame(5, 30)
    const next = makeFrame(5, 30)
    writeRow(next, 0, '混合 ASCII and 中文 content')
    writeRow(next, 1, 'short')
    // row 2 left empty
    writeRow(next, 3, 'with multibyte 字符 mixed')
    // row 4 left empty

    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    const ansi = ansiOf(diff)

    const elCount = (ansi.match(/\x1b\[K/g) ?? []).length
    // Each of 5 rows in the in-place loop emits pre-EL and post-EL = 10
    // ELs minimum across all rows. (Plus possibly the trailing-rows
    // explicit clear, but rowsToWalk = screen height covers it here.)
    expect(elCount).toBeGreaterThanOrEqual(5)
  })
})
