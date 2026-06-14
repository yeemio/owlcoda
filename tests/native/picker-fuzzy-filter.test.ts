import { describe, it, expect } from 'vitest'
import { filterPickerItems, nameMatchScore } from '../../src/native/tui/picker.js'
import { buildSlashPickerItems } from '../../src/native/repl-shared.js'
import type { PickerItem } from '../../src/native/tui/picker.js'

// The slash picker used to fuzzy-match the query against `name + description +
// meta + tag` joined into one haystack, with a loose subsequence test. With ~85
// commands each carrying a sentence-long description, almost any short query
// produced a subsequence hit somewhere in SOME description, so the picker was
// unusable: typing "re" returned 66/85 commands, "set" returned 41, and typing
// "mode" buried the actual /mode under /model, /models, /recommend, /color…
//
// The fix matches the COMMAND NAME primarily (tiered exact > prefix > substring
// > subsequence) and only falls back to description text when no name matched at
// all — so a semantic query ("authentication" → /login) still resolves without
// letting stray description letters flood short name queries.

const labels = (items: PickerItem<string>[]): string[] => items.map((i) => i.label)

describe('nameMatchScore — tiered name matching', () => {
  it('ranks exact < prefix < substring < subsequence', () => {
    const exact = nameMatchScore('mode', '/mode')
    const prefix = nameMatchScore('mode', '/model')
    const substring = nameMatchScore('ode', '/model') // "ode" is a substring of "model"
    const subseq = nameMatchScore('mdl', '/model') // m-d-l scattered
    expect(exact).toBeGreaterThanOrEqual(0)
    expect(exact).toBeLessThan(prefix)
    expect(prefix).toBeLessThan(substring)
    expect(substring).toBeLessThan(subseq)
  })

  it('is case-insensitive and slash-insensitive', () => {
    expect(nameMatchScore('MODE', '/mode')).toBe(0)
    expect(nameMatchScore('/mode', '/mode')).toBe(0)
  })

  it('returns -1 when the query is not even a subsequence of the name', () => {
    expect(nameMatchScore('xyz', '/mode')).toBe(-1)
    // "mode" must NOT match /recommend by name (it only matched via the old
    // description haystack: "Model recommendation…")
    expect(nameMatchScore('mode', '/recommend')).toBe(-1)
  })

  it('prefers shorter names within the same tier', () => {
    expect(nameMatchScore('mode', '/mode')).toBeLessThan(nameMatchScore('mode', '/model'))
    expect(nameMatchScore('mode', '/model')).toBeLessThan(nameMatchScore('mode', '/models'))
  })
})

describe('filterPickerItems — slash command picker', () => {
  const items = buildSlashPickerItems()

  it('empty query returns every item unchanged', () => {
    expect(filterPickerItems(items, '')).toHaveLength(items.length)
    expect(filterPickerItems(items, '   ')).toHaveLength(items.length)
  })

  it('"mode" surfaces /mode FIRST and drops description-only pollution', () => {
    const out = labels(filterPickerItems(items, 'mode'))
    expect(out[0]).toBe('/mode')
    // these only matched before because their DESCRIPTION contained the letters
    expect(out).not.toContain('/recommend')
    expect(out).not.toContain('/color')
    expect(out).not.toContain('/warmup')
    expect(out).not.toContain('/brief')
    // a real prefix relative is fine, just ranked after the exact hit
    expect(out).toContain('/model')
  })

  it('"set" collapses from 41 garbage matches to the genuine name matches', () => {
    const out = labels(filterPickerItems(items, 'set'))
    expect(out).toContain('/reset')   // substring "re·SET"
    expect(out).not.toContain('/save')
    expect(out).not.toContain('/sessions')
    expect(out).not.toContain('/dashboard')
    expect(out.length).toBeLessThanOrEqual(6)
  })

  it('"re" no longer returns ~78% of the command list', () => {
    const out = labels(filterPickerItems(items, 're'))
    // genuine prefix matches lead
    expect(out[0]!.startsWith('/re')).toBe(true)
    // /yolo only matched before via its description ("auto-appRovE EvEry")
    expect(out).not.toContain('/yolo')
    // hard ceiling: the old behaviour returned 66/85; names with an r..e
    // subsequence are far fewer
    expect(out.length).toBeLessThan(35)
  })

  it('"status" finds /status without dragging in /stats and friends', () => {
    const out = labels(filterPickerItems(items, 'status'))
    expect(out).toContain('/status')
    expect(out[0]).toBe('/status')
    expect(out).not.toContain('/stats')
    expect(out).not.toContain('/ratelimit')
  })

  it('falls back to description search only when NO name matches', () => {
    // "authentication" matches no command NAME, so the fallback searches the
    // description ("Authentication info") and resolves /login.
    const out = labels(filterPickerItems(items, 'authentication'))
    expect(out).toContain('/login')
  })

  it('a name match suppresses the description fallback (no flooding)', () => {
    // "config" matches /config by name, so we must NOT also pull in every
    // command whose description happens to contain c-o-n-f-i-g as a subsequence.
    const out = labels(filterPickerItems(items, 'config'))
    expect(out).toContain('/config')
    expect(out.length).toBeLessThanOrEqual(4)
  })
})
