/**
 * Block-level normalizer for OwlCoda markdown rendering.
 *
 * Recognizes block boundaries (code fences, headings, tables, blank lines,
 * malformed mid-line headings, prefix+|cells| jams) and produces a stream
 * of normalized logical lines as typed tokens. Owns NO ANSI rendering —
 * that responsibility stays with renderMarkdown's downstream renderTokens.
 *
 * Both rendering paths consume the normalizer:
 *   - `renderMarkdown(text)` feeds all lines at once via `feedAll()`.
 *   - `StreamingMarkdownRenderer` feeds one line at a time via `feedLine()`,
 *     and on end-of-stream calls `finalize()` to drain any held line.
 *
 * The normalizer holds AT MOST 1 pending line (the line awaiting next-line
 * lookahead for `|cells|` + separator detection). Streaming latency cap is
 * therefore one logical line.
 */

export type NormalizedLine =
  | { kind: 'text'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'table-header'; cells: string[] }
  | { kind: 'table-separator'; alignSpec: string[] }
  | { kind: 'table-row'; cells: string[] }
  | { kind: 'code-fence-open'; lang: string }
  | { kind: 'code-fence-close' }
  | { kind: 'code-line'; text: string }
  | { kind: 'blank' }

const HEADING_RE = /^(#{1,6})(?:\s+|(?=[0-9一-鿿]))(\S.*)$/

// Known fenced-code lang identifiers. The set is open-ended in real markdown
// (any word can be a lang), but we only need it for the heading-fence GLUE
// pre-split: when a heading line jams `## H```<word><code>...` on one line
// without a newline before the first code char, we can't tell where the
// lang stops and the code begins by syntax alone (`tsconst` looks like one
// word). So we accept a leading word as the lang ONLY when it matches a
// known identifier; otherwise lang='' and the entire post-``` content is
// emitted as the first code-line.
const KNOWN_FENCE_LANGS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'python', 'rb', 'ruby',
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'console', 'shell',
  'go', 'rs', 'rust', 'java', 'kt', 'kotlin', 'swift',
  'c', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx', 'm', 'mm',
  'cs', 'csharp', 'fs', 'fsharp', 'scala', 'clj', 'clojure',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'properties',
  'md', 'markdown', 'mdx', 'rst',
  'sql', 'graphql', 'gql', 'proto', 'protobuf',
  'php', 'lua', 'dart', 'r', 'julia', 'jl', 'pl', 'perl', 'tcl',
  'haskell', 'hs', 'elm', 'erl', 'erlang', 'ex', 'elixir',
  'dockerfile', 'docker', 'make', 'makefile', 'cmake',
  'tf', 'terraform', 'hcl', 'nix',
  'vim', 'elisp', 'lisp', 'scheme', 'racket',
  'asm', 's', 'wasm', 'wat',
  'diff', 'patch', 'log', 'txt', 'text', 'plain', 'plaintext',
  'vue', 'svelte', 'astro', 'jsx', 'tsx',
])
const MID_LINE_HEADING_RE = /^([^#].*?)(#{1,6})(?:\s+|(?=[0-9一-鿿]))(\S.*)$/
const FENCE_RE = /^```/
// Strict GFM separator: must contain at least one '-' or ':'. '|||' rejected.
const SEPARATOR_STRUCTURAL_RE = /^\s*\|[\s:|-]+\|\s*$/
const SEPARATOR_HAS_DASH_OR_COLON_RE = /[-:]/

function parseCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(c => c.trim())
}

function isStrictSeparator(line: string): boolean {
  return SEPARATOR_STRUCTURAL_RE.test(line) && SEPARATOR_HAS_DASH_OR_COLON_RE.test(line)
}

// Heading-glue pre-split: model occasionally jams an ordered-list item onto
// the heading line without the intervening newline, e.g.
//   "## 建议修改清单1. 模型名核实"
// Without the split this becomes ONE heading with the whole jam as its text.
// Heuristic: heading text matches `<CJK><digits>.<space><content>` — anchored
// on a CJK char before the digits to avoid mis-splitting `Section 1. Intro`
// or numbered headings like `1.5. Title`. Splits into heading(prefix) +
// text(list-item); the text classifier downstream renders the list correctly.
const HEADING_OL_GLUE_RE = /^(.*?[一-鿿])(\d+\.\s+\S.*)$/

const BOX_ROW_START_CHARS = new Set(['┌', '└', '├', '┏', '┗', '┣', '╔', '╚', '╠', '╭', '╰', '╞', '╟', '│', '┃'])
const BOX_ROW_END_CHARS = new Set(['┐', '┘', '┤', '┓', '┛', '┫', '╗', '╝', '╣', '╮', '╯', '╡', '╢', '│', '┃'])

function splitBoxDrawingGlue(line: string): string[] {
  if (!/[┌┐└┘├┤┏┓┗┛┣┫╔╗╚╝╠╣╭╮╰╯╞╡╟╢│┃]/.test(line)) return [line]

  const indent = line.match(/^\s*/)?.[0] ?? ''
  const breaks: number[] = []
  for (let i = indent.length + 1; i < line.length; i++) {
    const ch = line[i]!
    const prev = line[i - 1]!
    if (ch === '│' || ch === '┃') {
      if (BOX_ROW_END_CHARS.has(prev)) breaks.push(i)
      continue
    }
    if (BOX_ROW_START_CHARS.has(ch) && BOX_ROW_END_CHARS.has(prev)) {
      breaks.push(i)
    }
  }

  if (breaks.length === 0) return [line]
  const parts: string[] = []
  let start = 0
  for (const at of breaks) {
    const part = line.slice(start, at)
    if (part.trim() !== '') parts.push(part)
    start = at
  }
  const last = line.slice(start)
  if (last.trim() !== '') parts.push(last)
  if (parts.length <= 1) return [line]

  return parts.map((part, index) => {
    if (index === 0 || indent === '' || /^\s/.test(part)) return part
    return indent + part
  })
}

function splitGluedFenceClose(line: string): { content: string; closed: boolean } {
  const idx = line.lastIndexOf('```')
  if (idx <= 0) return { content: line, closed: false }
  if (line.slice(idx + 3).trim() !== '') return { content: line, closed: false }
  return { content: line.slice(0, idx), closed: true }
}

function classifyHeadingOrText(line: string): NormalizedLine[] {
  const m = line.match(HEADING_RE)
  if (m) {
    const level = m[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
    const headingText = m[2]!
    const glue = headingText.match(HEADING_OL_GLUE_RE)
    if (glue) {
      const prefix = glue[1]!.trimEnd()
      const tail = glue[2]!
      const out: NormalizedLine[] = []
      if (prefix !== '') out.push({ kind: 'heading', level, text: prefix })
      out.push({ kind: 'text', text: tail })
      return out
    }
    return [{ kind: 'heading', level, text: headingText }]
  }
  const mid = line.match(MID_LINE_HEADING_RE)
  if (mid) {
    const prefix = mid[1]!.trimEnd()
    const level = mid[2]!.length as 1 | 2 | 3 | 4 | 5 | 6
    const text = mid[3]!
    const out: NormalizedLine[] = []
    if (prefix !== '') out.push({ kind: 'text', text: prefix })
    const glue = text.match(HEADING_OL_GLUE_RE)
    if (glue) {
      const headPart = glue[1]!.trimEnd()
      const tail = glue[2]!
      if (headPart !== '') out.push({ kind: 'heading', level, text: headPart })
      out.push({ kind: 'text', text: tail })
    } else {
      out.push({ kind: 'heading', level, text })
    }
    return out
  }
  return [{ kind: 'text', text: line }]
}

export class MarkdownBlockNormalizer {
  private pending: string | null = null
  private inCodeFence = false
  private codeFenceLang = ''
  private inTable = false

  feedLine(line: string): NormalizedLine[] {
    const out: NormalizedLine[] = []

    // Step 1 — resolve pending (if any) using current line as next-line context.
    if (this.pending !== null) {
      if (isStrictSeparator(line)) {
        const pending = this.pending
        this.pending = null
        out.push(...this.resolveHeldAsTableHeader(pending, line))
        // Current line was consumed as separator. Done.
        return out
      }
      // No separator follows — emit pending as plain (heading or text).
      const pending = this.pending
      this.pending = null
      out.push(...classifyHeadingOrText(pending))
      // Fall through to process current line normally.
    }

    // Step 2 — process current line.

    // Code fence toggle.
    if (FENCE_RE.test(line.trimStart())) {
      if (this.inCodeFence) {
        this.inCodeFence = false
        this.codeFenceLang = ''
        out.push({ kind: 'code-fence-close' })
      } else {
        this.inCodeFence = true
        this.codeFenceLang = line.trimStart().slice(3).trim()
        // Fence lines exit any prior table state.
        this.inTable = false
        out.push({ kind: 'code-fence-open', lang: this.codeFenceLang })
      }
      return out
    }

    if (this.inCodeFence) {
      const splitFence = splitGluedFenceClose(line)
      for (const part of splitBoxDrawingGlue(splitFence.content)) {
        out.push({ kind: 'code-line', text: part })
      }
      if (splitFence.closed) {
        this.inCodeFence = false
        this.codeFenceLang = ''
        out.push({ kind: 'code-fence-close' })
      }
      return out
    }

    // Blank line.
    if (line === '') {
      this.inTable = false
      out.push({ kind: 'blank' })
      return out
    }

    // Inside an existing table: a leading-pipe line is a table-row.
    if (this.inTable && line.trimStart().startsWith('|')) {
      out.push({ kind: 'table-row', cells: parseCells(line) })
      return out
    }

    // Table state ends if we get to here with inTable still set.
    if (this.inTable) {
      this.inTable = false
    }

    const boxParts = splitBoxDrawingGlue(line)
    if (boxParts.length > 1) {
      for (const part of boxParts) {
        out.push(...classifyHeadingOrText(part))
      }
      return out
    }

    // Potential table-header / lookahead candidate: line has ≥ 2 pipes
    // (=> at least one cell pair). Hold for next-line decision. Catches:
    //   - clean | a | b |  shape
    //   - ## heading|cells|  jam
    //   - **bold**|cells|    jam
    //   - plain prefix|cells|  jam
    const pipeCount = (line.match(/\|/g) ?? []).length
    if (pipeCount >= 2 && !isStrictSeparator(line)) {
      // Hold for next-line lookahead. Strict separators (|---|---|) can't
      // be a table-header by themselves and are emitted as plain text.
      this.pending = line
      return out
    }

    // 0.13.98: HR-glue pre-split. Models occasionally emit a section
    // separator `---` immediately glued to the previous prose line:
    //   `RuntimeKernel插件化扩展点—...而非硬编码导入---`
    // HR_RE in classifyTextKind requires the line to be ENTIRELY dashes,
    // so the glued case stays as one text token visually showing literal
    // `---` at the end. Pre-split when the line ends with 3+ dashes
    // anchored after a non-dash-non-space char. Guards against tripping:
    //   - numeric ranges `1.0--2.0` (only 2 dashes; min 3 required)
    //   - CLI flags `--option` (no prose before)
    //   - table separator candidates `|---|---|` (pipeCount > 0 path)
    //   - YAML frontmatter `---` (whole-line, handled by HR_RE downstream)
    if (pipeCount === 0) {
      const hrGlueMatch = line.match(/^(.*[^\s-])(---+)\s*$/)
      if (hrGlueMatch) {
        const prose = hrGlueMatch[1]!.trimEnd()
        const dashes = hrGlueMatch[2]!
        if (prose !== '') {
          out.push(...classifyHeadingOrText(prose))
        }
        // dashes line goes through as plain text; downstream classifyTextKind
        // tags it 'hr' for spacing, render layer prints it verbatim.
        out.push({ kind: 'text', text: dashes })
        return out
      }
    }

    // No-pipe path. First, check the heading-with-fence-glue pre-split case:
    // model occasionally emits `## H```lang<rest>` on one line (forgot the
    // newline before the fence). HEADING_RE would otherwise consume the
    // entire line as heading text including ```. We split into:
    //   heading(prefix) + code-fence-open(lang) + (optional code-line tail)
    // and flip into in-fence state so subsequent lines become code-lines.
    const headingMatch = line.match(HEADING_RE)
    if (headingMatch && headingMatch[2]!.includes('```')) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      const headingText = headingMatch[2]!
      const fenceIdx = headingText.indexOf('```')
      const headPart = headingText.slice(0, fenceIdx).trimEnd()
      const afterFence = headingText.slice(fenceIdx + 3)
      // Lang extraction: only accept a leading word as lang when it matches
      // a known fenced-code language. `## H```tsconst x = 1` → lang='ts'
      // (since 'ts' is known and 'tsconst' is not). `## H```fooblahbar x`
      // → lang='' (neither is known) and the whole rest is the first
      // code-line — we lose syntax highlighting but never mis-attribute.
      const wordMatch = afterFence.match(/^([a-zA-Z][a-zA-Z0-9-]*)/)
      let lang = ''
      let tail = afterFence
      if (wordMatch) {
        const fullWord = wordMatch[1]!
        // Try the full word first; if not known, try shorter prefixes (down
        // to 2 chars) so `tsconst` resolves to `ts`. Prefer the LONGEST
        // matching known prefix to avoid e.g. `bashfoo` grabbing just `b`.
        for (let n = fullWord.length; n >= 2; n--) {
          const candidate = fullWord.slice(0, n).toLowerCase()
          if (KNOWN_FENCE_LANGS.has(candidate)) {
            lang = candidate
            tail = afterFence.slice(n)
            break
          }
        }
      }
      tail = tail.trim()
      if (headPart !== '') out.push({ kind: 'heading', level, text: headPart })
      this.inCodeFence = true
      this.codeFenceLang = lang
      this.inTable = false
      out.push({ kind: 'code-fence-open', lang })
      if (tail !== '') out.push({ kind: 'code-line', text: tail })
      return out
    }

    // No-pipe path: pure heading / mid-line heading / text.
    out.push(...classifyHeadingOrText(line))
    return out
  }

  feedAll(text: string): NormalizedLine[] {
    if (text === '') return []
    const out: NormalizedLine[] = []
    const lines = text.split('\n')
    // Drop the trailing phantom empty produced by a trailing '\n'. So
    // 'a\n' yields one 'text' (not text+blank); '\n' alone yields blank;
    // '' yields nothing (early-returned above).
    if (text.endsWith('\n')) lines.pop()
    for (const line of lines) {
      out.push(...this.feedLine(line))
    }
    out.push(...this.finalize())
    return out
  }

  finalize(): NormalizedLine[] {
    const out: NormalizedLine[] = []
    if (this.pending !== null) {
      const pending = this.pending
      this.pending = null
      out.push(...classifyHeadingOrText(pending))
    }
    return out
  }

  /** Whether the normalizer is currently inside a fenced code block.
   *  Streaming callers consult this before applying their own structural
   *  heuristics on the in-flight buffer (those heuristics must not split
   *  raw code content). */
  isInCodeFence(): boolean {
    return this.inCodeFence
  }

  reset(): void {
    this.pending = null
    this.inCodeFence = false
    this.codeFenceLang = ''
    this.inTable = false
  }

  // Internal: held line + confirmed next-separator → emit table tokens.
  private resolveHeldAsTableHeader(pending: string, separatorLine: string): NormalizedLine[] {
    const out: NormalizedLine[] = []
    const trimmed = pending.trimStart()
    if (trimmed.startsWith('|')) {
      // Pure |cells| header.
      out.push({ kind: 'table-header', cells: parseCells(pending) })
    } else {
      // <prefix>|cells| — split at first '|'.
      const idx = pending.indexOf('|')
      const prefix = pending.slice(0, idx).trim()
      const suffix = pending.slice(idx)
      if (prefix !== '') {
        out.push(...classifyHeadingOrText(prefix))
      }
      out.push({ kind: 'table-header', cells: parseCells(suffix) })
    }
    out.push({ kind: 'table-separator', alignSpec: parseCells(separatorLine) })
    this.inTable = true
    return out
  }
}
