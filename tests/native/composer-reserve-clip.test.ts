import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToScreen } from '../../src/ink/render-to-screen.js'
import { Box, Text } from '../../src/ink.js'
import { ScrollableTranscript } from '../../src/native/ink-fullscreen-layout.js'
import { ComposerPanel, computeTranscriptHeight } from '../../src/native/tui/composer.js'
import { charInCellAt } from '../../src/ink/screen.js'

// ── Regression: the transcript-height reserve must leave room for the WHOLE
// ComposerPanel below it ──
//
// ink-repl renders a fixed-height column: ScrollableTranscript (sized by
// computeTranscriptHeight) above the ComposerPanel. The panel paints THREE
// fixed chrome rows around its body (top divider + mid divider + rail), but the
// reserve only accounted for one — so on short viewports the column overflowed
// and Yoga clipped the bottom of the (flex) transcript: the newest row and the
// spinner/footer vanished until the turn settled. The earlier flexShrink fix
// only changed WHICH transcript rows clip; it did not fix the reserve, and its
// test never put a real ComposerPanel in the tree, so this went unseen.

const NEWEST = 'NEWESTROWmarker'
const RAIL = 'RAILmarker'

function renderBottom(rows: number, cols: number, bodyLines: number): string {
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true })

  const prior = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`, text: `prior assistant filler line ${i} occupying the transcript viewport`,
  }))
  const items = [...prior, { id: 'newest', text: NEWEST }]
  const transcriptHeight = computeTranscriptHeight(rows, bodyLines)

  const body = React.createElement(
    Box, { flexDirection: 'column' },
    ...Array.from({ length: bodyLines }, (_, i) => React.createElement(Text, { key: i }, `input ${i}`)),
  )
  const el = React.createElement(
    Box, { flexDirection: 'column', height: rows },
    React.createElement(ScrollableTranscript as never, {
      items, tail: React.createElement(Text, null, '  spinner'), footer: null,
      height: transcriptHeight, cols, tailLines: 1, footerLines: 0, isLoading: true,
    }),
    React.createElement(ComposerPanel as never, { bodyLines, rail: RAIL }, body),
  )
  const { screen } = renderToScreen(el, cols)
  let out = ''
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) out += charInCellAt(screen, x, y) ?? ' '
    out += '\n'
  }
  return out
}

describe('composer reserve: newest transcript row and rail survive (short viewport)', () => {
  for (const rows of [8, 10, 12, 16, 24]) {
    it(`keeps the newest transcript row visible (rows=${rows})`, () => {
      const d = renderBottom(rows, 80, 1)
      expect(d, `newest transcript row clipped (rows=${rows})`).toContain(NEWEST)
      expect(d, `composer rail clipped (rows=${rows})`).toContain(RAIL)
    })
  }
})
