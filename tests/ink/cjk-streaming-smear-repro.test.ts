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

// ─────────────────────────────────────────────────────────────────────────
// Bug 3 #3 repro harness — streaming CJK "row N tail + row N+1 head collide"
// smear in the MINIMAL CELL-DIFF repaint path (forceFullRepaint=false).
//
// Why a new harness: the existing CJK coverage (cjk-residual.test.ts) only
// exercises the SAFE forceFullRepaint path (inplaceFullRepaintSequence: per-row
// CUP+EL+CR+LF, EL-bracketed — proven correct). The kimi-dogfood scramble
// ("保留 Harness 术语" rendering as "语，但后置…") is in the minimal cell-diff
// path (the render() VirtualScreen relative-move tracking), which the LogUpdate
// source itself flags as able to drift from the physical terminal (only a
// 240-frame periodic scrub mitigates it). No CJK VT has ever driven that path.
//
// This harness provides:
//   1. A CJK-WIDTH-AWARE virtual terminal (the scrollback-smear-repro VT is
//      1-cell-per-char; CJK needs wide=2 cells, plus the relative-move ANSI
//      vocabulary the cell-diff path emits: CHA/CUU/CUD/CUF/CUB).
//   2. A driver that renders a SEQUENCE of frames through the cell-diff path and
//      applies each Diff to the VT.
//   3. Scenarios that stream CJK assistant text and assert the visible+scrollback
//      rows reconstruct the intended lines (no head-overwrite collide).
// ─────────────────────────────────────────────────────────────────────────

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

const SPACER = '' // right half of a wide char — contributes nothing when joined

function isWide(char: string): boolean {
  return /[　-鿿가-힯＀-￯]/.test(char)
}

// East-Asian *Ambiguous*-width characters: width 1 under ambiguousAsWide:false
// (what ink's stringWidth uses for layout), but width 2 in a CJK terminal/font.
// Box-drawing │ ─ ┼ etc. (used in owlcoda's table rendering) are the common
// case — a table immediately preceded the smeared kimi conclusion.
function isAmbiguous(char: string): boolean {
  const cp = char.codePointAt(0)!
  return (
    (cp >= 0x2500 && cp <= 0x257f) || // box drawing
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows
    cp === 0x00b7 || cp === 0x2022 || // middle dot, bullet
    (cp >= 0x2460 && cp <= 0x24ff)    // enclosed alphanumerics
  )
}

function makeFrame(rows: number, cols: number, cursorY = 0): Frame {
  return {
    screen: createScreen(cols, rows, stylePool, charPool, hyperlinkPool),
    viewport: { width: cols, height: rows },
    cursor: { x: 0, y: cursorY, visible: true },
  }
}

function writeRow(frame: Frame, y: number, text: string): void {
  let x = 0
  for (const char of text) {
    const wide = isWide(char)
    setCellAt(frame.screen, x, y, {
      char,
      styleId: stylePool.none,
      width: wide ? CellWidth.Wide : CellWidth.Narrow,
      hyperlink: undefined,
    })
    x += wide ? 2 : 1
    if (x >= frame.screen.width) break
  }
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

/**
 * CJK-width-aware VT. Wide chars occupy 2 columns (glyph at x, SPACER at x+1,
 * cursor advances 2). Models the full relative-move vocabulary the cell-diff
 * path emits, so a cursor-forward that miscounts a wide char as 1 column lands
 * the next write on the wide char's right half — the collide that produces the
 * smear.
 */
class CJKVT {
  width: number
  height: number
  grid: string[][]
  scrollback: string[] = []
  x = 0
  y = 0
  autowrap = true
  ambiguousWide: boolean

  constructor(width: number, height: number, ambiguousWide = false) {
    this.width = width
    this.height = height
    this.ambiguousWide = ambiguousWide
    this.grid = Array.from({ length: height }, () => Array(width).fill(' '))
  }

  /** Display width AS THE TERMINAL RENDERS IT (may differ from ink's layout). */
  private charCells(ch: string): number {
    if (isWide(ch)) return 2
    if (this.ambiguousWide && isAmbiguous(ch)) return 2
    return 1
  }

  private scrollUp(): void {
    this.scrollback.push(this.grid[0]!.join('').replace(/\s+$/, ''))
    this.grid.shift()
    this.grid.push(Array(this.width).fill(' '))
  }

  private lineFeed(): void {
    if (this.y >= this.height - 1) this.scrollUp()
    else this.y++
  }

  write(bytes: string): void {
    let i = 0
    while (i < bytes.length) {
      const ch = bytes[i]!
      if (ch === '\x1b') {
        if (bytes[i + 1] === '[') {
          let j = i + 2
          let params = ''
          while (j < bytes.length && /[0-9;?]/.test(bytes[j]!)) { params += bytes[j]!; j++ }
          this.csi(params, bytes[j]!)
          i = j + 1
          continue
        }
        if (bytes[i + 1] === ']') {
          // OSC (e.g. hyperlink) — skip to BEL or ST
          let j = i + 2
          while (j < bytes.length && bytes[j] !== '\x07' && !(bytes[j] === '\x1b' && bytes[j + 1] === '\\')) j++
          i = bytes[j] === '\x07' ? j + 1 : j + 2
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') { this.x = 0; i++; continue }
      if (ch === '\n') { this.x = 0; this.lineFeed(); i++; continue }
      // Printable
      const need = this.charCells(ch)
      const wide = need === 2
      if (this.x + need > this.width) {
        if (this.autowrap) { this.x = 0; this.lineFeed() }
        else { this.x = this.width - need }
      }
      this.grid[this.y]![this.x] = ch
      if (wide) this.grid[this.y]![this.x + 1] = SPACER
      this.x += need
      i++
    }
  }

  private csi(params: string, final: string): void {
    const n = Math.max(1, parseInt(params || '1', 10) || 1)
    switch (final) {
      case 'H': {
        const [r = '1', c = '1'] = params.split(';')
        this.y = Math.min(this.height - 1, Math.max(0, parseInt(r, 10) - 1))
        this.x = Math.min(this.width - 1, Math.max(0, parseInt(c, 10) - 1))
        return
      }
      case 'G': this.x = Math.min(this.width - 1, Math.max(0, (parseInt(params || '1', 10) || 1) - 1)); return // CHA absolute column
      case 'A': this.y = Math.max(0, this.y - n); return
      case 'B': this.y = Math.min(this.height - 1, this.y + n); return
      case 'C': this.x = Math.min(this.width - 1, this.x + n); return // CUF
      case 'D': this.x = Math.max(0, this.x - n); return // CUB
      case 'K': { for (let c = this.x; c < this.width; c++) this.grid[this.y]![c] = ' '; return }
      case 'm': return
      case 'h': if (params === '?7') this.autowrap = true; return
      case 'l': if (params === '?7') this.autowrap = false; return
      case 'r': return
      case 'S': for (let k = 0; k < n; k++) this.scrollUp(); return
      case 'J':
        if (params === '2' || params === '') this.grid = Array.from({ length: this.height }, () => Array(this.width).fill(' '))
        return
      default: return
    }
  }

  allRows(): string[] {
    return [
      ...this.scrollback,
      ...this.grid.map(r => r.join('').replace(/\s+$/, '')),
    ]
  }
}

/** Render a sequence of frames through the MINIMAL cell-diff path (forceFullRepaint=false). */
function streamThroughCellDiff(frames: Frame[], cols: number, rows: number, ambiguousWide = false): CJKVT {
  const log = new LogUpdate({ isTTY: true, stylePool })
  const vt = new CJKVT(cols, rows, ambiguousWide)
  let prev = makeFrame(rows, cols)
  // prime
  log.render(makeFrame(rows, cols), prev, false, true, false)
  for (const next of frames) {
    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ false)
    vt.write(ansiOf(diff))
    prev = next
  }
  return vt
}

// FINDING (v0.14.53): none of the scenarios below reproduce the kimi-dogfood
// smear. The cell-diff path emits RELATIVE cursor moves (CUF/CUB) that ride on
// real character writes — so after writing CJK/ambiguous-width content the
// cursor sits at the TRUE terminal column, and the next relative skip lands
// correctly even when ink's cell-index width disagrees with the terminal's
// render width. (Probe: append after "│ 表 │ 保留" emits `CUF 11` from the
// post-write cursor, which is column 13 in a CJK terminal — exactly the append
// point.) These tests therefore stand as REGRESSION GUARDS: if someone replaces
// a relative move with a cell-index ABSOLUTE position (CHA/CUP) over CJK or
// ambiguous content, the self-correction breaks and these go red. Reproducing
// the original smear needs a captured frame sequence (OWLCODA_DEBUG_MD_RAW from
// a live repro) — synthetic single-/few-frame scenarios do not trigger it.
describe('Bug 3 #3 — CJK cell-diff repaint regression guards (smear prevention)', () => {
  it('a single CJK row updated via cell-diff renders intact (no wide-char collide)', () => {
    const cols = 40
    const rows = 6
    const f1 = makeFrame(rows, cols)
    writeRow(f1, 0, '保留 Harness 术语，但后置')
    const f2 = makeFrame(rows, cols)
    writeRow(f2, 0, '保留 Harness 术语，但后置，降低陌生感')

    const vt = streamThroughCellDiff([f1, f2], cols, rows)
    const rowsOut = vt.allRows()
    expect(
      rowsOut.some(r => r.includes('保留 Harness 术语，但后置，降低陌生感')),
      `rows=${JSON.stringify(rowsOut)}`,
    ).toBe(true)
  })

  it('streamed CJK conclusion (growing past the viewport) reconstructs every line in order', () => {
    const cols = 44
    const rows = 5
    const lines = [
      '这个标题比原版的改进：',
      '"动手之前"呼应文章里反复讲的问题',
      '保留 Harness 术语，但后置，降低陌生感',
      '整体更短、更利落',
      '需要再调，告诉我。如果你有偏好的方向',
    ]
    // Stream: frame k shows the first k lines (assistant text growing line by line).
    const frames: Frame[] = []
    for (let k = 1; k <= lines.length; k++) {
      const h = Math.max(rows, k) // grow the screen as lines accumulate (overflow → scroll)
      const f = makeFrame(h, cols, Math.min(h - 1, k - 1))
      // re-create screen at height h
      const screen = createScreen(cols, h, stylePool, charPool, hyperlinkPool)
      const frame: Frame = { screen, viewport: { width: cols, height: rows }, cursor: { x: 0, y: Math.min(h - 1, k - 1), visible: true } }
      for (let li = 0; li < k; li++) writeRow(frame, li, lines[li]!)
      frames.push(frame)
      void f
    }

    const vt = streamThroughCellDiff(frames, cols, rows)
    const rowsOut = vt.allRows()
    for (const line of lines) {
      expect(rowsOut.some(r => r.includes(line)), `missing/smeared "${line}" in ${JSON.stringify(rowsOut)}`).toBe(true)
    }
  })

  it('control: same-row CJK append with MATCHING widths renders intact', () => {
    // ambiguousWide=false → the VT agrees with ink's layout, so the cell-diff
    // applies cleanly. Proves the harness itself is sound (no false smear).
    const cols = 40, rows = 6
    const a = makeFrame(rows, cols); writeRow(a, 0, '│ 表 │ 保留')
    const b = makeFrame(rows, cols); writeRow(b, 0, '│ 表 │ 保留更新内容')
    const vt = streamThroughCellDiff([a, b], cols, rows, /*ambiguousWide=*/ false)
    expect(vt.allRows().some(r => r.includes('保留更新内容')), JSON.stringify(vt.allRows())).toBe(true)
  })

  it('ambiguous-width │ on a CJK row: relative cursor moves self-correct (no smear)', () => {
    // ink lays │ (U+2502, East-Asian Ambiguous) out as width 1 (ambiguousAsWide:false).
    // A naive ABSOLUTE position-by-cell-index would land the appended suffix 2 columns
    // early in a CJK terminal (│ rendered width 2) and overwrite the tail of 保留. The
    // current cell-diff does NOT smear: it emits a RELATIVE CUF from the post-write
    // cursor (which already sits at the true column 13), so the suffix lands correctly.
    // This guard fails if that relative move is ever swapped for a cell-index CHA/CUP.
    const cols = 40, rows = 6
    const a = makeFrame(rows, cols); writeRow(a, 0, '│ 表 │ 保留')
    const b = makeFrame(rows, cols); writeRow(b, 0, '│ 表 │ 保留更新内容')
    const vt = streamThroughCellDiff([a, b], cols, rows, /*ambiguousWide=*/ true)
    expect(vt.allRows().some(r => r.includes('保留更新内容')), `smear: ${JSON.stringify(vt.allRows())}`).toBe(true)
  })
})
