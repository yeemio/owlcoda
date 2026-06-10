import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  registerPickerIsolation,
  showPicker,
  __getPickerIsolationForTests,
  type PickerIsolationHooks,
} from '../../src/native/tui/picker.js'

/**
 * Capability-driven picker isolation: any code path that reaches showPicker
 * triggers the registered host hooks (enter/exit), without any whitelist of
 * slash commands. These tests prove that isolation fires regardless of the
 * caller's identity — the previous bug was a per-command whitelist that
 * silently missed new picker sites.
 */

function makeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & { isTTY: boolean; setRawMode: (flag: boolean) => NodeJS.ReadStream }
  stdin.isTTY = false
  stdin.setRawMode = () => stdin
  stdin.pause = () => stdin
  stdin.resume = () => stdin
  return stdin
}

function makeStdout(): NodeJS.WriteStream {
  const writes: string[] = []
  const stream = {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: (chunk: unknown) => { writes.push(String(chunk)); return true },
  } as unknown as NodeJS.WriteStream
  ;(stream as unknown as { writes: string[] }).writes = writes
  return stream
}

describe('picker isolation hooks', () => {
  let originalStdin: NodeJS.ReadStream
  let originalStdinRaw: boolean | undefined

  beforeEach(() => {
    originalStdin = process.stdin
    originalStdinRaw = process.stdin.isRaw
    Object.defineProperty(process, 'stdin', {
      value: makeStdin(),
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    registerPickerIsolation(null)
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    })
    if (originalStdinRaw !== undefined && originalStdin.isTTY) {
      try { originalStdin.setRawMode?.(originalStdinRaw) } catch { /* ignore */ }
    }
    vi.restoreAllMocks()
  })

  it('registerPickerIsolation stores the hooks and clears on null', () => {
    const hooks: PickerIsolationHooks = { enter: () => {}, exit: () => {} }
    registerPickerIsolation(hooks)
    expect(__getPickerIsolationForTests()).toBe(hooks)
    registerPickerIsolation(null)
    expect(__getPickerIsolationForTests()).toBeNull()
  })

  it('showPicker fires enter BEFORE paint and exit AFTER cleanup', async () => {
    const events: Array<'enter' | 'exit' | 'paint'> = []
    const stdout = makeStdout()
    // Track paint order via the mock stdout's first write.
    const originalWrite = stdout.write as (chunk: unknown) => boolean
    ;(stdout as unknown as { write: typeof originalWrite }).write = (chunk: unknown) => {
      if (events[events.length - 1] !== 'paint') events.push('paint')
      return originalWrite(chunk)
    }
    registerPickerIsolation({
      enter: () => events.push('enter'),
      exit: () => events.push('exit'),
    })

    // Immediately resolve the picker via a simulated Enter keystroke.
    const pickerPromise = showPicker({
      items: [{ label: 'alpha', value: 'alpha' }, { label: 'beta', value: 'beta' }],
      stream: stdout,
    })
    // Drive the picker's input loop: write an Enter byte.
    setTimeout(() => {
      (process.stdin as EventEmitter).emit('data', Buffer.from('\r'))
    }, 5)
    const res = await pickerPromise
    expect(res.cancelled).toBe(false)

    // enter must come first, exit must come last, and paint lies between.
    expect(events[0]).toBe('enter')
    expect(events[events.length - 1]).toBe('exit')
    expect(events).toContain('paint')
    const enterIdx = events.indexOf('enter')
    const paintIdx = events.indexOf('paint')
    const exitIdx = events.lastIndexOf('exit')
    expect(enterIdx).toBeLessThan(paintIdx)
    expect(paintIdx).toBeLessThan(exitIdx)
  })

  it('no registered hooks → showPicker still works (headless / CI)', async () => {
    registerPickerIsolation(null)
    const stdout = makeStdout()
    const pickerPromise = showPicker({
      items: [{ label: 'alpha', value: 'alpha' }],
      stream: stdout,
    })
    setTimeout(() => {
      (process.stdin as EventEmitter).emit('data', Buffer.from('\x1b')) // Esc
      setTimeout(() => {
        (process.stdin as EventEmitter).emit('data', Buffer.from(''))
      }, 60)
    }, 5)
    const res = await pickerPromise
    expect(res.cancelled).toBe(true)
  })

  it('exit fires even if picker is cancelled (Esc)', async () => {
    const events: string[] = []
    registerPickerIsolation({
      enter: () => events.push('enter'),
      exit: () => events.push('exit'),
    })
    const stdout = makeStdout()
    const pickerPromise = showPicker({
      items: [{ label: 'alpha', value: 'alpha' }],
      stream: stdout,
    })
    setTimeout(() => {
      (process.stdin as EventEmitter).emit('data', Buffer.from('\x1b'))
    }, 5)
    const res = await pickerPromise
    expect(res.cancelled).toBe(true)
    expect(events).toEqual(['enter', 'exit'])
  })
})
