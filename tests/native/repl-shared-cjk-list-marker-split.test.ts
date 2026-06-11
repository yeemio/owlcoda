import { describe, expect, it } from 'vitest'
import { composeAssistantChunk, fallbackSplitIfLong, type ComposeState } from '../../src/native/repl-shared.js'
import { StreamingMarkdownRenderer } from '../../src/native/markdown.js'

// 2026-06-11 dogfood regression (deepseek, owlcoda 0.14.64): a clean model
// ordered list of LONG CJK items —
//   1. **HTTP timeout** … (long CJK explanation)
//   2. **agent timeout** … (long CJK explanation)
// rendered as a lone "1." line, the body on the next line, and later items
// RENUMBERED back to "1.". Root cause chain: fallbackSplitIfLong treats the
// "." of the list marker "1." as a Latin sentence ender — `(?<=[.!?])\s+`
// matches right after the marker — so when any segment of the long item
// trips the 80-cell threshold the marker is severed onto its own line. The
// downstream OL regex (`^\s*\d+\.\s+content`) then can't see a list item,
// list state resets, and the surviving items renumber from 1.
//
// Contract: a line that *starts with a list marker* is structural, not
// prose — the fallback sentence-splitter must leave it alone entirely.
// (Splitting mid-item is just as destructive as severing the marker: the
// continuation line would be parsed as a new paragraph, breaking the list.)

const ANSI_RE = /\x1b\[[0-9;]*m/g
const strip = (s: string): string => s.replace(ANSI_RE, '')

describe('fallbackSplitIfLong — list-marker lines are never split', () => {
  it('keeps a long CJK ordered-list item on one line (marker not severed)', () => {
    const input =
      '1. **HTTP timeout** (`timeoutSeconds: 60`) — 模型接口不返回结果也不报错，底层的中止信号等不到超时，可能是流式连接保持打开但没有任何数据。'
    expect(fallbackSplitIfLong(input)).toBe(input)
  })

  it('keeps a long CJK bullet item with an inner 。 on one line', () => {
    const input =
      '- **第一项原因** — 这是一段很长的中文说明文字其中包含句号。后半句继续解释直到整体长度明显超过八十个显示单元的阈值为止。'
    expect(fallbackSplitIfLong(input)).toBe(input)
  })

  it('still splits long plain CJK prose (non-list fallback behavior intact)', () => {
    const input =
      '这是一个故意写得非常长的中文句子用来确保它的显示宽度明显超过八十个单元从而应当被切开。短句。'
    expect(fallbackSplitIfLong(input)).toContain('\n')
  })
})

describe('compose → renderer pipeline — long CJK ordered lists keep their numbering', () => {
  const renderStreamed = (text: string, chunkSize: number): string => {
    const state: ComposeState = { leftover: '', seenAnchors: new Set() }
    const renderer = new StreamingMarkdownRenderer()
    let out = ''
    for (let i = 0; i < text.length; i += chunkSize) {
      const composed = composeAssistantChunk(text.slice(i, i + chunkSize), state)
      if (composed) out += renderer.push(composed)
    }
    if (state.leftover.length > 0) {
      const drained = composeAssistantChunk('\n', state)
      if (drained) out += renderer.push(drained)
    }
    out += renderer.flush()
    return strip(out)
  }

  const LONG_OL =
    '当前接口调用卡死时：\n' +
    '1. **第一项原因** — 这是一段很长的中文说明文字用来触发长行拆分逻辑因为模型返回时不会换行而是连续输出所以会超过阈值\n' +
    '2. **第二项原因** — 同样是一段足够长的中文解释文字确保超过八十个显示单元的换行阈值从而触发结构断点\n' +
    '3. **第三项原因** — 再来一段长说明保证整体行长度超出限制触发问题复现验证渲染管线缺陷\n'

  for (const chunkSize of [7, 11, 40]) {
    it(`no lone marker lines and no renumbering at chunk size ${chunkSize}`, () => {
      const rendered = renderStreamed(LONG_OL, chunkSize)
      // No marker severed onto its own line.
      expect(rendered).not.toMatch(/^\s*\d+\.\s*$/m)
      // All three items survive with their original numbers, marker glued to body.
      expect(rendered).toMatch(/^1\. 第一项原因/m)
      expect(rendered).toMatch(/^2\. 第二项原因/m)
      expect(rendered).toMatch(/^3\. 第三项原因/m)
    })
  }
})
