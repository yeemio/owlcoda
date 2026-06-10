/**
 * Tests for the slash-picker Enter-fallback (the "/mode normal" trap).
 *
 * The slash picker opens on a bare "/" and fuzzy-matches the typed query
 * against command haystacks. Typing a command WITH an argument
 * ("/mode normal" → query "mode normal") matches nothing → "0/84 matches" →
 * the picker's Enter handler has no item to select → nothing happens, and the
 * user can't leave plan mode. resolveSlashPickerRawSubmit lets Enter submit the
 * raw command when the first token is a known slash command and an argument was
 * typed — while leaving the no-arg select / REQUIRING_ARGS prefill flow alone.
 */
import { describe, it, expect } from 'vitest'
import { resolveSlashPickerRawSubmit } from '../src/native/repl-shared.js'
import { SLASH_COMMANDS } from '../src/native/slash-commands.js'

describe('resolveSlashPickerRawSubmit', () => {
  it('submits a known command typed with an argument (the /mode normal trap)', () => {
    expect(resolveSlashPickerRawSubmit('mode normal', SLASH_COMMANDS)).toBe('/mode normal')
    expect(resolveSlashPickerRawSubmit('mode auto', SLASH_COMMANDS)).toBe('/mode auto')
    expect(resolveSlashPickerRawSubmit('mode plan', SLASH_COMMANDS)).toBe('/mode plan')
  })

  it('returns null with no argument, so select / REQUIRING_ARGS prefill is untouched', () => {
    expect(resolveSlashPickerRawSubmit('mode', SLASH_COMMANDS)).toBeNull()
    expect(resolveSlashPickerRawSubmit('branch', SLASH_COMMANDS)).toBeNull()
  })

  it('also lets arg-requiring commands take their arg inline', () => {
    expect(resolveSlashPickerRawSubmit('branch my-feature', SLASH_COMMANDS)).toBe('/branch my-feature')
  })

  it('preserves spaces inside the argument (e.g. a commit message)', () => {
    expect(resolveSlashPickerRawSubmit('commit fix the picker bug', SLASH_COMMANDS)).toBe('/commit fix the picker bug')
  })

  it('returns null for an unknown first token (never submit garbage)', () => {
    expect(resolveSlashPickerRawSubmit('asdf qwer', SLASH_COMMANDS)).toBeNull()
  })

  it('lowercases the command token but preserves the argument casing', () => {
    expect(resolveSlashPickerRawSubmit('MODE Normal', SLASH_COMMANDS)).toBe('/mode Normal')
  })

  it('ignores surrounding whitespace and collapses the command/arg separator', () => {
    expect(resolveSlashPickerRawSubmit('   mode   ', SLASH_COMMANDS)).toBeNull()
    expect(resolveSlashPickerRawSubmit('  mode   normal  ', SLASH_COMMANDS)).toBe('/mode normal')
  })

  it('returns null on empty input', () => {
    expect(resolveSlashPickerRawSubmit('', SLASH_COMMANDS)).toBeNull()
  })
})
