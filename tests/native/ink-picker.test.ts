import { describe, it, expect } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import { renderSync } from '../../src/ink/root.js'
import { InkPicker } from '../../src/native/ink-picker.js'

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

describe('<InkPicker>', () => {
  const items = [
    { label: '/help', description: 'Show commands and shortcuts', value: '/help' },
    { label: '/model', description: 'Switch model', value: '/model' },
    { label: '/quit', description: 'Exit OwlCoda', value: '/quit' },
  ]

  it('renders as compact composer overlay instead of a boxed modal', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(InkPicker, {
        title: 'slash commands',
        items,
        onSelect: () => {},
        onCancel: () => {},
      }),
    )
    try {
      const plain = expandCursorAdvance(emit)
      expect(plain).toContain('SLASH COMMANDS')
      expect(plain).toContain('3 items')
      expect(plain).toContain('›')
      expect(plain).toContain('↵ select')
      expect(plain).toContain('esc close')
      expect(plain).not.toContain('╭')
    } finally {
      unmount()
    }
  })

  it('shows slash prefix and run action when used as the command overlay', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(InkPicker, {
        title: 'slash commands',
        items,
        queryPrefix: '/',
        submitLabel: 'run',
        onSelect: () => {},
        onCancel: () => {},
      }),
    )
    try {
      const plain = expandCursorAdvance(emit)
      expect(plain).toContain('› /')
      expect(plain).toContain('↵ run')
    } finally {
      unmount()
    }
  })

  it('keeps focused row marker and description on one scan line', async () => {
    const { emit, unmount } = await mountAndCollect(
      React.createElement(InkPicker, {
        title: 'slash commands',
        items,
        onSelect: () => {},
        onCancel: () => {},
      }),
    )
    try {
      const plain = expandCursorAdvance(emit)
      expect(plain).toContain('▸ /help')
      expect(plain).toContain('Show commands and shortcuts')
    } finally {
      unmount()
    }
  })
})
