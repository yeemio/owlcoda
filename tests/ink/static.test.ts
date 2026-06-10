import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { PassThrough } from 'stream'
import { renderSync } from '../../src/ink/root.js'
import { Static } from '../../src/ink/components/Static.js'
import {
  InkInstanceContext,
  type InkInstanceHandle,
} from '../../src/ink/components/InkInstanceContext.js'

/**
 * Mock TTY stdout. The Ink fork doesn't ship ink-testing-library; instead
 * we drive the real renderer with a PassThrough that satisfies the WriteStream
 * shape well enough for Ink's terminal detection. We don't assert on emitted
 * ANSI — we observe the <Static> → enqueueStaticCommit contract via a spy
 * handle injected through the InkInstanceContext.Provider INSIDE the user
 * tree (innermost Provider wins, overriding the Ink class's wiring).
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
  // setRawMode is queried during setup; no-op is fine
  stream.setRawMode = () => stream
  stream.ref = () => stream
  stream.unref = () => stream
  return stream
}

function mountWithHandle(
  handle: InkInstanceHandle,
  items: readonly string[],
): { rerender: (items: readonly string[]) => void; unmount: () => void; stdout: NodeJS.WriteStream } {
  const stdout = makeMockStdout()
  const stdin = makeMockStdin()
  const tree = (nextItems: readonly string[]) =>
    React.createElement(
      InkInstanceContext.Provider,
      { value: handle },
      React.createElement(Static, { items: nextItems }),
    )
  const instance = renderSync(tree(items), {
    stdout,
    stdin,
    stderr: stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  return {
    rerender: nextItems => instance.rerender(tree(nextItems)),
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
    stdout,
  }
}

describe('<Static> component', () => {
  it('enqueues all items on initial mount', () => {
    const enqueue = vi.fn()
    const handle: InkInstanceHandle = { enqueueStaticCommit: enqueue }
    const { unmount } = mountWithHandle(handle, ['one', 'two', 'three'])
    try {
      // Ink useLayoutEffect runs synchronously during commit; enqueue
      // should have been called with all three items on mount.
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(['one', 'two', 'three'])
    } finally {
      unmount()
    }
  })

  it('enqueues only the newly-appended delta on re-render (not the whole array)', () => {
    const enqueue = vi.fn()
    const handle: InkInstanceHandle = { enqueueStaticCommit: enqueue }
    const { rerender, unmount } = mountWithHandle(handle, ['one', 'two'])
    try {
      // Mount: enqueue(['one', 'two'])
      enqueue.mockClear()
      rerender(['one', 'two', 'three', 'four'])
      // Only the delta should be enqueued
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(['three', 'four'])
    } finally {
      unmount()
    }
  })

  it('no-op when items array is unchanged', () => {
    const enqueue = vi.fn()
    const handle: InkInstanceHandle = { enqueueStaticCommit: enqueue }
    const items = ['x', 'y']
    const { rerender, unmount } = mountWithHandle(handle, items)
    try {
      enqueue.mockClear()
      // Re-render with the SAME array reference — no append
      rerender(items)
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('renders null (contributes nothing to the dynamic screen)', () => {
    const enqueue = vi.fn()
    const handle: InkInstanceHandle = { enqueueStaticCommit: enqueue }
    const { stdout, unmount } = mountWithHandle(handle, ['a', 'b'])
    try {
      // Collect everything Ink emits to the mock stdout.
      const chunks: Buffer[] = []
      ;(stdout as unknown as PassThrough).on('data', c => chunks.push(c))
      // Give the event loop a tick so any buffered data drains.
      return new Promise<void>(resolve => {
        setImmediate(() => {
          const emitted = Buffer.concat(chunks).toString('utf8')
          // <Static> itself returns null — no "a"/"b" should appear in the
          // dynamic viewport output. (The scrollback commit path is tested
          // separately in log-update.test.ts; here we care only that <Static>
          // doesn't render its items into the frame.)
          expect(emitted).not.toMatch(/\ba\b|\bb\b/)
          unmount()
          resolve()
        })
      })
    } catch (err) {
      unmount()
      throw err
    }
  })

  it('empty items reset commit counter so next growth commits from 0', () => {
    // Regression guard for /clear: after the caller clears transcriptItems
    // (items=[]), <Static>'s internal committedCountRef must reset so that
    // subsequent new items don't fall into a "phantom window" where
    // length <= old-watermark causes the delta check to silently skip.
    const enqueue = vi.fn()
    const handle: InkInstanceHandle = { enqueueStaticCommit: enqueue }
    const { rerender, unmount } = mountWithHandle(handle, ['old1', 'old2', 'old3'])
    try {
      // Mount: enqueue(['old1', 'old2', 'old3']) — watermark now 3
      enqueue.mockClear()
      // Simulate /clear's transcript wipe: items goes to empty
      rerender([])
      // Empty render should NOT enqueue (nothing to commit) but MUST reset
      // the internal counter — verified indirectly via the next assertion.
      expect(enqueue).not.toHaveBeenCalled()
      // Now add two new items — total length (2) is LESS than old watermark (3).
      // Without the reset, items.length <= committedCountRef.current would
      // short-circuit and skip the enqueue. With the reset, counter is 0 and
      // both new items get enqueued.
      rerender(['new1', 'new2'])
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(['new1', 'new2'])
    } finally {
      unmount()
    }
  })
})
