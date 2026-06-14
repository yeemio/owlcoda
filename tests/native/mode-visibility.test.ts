import { describe, expect, it } from 'vitest'
import { renderComposerRail } from '../../src/native/tui/message.js'
import { buildSlashPickerItems, SLASH_COMMANDS_REQUIRING_ARGS } from '../../src/native/repl-shared.js'
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

// /plan is now a demoted alias of `/mode plan` — it still works if typed, but
// the picker no longer lists it (one permission axis = /mode). The promoted
// /mode entry is the one that must surface plan, and its hint must name the
// modes (it used to be the bare, useless "Switch operating mode").
describe('the permission surface is /mode, with /plan demoted to an alias', () => {
  it('does not list /plan in the picker (it folded into /mode)', () => {
    expect(buildSlashPickerItems().find((i) => i.value === '/plan')).toBeUndefined()
  })

  it('the /mode picker hint names the available modes, including plan', () => {
    const mode = buildSlashPickerItems().find((i) => i.value === '/mode')
    expect(mode).toBeDefined()
    const desc = (mode?.description ?? '').toLowerCase()
    expect(desc).toContain('plan')
    expect(desc).toContain('yolo')
  })
})
