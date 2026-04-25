import { describe, it, expect } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import { renderSync } from '../../../src/ink/root.js'
import { ComposerInputChrome, ComposerPanel } from '../../../src/native/tui/composer.js'
import { Box, Text } from '../../../src/ink.js'

/**
 * Self-written renderSync + PassThrough mock, matching the pattern in
 * tests/ink/static.test.ts. The Ink fork doesn't ship
 * ink-testing-library; we drive the real renderer with a PassThrough
 * that satisfies the WriteStream shape and collect emitted ANSI for
 * content assertions.
 */
function makeMockStdout(): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  stream.isTTY = true
  stream.columns = 80
  stream.rows = 24
  return stream
}

function makeMockStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream
  stream.isTTY = true
  stream.setRawMode = () => stream
  stream.ref = () => stream
  stream.unref = () => stream
  return stream
}

async function mountAndCollect(tree: React.ReactElement): Promise<{ emit: string; unmount: () => void }> {
  const stdout = makeMockStdout()
  const stdin = makeMockStdin()
  const chunks: Buffer[] = []
  ;(stdout as unknown as PassThrough).on('data', (c: Buffer) => chunks.push(c))
  const instance = renderSync(tree, {
    stdout,
    stdin,
    stderr: stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  // Give the event loop a tick so buffered data drains.
  await new Promise<void>((resolve) => setImmediate(resolve))
  return {
    emit: Buffer.concat(chunks).toString('utf8'),
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

function expandCursorAdvance(emit: string): string {
  return emit.replace(/\x1b\[([0-9]*)C/g, (_match, n: string) => ' '.repeat(n ? Number(n) : 1))
}

describe('<ComposerPanel>', () => {
  it('renders a left accent bar ▎ on the body row', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'rail-text' },
        React.createElement(Text, null, 'body-text'),
      ),
    )
    try {
      expect(emit).toContain('\u258E')
      expect(emit).toContain('body-text')
    } finally {
      unmount()
    }
  })

  it('renders the separator ─ between body and rail', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'rail-text' },
        React.createElement(Text, null, 'body-text'),
      ),
    )
    try {
      expect(emit).toContain('\u2500')
    } finally {
      unmount()
    }
  })

  it('renders the rail string at the bottom', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'owl · auto · ready' },
        React.createElement(Text, null, 'body'),
      ),
    )
    try {
      // Ink may insert cursor-advance escapes ([1C) between whitespace-
      // separated tokens on the rail row, so we assert the tokens appear
      // in order rather than the raw literal string.
      const idxOwl = emit.indexOf('owl')
      const idxAuto = emit.indexOf('auto', idxOwl)
      const idxReady = emit.indexOf('ready', idxAuto)
      expect(idxOwl).toBeGreaterThanOrEqual(0)
      expect(idxAuto).toBeGreaterThan(idxOwl)
      expect(idxReady).toBeGreaterThan(idxAuto)
    } finally {
      unmount()
    }
  })

  it('with bodyLines undefined, body does not render extra blank bg rows below children', async () => {
    // Regression: overlay/permission modes pass bodyLines=undefined so the
    // body shrinks to fit. Previously we applied a hard minHeight=3 whose
    // leftover rows painted a bg slab under the picker. A single one-line
    // child must produce exactly one body row, not three.
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'r' },
        React.createElement(Text, null, 'single-line'),
      ),
    )
    try {
      // Count how many times ▎ appears. With minHeight undefined and a
      // one-line child, Ink's custom borderStyle replicates ▎ once per
      // body row — expect exactly 1.
      const barCount = (emit.match(/\u258E/g) ?? []).length
      expect(barCount).toBe(1)
    } finally {
      unmount()
    }
  })

  it('with bodyLines=5, body grows to that minimum so multi-line draft stays inside the band', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'r', bodyLines: 5 },
        React.createElement(Text, null, 'one-liner'),
      ),
    )
    try {
      const barCount = (emit.match(/\u258E/g) ?? []).length
      expect(barCount).toBe(5)
    } finally {
      unmount()
    }
  })

  it('body accepts arbitrary children (three-mode integration works the same)', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerPanel,
        { rail: 'r' },
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(Text, null, 'line-a'),
          React.createElement(Text, null, 'line-b'),
        ),
      ),
    )
    try {
      expect(emit).toContain('line-a')
      expect(emit).toContain('line-b')
    } finally {
      unmount()
    }
  })
})

describe('<ComposerInputChrome>', () => {
  it('renders a clean prompt marker before input without leaking the mode label', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerInputChrome,
        { mode: 'plan', columns: 80 },
        React.createElement(Text, null, 'draft text'),
      ),
    )
    try {
      const plain = expandCursorAdvance(emit)
      expect(plain).toContain('›')
      expect(plain).not.toContain('plan')
      expect(plain).toContain('draft text')
    } finally {
      unmount()
    }
  })

  it('renders queued summary without overflowing the requested columns', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(
        ComposerInputChrome,
        { mode: 'act', columns: 32, queued: 'please run the next long verification after this one finishes' },
        React.createElement(Text, null, 'new draft'),
      ),
    )
    try {
      const plain = expandCursorAdvance(emit)
      expect(plain).toContain('QUEUED NEXT')
      expect(plain).not.toContain('act')
      expect(plain).toContain('new draft')
      expect(plain).toContain('…')
    } finally {
      unmount()
    }
  })
})
