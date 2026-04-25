import { describe, it, expect } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import { renderSync } from '../../src/ink/root.js'
import { ComposerInputChrome, ComposerPanel } from '../../src/native/tui/composer.js'
import { Text } from '../../src/ink.js'

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

function expandCursorAdvance(emit: string): string {
  return emit.replace(/\x1b\[([0-9]*)C/g, (_match, n: string) => ' '.repeat(n ? Number(n) : 1))
}

describe('alternate-screen return redraw', () => {
  it('re-renders composer chrome after exiting an external alt-screen handoff', async () => {
    const stdout = makeMockStdout()
    const stdin = makeMockStdin()
    const chunks: Buffer[] = []
    ;(stdout as unknown as PassThrough).on('data', (chunk: Buffer) => chunks.push(chunk))

    const tree = React.createElement(
      ComposerPanel,
      { rail: 'rail text', bodyLines: 3 },
      React.createElement(
        ComposerInputChrome,
        { mode: 'plan', columns: 80 },
        React.createElement(Text, null, 'draft text'),
      ),
    )

    const instance = renderSync(tree, {
      stdout,
      stdin,
      stderr: stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    chunks.length = 0

    instance.enterAlternateScreen()
    instance.exitAlternateScreen()

    await new Promise<void>((resolve) => setImmediate(resolve))
    const emit = Buffer.concat(chunks).toString('utf8')
    const plain = expandCursorAdvance(emit)

    try {
      expect(emit).toContain('\u258E')
      expect(emit).toContain('\u2500')
      expect(plain).toContain('› draft text')
      expect(plain).toContain('rail text')
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
