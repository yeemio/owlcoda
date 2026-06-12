import { beforeEach, describe, expect, it } from 'vitest'
import { renderMarkdown, resetListState } from '../../src/native/markdown.js'

// 2026-06-12 ghostty repro: source had two independent `1.`-`6.` ordered
// lists separated by a `## …` heading; the second list rendered `7.`-`12.`.
// renderLine only reset the OL counter stack on the fall-through plain-text
// branch — headings, rules, and other early-return branches leaked the
// counter into the next list.

function nums(out: string): number[] {
  return [...out.replace(/\[[0-9;]*m/g, '').matchAll(/^\s*(\d+)\./gm)].map(m => Number(m[1]))
}

describe('ordered list counter resets between lists', () => {
  beforeEach(() => resetListState())

  it('a heading between two lists starts the second at 1', () => {
    const md = '## 优势\n\n1. 甲\n2. 乙\n3. 丙\n\n## 建议\n\n1. 拆分\n2. 统一\n3. 引入'
    expect(nums(renderMarkdown(md))).toEqual([1, 2, 3, 1, 2, 3])
  })

  it('a horizontal rule between two lists starts the second at 1', () => {
    const md = '1. a\n2. b\n\n---\n\n1. c\n2. d'
    expect(nums(renderMarkdown(md))).toEqual([1, 2, 1, 2])
  })

  it('an unordered list between two ordered lists resets the counter', () => {
    const md = '1. a\n2. b\n\n- x\n- y\n\n1. c\n2. d'
    expect(nums(renderMarkdown(md))).toEqual([1, 2, 1, 2])
  })

  it('honors the source start number', () => {
    const md = '3. a\n4. b'
    expect(nums(renderMarkdown(md))).toEqual([3, 4])
  })

  it('still continues numbering across blank lines inside one list', () => {
    const md = '1. a\n\n2. b\n\n3. c'
    expect(nums(renderMarkdown(md))).toEqual([1, 2, 3])
  })
})
