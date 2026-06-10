import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToScreen } from '../../src/ink/render-to-screen.js'
import { Box, Text } from '../../src/ink.js'
import { ScrollableTranscript } from '../../src/native/ink-fullscreen-layout.js'
import { renderUserBlock } from '../../src/native/tui/user-block.js'
import { __clearDisplayLinesCacheForTest, estimateWrappedLineCount } from '../../src/native/repl-shared.js'
import { charInCellAt } from '../../src/ink/screen.js'

// ── Regression: a just-submitted multi-line user message must never be
// squeezed out of the transcript by the live streaming-response preview ──
//
// Bug (reproduced via the real reconciler+Yoga+paint pipeline): on a short
// viewport, the live "tail" preview (up to LIVE_RESPONSE_MAX_LINES=10 lines)
// plus the transcript window exceeds the transcript height. Yoga, finding the
// column over-full, shrank the FLEX transcript-item rows to zero — collapsing
// the user's own echoed message out of view — while the tail kept its size.
// The user saw their wrapped message render only partially ("只显示一部分")
// until the turn settled. Fix: flexShrink={0} on the transcript-items wrapper
// so the tail (secondary preview) is the content that clips, not the message.

const CJK_HEAD = '悠哈的当前状态'
const CJK_TAIL = '动。'
const CJK = `${CJK_HEAD}这类问题我今天已经处理了，你可以去看一下怎么处理的。你只是看如何处理，可以提建议。但是不允许又任何改${CJK_TAIL}`

function dumpRows(screen: Parameters<typeof charInCellAt>[0]): string {
  let out = ''
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) out += charInCellAt(screen, x, y) ?? ' '
    out += '\n'
  }
  return out
}

function renderTranscript(rows: number, cols: number, tailCount: number): string {
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true })
  __clearDisplayLinesCacheForTest()

  const block = renderUserBlock(CJK)
  const prior = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, text: `先前第${i}轮的助手回复内容占位行用于填满视口空间一二三四五`,
  }))
  const items = [...prior, { id: 'user', text: block }]

  const tailText = tailCount === 0
    ? ''
    : Array.from({ length: tailCount }, (_, i) => `这是助手正在流式输出的第${i + 1}行回复内容用于占位演示`).join('\n')
  const tailLines = tailText ? estimateWrappedLineCount(tailText, cols) : 1
  const transcriptHeight = Math.max(3, rows - 2)
  const tail = tailText
    ? React.createElement(Text, { wrap: 'wrap' }, tailText)
    : React.createElement(Text, null, '  ⎿  spinner...')

  const el = React.createElement(
    Box,
    { flexDirection: 'column', height: rows },
    React.createElement(ScrollableTranscript as never, {
      items, tail, footer: null, height: transcriptHeight,
      cols, tailLines, footerLines: 0, isLoading: true,
    }),
  )
  const { screen } = renderToScreen(el, cols)
  return dumpRows(screen as never)
}

describe('transcript: live preview must not clip the user message (short viewport)', () => {
  // Matrix: short→tall viewports × empty→max streaming tail. The newest user
  // message must be fully visible (both its wrapped rows) in every cell.
  for (const rows of [8, 10, 12, 16, 24, 40]) {
    for (const tailCount of [0, 6, 10]) {
      it(`keeps both wrapped rows visible (rows=${rows}, tail=${tailCount})`, () => {
        const dump = renderTranscript(rows, 120, tailCount)
        // Head row (first wrapped line) and tail row (last wrapped line) of the
        // user block must BOTH survive — clipping either is the bug.
        expect(dump, `head row missing (rows=${rows}, tail=${tailCount})`).toContain(CJK_HEAD)
        expect(dump, `tail row missing (rows=${rows}, tail=${tailCount})`).toContain(CJK_TAIL)
      })
    }
  }
})
