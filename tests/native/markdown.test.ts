/**
 * Tests for src/native/markdown.ts — Markdown-to-ANSI terminal renderer.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { renderMarkdown, renderInline, StreamingMarkdownRenderer, resetListState } from '../../src/native/markdown.js'
import { themeColor, sgr, stripAnsi } from '../../src/native/tui/colors.js'

const BOLD = sgr.bold
const DIM = sgr.dim
const ITALIC = sgr.italic
const UNDERLINE = sgr.underline
const RESET = sgr.reset

// Theme-resolved semantic colors (dark theme defaults)
const CODE_COLOR = themeColor('info')        // was CYAN
const HEADER_COLOR = themeColor('warning')   // was YELLOW
const LIST_COLOR = themeColor('success')     // was GREEN
const INLINE_CODE_FG = themeColor('inlineCode')

describe('renderInline', () => {
  it('renders inline code with themed styling', () => {
    const result = renderInline('use `foo` here')
    const plain = stripAnsi(result)
    expect(plain).toContain('foo')
    // Should include inlineCode theme color
    expect(result).toContain(INLINE_CODE_FG)
  })

  it('renders bold with **', () => {
    expect(renderInline('this is **bold** text')).toBe(`this is ${BOLD}bold${RESET} text`)
  })

  it('renders bold with __', () => {
    expect(renderInline('this is __bold__ text')).toBe(`this is ${BOLD}bold${RESET} text`)
  })

  it('renders italic with *', () => {
    expect(renderInline('this is *italic* text')).toBe(`this is ${ITALIC}italic${RESET} text`)
  })

  it('renders italic with _', () => {
    expect(renderInline('this is _italic_ text')).toBe(`this is ${ITALIC}italic${RESET} text`)
  })

  it('renders bold+italic with ***', () => {
    expect(renderInline('***both***')).toBe(`${BOLD}${ITALIC}both${RESET}`)
  })

  it('renders links', () => {
    const result = renderInline('[click](https://example.com)')
    expect(result).toContain(`${UNDERLINE}click${RESET}`)
    expect(result).toContain('https://example.com')
  })

  it('returns plain text unchanged', () => {
    expect(renderInline('hello world')).toBe('hello world')
  })

  it('handles multiple inline codes', () => {
    const result = renderInline('`a` and `b`')
    const plain = stripAnsi(result)
    expect(plain).toBe('a and b')
    // Both should use inlineCode theme color
    const matches = result.split(INLINE_CODE_FG)
    expect(matches.length).toBeGreaterThanOrEqual(3) // original + 2 replacements
  })

  // ── intraword underscore guard (regression: 0.12.6) ──
  //
  // CommonMark: `_` emphasis cannot open/close inside a word. Before the
  // fix, the naive /_(.+?)_/g regex shredded snake_case identifiers into
  // alternating italic segments and — because the replacement consumed the
  // `_` delimiters — the rendered text came back WITHOUT any underscores.
  // User-facing symptom: `reporting_source_connector_stub_client.py` got
  // displayed as `reportingsourceconnectorstubclient.py`, corrupting file
  // paths, module names, API response keys, and every snake_case token
  // in assistant explanations.
  it('keeps intraword underscores literal (single _)', () => {
    const inputs = [
      'reporting_source_connector_stub_client.py',
      'py_compile passed',
      'contract_validation: ok',
      'snapshot_id and generated_at',
      'source_file=/tmp/foo.json',
      'call foo_bar(x_y)',
    ]
    for (const text of inputs) {
      const out = stripAnsi(renderInline(text))
      expect(out).toBe(text)
    }
  })

  it('keeps intraword underscores literal (double __, intraword only)', () => {
    // Note: CommonMark actually treats `__init__.py` as opening+closing
    // emphasis (start-of-string + dot both flank cleanly). We keep the
    // spec-faithful behavior there because users asking for `__bold__`
    // at the start of a line is a real pattern. The cases below are the
    // ones users hit constantly — intraword double-underscore inside
    // already-worded tokens — which the flanking rule correctly leaves
    // literal.
    const inputs = [
      'dunder__method__name',
      'PATH__SEP__SPLIT',
    ]
    for (const text of inputs) {
      const out = stripAnsi(renderInline(text))
      expect(out).toBe(text)
    }
  })

  it('still renders _emphasis_ when flanked by whitespace or punctuation', () => {
    expect(renderInline('say _hello_ world')).toBe(`say ${ITALIC}hello${RESET} world`)
    expect(renderInline('_start_ of line')).toBe(`${ITALIC}start${RESET} of line`)
    expect(renderInline('end with _close_')).toBe(`end with ${ITALIC}close${RESET}`)
    expect(renderInline('(_inside parens_)')).toBe(`(${ITALIC}inside parens${RESET})`)
  })

  it('still renders __bold__ when flanked by whitespace or punctuation', () => {
    expect(renderInline('say __hello__ world')).toBe(`say ${BOLD}hello${RESET} world`)
    expect(renderInline('__start__ of line')).toBe(`${BOLD}start${RESET} of line`)
  })

  it('asterisk emphasis stays intraword-capable (CommonMark allows it)', () => {
    // *foo*bar* in CommonMark: asterisk emphasis CAN open/close intraword.
    // We only tightened underscore rules; this test guards that behavior.
    expect(renderInline('use *this* word')).toBe(`use ${ITALIC}this${RESET} word`)
    expect(renderInline('**bold** here')).toBe(`${BOLD}bold${RESET} here`)
  })

  it('mixed identifier + real emphasis on the same line', () => {
    // Real transcript pattern: explanation text contains both italicized
    // phrases and snake_case identifiers.
    const out = stripAnsi(renderInline(
      'The _helper_ calls foo_bar_baz then returns _done_.',
    ))
    expect(out).toBe('The helper calls foo_bar_baz then returns done.')
  })
})

describe('renderMarkdown', () => {
  it('renders h1 headers', () => {
    const result = renderMarkdown('# Hello')
    expect(result).toContain(BOLD)
    expect(result).toContain(HEADER_COLOR)
    expect(result).toContain('Hello')
  })

  it('renders h2 headers', () => {
    const result = renderMarkdown('## Section')
    expect(result).toContain(BOLD)
    expect(result).toContain(HEADER_COLOR)
    expect(result).toContain('Section')
  })

  it('renders h3 headers (bold, no yellow)', () => {
    const result = renderMarkdown('### Sub')
    expect(result).toContain(BOLD)
    expect(result).not.toContain(HEADER_COLOR)
    expect(result).toContain('Sub')
  })

  // ── no-space after hash (regression: 0.12.17) ─────────────────
  //
  // Chinese-LLM output routinely emits headings without a space
  // between the `#` run and the heading text — `##1.完成情况`,
  // `##标题`, `###步骤`. CommonMark requires a space, but the strict
  // check made those lines render as literal `##...` text while
  // sibling `## Title` lines rendered as bold headings, producing
  // inconsistent numbered sections in the same document. The regex
  // now accepts either whitespace, a digit start, or a CJK start
  // after the `#` run.
  it('renders no-space numeric heading (##1. 形式)', () => {
    const plain = stripAnsi(renderMarkdown('##1.完成情况'))
    expect(plain).toContain('1.完成情况')
    expect(plain).not.toContain('##')
    const result = renderMarkdown('##1.完成情况')
    expect(result).toContain(BOLD)
    expect(result).toContain(HEADER_COLOR)
  })

  it('renders no-space CJK heading (##标题)', () => {
    const plain = stripAnsi(renderMarkdown('##任务归类'))
    expect(plain).toContain('任务归类')
    expect(plain).not.toContain('##')
    const result = renderMarkdown('##任务归类')
    expect(result).toContain(BOLD)
  })

  it('renders no-space h3 heading (###步骤)', () => {
    const plain = stripAnsi(renderMarkdown('###步骤'))
    expect(plain).toContain('步骤')
    expect(plain).not.toContain('###')
  })

  it('leaves bare ## alone (no content → literal)', () => {
    // Degenerate cases with nothing after the hash run stay literal so
    // we don't accidentally treat stray comments / diff-mark-ups as
    // headings. Only lines with actual content after the # run match.
    const plain = stripAnsi(renderMarkdown('##'))
    expect(plain.trim()).toBe('##')
  })

  it('leaves latin-without-space as NON-heading (##foo stays literal)', () => {
    // Latin text glued to ## is more likely a typo / code reference
    // than a heading; we only relax the rule for digits and CJK where
    // the Chinese-input convention makes the omission natural.
    const plain = stripAnsi(renderMarkdown('##foo'))
    expect(plain.trim()).toBe('##foo')
  })

  it('renders unordered list items', () => {
    const result = renderMarkdown('- item one\n- item two')
    expect(result).toContain(`${LIST_COLOR}•${RESET}`)
    expect(result).toContain('item one')
    expect(result).toContain('item two')
  })

  it('renders ordered list items', () => {
    resetListState()
    const result = renderMarkdown('1. first\n2. second')
    expect(result).toContain(LIST_COLOR)
    expect(result).toContain('first')
    expect(result).toContain('second')
  })

  it('renders code blocks with syntax highlighting', () => {
    const result = renderMarkdown('```ts\nconst x = 1\n```')
    const plain = stripAnsi(result)
    // Code block separator uses DIM
    expect(result).toContain(DIM)
    // Content is present (stripped of ANSI for matching)
    expect(plain).toContain('const x = 1')
    // Language label appears in separator
    expect(plain).toContain('ts')
    // Keyword "const" should get syntax color (purple 141)
    expect(result).toContain('\x1b[38;5;141m')
  })

  it('renders code blocks without language', () => {
    const result = renderMarkdown('```\nhello\n```')
    expect(result).toContain(DIM)
    expect(result).toContain('hello')
  })

  it('renders blockquotes', () => {
    const result = renderMarkdown('> important note')
    expect(result).toContain('│')
    expect(result).toContain('important note')
  })

  it('renders horizontal rules', () => {
    const result = renderMarkdown('---')
    expect(result).toContain('─')
  })

  it('handles multi-line with mixed elements', () => {
    const md = `# Title

Some **bold** paragraph.

- item 1
- item 2

\`\`\`js
console.log("hi")
\`\`\`

> quote here`

    const result = renderMarkdown(md)
    expect(result).toContain('Title')
    expect(result).toContain(BOLD)
    expect(result).toContain(`${LIST_COLOR}•${RESET}`)
    expect(stripAnsi(result)).toContain('console.log("hi")')
    expect(result).toContain('│')
  })

  it('preserves blank lines', () => {
    const result = renderMarkdown('line 1\n\nline 2')
    const lines = result.split('\n')
    expect(lines.length).toBe(3)
    expect(lines[1]).toBe('')
  })

  it('handles inline code inside list items', () => {
    const result = renderMarkdown('- use `npm install`')
    expect(result).toContain(INLINE_CODE_FG)
    expect(stripAnsi(result)).toContain('npm install')
    expect(result).toContain(`${LIST_COLOR}•${RESET}`)
  })
})

describe('StreamingMarkdownRenderer', () => {
  it('renders complete text identically to single-pass', () => {
    const md = '# Hello\n\nSome **bold** text.\n\n```ts\ncode()\n```\n'
    const renderer = new StreamingMarkdownRenderer()
    const chunks: string[] = []
    // Feed character by character
    for (const ch of md) {
      const out = renderer.push(ch)
      if (out) chunks.push(out)
    }
    const flushed = renderer.flush()
    if (flushed) chunks.push(flushed)

    const streamed = chunks.join('')
    const singlePass = renderMarkdown(md.trimEnd())
    // Both should produce the same rendered content (ignoring trailing newline)
    expect(streamed.trimEnd()).toBe(singlePass.trimEnd())
  })

  it('handles code blocks across multiple pushes', () => {
    const renderer = new StreamingMarkdownRenderer()
    const chunks: string[] = []

    for (const line of ['```py\n', 'x = 1\n', '```\n']) {
      const out = renderer.push(line)
      if (out) chunks.push(out)
    }
    const flushed = renderer.flush()
    if (flushed) chunks.push(flushed)
    const result = chunks.join('')
    // Streaming code block uses DIM separators + syntax highlighting
    expect(result).toContain(DIM)
    expect(stripAnsi(result)).toContain('x = 1')
  })

  it('flushes partial line on flush()', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('partial **bold')
    const out = renderer.flush()
    expect(out).toBeTruthy()
  })

  it('reset clears state for next response', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('```py\n')
    renderer.reset()
    // After reset, should not be in code block
    const out = renderer.push('normal text\n')
    expect(out).not.toContain(CODE_COLOR)
    expect(out).toContain('normal text')
  })

  it('handles empty push', () => {
    const renderer = new StreamingMarkdownRenderer()
    expect(renderer.push('')).toBe('')
  })

  it('handles multiple newlines in one push', () => {
    const renderer = new StreamingMarkdownRenderer()
    const out = renderer.push('line1\nline2\nline3\n')
    expect(out).toContain('line1')
    expect(out).toContain('line2')
    expect(out).toContain('line3')
  })

  it('renders tables in streaming mode', () => {
    const renderer = new StreamingMarkdownRenderer()
    const out = renderer.push('| A | B |\n|---|---|\n| 1 | 2 |\n\n')
    const flushed = renderer.flush()
    const combined = (out || '') + (flushed || '')
    const plain = stripAnsi(combined)
    expect(plain).toContain('A')
    expect(plain).toContain('B')
    expect(plain).toContain('1')
    expect(plain).toContain('2')
  })
})

describe('GFM tables', () => {
  it('renders a simple table', () => {
    const md = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob   | 25 |`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect(plain).toContain('Name')
    expect(plain).toContain('Age')
    expect(plain).toContain('Alice')
    expect(plain).toContain('30')
    expect(plain).toContain('Bob')
    expect(plain).toContain('25')
    // Should contain table borders
    expect(plain).toContain('│')
    expect(plain).toContain('─')
  })

  it('renders right-aligned columns', () => {
    const md = `| Item | Price |
|------|------:|
| Apple | 1.50 |
| Banana | 0.75 |`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect(plain).toContain('Item')
    expect(plain).toContain('Price')
    expect(plain).toContain('1.50')
  })

  it('renders center-aligned columns', () => {
    const md = `| Left | Center | Right |
|:-----|:------:|------:|
| L | C | R |`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect(plain).toContain('Left')
    expect(plain).toContain('Center')
    expect(plain).toContain('Right')
  })

  it('handles single-column table', () => {
    const md = `| Status |
|--------|
| OK |
| Fail |`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect(plain).toContain('Status')
    expect(plain).toContain('OK')
    expect(plain).toContain('Fail')
  })

  it('handles empty cells', () => {
    const md = `| A | B |
|---|---|
| x |   |
|   | y |`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect(plain).toContain('x')
    expect(plain).toContain('y')
  })

  // ── width-adaptive wrap (regression: 0.12.11) ──────────────────
  //
  // Before 0.12.11 the renderer computed each column's natural width
  // (capped at 40) and emitted rows that exceeded the terminal. The
  // terminal's auto-wrap then broke the `│` grid into disjoint visual
  // rows. Real transcripts showed long Chinese descriptions split with
  // separators lost and cells colliding. The fix caps total table
  // width to the terminal's columns and wraps oversized cells WITHIN
  // their column, so every physical terminal row still starts and
  // ends with `│`.
  it('wraps oversized cells within their column to keep grid intact', () => {
    const save = process.stdout.columns
    try {
      // Force narrow terminal so the test is width-independent.
      Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true })
      const longTail = '这是一段非常非常非常长的中文描述'.repeat(5)
      const md = `| 模块 | 核心真相 |
|------|----------|
| reporting_source_provider.py | ${longTail} |`
      const result = renderMarkdown(md)
      const plain = stripAnsi(result)
      const lines = plain.split('\n').filter(l => l.includes('│'))
      // Every content row starts and ends with │ (grid intact).
      for (const line of lines) {
        expect(line.trim().startsWith('│')).toBe(true)
        expect(line.trim().endsWith('│')).toBe(true)
      }
      // Long content survived (not truncated), just wrapped across
      // multiple physical rows within the same cell. We check fragments
      // (full identifier is split across rows by design) rather than
      // requiring the whole token on one line.
      expect(plain).toContain('非常')
      expect(plain).toContain('repor')
      expect(plain).toContain('.py')
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: save ?? 80, configurable: true })
    }
  })

  it('does not exceed terminal width even with many narrow columns', () => {
    const save = process.stdout.columns
    try {
      Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true })
      const md = `| A | B | C | D | E |
|---|---|---|---|---|
| word1 | word2 | word3 | word4 | word5 |`
      const result = renderMarkdown(md)
      const plain = stripAnsi(result)
      for (const line of plain.split('\n').filter(l => l.includes('│'))) {
        // Allow a small slack margin but not overflow past terminal width.
        expect(line.length).toBeLessThanOrEqual(60)
      }
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: save ?? 80, configurable: true })
    }
  })
})

describe('task lists', () => {
  it('renders unchecked task items', () => {
    const result = renderMarkdown('- [ ] todo item')
    const plain = stripAnsi(result)
    expect(plain).toContain('☐')
    expect(plain).toContain('todo item')
  })

  it('renders checked task items', () => {
    const result = renderMarkdown('- [x] done item')
    const plain = stripAnsi(result)
    expect(plain).toContain('☑')
    expect(plain).toContain('done item')
  })

  it('renders mixed task list', () => {
    const md = `- [x] Step 1
- [ ] Step 2
- [x] Step 3`
    const result = renderMarkdown(md)
    const plain = stripAnsi(result)
    expect((plain.match(/☑/g) ?? []).length).toBe(2)
    expect((plain.match(/☐/g) ?? []).length).toBe(1)
  })

  it('handles uppercase X', () => {
    const result = renderMarkdown('- [X] uppercase')
    const plain = stripAnsi(result)
    expect(plain).toContain('☑')
  })
})

describe('depth-aware list numbering', () => {
  it('uses arabic numerals at depth 0', () => {
    resetListState()
    const result = renderMarkdown('1. first\n2. second\n3. third')
    const plain = stripAnsi(result)
    expect(plain).toContain('1.')
    expect(plain).toContain('2.')
    expect(plain).toContain('3.')
  })

  it('uses letters at depth 1', () => {
    resetListState()
    const result = renderMarkdown('1. top\n  1. nested')
    const plain = stripAnsi(result)
    // Depth 1 should use letters
    expect(plain).toContain('a.')
  })

  it('uses roman numerals at depth 2', () => {
    resetListState()
    const result = renderMarkdown('1. top\n  1. mid\n    1. deep')
    const plain = stripAnsi(result)
    // Depth 2 should use roman
    expect(plain).toContain('i.')
  })
})

describe('syntax highlighting', () => {
  // SYN color codes from markdown.ts
  const SYN_KEYWORD = '\x1b[38;5;141m'  // purple
  const SYN_STRING  = '\x1b[38;5;113m'  // green
  const SYN_COMMENT = '\x1b[38;5;240m'  // gray
  const SYN_NUMBER  = '\x1b[38;5;209m'  // orange
  const SYN_TYPE    = '\x1b[38;5;81m'   // cyan
  const SYN_FUNC    = '\x1b[38;5;222m'  // yellow

  it('highlights TypeScript keywords', () => {
    const result = renderMarkdown('```ts\nconst x = 1\nexport function foo() {}\n```')
    expect(result).toContain(SYN_KEYWORD)  // "const", "export", "function"
    expect(result).toContain(SYN_NUMBER)   // "1"
    expect(result).toContain('const')
    expect(result).toContain('foo')
  })

  it('highlights Python keywords and comments', () => {
    const result = renderMarkdown('```python\ndef greet(name):\n  # hello\n  return name\n```')
    expect(result).toContain(SYN_KEYWORD)  // "def", "return"
    expect(result).toContain(SYN_COMMENT)  // "# hello"
    expect(result).toContain('greet')
    expect(result).toContain('name')
  })

  it('highlights string literals', () => {
    const result = renderMarkdown('```js\nconst s = "hello world"\n```')
    expect(result).toContain(SYN_STRING)
    expect(result).toContain('hello world')
  })

  it('highlights JSON keys and values', () => {
    const result = renderMarkdown('```json\n{"name": "owl", "count": 42, "ok": true}\n```')
    expect(result).toContain(SYN_STRING)   // keys and string values
    expect(result).toContain(SYN_NUMBER)   // 42
    expect(result).toContain(SYN_KEYWORD)  // true
  })

  it('falls back to plain text for unknown languages', () => {
    const result = renderMarkdown('```brainfuck\n+++++\n```')
    // Content should still appear, just without highlighting
    expect(stripAnsi(result)).toContain('+++++')
    // Should not have keyword colors
    expect(result).not.toContain(SYN_KEYWORD)
  })

  it('highlights Rust types and functions', () => {
    const result = renderMarkdown('```rust\nfn main() {\n  let v: Vec<String> = Vec::new();\n}\n```')
    expect(result).toContain(SYN_KEYWORD)  // "fn", "let"
    expect(result).toContain(SYN_TYPE)     // "Vec", "String"
    expect(result).toContain(SYN_FUNC)     // "main(", "new("
  })

  it('highlights Go code', () => {
    const result = renderMarkdown('```go\nfunc main() {\n  fmt.Println("hi")\n}\n```')
    expect(result).toContain(SYN_KEYWORD)  // "func"
    expect(result).toContain(SYN_STRING)   // "hi"
    expect(result).toContain(SYN_FUNC)     // "Println("
  })

  it('highlights bash comments and strings', () => {
    const result = renderMarkdown('```bash\n# install deps\nnpm install "foo"\n```')
    expect(result).toContain(SYN_COMMENT)  // "# install deps"
    expect(result).toContain(SYN_STRING)   // "foo"
  })

  it('streaming renderer also highlights code', () => {
    const renderer = new StreamingMarkdownRenderer()
    const chunks: string[] = []
    for (const line of ['```ts\n', 'const n = 42\n', '```\n']) {
      const out = renderer.push(line)
      if (out) chunks.push(out)
    }
    const flushed = renderer.flush()
    if (flushed) chunks.push(flushed)
    const result = chunks.join('')
    expect(result).toContain(SYN_KEYWORD)  // "const"
    expect(result).toContain(SYN_NUMBER)   // "42"
  })
})

describe('StreamingMarkdownRenderer word-wrap', () => {
  it('word-wraps long lines without newlines', () => {
    const renderer = new StreamingMarkdownRenderer()
    // Feed a very long string without newlines, token by token
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`)
    const longText = words.join(' ')
    // Push all at once (simulating buffered output)
    const out = renderer.push(longText)
    // Should have emitted some wrapped output since text > 120 chars
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('\n')
  })

  it('does not word-wrap inside code blocks', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('```\n')
    const longCode = 'x'.repeat(200)
    const out = renderer.push(longCode)
    // Code blocks should NOT be word-wrapped
    expect(out).toBe('')
    // Flush to get remaining
    const flushed = renderer.flush()
    expect(flushed).toContain('x'.repeat(200))
  })

  it('flush always ends with newline', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('hello')
    const flushed = renderer.flush()
    expect(flushed).toMatch(/\n$/)
  })
})

describe('flush structural splitting', () => {
  it('splits concatenated list items on flush', () => {
    const renderer = new StreamingMarkdownRenderer()
    // Simulate model sending list items without newlines
    renderer.push('Here are options: 1. Write code 2. Read files 3. Run commands')
    const flushed = renderer.flush()
    // Should split at sentence boundary before numbered items
    expect(flushed.split('\n').length).toBeGreaterThan(1)
  })

  it('splits before dash list items on flush', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('I can help with: - Writing code - Reading files - Running tests')
    const flushed = renderer.flush()
    expect(flushed.split('\n').length).toBeGreaterThan(1)
  })
})

describe('CJK text handling', () => {
  it('breaks Chinese text at CJK punctuation when exceeding threshold', () => {
    const renderer = new StreamingMarkdownRenderer()
    // 70 Chinese chars — exceeds CJK threshold of 60
    const cjk = '这是一段很长的中文文本，用来测试自动换行功能。当文本超过一定长度时，应该在合适的标点处换行，而不是等到缓冲区满才输出。'
    renderer.push(cjk)
    const output = renderer.flush()
    expect(output.split('\n').length).toBeGreaterThan(1)
  })

  it('breaks CJK text followed by list marker without space', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('我可以帮你做这些事情：- 写代码- 读文件- 运行命令')
    const flushed = renderer.flush()
    expect(flushed.split('\n').length).toBeGreaterThan(1)
  })

  it('breaks at Chinese colon followed by list marker in push()', () => {
    const renderer = new StreamingMarkdownRenderer()
    // This should trigger structural break at ：
    const result = renderer.push('如果你有需求，可以告诉我：- 帮我写代码- 解释某个概念- 搜索文件内容')
    const flushed = renderer.flush()
    const combined = result + flushed
    expect(combined.split('\n').length).toBeGreaterThan(1)
  })
})

describe('numbered list structural breaks', () => {
  it('splits "概念3. 搜索" pattern in push()', () => {
    const renderer = new StreamingMarkdownRenderer()
    // Model sends numbered items without separators
    const result = renderer.push('帮我写代码2. 解释概念3. 搜索文件4. 运行命令')
    const flushed = renderer.flush()
    const combined = result + flushed
    // Should split at number boundaries
    expect(combined.split('\n').length).toBeGreaterThanOrEqual(3)
  })

  it('splits consecutive numbered items in flush()', () => {
    const renderer = new StreamingMarkdownRenderer()
    renderer.push('Try: 1. Code 2. Test 3. Build')
    const flushed = renderer.flush()
    expect(flushed.split('\n').length).toBeGreaterThan(1)
  })

  it('splits emoji-prefixed items in push()', () => {
    const renderer = new StreamingMarkdownRenderer()
    const result = renderer.push('我可以帮你：📝 写代码🔍 搜索文件⚙️ 运行命令')
    const flushed = renderer.flush()
    const combined = result + flushed
    // Should detect emoji + space pattern as break points
    expect(combined.split('\n').length).toBeGreaterThan(1)
  })
})

describe('Streaming: no-newline list formatting (user regression)', () => {
  let renderer: StreamingMarkdownRenderer

  beforeEach(() => {
    renderer = new StreamingMarkdownRenderer()
  })

  it('single chunk CJK with dash-list items produces multiple lines', () => {
    const text = '我在呢！不过目前没有具体的任务要处理。如果你有需求，可以告诉我：- 帮我写/修改代码- 解释某个概念- 搜索文件内容- 运行某个命令- 或者任何编程相关的问题有什么可以帮你的吗？'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    // Should have at LEAST 3 lines: intro sentence + some list items
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('token-by-token CJK with dash-list items produces multiple lines', () => {
    const tokens = ['我在', '呢！', '不过', '目前', '没有', '具体的', '任务要', '处理。',
      '如果', '你有', '需求', '，可以', '告诉', '我：', '- ', '帮我写', '/修改',
      '代码', '- ', '解释', '某个', '概念', '- ', '搜索', '文件', '内容', '- ',
      '运行', '某个', '命令', '- ', '或者', '任何']
    let combined = ''
    for (const t of tokens) {
      combined += renderer.push(t)
    }
    combined += renderer.flush()
    const full = stripAnsi(combined)
    const lines = full.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('numbered list without newlines produces separate lines', () => {
    const text = '如果你有需求，可以告诉我：1. 写/修改代码2. 解释某个概念3. 搜索文件内容4. 运行某个命令5. 或者其他任何编程相关的问题有什么可以帮你的吗？'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('emoji-prefixed list without newlines produces separate lines', () => {
    const text = '收到！✅以后我的输出会：- 合理换行- 使用Markdown格式📝 写代码/修改代码🔍 搜索/分析文件⚙️ 运行命令💡 解释概念'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('bold section headers without newlines produce separate lines', () => {
    const text = '以下是分析结果：**代码质量** 代码结构清晰。**性能** 没有明显的性能问题。**建议** 可以添加更多注释。'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('horizontal rule concatenated with text produces separate lines', () => {
    const text = '收到！---如果有具体任务，随时告诉我！'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    // Should be at least 3 lines: text, HR, text
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('closing bracket before CJK produces separate lines', () => {
    const text = '修改某个 UI 组件的颜色）还是其他什么？'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('emoji bullet items stay intact when preceded by list marker', () => {
    const text = '- 📝 写代码- 🔍 搜索文件- ⚙️ 运行命令- 💡 解释概念'
    const pushOut = renderer.push(text)
    const flushOut = renderer.flush()
    const full = stripAnsi(pushOut + flushOut)
    const lines = full.split('\n').filter(l => l.trim())
    // Each list item should be its own complete line with emoji
    expect(lines.length).toBe(4)
    expect(lines[0]).toContain('📝 写代码')
    expect(lines[1]).toContain('🔍 搜索文件')
    expect(lines[2]).toContain('⚙️ 运行命令')
    expect(lines[3]).toContain('💡 解释概念')
  })
})
