import { describe, it, expect } from 'vitest'
import {
  createPasteStore,
  resetPasteStore,
  detectPasteInsert,
  shouldCollapse,
  collapsePaste,
  expandPlaceholders,
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
    expect(collapsed).toMatch(/^prompt: \[Pasted #1 250 chars\]$/)
    expect(collapsed).not.toContain('X')
    // Expand back to raw.
    const expanded = expandPlaceholders(collapsed, store)
    expect(expanded).toBe(next)
  })

  it('annotates multi-line pastes with line count', () => {
    const store = createPasteStore()
    const raw = 'a\nb\nc\nd\ne\nf' // 6 lines
    const insert = detectPasteInsert('', raw)
    expect(insert).not.toBeNull()
    const { value } = collapsePaste(store, '', insert!)
    expect(value).toMatch(/\[Pasted #1 \d+ chars \/ 6 lines\]/)
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
