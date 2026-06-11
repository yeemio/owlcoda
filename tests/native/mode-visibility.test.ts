import { describe, expect, it } from 'vitest'
import { renderComposerRail } from '../../src/native/tui/message.js'
import { SLASH_COMMANDS_REQUIRING_ARGS } from '../../src/native/repl-shared.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

const base = {
  model: 'kimi-code',
  mode: 'plan' as const, // legacy derived busy-signal prop, NOT the operating mode
  busy: false,
  queued: 0,
  contextTokens: 0,
  contextMax: 0,
  draftChars: 0,
  interruptRequested: false,
}

// Operating modes shipped (0.14.46) but were invisible: the rail's MODE slot
// was a deliberately-empty forwards-compat placeholder, so /mode plan|auto
// produced ZERO persistent visual change — dogfood read it as "mode is
// broken". The rail must paint non-default operating modes; `normal` stays
// unpainted so the default rail is unchanged.
describe('composer rail operating-mode cell', () => {
  it('shows MODE plan when the operating mode is plan', () => {
    const out = stripAnsi(renderComposerRail({ ...base, operatingMode: 'plan' }))
    expect(out).toMatch(/MODE plan/i)
  })

  it('shows MODE auto when the operating mode is auto', () => {
    const out = stripAnsi(renderComposerRail({ ...base, operatingMode: 'auto' }))
    expect(out).toMatch(/MODE auto/i)
  })

  it('paints nothing for normal (default rail unchanged)', () => {
    const out = stripAnsi(renderComposerRail({ ...base, operatingMode: 'normal' }))
    expect(out).not.toMatch(/MODE\s/)
  })

  it('paints nothing when operatingMode is absent (modes off)', () => {
    const out = stripAnsi(renderComposerRail(base))
    expect(out).not.toMatch(/MODE\s/)
  })
})

// Selecting /mode from the slash picker used to EXECUTE it immediately with
// no argument — printing a status blurb instead of letting the user pick a
// mode. Prefill like /resume et al so the picker flow is "select → type arg".
describe('/mode picker prefill', () => {
  it('/mode requires an argument (picker prefills instead of executing)', () => {
    expect(SLASH_COMMANDS_REQUIRING_ARGS.has('/mode')).toBe(true)
  })
})
