import { describe, it, expect } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { renderSync } from '../../../src/ink/root.js'
import { stringWidth } from '../../../src/ink/stringWidth.js'
import { PermissionCard } from '../../../src/native/tui/permission-card.js'

function makeMockStdout(columns = 80): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  stream.isTTY = true
  stream.columns = columns
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

async function mountAndCollect(
  tree: React.ReactElement,
  columns = 80,
): Promise<{ emit: string; plain: string; unmount: () => void }> {
  const stdout = makeMockStdout(columns)
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
  const emit = Buffer.concat(chunks).toString('utf8')
  return {
    emit,
    plain: stripAnsi(expandCursorAdvance(emit)),
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

function expandCursorAdvance(emit: string): string {
  return emit.replace(/\x1b\[([0-9]*)C/g, (_match, n: string) => ' '.repeat(n ? Number(n) : 1))
}

function visibleRows(plain: string): string[] {
  return plain
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

describe('<PermissionCard>', () => {
  it('renders a read permission with action, target, and choice keys', async () => {
    const { plain, unmount } = await mountAndCollect(
      React.createElement(PermissionCard, {
        kind: 'read',
        action: 'Read file',
        target: '/Users/test/project/src/main.ts',
        choices: [
          { key: 'y', label: 'Allow', primary: true },
          { key: 'n', label: 'Deny' },
        ],
        selectedIndex: 0,
        columns: 80,
      }),
    )
    try {
      expect(plain).toContain('READ  requires approval')
      expect(plain).toContain('Read file')
      expect(plain).toContain('/Users/test/project/src/main.ts')
      expect(plain).toContain('[Y] Allow')
      expect(plain).toContain('[N] Deny')
    } finally {
      unmount()
    }
  })

  it('renders write permission choices in the requested order', async () => {
    const { plain, unmount } = await mountAndCollect(
      React.createElement(PermissionCard, {
        kind: 'write',
        action: 'Update file',
        target: 'src/native/tui/permission-card.tsx',
        choices: [
          { key: 'n', label: 'Deny' },
          { key: 'y', label: 'Allow', primary: true },
          { key: 'a', label: 'Always allow writes' },
        ],
        selectedIndex: 1,
        columns: 90,
      }),
    )
    try {
      const idxN = plain.indexOf('[N] Deny')
      const idxY = plain.indexOf('[Y] Allow')
      const idxA = plain.indexOf('[A] Always allow writes')
      expect(plain).toContain('WRITE  requires approval')
      expect(idxN).toBeGreaterThanOrEqual(0)
      expect(idxY).toBeGreaterThan(idxN)
      expect(idxA).toBeGreaterThan(idxY)
    } finally {
      unmount()
    }
  })

  it('shows danger kind and risk without making the dangerous choice primary', async () => {
    const { plain, unmount } = await mountAndCollect(
      React.createElement(PermissionCard, {
        kind: 'danger',
        action: 'Run shell command',
        target: 'rm -rf /tmp/owlcoda-old',
        risk: 'Recursive delete detected',
        choices: [
          { key: 'n', label: 'Deny', primary: true },
          { key: 'y', label: 'Run anyway', primary: true, danger: true },
        ],
        selectedIndex: 1,
        columns: 80,
      }),
    )
    try {
      expect(plain).toContain('DANGEROUS  requires approval')
      expect(plain).toContain('Recursive delete detected')
      expect(plain).toContain('[N] Deny')
      expect(plain).toContain('[Y] Run anyway')
    } finally {
      unmount()
    }
  })

  it('keeps narrow output within columns and truncates long paths', async () => {
    const columns = 42
    const { plain, unmount } = await mountAndCollect(
      React.createElement(PermissionCard, {
        kind: 'web',
        action: 'Fetch URL with a long descriptive action',
        target: 'https://example.com/a/very/long/path/that/should/not/overflow/permission/card',
        risk: 'External network request',
        choices: [
          { key: 'y', label: 'Allow this request', primary: true },
          { key: 'n', label: 'Deny' },
          { key: 'a', label: 'Always allow this host' },
        ],
        selectedIndex: 0,
        columns,
      }),
      columns,
    )
    try {
      const rows = visibleRows(plain)
      expect(rows.length).toBeGreaterThanOrEqual(5)
      expect(rows.length).toBeLessThanOrEqual(8)
      expect(plain).toContain('https://example')
      expect(plain).toContain('…')
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(columns)
      }
    } finally {
      unmount()
    }
  })
})
