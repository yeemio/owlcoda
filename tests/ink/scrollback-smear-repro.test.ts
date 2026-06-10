import { describe, it, expect } from 'vitest'
import { LogUpdate, sanitizeCommitLine } from '../../src/ink/log-update.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import { CharPool, HyperlinkPool, StylePool } from '../../src/ink/screen.js'

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

function renderAnsi(log: LogUpdate, prev: Frame, next: Frame): string {
  const diff = log.render(prev, next)
  return diff
    .filter((p): p is Extract<typeof p, { type: 'stdout' }> => p.type === 'stdout')
    .map(p => p.content)
    .join('')
}

/**
 * Minimal-but-faithful VT grid emulator with scrollback. Models exactly the
 * sequences the staticCommit path emits: CUP, EL (\x1b[K), DECAWM on/off
 * (\x1b[?7l/h), DECSTBM reset (\x1b[r), printable writes, \r and \n.
 *
 * `onlcr` toggles whether \n behaves as CR+LF (terminal output post-processing,
 * the macOS default) or as a bare LF (move down, keep column — raw output mode).
 */
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
        // CSI / escape sequence
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
        // Other ESC (e.g. \x1b], \x1bP) — skip the next char minimally.
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
      // Printable
      if (this.x >= this.width) {
        if (this.autowrap) {
          this.x = 0
          this.lineFeed()
        } else {
          this.x = this.width - 1 // clamp: overwrite last cell
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
        // Erase from cursor to end of line (default param 0).
        for (let c = this.x; c < this.width; c++) this.grid[this.y]![c] = ' '
        return
      }
      case 'm':
        return // SGR — no cursor movement
      case 'h':
        if (params === '?7') this.autowrap = true
        return
      case 'l':
        if (params === '?7') this.autowrap = false
        return
      case 'r':
        return // DECSTBM reset — full-screen region assumed; no-op here
      case 'J':
        // Clear screen — should NOT appear in staticCommit path.
        if (params === '2' || params === '') {
          this.grid = Array.from({ length: this.height }, () => Array(this.width).fill(' '))
        }
        return
      default:
        return
    }
  }

  /** All committed scrollback rows + current visible rows, trimmed. */
  allRows(): string[] {
    return [
      ...this.scrollback,
      ...this.grid.map(r => r.join('').replace(/\s+$/, '')),
    ]
  }
}

// A realistic tool-result block as produced by formatToolResult: header line
// with the (Nms) timing, then the bash output (which already carries the
// [stdout]/[exit code] labels), each indented 5 spaces. Pre-wrapped to width.
function toolResultCommit(): { text: string; rowCount: number } {
  const lines = [
    '  ⎿  ✓ Bash (13ms)',
    '     [stdout]',
    '     -rw-r--r--@ 1 yeemio  staff       0 May 31 09:51 L2_qa.jsonl',
    '     [exit code: 0]',
  ]
  return { text: lines.join('\n'), rowCount: lines.length }
}

// Same block, but the bash output carries an embedded carriage return — common
// in real tool output (progress bars, CI logs, \r\n line endings). Nothing in
// the commit pipeline strips it, so the bare \r reaches the terminal and resets
// the column mid-row. Each physical row is still one element (split on \n only).
function toolResultCommitWithCR(): { text: string; rowCount: number } {
  const lines = [
    '  ⎿  ✓ Bash (13ms)\r', // trailing CR (as from a \r\n ending split on \n)
    '     [stdout]',
    '     progress 50%\rprogress 100% done', // in-line CR (progress bar)
    '     [exit code: 0]',
  ]
  return { text: lines.join('\n'), rowCount: lines.length }
}

describe('scrollback smear repro — header overwritten by next line ([stdout]13ms))', () => {
  for (const onlcr of [true, false]) {
    it(`commits a tool-result block without head-overwrite (onlcr=${onlcr})`, () => {
      const cols = 118
      const rows = 12
      const log = newLogAt(rows)
      // Prime: a frame with no commit (cursor settled at bottom).
      const prev = makeFrame({ rows, cols })
      log.render(makeFrame({ rows, cols }), prev)
      // Commit the tool-result block.
      const next = makeFrame({ rows, cols, staticCommit: toolResultCommit() })
      const ansi = renderAnsi(log, prev, next)

      const vt = new VT(cols, rows, onlcr)
      vt.write(ansi)
      const rowsOut = vt.allRows()

      // The smear: '[stdout]' overwriting the head of the '✓ Bash (13ms)' header,
      // leaving '...[stdout]13ms)' on one row.
      const smeared = rowsOut.find(r => /\[stdout\].*13ms\)/.test(r))
      expect(smeared, `smear row found: ${JSON.stringify(smeared)}`).toBeUndefined()

      // And the header must survive intact somewhere.
      const headerIntact = rowsOut.some(r => /✓ Bash \(13ms\)/.test(r))
      expect(headerIntact, `rows=${JSON.stringify(rowsOut)}`).toBe(true)
    })
  }

  // The real macOS terminal has ONLCR on; this is the case that matters.
  it('embedded \\r in committed tool output must not overwrite the header (onlcr=true)', () => {
    const cols = 118
    const rows = 12
    const log = newLogAt(rows)
    const prev = makeFrame({ rows, cols })
    log.render(makeFrame({ rows, cols }), prev)
    const next = makeFrame({ rows, cols, staticCommit: toolResultCommitWithCR() })
    const ansi = renderAnsi(log, prev, next)

    const vt = new VT(cols, rows, true)
    vt.write(ansi)
    const rowsOut = vt.allRows()

    // Header must survive intact — a trailing \r + the next line's content must
    // not collapse onto the header row.
    const headerIntact = rowsOut.some(r => /✓ Bash \(13ms\)/.test(r))
    expect(headerIntact, `rows=${JSON.stringify(rowsOut)}`).toBe(true)
    // No row may contain a raw CR.
    expect(rowsOut.some(r => r.includes('\r'))).toBe(false)
  })
})

function newLogAt(_rows: number): LogUpdate {
  return new LogUpdate({ isTTY: true, stylePool })
}

describe('sanitizeCommitLine', () => {
  it('strips bare CR (the head-overwrite / line-blank trigger)', () => {
    expect(sanitizeCommitLine('done\r')).toBe('done')
    expect(sanitizeCommitLine('a\rb')).toBe('ab')
  })

  it('strips other C0 controls and DEL', () => {
    expect(sanitizeCommitLine('a\x00b\x07c\x7f')).toBe('abc')
  })

  it('preserves TAB and ESC-carried SGR ANSI', () => {
    expect(sanitizeCommitLine('a\tb')).toBe('a\tb')
    expect(sanitizeCommitLine('\x1b[1mbold\x1b[0m')).toBe('\x1b[1mbold\x1b[0m')
  })

  it('leaves clean text untouched', () => {
    expect(sanitizeCommitLine('  ⎿  ✓ Bash (13ms)')).toBe('  ⎿  ✓ Bash (13ms)')
  })
})
