import { describe, expect, it } from 'vitest'
import { isModifierPressed } from '../../src/utils/modifiers.js'

describe('isModifierPressed', () => {
  // Regression: owlcoda exited on Enter in macOS Terminal.app. Root cause —
  // handleEnter (useTextInput) calls isModifierPressed('shift') only when
  // env.terminal === 'Apple_Terminal', and isModifierPressed did an UNGUARDED
  // require('modifiers-napi'). That native addon is not bundled, so require
  // threw "Cannot find module", the throw escaped the Enter handler, and the
  // REPL died before onSubmit ran. (tmux/headless never hit the branch.)
  // The native call must never escape as a throw — degrade to false so the
  // caller falls through to a normal submit.
  it('never throws when the native modifier module is unavailable', () => {
    expect(() => isModifierPressed('shift')).not.toThrow()
  })

  it('returns a boolean for every modifier', () => {
    for (const mod of ['shift', 'command', 'control', 'option'] as const) {
      expect(typeof isModifierPressed(mod)).toBe('boolean')
    }
  })
})
