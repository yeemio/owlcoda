import { describe, it, expect } from 'vitest'
import { LogUpdate } from '../../src/ink/log-update.js'
import { type Frame } from '../../src/ink/frame.js'
import { writeDiffToTerminal } from '../../src/ink/terminal.js'
import {
  CharPool,
  CellWidth,
  createScreen,
  HyperlinkPool,
  StylePool,
  setCellAt,
  type Screen,
} from '../../src/ink/screen.js'

// ─── Paste-friendly inter-cell advance invariant ─────────────────
//
// safeFullRepaint must emit literal ASCII spaces (not \x1b[NC cursor-forward)
// when advancing the cursor over empty cells WITHIN a row. Reason: ANSI
// control sequences are stripped on copy / screenshot OCR; if we use
// cursor-forward to skip over "implicit space" cells, the visual display is
// fine, but pasted/extracted text reads as e.g.
//
//   5.显著亮点5.1协议翻译层设计前端对外暴露AnthropicMessages...
//
// — every space and row boundary collapsed. Users routinely copy assistant
// answers to share/review/log; that flow MUST produce readable text.
//
// Row boundaries already use CR+LF (handled by writeDiffToTerminal NEWLINE
// patches), which paste preserves. The space-loss happens only WITHIN a row,
// so this test checks that.

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function newFrame(viewportRows: number, viewportCols: number): Frame {
  return {
    screen: createScreen(viewportCols, viewportRows, stylePool, charPool, hyperlinkPool),
    viewport: { width: viewportCols, height: viewportRows },
    cursor: { x: 0, y: 0, visible: true },
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

function writeAscii(screen: Screen, x: number, y: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    const charIdx = charPool.intern(text[i]!)
    setCellAt(screen, x + i, y, {
      char: text[i]!,
      charIndex: charIdx,
      styleId: stylePool.none,
      hyperlink: undefined,
      width: CellWidth.Narrow,
    } as never)
  }
}

describe('paste-friendly inter-cell advance', () => {
  it('safeFullRepaint emits no \\x1b[NC within a content row — uses literal spaces instead', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = newFrame(5, 40)
    const next = newFrame(5, 40)

    // Layout:  "  Hello World"  with the gap and the inter-word gap left as
    // empty cells (the screen treats them as unstyled-empty, the regression
    // case for cursor-forward optimization).
    writeAscii(next.screen, 2, 0, 'Hello')
    // gap at col 7
    writeAscii(next.screen, 8, 0, 'World')

    const diff = log.render(prev, next, false, true, /*forceFullRepaint=*/ true)
    const bytes = ansiOf(diff)

    // No cursor-forward escapes anywhere in the byte stream.
    const cursorForwards = bytes.match(/\x1b\[\d+C/g) || []
    expect(cursorForwards.length).toBe(0)

    // After ANSI strip, the row reads with spaces preserved.
    const stripped = bytes.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').replace(/\r/g, '')
    const rowText = stripped.split('\n').find(l => l.includes('Hello'))!
    expect(rowText).toContain('Hello World')
    expect(rowText).toMatch(/^ {2}Hello World/)
  })

  it('safeFullRepaint preserves leading-indent + inter-token spaces (CJK row)', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = newFrame(5, 40)
    const next = newFrame(5, 40)

    // ASCII proxy for the user's "  5. 显著亮点" / "Anthropic Messages API"
    // case: 2-space indent, then content with internal spaces.
    writeAscii(next.screen, 2, 0, 'A B C')

    const diff = log.render(prev, next, false, true, true)
    const bytes = ansiOf(diff)

    expect((bytes.match(/\x1b\[\d+C/g) || []).length).toBe(0)

    const stripped = bytes.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').replace(/\r/g, '')
    const row = stripped.split('\n').find(l => l.includes('A B C'))!
    expect(row).toMatch(/^ {2}A B C/)
  })
})
