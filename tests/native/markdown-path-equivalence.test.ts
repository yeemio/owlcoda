/**
 * 0.13.90 renderer-unification: failing-tests pass.
 *
 * The same markdown source MUST render structurally equivalently across
 * four paths:
 *   A. renderMarkdown(text)                    — full one-shot pass
 *   B. StreamingMarkdownRenderer / single push — streamed in 1 chunk
 *   C. StreamingMarkdownRenderer / line-by-line
 *   D. StreamingMarkdownRenderer / token-by-token (1-char chunks)
 *
 * "Structurally equivalent" = stripped of ANSI, the rendered text agrees
 * on logical lines, content, heading/table/list/code-block decisions.
 * Trailing whitespace differences are normalized via .trim() per-line +
 * collapse-blank-runs.
 *
 * Today (post-0.13.88+89 revert, 0.13.87 baseline), the four paths diverge
 * on malformed model output. These tests pin the divergence as the contract
 * the 0.13.90 normalizer must close.
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown, StreamingMarkdownRenderer } from '../../src/native/markdown.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

/** Normalize: strip ANSI, trim each line right, collapse runs of ≥2 blank
 *  lines into a single blank, remove leading/trailing blank lines. */
function normalize(text: string): string {
  const lines = stripAnsi(text)
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
  // collapse blank runs
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const blank = l === ''
    if (blank && prevBlank) continue
    out.push(l)
    prevBlank = blank
  }
  // trim leading/trailing blanks
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

function viaFullRender(text: string): string {
  return normalize(renderMarkdown(text))
}

function viaStreamingSingleChunk(text: string): string {
  const r = new StreamingMarkdownRenderer()
  const out = r.push(text) + r.flush()
  return normalize(out)
}

function viaStreamingByLine(text: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const chunk = lines[i] + (i < lines.length - 1 ? '\n' : '')
    out += r.push(chunk)
  }
  out += r.flush()
  return normalize(out)
}

function viaStreamingByToken(text: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  // 1-char chunks (most aggressive — surfaces stateful boundary bugs)
  for (const c of text) {
    out += r.push(c)
  }
  out += r.flush()
  return normalize(out)
}

interface Case {
  name: string
  /** Source markdown */
  md: string
}

const CASES: Case[] = [
  {
    name: 'A1. ## heading + table-header glued on one line',
    md: '## 一、改动地图|模块|改动|影响|\n|------|------|------|\n| a | b | c |',
  },
  {
    name: 'A2. **heading** (bold-only) + table-header glued',
    md: '**一、改动地图**|模块|改动|影响|\n|------|------|------|\n| a | b | c |',
  },
  {
    name: 'A3. plain prose prefix + table-header glued, separator next line',
    md: '一、改动地图|模块|改动|影响|\n|------|------|------|\n| a | b | c |',
  },
  {
    name: 'A4. mid-line heading marker (### inside text)',
    md: '三、关键架构决策分析###1.凭证隔离 (Credential Isolation)\n这是整个架构最关键的安全决策：',
  },
  {
    name: 'A5. clean GFM table (no malformation)',
    md: '| 模块 | 改动 | 影响 |\n|------|------|------|\n| task-contract.ts | classifier | text_deliverable |\n| ink-repl.tsx | queue refusal | block /retry |',
  },
  {
    name: 'A6. heading immediately followed by prose (no blank line)',
    md: '## 上一轮回顾\n这是正文段落，紧贴上面标题。\n## 本轮新增\n再一段。',
  },
  {
    name: 'A7. fenced code block containing ## and | characters',
    md: 'before\n```ts\n// `## not heading`\nconst t = `|cell|cell|`\n```\nafter',
  },
  {
    name: 'A8. malformed separator |||  must NOT be parsed as table',
    md: 'header sentence not a table\n|||\nbody continues',
  },
  {
    name: 'A9. unordered list with bold inline markers',
    md: '审计结论：\n- **P1-1** 改进建议误判已修复\n- **P2-2** queue 拒绝逻辑存在缺口\n- **P3-1** 测试覆盖不足',
  },
  {
    name: 'A10. version numbers must NOT be split mid-token',
    md: '当前 HEAD 是 v0.13.87，对比 v0.13.85 的差异如下。',
  },
  {
    name: 'A11. CJK + ASCII identifier in table cell',
    md: '| 模块 | 改动 |\n|---|---|\n| src/native/task-contract.ts | TASK_TEXT_DELIVERABLE_RE 增加 bare-noun 分支 |',
  },
  {
    name: 'A12. consecutive headings (no body between)',
    md: '# 一级\n## 二级\n### 三级\n正文从这里开始',
  },
  {
    // Without `hasKvLine` gating the fast path, full-pass renderMarkdown
    // takes the no-markdown-syntax shortcut and emits the lines without
    // a block boundary, while streaming routes through TokenRenderer
    // which classifies the first line as kvLine and inserts a blank
    // before the paragraph.
    name: 'A13. kvLine followed by paragraph (block-boundary equivalence)',
    md: 'model: kimi\nplain paragraph',
  },
  {
    name: 'A14. kvLine followed by another kvLine then paragraph',
    md: 'model: kimi\nprovider: kimi\nplain paragraph',
  },
  {
    name: 'A15. paragraph followed by kvLine (transition both directions)',
    md: 'intro prose here\nmodel: kimi\nduration_ms: 108',
  },
]

// FIXME(0.13.90): unblock these by removing .skip when MarkdownBlockNormalizer
// is in place. Today (post 0.13.88+89 revert), 34/56 cases fail — including
// even A5 (a fully-clean GFM table) where streaming bails out after the
// first data row. The failures are the contract the normalizer must close.
describe('markdown 路径等价性 (0.13.90 contract — failing today)', () => {
  describe('单 chunk streaming = 全量 renderMarkdown', () => {
    for (const c of CASES) {
      it(`${c.name}`, () => {
        const full = viaFullRender(c.md)
        const stream = viaStreamingSingleChunk(c.md)
        expect(stream).toBe(full)
      })
    }
  })

  describe('逐行 streaming = 全量 renderMarkdown', () => {
    for (const c of CASES) {
      it(`${c.name}`, () => {
        const full = viaFullRender(c.md)
        const stream = viaStreamingByLine(c.md)
        expect(stream).toBe(full)
      })
    }
  })

  describe('逐 token streaming = 全量 renderMarkdown', () => {
    for (const c of CASES) {
      it(`${c.name}`, () => {
        const full = viaFullRender(c.md)
        const stream = viaStreamingByToken(c.md)
        expect(stream).toBe(full)
      })
    }
  })

  // 显式 P0 期望：external-coding-assistant-style 表格必须在所有路径都被识别成 boxed 表格，
  // 而不是 raw |cell|cell|。我们通过查看输出里是否有 ┌ 或 └ 来判定。
  describe('P0 invariant: malformed input 必须被 normalizer 修复成 boxed 表格', () => {
    const malformedTableCases = CASES.filter(c => c.name.startsWith('A1.') || c.name.startsWith('A2.') || c.name.startsWith('A3.'))
    for (const c of malformedTableCases) {
      it(`${c.name} — 全量 path 必须 boxed`, () => {
        const out = renderMarkdown(c.md)
        expect(out).toMatch(/[┌└├┤┼─│]/)
      })
      it(`${c.name} — 单 chunk streaming 必须 boxed`, () => {
        const r = new StreamingMarkdownRenderer()
        const out = r.push(c.md) + r.flush()
        expect(out).toMatch(/[┌└├┤┼─│]/)
      })
      it(`${c.name} — 逐行 streaming 必须 boxed`, () => {
        const r = new StreamingMarkdownRenderer()
        let out = ''
        const lines = c.md.split('\n')
        for (let i = 0; i < lines.length; i++) {
          out += r.push(lines[i] + (i < lines.length - 1 ? '\n' : ''))
        }
        out += r.flush()
        expect(out).toMatch(/[┌└├┤┼─│]/)
      })
    }
  })

  // 显式 P1 期望：code fence 内的 ## / | 必须保留为字面量，不被任何 path 识别成 heading/table
  describe('P1 invariant: code fence 内的 markdown syntax 必须保留为字面量', () => {
    const c = CASES.find(x => x.name.startsWith('A7'))!
    it('全量 path: ## 在 fence 内不染色', () => {
      const plain = stripAnsi(renderMarkdown(c.md))
      // The literal '##' must survive in the rendered code-line; no heading color.
      expect(plain).toContain('// `## not heading`')
    })
    it('逐行 streaming: ## 在 fence 内不染色', () => {
      const r = new StreamingMarkdownRenderer()
      let out = ''
      const lines = c.md.split('\n')
      for (let i = 0; i < lines.length; i++) {
        out += r.push(lines[i] + (i < lines.length - 1 ? '\n' : ''))
      }
      out += r.flush()
      const plain = stripAnsi(out)
      expect(plain).toContain('// `## not heading`')
    })
  })
})
