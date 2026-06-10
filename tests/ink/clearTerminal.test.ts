import { describe, it, expect } from 'vitest'
import { getClearTerminalSequence, getNuclearClearSequence } from '../../src/ink/clearTerminal.js'

describe('clearTerminal sequences', () => {
  it('default getClearTerminalSequence preserves scrollback (no ERASE_SCROLLBACK)', () => {
    const seq = getClearTerminalSequence()
    // ERASE_SCROLLBACK is CSI 3 J — must NOT appear
    expect(seq).not.toContain('\x1b[3J')
    // Should still erase visible screen (CSI 2 J) and home cursor (CSI H)
    expect(seq).toContain('\x1b[2J')
    expect(seq).toContain('\x1b[H')
  })

  it('getNuclearClearSequence also wipes scrollback (for /clear slash command)', () => {
    const seq = getNuclearClearSequence()
    // Must include ERASE_SCROLLBACK in addition to screen+home
    expect(seq).toContain('\x1b[3J')
    expect(seq).toContain('\x1b[2J')
    expect(seq).toContain('\x1b[H')
  })

  it('default and nuclear differ on non-Windows (copy-paste guard)', () => {
    // If a future refactor accidentally made getNuclearClearSequence
    // identical to the default (e.g. dropped the \x1b[3J), both tests
    // above could still pass individually. This guards against that
    // specific copy-paste regression. Skipped on win32 where legacy
    // conhost can't emit \x1b[3J so both are deliberately equal.
    if (process.platform === 'win32') return
    expect(getClearTerminalSequence()).not.toBe(getNuclearClearSequence())
  })
})
