/**
 * 0.13.94 contract: a heading line that has an ordered-list item glued onto
 * the end without a separating newline must pre-split into heading + list.
 * Real-world emit: `## 建议修改清单1. 模型名核实` (the model dropped the \n).
 *
 * Heuristic anchors on a CJK boundary so we don't break legitimate cases:
 *   - `## Section 1. Intro`     → no CJK before digit, single heading
 *   - `## 1.5. Title`           → no CJK before digit, single heading
 *   - `## 第3章 概述`            → no `\d+. ` shape, single heading
 *   - `## 建议修改清单1. 模型名核实` → split: heading('建议修改清单') + list('1. 模型名核实')
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown, StreamingMarkdownRenderer } from '../../src/native/markdown.js'
import { stripAnsi } from '../../src/native/tui/colors.js'
import { MarkdownBlockNormalizer } from '../../src/native/markdown-normalizer.js'

function normalize(t: string): string {
  const lines = stripAnsi(t).split('\n').map(l => l.replace(/\s+$/, ''))
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const blank = l === ''
    if (blank && prevBlank) continue
    out.push(l)
    prevBlank = blank
  }
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
function full(s: string): string { return normalize(renderMarkdown(s)) }
function streamed(s: string): string {
  const r = new StreamingMarkdownRenderer()
  return normalize(r.push(s) + r.flush())
}
function streamedTok(s: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  for (const c of s) out += r.push(c)
  out += r.flush()
  return normalize(out)
}

describe('0.13.94 heading + ordered-list glue', () => {
  it('CJK + N. + content splits into heading + list-text token', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll('## 建议修改清单1. 模型名核实\n')
    expect(tokens.map(t => t.kind)).toEqual(['heading', 'text'])
    const heading = tokens[0]
    const text = tokens[1]
    if (heading?.kind === 'heading') {
      expect(heading.level).toBe(2)
      expect(heading.text).toBe('建议修改清单')
    }
    if (text?.kind === 'text') {
      expect(text.text).toBe('1. 模型名核实')
    }
  })

  it('full-pass emits heading then list-styled line', () => {
    const out = full('前置。\n\n## 建议修改清单1. 模型名核实\n后续。\n')
    // The heading appears
    expect(out).toContain('建议修改清单')
    // The list item is on its own line, not concatenated to the heading
    const headingLine = out.split('\n').find(l => l.includes('建议修改清单'))
    expect(headingLine).toBeDefined()
    expect(headingLine!).not.toContain('1. 模型名核实')
    // The list item content appears somewhere
    expect(out).toContain('模型名核实')
  })

  it('streaming (1-chunk) = full-pass for glued shape', () => {
    const src = '前置。\n\n## 建议修改清单1. 模型名核实\n后续。\n'
    expect(streamed(src)).toBe(full(src))
  })

  it('streaming (token-by-token) = full-pass for glued shape', () => {
    const src = '前置。\n\n## 建议修改清单1. 模型名核实\n后续。\n'
    expect(streamedTok(src)).toBe(full(src))
  })

  it('English heading "Section 1. Intro" stays as one heading (no CJK anchor)', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll('## Section 1. Intro\n')
    expect(tokens.map(t => t.kind)).toEqual(['heading'])
    const h = tokens[0]
    if (h?.kind === 'heading') expect(h.text).toBe('Section 1. Intro')
  })

  it('decimal numbering "## 1.5. Title" stays as one heading (no CJK anchor)', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll('## 1.5. Title\n')
    expect(tokens.map(t => t.kind)).toEqual(['heading'])
  })

  it('CJK heading without trailing N. stays as one heading', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll('## 第3章 概述\n')
    expect(tokens.map(t => t.kind)).toEqual(['heading'])
    const h = tokens[0]
    if (h?.kind === 'heading') expect(h.text).toBe('第3章 概述')
  })

  it('mid-line heading carrying the same glue still splits', () => {
    // text<MID-HEADING-RE>level=3 ... and the heading text itself has the OL glue
    const tokens = new MarkdownBlockNormalizer().feedAll('正文部分### 附录1. 资料来源\n')
    const kinds = tokens.map(t => t.kind)
    expect(kinds).toContain('heading')
    expect(kinds[kinds.length - 1]).toBe('text')
  })

  it('zero-prefix glue: "## 1. content" without CJK does NOT split', () => {
    // Ambiguous — without a CJK anchor we do not split. The result is a single
    // heading. Documents the trade-off.
    const tokens = new MarkdownBlockNormalizer().feedAll('## 1. content\n')
    expect(tokens.map(t => t.kind)).toEqual(['heading'])
  })
})
