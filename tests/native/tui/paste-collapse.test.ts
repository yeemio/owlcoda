/**
 * Slice C acceptance annotations (2026-05-08):
 *
 * Manual checks required before release (not automated here):
 *   1. Paste 5KB CJK into composer → visible shows "[Pasted text #1 +N lines]"
 *   2. Submit → model receives full CJK text
 *   3. Paste 5KB CJK → press Backspace once → token deleted atomically; store size = 0
 *   4. Paste 5KB CJK → press Ctrl+U → composer clears; store size = 0
 *   5. Running task + fast typing for 5s → no noticeable lag
 *
 * Automated regression: all 24 tests in this file (token format, round-trip,
 * pruneStaleTokens, GC round-trip, burst collapse).
 */
import { describe, it, expect } from 'vitest'
import {
  createPasteStore,
  resetPasteStore,
  detectPasteInsert,
  shouldCollapse,
  collapsePaste,
  expandPlaceholders,
  pruneStaleTokens,
  createBurstState,
  resetBurst,
  tryBurstCollapse,
} from '../../../src/native/tui/paste-collapse.js'

describe('detectPasteInsert', () => {
  it('detects a pure insertion at the start', () => {
    const insert = detectPasteInsert('world', 'hello world')
    expect(insert).toEqual({ index: 0, inserted: 'hello ' })
  })

  it('detects a pure insertion in the middle', () => {
    const insert = detectPasteInsert('abcxyz', 'abcMIDDLExyz')
    expect(insert).toEqual({ index: 3, inserted: 'MIDDLE' })
  })

  it('detects a pure insertion at the end', () => {
    const insert = detectPasteInsert('hello', 'hello world')
    expect(insert).toEqual({ index: 5, inserted: ' world' })
  })

  it('returns null when next is not longer than prev', () => {
    expect(detectPasteInsert('abc', 'abc')).toBeNull()
    expect(detectPasteInsert('abcdef', 'abc')).toBeNull()
  })

  it('returns null on a replacement (not a pure insert)', () => {
    // Prefix "ab" matches, suffix "" matches, but the middle doesn't
    // account for the length delta cleanly because "c" was removed.
    const insert = detectPasteInsert('abc', 'abXYZ')
    expect(insert).toBeNull()
  })
})

describe('shouldCollapse', () => {
  it('returns true for long pastes', () => {
    const big = 'x'.repeat(300)
    expect(shouldCollapse(big)).toBe(true)
  })
  it('returns true for multi-line pastes (5+ lines)', () => {
    expect(shouldCollapse('a\nb\nc\nd\ne')).toBe(true)
  })
  it('returns false for short, few-line inserts', () => {
    expect(shouldCollapse('hello')).toBe(false)
    expect(shouldCollapse('line one\nline two')).toBe(false)
  })
})

describe('collapse + expand round-trip', () => {
  it('replaces a pasted blob with a placeholder and restores on expand', () => {
    const store = createPasteStore()
    const prev = 'prompt: '
    const rawPaste = 'X'.repeat(250)
    const next = prev + rawPaste
    const insert = detectPasteInsert(prev, next)
    expect(insert).not.toBeNull()
    const { value: collapsed } = collapsePaste(store, prev, insert!)
    expect(collapsed).toBe('prompt: [Pasted text #1]')
    expect(collapsed).not.toContain('X')
    // Expand back to raw.
    const expanded = expandPlaceholders(collapsed, store)
    expect(expanded).toBe(next)
  })

  it('annotates multi-line pastes with line count', () => {
    const store = createPasteStore()
    const raw = 'a\nb\nc\nd\ne\nf' // 6 lines → +5 newlines
    const insert = detectPasteInsert('', raw)
    expect(insert).not.toBeNull()
    const { value } = collapsePaste(store, '', insert!)
    expect(value).toBe('[Pasted text #1 +5 lines]')
  })

  it('token format matches [Pasted text #N] / [Pasted text #N +X lines]', () => {
    const store = createPasteStore()
    // Single-line paste: no line suffix
    const raw1 = 'X'.repeat(250)
    const insert1 = detectPasteInsert('', raw1)!
    const { value: v1 } = collapsePaste(store, '', insert1)
    expect(v1).toBe('[Pasted text #1]')

    // Multi-line paste: +X lines suffix
    const raw2 = 'a\nb\nc\nd\ne\nf' // 6 lines → +5 lines (newline count)
    const insert2 = detectPasteInsert('', raw2)!
    const { value: v2 } = collapsePaste(store, '', insert2)
    expect(v2).toBe('[Pasted text #2 +5 lines]')
  })

  it('leaves unrecognized bracket text alone when expanding', () => {
    const store = createPasteStore()
    const out = expandPlaceholders('plain text [Pasted #99 10 chars] more', store)
    expect(out).toBe('plain text [Pasted #99 10 chars] more')
  })
})

describe('resetPasteStore', () => {
  it('clears entries and resets the id counter', () => {
    const store = createPasteStore()
    const insert = detectPasteInsert('', 'Y'.repeat(250))
    collapsePaste(store, '', insert!)
    expect(store.entries.size).toBe(1)
    resetPasteStore(store)
    expect(store.entries.size).toBe(0)
    expect(store.nextId).toBe(1)
  })
})

describe('pruneStaleTokens', () => {
  it('removes store entries whose token is absent from the visible value', () => {
    const store = createPasteStore()
    const insert1 = detectPasteInsert('', 'A'.repeat(250))!
    const { token: t1 } = collapsePaste(store, '', insert1)
    const insert2 = detectPasteInsert('', 'B'.repeat(250))!
    const { token: t2 } = collapsePaste(store, t1, insert2)
    expect(store.entries.size).toBe(2)

    // Simulate: user deleted the second token, first remains in visible value
    const visibleWithOnlyFirst = t1
    pruneStaleTokens(store, visibleWithOnlyFirst)
    expect(store.entries.has(t1)).toBe(true)
    expect(store.entries.has(t2)).toBe(false)
    expect(store.entries.size).toBe(1)
  })

  it('is a no-op when visible value contains all tokens', () => {
    const store = createPasteStore()
    const insert = detectPasteInsert('', 'X'.repeat(250))!
    const { token } = collapsePaste(store, '', insert)
    pruneStaleTokens(store, `context ${token} more`)
    expect(store.entries.size).toBe(1)
  })

  it('clears all entries when visible value is empty', () => {
    const store = createPasteStore()
    const insert = detectPasteInsert('', 'X'.repeat(250))!
    collapsePaste(store, '', insert)
    pruneStaleTokens(store, '')
    expect(store.entries.size).toBe(0)
  })
})

describe('collapse-then-delete GC round-trip', () => {
  it('store entry is removed when the placeholder is later deleted from visible value', () => {
    const store = createPasteStore()
    const raw = 'X'.repeat(250)

    // Step 1: paste arrives and collapses
    const insert = detectPasteInsert('prefix ', 'prefix ' + raw)!
    const { value: collapsed } = collapsePaste(store, 'prefix ', insert)
    expect(store.entries.size).toBe(1)

    // Step 2: user deletes the placeholder — visible value returns to 'prefix '
    pruneStaleTokens(store, 'prefix ')
    expect(store.entries.size).toBe(0)

    // Step 3: expandPlaceholders on empty string is a no-op
    expect(expandPlaceholders('prefix ', store)).toBe('prefix ')
  })
})

// 0.13.72 paste-perf — chunked-paste burst collapse. Captures the
// real-world failure pattern where bracketed-paste sequences are
// stripped (SSH proxy / tmux without allow-passthrough / older
// terminals) so a long paste arrives as N small chunks. Each
// individual chunk's diff is below the per-event collapse
// threshold; cumulative diff from a captured anchor exceeds it.
describe('tryBurstCollapse (0.13.72)', () => {
  it('collapses a chunked paste whose individual chunks are below the per-event threshold', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    // Three chunks of 80 chars each = 240 chars total. Each chunk
    // alone is below the 200-char per-event collapse threshold,
    // but cumulatively they cross it.
    const chunk = 'x'.repeat(80)
    const t0 = 1_000_000
    let value = ''

    // Chunk 1 — first event: anchor captured at empty value.
    let r = tryBurstCollapse(burst, store, value, value + chunk, t0)
    expect(r).toBeNull() // 80 chars < threshold
    value += chunk

    // Chunk 2 — 10ms later, well within window.
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 10)
    expect(r).toBeNull() // 160 chars < threshold
    value += chunk

    // Chunk 3 — 20ms later, cumulative 240 chars crosses threshold.
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 20)
    expect(r).not.toBeNull()
    expect(r!.value).toBe('[Pasted text #1]')
    expect(r!.token).toBe('[Pasted text #1]')
    // The placeholder should fully replace the burst — value has no remnant of the raw chunk.
    expect(r!.value).not.toContain(chunk)
  })

  it('does not collapse slow-typed sequences (window expires between events)', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    const chunk = 'y'.repeat(80)
    const t0 = 2_000_000
    let value = ''

    // First chunk
    let r = tryBurstCollapse(burst, store, value, value + chunk, t0)
    expect(r).toBeNull()
    value += chunk

    // 200ms gap — anchor expires, new anchor captured at this value
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 200)
    expect(r).toBeNull()
    value += chunk

    // Another 200ms gap, anchor refreshes again
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 400)
    expect(r).toBeNull()
  })

  it('refreshes the anchor on shrink (deletion) so a subsequent paste starts a fresh burst', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    const chunk = 'z'.repeat(50)
    const t0 = 3_000_000

    // Build up a few chunks within window
    let value = ''
    let r = tryBurstCollapse(burst, store, value, chunk, t0)
    expect(r).toBeNull()
    value = chunk
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 10)
    expect(r).toBeNull()
    value += chunk

    // User backspaces to a shorter value — burst must reset.
    const shorter = chunk.slice(0, 20)
    r = tryBurstCollapse(burst, store, value, shorter, t0 + 20)
    expect(r).toBeNull()
    expect(burst.anchorAt).toBe(0)
    expect(burst.anchorValue).toBe('')

    // From the new (empty) anchor, a small typed addition refreshes
    // the anchor to `shorter` and does not collapse.
    r = tryBurstCollapse(burst, store, shorter, shorter + 'a', t0 + 30)
    expect(r).toBeNull()
    expect(burst.anchorValue).toBe(shorter)
  })

  it('a single big-enough event collapses on the first call (no burst needed)', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    const big = 'q'.repeat(500)
    const r = tryBurstCollapse(burst, store, '', big, 4_000_000)
    expect(r).not.toBeNull()
    expect(r!.value).toBe('[Pasted text #1]')
  })

  it('resets the burst after a successful collapse so the placeholder is the new baseline', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    const chunk = 'a'.repeat(150)
    const t0 = 5_000_000

    // First chunk doesn't collapse
    let value = ''
    let r = tryBurstCollapse(burst, store, value, value + chunk, t0)
    expect(r).toBeNull()
    value += chunk

    // Second chunk — 300 chars cumulative — collapses
    r = tryBurstCollapse(burst, store, value, value + chunk, t0 + 10)
    expect(r).not.toBeNull()
    const collapsedValue = r!.value
    // After collapse, anchor reset.
    expect(burst.anchorAt).toBe(0)

    // A third chunk arriving after the collapse — anchor refreshes
    // to the placeholder, NOT to the original chunk concatenation.
    r = tryBurstCollapse(burst, store, collapsedValue, collapsedValue + 'c', t0 + 20)
    expect(r).toBeNull()
    expect(burst.anchorValue).toBe(collapsedValue)
  })

  it('resetBurst clears state explicitly', () => {
    const burst = createBurstState()
    burst.anchorValue = 'something'
    burst.anchorAt = 12345
    resetBurst(burst)
    expect(burst.anchorValue).toBe('')
    expect(burst.anchorAt).toBe(0)
  })

  it('multi-line chunks count toward the line threshold even at small char count', () => {
    const burst = createBurstState()
    const store = createPasteStore()
    // Each chunk is 5 lines, well under the char threshold but still
    // a paste signal. Two chunks within window cross the line threshold.
    const chunk = 'a\nb\nc\nd\ne\nf' // 6 lines, 11 chars
    const t0 = 6_000_000
    let value = ''
    let r = tryBurstCollapse(burst, store, value, value + chunk, t0)
    // 6 lines >= 5 → collapses on first event itself.
    expect(r).not.toBeNull()
    void value
  })
})
