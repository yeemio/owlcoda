import { describe, it, expect } from 'vitest'
import {
  createUnifiedDiff,
  renderChangeBlockLines,
  renderFileCreateLines,
  countDiffStats,
} from '../../../src/native/tui/diff.js'
import { stripAnsi } from '../../../src/native/tui/colors.js'

describe('createUnifiedDiff', () => {
  it('produces add/remove/context lines for a single-line change', () => {
    const oldText = 'line1\nline2\nline3'
    const newText = 'line1\nCHANGED\nline3'
    const diff = createUnifiedDiff(oldText, newText)
    const types = diff.map((d) => d.type)
    expect(types).toContain('context')
    expect(types).toContain('remove')
    expect(types).toContain('add')
  })
})

describe('renderChangeBlockLines', () => {
  it('emits indented diff body with 1-based line numbers by default', () => {
    const body = renderChangeBlockLines('a\nb\nc', 'a\nB\nc', { termCols: 80 })
    const plain = body.map((l: string) => stripAnsi(l).trimEnd())
    expect(plain.some((l: string) => /^\s+1\s+ a$/.test(l))).toBe(true)
    expect(plain.some((l: string) => /^\s+2\s+-\s+b$/.test(l))).toBe(true)
    expect(plain.some((l: string) => /^\s+2\s+\+\s+B$/.test(l))).toBe(true)
    expect(plain.some((l: string) => /^\s+3\s+ c$/.test(l))).toBe(true)
  })

  it('offsets line numbers by startLine', () => {
    const body = renderChangeBlockLines('a\nb', 'a\nB', { startLine: 42, termCols: 80 })
    const plain = body.map((l: string) => stripAnsi(l).trimEnd())
    expect(plain.some((l: string) => /^\s+42\s+ a$/.test(l))).toBe(true)
    expect(plain.some((l: string) => /^\s+43\s+-\s+b$/.test(l))).toBe(true)
    expect(plain.some((l: string) => /^\s+43\s+\+\s+B$/.test(l))).toBe(true)
  })

  it('drops the trailing blank line produced by a terminating newline', () => {
    const body = renderChangeBlockLines('x\n', 'x\n', { termCols: 80 })
    const plain = body.map((l: string) => stripAnsi(l).trimEnd())
    expect(plain.filter((l: string) => /\S/.test(l)).length).toBe(1)
    expect(plain[0]).toMatch(/^\s+1\s+ x$/)
  })

  it('paints diffAddedDim / diffRemovedDim background on add/remove rows', () => {
    const body = renderChangeBlockLines('a\nb\nc', 'a\nB\nc', { termCols: 80 })
    const addLine = body.find((l: string) => stripAnsi(l).includes('+ B'))!
    const removeLine = body.find((l: string) => stripAnsi(l).includes('- b'))!
    const contextLine = body.find((l: string) => /\s{2}a/.test(stripAnsi(l).trimEnd()))!
    expect(addLine).toMatch(/\x1b\[48;2;/)
    expect(removeLine).toMatch(/\x1b\[48;2;/)
    expect(contextLine).not.toMatch(/\x1b\[48;2;/)
  })

  it('truncates beyond maxLines and appends a dim tail', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `old${i}`).join('\n')
    const newText = Array.from({ length: 10 }, (_, i) => `new${i}`).join('\n')
    const body = renderChangeBlockLines(oldText, newText, { maxLines: 5, termCols: 80 })
    // With the design's hunk-header band prepended, body now starts with
    // a `@@ -... +... @@` row; total = 1 (header) + 5 (lines) + 1 (tail) = 7.
    expect(body.length).toBe(7)
    expect(stripAnsi(body[0]!)).toMatch(/^\s+@@ /)
    expect(stripAnsi(body[6]!)).toMatch(/more hunk lines/)
  })

  it('contains no box-drawing characters so drag-select stays clean', () => {
    const body = renderChangeBlockLines('a\nb', 'a\nB', { termCols: 80 })
    for (const line of body) {
      expect(line).not.toMatch(/[│╭╮╯╰─┃┏┓┗┛━]/)
    }
  })

  it('respects narrow terminals by tightening the body budget', () => {
    const longLine = 'x'.repeat(200)
    const body = renderChangeBlockLines('a', longLine, { termCols: 40 })
    const addLine = body.find((l: string) => stripAnsi(l).includes('+ x'))!
    expect(stripAnsi(addLine).length).toBeLessThanOrEqual(40)
  })
})

describe('renderFileCreateLines', () => {
  it('treats every line as an add with 1-based line numbers', () => {
    const body = renderFileCreateLines('hello\nworld', { termCols: 80 })
    const plain = body.map((l: string) => stripAnsi(l).trimEnd())
    // Hunk header sits first per design (`@@ -0,0 +1,N @@ new file`),
    // then each content row.
    expect(plain[0]).toMatch(/^\s+@@ -0,0 \+1,2 @@ new file/)
    expect(plain[1]).toMatch(/^\s+1\s+\+ hello$/)
    expect(plain[2]).toMatch(/^\s+2\s+\+ world$/)
  })

  it('drops the trailing blank line for newline-terminated content', () => {
    const body = renderFileCreateLines('only\n', { termCols: 80 })
    const plain = body.map((l: string) => stripAnsi(l).trimEnd())
    expect(plain.length).toBe(2)            // hunk header + 1 line
    expect(plain[0]).toMatch(/^\s+@@ -0,0 \+1,1 @@/)
    expect(plain[1]).toMatch(/^\s+1\s+\+ only$/)
  })

  it('paints success-soft background on every content row', () => {
    const body = renderFileCreateLines('a\nb', { termCols: 80 })
    // Skip the hunk header row (which uses bgCard, not the add band).
    for (const line of body.slice(1)) {
      expect(line).toMatch(/\x1b\[48;2;/)
    }
  })

  it('appends a truncation tail when exceeding maxLines', () => {
    const content = Array.from({ length: 40 }, (_, i) => `ln${i}`).join('\n')
    const body = renderFileCreateLines(content, { maxLines: 10, termCols: 80 })
    // 1 hunk header + 10 lines + 1 truncation tail = 12.
    expect(body.length).toBe(12)
    expect(stripAnsi(body[11]!)).toMatch(/\+\d+ more lines/)
  })
})

describe('countDiffStats', () => {
  it('counts added and removed lines in a change region', () => {
    const stats = countDiffStats('a\nb\nc', 'a\nX\nY\nc')
    expect(stats.removed).toBe(1)
    expect(stats.added).toBe(2)
  })

  it('returns zeros for identical input', () => {
    const stats = countDiffStats('same', 'same')
    expect(stats.added).toBe(0)
    expect(stats.removed).toBe(0)
  })

  it('ignores a trailing newline when counting (append case)', () => {
    // Appending one line to a newline-terminated file should count as +1/-0,
    // not +2/-0 from a ghost blank line.
    const stats = countDiffStats('a\n', 'a\nb\n')
    expect(stats.added).toBe(1)
    expect(stats.removed).toBe(0)
  })
})
