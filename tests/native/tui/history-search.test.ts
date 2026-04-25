/**
 * Tests for HistorySearch (Ctrl+R interactive search)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistorySearch } from '../../../src/native/tui/history-search.js'

// Minimal readline mock
function makeRl(history: string[] = []) {
  const rl = {
    line: '',
    cursor: 0,
    history,
    prompt: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  return rl as any
}

describe('HistorySearch', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('creates without crashing', () => {
    const rl = makeRl()
    const hs = new HistorySearch(rl)
    expect(hs).toBeDefined()
    expect(hs.isActive).toBe(false)
  })

  it('isActive is false by default', () => {
    const rl = makeRl()
    const hs = new HistorySearch(rl)
    expect(hs.isActive).toBe(false)
  })

  it('install and uninstall manage keypress handlers', () => {
    const onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin)
    const removeSpy = vi.spyOn(process.stdin, 'removeListener').mockImplementation(() => process.stdin)

    const rl = makeRl()
    const hs = new HistorySearch(rl)

    hs.install()
    expect(onSpy).toHaveBeenCalledWith('keypress', expect.any(Function))

    hs.uninstall()
    expect(removeSpy).toHaveBeenCalledWith('keypress', expect.any(Function))

    onSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('double install is idempotent', () => {
    const onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin)

    const rl = makeRl()
    const hs = new HistorySearch(rl)

    hs.install()
    hs.install() // should not add a second handler
    expect(onSpy).toHaveBeenCalledTimes(1)

    hs.uninstall()
    onSpy.mockRestore()
  })

  it('double uninstall is safe', () => {
    const rl = makeRl()
    const hs = new HistorySearch(rl)
    hs.uninstall() // no-op when not installed
    hs.uninstall() // should not throw
  })
})
