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

// ─── Tall static-commit ownership (commit-once for tall items) ──────
//
// Coverage gap closed during a 2026-06-03 dogfood investigation. A
// screenshot of the kimi-code / deepseek Ghostty panes *appeared* to
// show a model report (which exists EXACTLY ONCE in the saved
// conversation) duplicated 2-3× in scrollback. Root-causing across every
// layer — saved conversation (report ×1), StreamingMarkdownRenderer
// replay of the real report (×1 at all chunk sizes), and the commit path
// — found NO duplication: the apparent doubling was a dual-scroll TUI
// artifact (in-app ScrollableTranscript over terminal scrollback), not a
// render bug.
//
// What the investigation DID surface: static-ownership.test.ts only
// locked "commit text once" for SHORT commits (rows=5, rowCount<=3),
// while a real report is a SINGLE transcript item TALLER than the
// viewport — when it ages past the visible window it commits with
// rowCount >> viewport.height, exercising the natural-scroll +
// bulkScrollCount clamp path the short test never reached. This test
// closes that gap: it drives the tall-commit path through a
// scrollback-aware VT and confirms every committed row lands exactly
// once. (Confirms the contract holds; it is NOT a reproduced bug.)

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

// Minimal VT grid emulator WITH scrollback — models the sequences the
// staticCommit path emits: CUP, EL (\x1b[K), DECAWM on/off, DECSTBM reset,
// printable writes, \r and \n. onlcr=true (macOS default: \n -> CR+LF).
// (Structure mirrors tests/ink/scrollback-smear-repro.test.ts.)
class VT {
  width: number
  height: number
  grid: string[][]
  scrollback: string[] = []
  x = 0
  y = 0
  autowrap = true
  onlcr: boolean

  constructor(width: number, height: number, onlcr: boolean) {
    this.width = width
    this.height = height
    this.onlcr = onlcr
    this.grid = Array.from({ length: height }, () => Array(width).fill(' '))
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
          while (j < bytes.length && /[0-9;?]/.test(bytes[j]!)) {
            params += bytes[j]!
            j++
          }
          const final = bytes[j]!
          this.csi(params, final)
          i = j + 1
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') {
        this.x = 0
        i++
        continue
      }
      if (ch === '\n') {
        if (this.onlcr) this.x = 0
        this.lineFeed()
        i++
        continue
      }
      if (this.x >= this.width) {
        if (this.autowrap) {
          this.x = 0
          this.lineFeed()
        } else {
          this.x = this.width - 1
        }
      }
      this.grid[this.y]![this.x] = ch
      this.x++
      i++
    }
  }

  private csi(params: string, final: string): void {
    switch (final) {
      case 'H': {
        const [r = '1', c = '1'] = params.split(';')
        this.y = Math.min(this.height - 1, Math.max(0, parseInt(r, 10) - 1))
        this.x = Math.min(this.width - 1, Math.max(0, parseInt(c, 10) - 1))
        return
      }
      case 'K': {
        for (let c = this.x; c < this.width; c++) this.grid[this.y]![c] = ' '
        return
      }
      case 'm':
        return
      case 'h':
        if (params === '?7') this.autowrap = true
        return
      case 'l':
        if (params === '?7') this.autowrap = false
        return
      case 'r':
        return
      case 'J':
        if (params === '2' || params === '') {
          this.grid = Array.from({ length: this.height }, () => Array(this.width).fill(' '))
        }
        return
      default:
        return
    }
  }

  allRows(): string[] {
    return [
      ...this.scrollback,
      ...this.grid.map(r => r.join('').replace(/\s+$/, '')),
    ]
  }
}

function makeFrame(opts: {
  rows: number
  cols: number
  staticCommit?: { text: string; rowCount: number }
  dynamicLines?: string[]
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

describe('tall static commit does not duplicate rows in scrollback', () => {
  it('a single tall commit (rowCount >> viewport.height) writes each line exactly once', () => {
    const cols = 40
    const viewportRows = 10
    const commitLines = Array.from({ length: 40 }, (_, i) => `RPT_ROW_${String(i).padStart(2, '0')}`)

    const log = newLog()
    // Prime: settle a blank frame so the next render isn't first-frame.
    const prev = makeFrame({ rows: viewportRows, cols })
    log.render(makeFrame({ rows: viewportRows, cols }), prev)

    const next = makeFrame({
      rows: viewportRows,
      cols,
      staticCommit: { text: commitLines.join('\n'), rowCount: commitLines.length },
      dynamicLines: ['VISIBLE_TAIL'],
    })
    const ansi = ansiOf(log.render(prev, next, false, true, true))

    const vt = new VT(cols, viewportRows, true)
    vt.write(ansi)
    const rows = vt.allRows()

    for (const line of commitLines) {
      const count = rows.filter(r => r.includes(line)).length
      expect(count, `committed line "${line}" appears ${count}× (rows=${JSON.stringify(rows)})`).toBe(1)
    }
    // The new visible content shows once, in the viewport.
    expect(rows.filter(r => r.includes('VISIBLE_TAIL')).length).toBe(1)
  })
})
