import { describe, expect, it } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import { renderSync } from '../../src/ink/root.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { useDeclaredCursor } from '../../src/ink/hooks/use-declared-cursor.js'

// 2026-06-12 dogfood (ghostty + Terminal.app): macOS IMEs draw the preedit
// at the PHYSICAL cursor position. useDeclaredCursor parks the hidden
// hardware cursor at the composer caret — but a pyte probe of the live app
// showed it parking ONE ROW ABOVE the caret (the divider above the input),
// so the preedit block covered the wrong row. This test drives the real
// renderer and tracks the physical cursor over the emitted bytes.

function makeMockStdout(): { stream: NodeJS.WriteStream; data: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  let captured = ''
  stream.isTTY = true
  stream.columns = 40
  stream.rows = 12
  const origWrite = stream.write.bind(stream)
  stream.write = ((chunk: string, cb?: () => void) => {
    captured += chunk
    return origWrite(chunk, cb as never)
  }) as never
  return { stream, data: () => captured }
}

function makeMockStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream
  stream.isTTY = true
  stream.setRawMode = () => stream
  stream.ref = () => stream
  stream.unref = () => stream
  return stream
}

/**
 * Minimal terminal cursor emulation over the emitted ANSI. Tracks x/y in
 * 0-indexed screen coords. Rows scroll when LF fires on the last row —
 * we model an infinite canvas and report y relative to total lines
 * written, which matches frame coords for these short fixtures.
 */
function finalCursor(ansi: string, cols: number): { x: number; y: number } {
  let x = 0
  let y = 0
  let i = 0
  while (i < ansi.length) {
    const ch = ansi[i]!
    if (ch === '\x1b') {
      const m = ansi.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/)
      if (m) {
        const arg = parseInt(m[1]!.replace('?', '') || '1', 10)
        switch (m[2]) {
          case 'A': y -= arg; break
          case 'B': y += arg; break
          case 'C': x += arg; break
          case 'D': x -= arg; break
          case 'H': {
            const parts = m[1]!.split(';').map(p => parseInt(p || '1', 10))
            y = (parts[0] || 1) - 1
            x = (parts[1] || 1) - 1
            break
          }
          case 'G': x = arg - 1; break
          // EL/ED/SGR/DEC private modes: no cursor movement
        }
        i += m[0].length
        continue
      }
      const osc = ansi.slice(i).match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/)
      if (osc) { i += osc[0].length; continue }
      i += 1
      continue
    }
    if (ch === '\r') { x = 0; i += 1; continue }
    if (ch === '\n') { y += 1; i += 1; continue }
    if (ch === '\x08') { x -= 1; i += 1; continue }
    // printable — CJK wide chars advance 2 cells
    x += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
    if (x >= cols) { x = 0; y += 1 }
    i += 1
  }
  return { x, y }
}

function CaretBox(props: { line: number; column: number; children?: React.ReactNode }): React.ReactElement {
  const ref = useDeclaredCursor({ line: props.line, column: props.column, active: true })
  return React.createElement(Box, { ref }, props.children)
}

function mount(tree: React.ReactElement) {
  const { stream, data } = makeMockStdout()
  const instance = renderSync(tree, {
    stdout: stream,
    stdin: makeMockStdin(),
    stderr: stream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  return { instance, data }
}

describe('useDeclaredCursor parks the physical cursor at the caret', () => {
  it('lands on the input row, not the row above', () => {
    const tree = (label: string) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, label),
        React.createElement(Text, null, 'divider'),
        React.createElement(CaretBox, { line: 0, column: 3 }, React.createElement(Text, null, 'hello')),
      )
    const { instance, data } = mount(tree('first'))
    try {
      // Layout effects commit after the first synchronous render in test
      // env; a rerender picks up the declaration.
      instance.rerender(tree('second'))
      const { x, y } = finalCursor(data(), 40)
      // CaretBox is the third row (y=2); declared column 3.
      expect({ x, y }).toEqual({ x: 3, y: 2 })
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

  it('lands on the caret row when content fills the terminal (clamp case)', () => {
    // When screen.height >= terminal rows, frame.cursor.y = screen.height
    // points at a row the terminal doesn't have; the physical cursor is
    // clamped at the bottom row. dy computed from the unclamped frame value
    // parked the cursor one row ABOVE the caret — the live IME bug.
    const filler = Array.from({ length: 10 }, (_, i) =>
      React.createElement(Text, { key: i }, `row${i}`))
    const tree = (label: string) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, label),
        ...filler,
        React.createElement(CaretBox, { line: 0, column: 2 }, React.createElement(Text, null, 'input')),
      )
    // stdout rows = 12; content = 1 + 10 + 1 = 12 rows → fills exactly.
    const { instance, data } = mount(tree('first'))
    try {
      instance.rerender(tree('second'))
      const { x, y } = finalCursor(data(), 40)
      expect({ x, y }).toEqual({ x: 2, y: 11 })
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

  it('accounts for CJK display width in preceding content', () => {
    const tree = (label: string) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, label),
        React.createElement(CaretBox, { line: 0, column: 8 }, React.createElement(Text, null, '你好世界')),
      )
    const { instance, data } = mount(tree('one'))
    try {
      instance.rerender(tree('two'))
      const { x, y } = finalCursor(data(), 40)
      expect({ x, y }).toEqual({ x: 8, y: 1 })
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
