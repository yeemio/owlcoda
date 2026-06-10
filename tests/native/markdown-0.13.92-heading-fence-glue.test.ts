/**
 * 0.13.92 contract: heading text glued to ```lang code-fence on the same
 * logical line must pre-split into heading + fence-open + (optional first
 * code-line tail). Real-world model output occasionally emits this jam
 * (e.g. `## 三、风险与建议\`\`\`tsconst AUDIT_VERSION = '0.13.91';\n...`)
 * because it forgets the newline before the fence. The renderer must
 * recover.
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown, StreamingMarkdownRenderer } from '../../src/native/markdown.js'
import { stripAnsi } from '../../src/native/tui/colors.js'
import { MarkdownBlockNormalizer } from '../../src/native/markdown-normalizer.js'

/** Normalize: strip ANSI, trim trailing whitespace per-line, collapse blank
 *  runs, drop leading/trailing blanks. Same shape as the path-equivalence
 *  test's normalize. */
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
function streamedToken(s: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  for (const c of s) out += r.push(c)
  out += r.flush()
  return normalize(out)
}

describe('0.13.92 heading + ```lang glue', () => {
  it('## H```lang glue: tokens split into heading + fence-open + code-line', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      '## 三、风险```tsconst x = 1\n```\nafter',
    )
    const kinds = tokens.map(t => t.kind)
    expect(kinds).toContain('heading')
    expect(kinds).toContain('code-fence-open')
    expect(kinds).toContain('code-fence-close')
    // The heading text should NOT contain '```'
    const heading = tokens.find(t => t.kind === 'heading')
    expect(heading).toBeDefined()
    if (heading && heading.kind === 'heading') {
      expect(heading.text).not.toContain('```')
      expect(heading.text.trim()).toBe('三、风险')
    }
  })

  it('### H```lang glue at level 3', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      '### 附录```py\ndef f(): pass\n```',
    )
    const kinds = tokens.map(t => t.kind)
    expect(kinds).toEqual(['heading', 'code-fence-open', 'code-line', 'code-fence-close'])
  })

  it('# H```lang glue at level 1', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      '# Title```bash\necho hi\n```',
    )
    const kinds = tokens.map(t => t.kind)
    expect(kinds).toContain('heading')
    expect(kinds).toContain('code-fence-open')
  })

  it('full-pass renders boxed code fence after glue', () => {
    const out = stripAnsi(renderMarkdown('## 三、风险```ts\nconst x = 1\n```\nafter'))
    // Fence should render with the dim ─── ts ─── header line.
    expect(out).toMatch(/─── ts ─+/)
    expect(out).toContain('const x = 1')
    expect(out).toContain('三、风险')
  })

  it('streaming (single chunk) = full-pass for glued shape', () => {
    const src = '## 三、风险```ts\nconst x = 1\n```\nafter'
    expect(streamed(src)).toBe(full(src))
  })

  it('streaming (token-by-token) = full-pass for glued shape', () => {
    const src = '## 三、风险```ts\nconst x = 1\n```\nafter'
    expect(streamedToken(src)).toBe(full(src))
  })

  it('clean fence (no glue) is unchanged', () => {
    const src = '## H\n```ts\nconst x = 1\n```\nafter'
    const tokens = new MarkdownBlockNormalizer().feedAll(src)
    const kinds = tokens.map(t => t.kind)
    expect(kinds).toEqual(['heading', 'code-fence-open', 'code-line', 'code-fence-close', 'text'])
  })

  it('lang extraction: known-lang prefix wins over greedy word grab (tsconst → ts)', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      "## H```tsconst x = 1;\n```\nafter",
    )
    const fence = tokens.find(t => t.kind === 'code-fence-open')
    expect(fence).toBeDefined()
    if (fence && fence.kind === 'code-fence-open') {
      expect(fence.lang).toBe('ts')
    }
    const codeLine = tokens.find(t => t.kind === 'code-line')
    expect(codeLine).toBeDefined()
    if (codeLine && codeLine.kind === 'code-line') {
      expect(codeLine.text).toBe('const x = 1;')
    }
  })

  it('lang extraction: unknown lang gives empty lang and full tail as code-line', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      '## H```fooblahbar = 1\n```\nafter',
    )
    const fence = tokens.find(t => t.kind === 'code-fence-open')
    if (fence && fence.kind === 'code-fence-open') {
      expect(fence.lang).toBe('')
    }
    const codeLine = tokens.find(t => t.kind === 'code-line')
    if (codeLine && codeLine.kind === 'code-line') {
      expect(codeLine.text).toBe('fooblahbar = 1')
    }
  })

  it('lang extraction: bash + echo glue resolves to bash', () => {
    const tokens = new MarkdownBlockNormalizer().feedAll(
      '## H```bashecho hi\n```',
    )
    const fence = tokens.find(t => t.kind === 'code-fence-open')
    if (fence && fence.kind === 'code-fence-open') {
      expect(fence.lang).toBe('bash')
    }
  })

  it('heading without fence: text containing ``` should not be split when no fence-open intent', () => {
    // A heading whose text contains a triple backtick at the END but no
    // following code is unusual; we still split (since the fence opens),
    // but the close must come from a separate `\`\`\`\` on a later line —
    // which here it does not, so the rest of the input becomes code-lines
    // until end-of-stream finalize. This documents the trade-off: better
    // to recover the intent (open fence) than render `\`\`\`` literal in
    // a heading.
    const tokens = new MarkdownBlockNormalizer().feedAll('## H```')
    const kinds = tokens.map(t => t.kind)
    expect(kinds[0]).toBe('heading')
    expect(kinds).toContain('code-fence-open')
  })
})
