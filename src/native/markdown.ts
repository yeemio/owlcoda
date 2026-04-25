/**
 * OwlCoda Markdown-to-ANSI Renderer
 *
 * Lightweight terminal markdown rendering for LLM output.
 * Handles: bold, italic, code, code blocks, headers, lists,
 *          links, tables, task lists, blockquotes.
 * Uses TUI theme colors for consistent appearance.
 *
 * Design note: Strikethrough (~~text~~) is intentionally disabled.
 * LLMs frequently use `~` for approximation (e.g. ~100) which triggers
 * false positives. This keeps rendering predictable for the native terminal UI.
 */

import { sgr, themeColor, dim as dimFn, stripAnsi, visibleWidth } from './tui/colors.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'

const BOLD = sgr.bold
const DIM = sgr.dim
const ITALIC = sgr.italic
const UNDERLINE = sgr.underline
const RESET = sgr.reset

// Semantic colors (resolved at render time from TUI theme)
function codeColor(): string { return themeColor('info') }
function headerColor(): string { return themeColor('warning') }
function listColor(): string { return themeColor('success') }
function tableColor(): string { return themeColor('textDim') }

/**
 * Inline code styling — foreground + background to create a "chip" appearance.
 * Uses the native theme palette for a similar visual effect.
 */
function inlineCodeStyle(): string {
  return `${themeColor('inlineCode')}${themeColor('inlineCodeBg').replace('\x1b[38;', '\x1b[48;')}`
}

/**
 * Helper: convert a foreground ANSI escape to background.
 * Transforms \x1b[38;... to \x1b[48;... for use as background color.
 */
function fgToBg(fg: string): string {
  return fg.replace(/\x1b\[38;/g, '\x1b[48;')
}

// ─── Lightweight syntax highlighting ──────────────────────────

/**
 * Keyword-based syntax highlighting for code blocks.
 * Clean-room implementation — no external highlighting library.
 * Covers common tokens: keywords, strings, comments, numbers.
 * Language-aware for JS/TS, Python, Rust, Go, Bash, JSON.
 */

// ANSI SGR codes for syntax tokens (independent of theme — using standard terminal palette)
const SYN = {
  keyword:  '\x1b[38;5;141m', // purple (keywords, control flow)
  string:   '\x1b[38;5;113m', // green (string literals)
  comment:  '\x1b[38;5;240m', // gray (comments)
  number:   '\x1b[38;5;209m', // orange (numeric literals)
  type:     '\x1b[38;5;81m',  // cyan (type names, built-ins)
  func:     '\x1b[38;5;222m', // yellow (function names)
  operator: '\x1b[38;5;247m', // light gray (operators)
  reset:    RESET,
}

/** Keywords by language family. */
const KEYWORDS: Record<string, Set<string>> = {
  js: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends',
    'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'throw',
    'try', 'catch', 'finally', 'typeof', 'instanceof', 'in', 'of', 'delete',
    'void', 'this', 'super', 'true', 'false', 'null', 'undefined',
  ]),
  ts: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends',
    'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'throw',
    'try', 'catch', 'finally', 'typeof', 'instanceof', 'in', 'of', 'delete',
    'void', 'this', 'super', 'true', 'false', 'null', 'undefined',
    'type', 'interface', 'enum', 'namespace', 'declare', 'abstract', 'implements',
    'readonly', 'as', 'is', 'keyof', 'infer', 'extends', 'satisfies',
  ]),
  python: new Set([
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break',
    'continue', 'import', 'from', 'as', 'with', 'try', 'except', 'finally',
    'raise', 'pass', 'yield', 'lambda', 'and', 'or', 'not', 'in', 'is',
    'True', 'False', 'None', 'self', 'async', 'await', 'global', 'nonlocal',
  ]),
  rust: new Set([
    'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait',
    'type', 'use', 'mod', 'pub', 'crate', 'self', 'super', 'where', 'for',
    'loop', 'while', 'if', 'else', 'match', 'return', 'break', 'continue',
    'move', 'ref', 'as', 'in', 'unsafe', 'async', 'await', 'dyn', 'true', 'false',
  ]),
  go: new Set([
    'func', 'var', 'const', 'type', 'struct', 'interface', 'package', 'import',
    'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break',
    'continue', 'go', 'defer', 'select', 'chan', 'map', 'make', 'new', 'nil',
    'true', 'false', 'fallthrough',
  ]),
  bash: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
    'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'declare',
    'set', 'unset', 'source', 'shift', 'eval', 'exec', 'trap', 'true', 'false',
    'in', 'until', 'select',
  ]),
}

/** Detect language family from code fence language tag. */
function detectLangFamily(lang: string): string {
  const l = lang.toLowerCase()
  if (['javascript', 'js', 'jsx', 'mjs', 'cjs'].includes(l)) return 'js'
  if (['typescript', 'ts', 'tsx', 'mts', 'cts'].includes(l)) return 'ts'
  if (['python', 'py', 'python3'].includes(l)) return 'python'
  if (['rust', 'rs'].includes(l)) return 'rust'
  if (['go', 'golang'].includes(l)) return 'go'
  if (['bash', 'sh', 'zsh', 'shell', 'fish'].includes(l)) return 'bash'
  if (['json', 'jsonc', 'json5'].includes(l)) return 'json'
  return ''
}

/** Apply syntax highlighting to a single code line. */
function highlightCode(line: string, lang: string): string {
  const family = detectLangFamily(lang)
  if (!family) return `${codeColor()}${line}${RESET}`

  // JSON: special case — colorize keys, strings, numbers, booleans
  if (family === 'json') {
    return highlightJson(line)
  }

  const keywords = KEYWORDS[family]
  if (!keywords) return `${codeColor()}${line}${RESET}`

  // Line-comment detection
  const commentPrefixes = family === 'python' ? ['#'] :
    family === 'bash' ? ['#'] :
    ['//']

  // Check for line comment
  for (const prefix of commentPrefixes) {
    const ci = line.indexOf(prefix)
    if (ci >= 0) {
      // Check if # is inside a string (rough heuristic: count quotes before it)
      const before = line.slice(0, ci)
      const singleQuotes = (before.match(/'/g) || []).length
      const doubleQuotes = (before.match(/"/g) || []).length
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        const codePart = highlightCodeTokens(line.slice(0, ci), keywords, family)
        return `${codePart}${SYN.comment}${line.slice(ci)}${RESET}`
      }
    }
  }

  return highlightCodeTokens(line, keywords, family)
}

/** Tokenize and highlight a line without comments. */
function highlightCodeTokens(line: string, keywords: Set<string>, family: string): string {
  // Regex: match strings, numbers, words, or other characters
  const TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[a-zA-Z_]\w*\b|.)/g
  let result = ''
  let m: RegExpExecArray | null

  while ((m = TOKEN.exec(line)) !== null) {
    const tok = m[0]

    // String literal
    if ((tok.startsWith('"') && tok.endsWith('"')) ||
        (tok.startsWith("'") && tok.endsWith("'")) ||
        (tok.startsWith('`') && tok.endsWith('`'))) {
      result += `${SYN.string}${tok}${RESET}`
      continue
    }

    // Number literal
    if (/^\d/.test(tok)) {
      result += `${SYN.number}${tok}${RESET}`
      continue
    }

    // Keyword
    if (keywords.has(tok)) {
      result += `${SYN.keyword}${tok}${RESET}`
      continue
    }

    // Type-like (starts with uppercase in TS/Rust/Go)
    if (/^[A-Z]/.test(tok) && ['ts', 'js', 'rust', 'go'].includes(family)) {
      result += `${SYN.type}${tok}${RESET}`
      continue
    }

    // Function call (word followed by '(' — look ahead in original line)
    const nextChar = line[TOKEN.lastIndex]
    if (/^[a-z_]/i.test(tok) && nextChar === '(') {
      result += `${SYN.func}${tok}${RESET}`
      continue
    }

    // Default: use code color
    result += `${codeColor()}${tok}${RESET}`
  }

  return result || `${codeColor()}${line}${RESET}`
}

/** Highlight JSON line. */
function highlightJson(line: string): string {
  // Keys: "key":
  let result = line.replace(/"([^"]+)"(\s*:)/g, `${SYN.type}"$1"${RESET}$2`)
  // String values (not keys)
  result = result.replace(/:\s*"([^"]*)"(?=[,}\]\s]|$)/g, (m, val) =>
    `: ${SYN.string}"${val}"${RESET}`)
  // Numbers
  result = result.replace(/:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, (m, num) =>
    `: ${SYN.number}${num}${RESET}`)
  // Booleans and null
  result = result.replace(/\b(true|false|null)\b/g, `${SYN.keyword}$1${RESET}`)
  // Wrap any remaining uncolored text in code color
  if (!result.includes('\x1b[')) {
    result = `${codeColor()}${result}${RESET}`
  }
  return result
}

// ─── Depth-aware list numbering ─────────────────────────────────

/** Convert number to lowercase letter (1→a, 2→b, …, 26→z, 27→aa). */
function toLetter(n: number): string {
  let s = ''
  let v = n
  while (v > 0) {
    v--
    s = String.fromCharCode(97 + (v % 26)) + s
    v = Math.floor(v / 26)
  }
  return s
}

/** Convert number to lowercase roman numeral. */
function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let result = ''
  let remaining = n
  for (const [value, sym] of table) {
    while (remaining >= value) {
      result += sym
      remaining -= value
    }
  }
  return result
}

/** Format a list number based on nesting depth (arabic → letter → roman). */
function formatListNumber(n: number, depth: number): string {
  switch (depth % 3) {
    case 0: return `${n}`
    case 1: return toLetter(n)
    case 2: return toRoman(n)
    default: return `${n}`
  }
}

// ─── GFM Table Rendering ────────────────────────────────────────

type TableAlign = 'left' | 'center' | 'right'

interface ParsedTable {
  headers: string[]
  alignments: TableAlign[]
  rows: string[][]
}

/** Parse GFM table lines into structured data. */
function parseGfmTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null

  const parseCells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\||\|$/g, '')
    return trimmed.split('|').map(c => c.trim())
  }

  const headers = parseCells(lines[0]!)
  const sepLine = lines[1]!.trim()

  // Validate separator row: must have |---|... pattern
  if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sepLine)) return null

  const sepCells = parseCells(sepLine)
  const alignments: TableAlign[] = sepCells.map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })

  const rows: string[][] = []
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || !line.includes('|')) break
    rows.push(parseCells(line))
  }

  return { headers, alignments, rows }
}

/** Render a parsed table with aligned columns and borders, wrapping
 *  oversized cells within their column so the whole table stays within
 *  the available terminal width. Previous version computed each column's
 *  natural max-content width (capped at 40 cols); two wide columns
 *  blew past the terminal and the terminal's own auto-wrap then
 *  shredded the `│` grid into disjoint rows. Symptom matched the real
 *  transcript from the user: long Chinese descriptions broken across
 *  multiple visual rows with the `│` separators lost. */
function renderTable(table: ParsedTable): string {
  const cols = table.headers.length
  const tc = tableColor()

  // Budget: how many columns the rendered table can occupy. Leaves 6
  // cells of slack for the assistant `⎿ `+ indent prefix and a little
  // breathing room so the table doesn't hug the right edge.
  const termCols = Math.max(40, process.stdout.columns || 80)
  const RESERVED = 6
  const widthBudget = Math.max(20, termCols - RESERVED)
  // Non-content chrome per row: `│ cell │ cell │ cell │`
  //   one `│` per column boundary (cols+1) + one space on each side of
  //   each cell (cols * 2) = 3*cols + 1.
  const chromeWidth = 3 * cols + 1
  const contentBudget = Math.max(cols * 3, widthBudget - chromeWidth)

  // Natural content widths per column (max of header + all rows).
  const desired: number[] = new Array(cols).fill(0)
  for (let c = 0; c < cols; c++) {
    desired[c] = visibleWidth(table.headers[c] ?? '')
    for (const row of table.rows) {
      desired[c] = Math.max(desired[c]!, visibleWidth(row[c] ?? ''))
    }
    desired[c] = Math.max(3, desired[c]!)
  }

  // Fit desired widths into contentBudget. If they already fit, use as-is
  // (capped at 60 so a giant cell doesn't monopolize). If not, scale all
  // columns proportionally with a per-column floor of 3.
  const totalDesired = desired.reduce((s, w) => s + w, 0)
  const colWidths: number[] = new Array(cols).fill(0)
  if (totalDesired <= contentBudget) {
    for (let c = 0; c < cols; c++) colWidths[c] = Math.min(60, desired[c]!)
  } else {
    const ratio = contentBudget / totalDesired
    let allocated = 0
    for (let c = 0; c < cols; c++) {
      colWidths[c] = Math.max(3, Math.floor(desired[c]! * ratio))
      allocated += colWidths[c]!
    }
    // Re-distribute any leftover from Math.floor rounding to the widest
    // (most-needy) column so the table uses the full budget.
    let slack = contentBudget - allocated
    while (slack > 0) {
      let widest = 0
      for (let c = 1; c < cols; c++) {
        if (desired[c]! - colWidths[c]! > desired[widest]! - colWidths[widest]!) widest = c
      }
      colWidths[widest]! += 1
      slack -= 1
    }
  }

  /** Pad a cell string to target width with alignment. */
  const padCell = (text: string, width: number, align: TableAlign): string => {
    const vw = visibleWidth(text)
    const deficit = Math.max(0, width - vw)
    if (align === 'right') return ' '.repeat(deficit) + text
    if (align === 'center') {
      const left = Math.floor(deficit / 2)
      return ' '.repeat(left) + text + ' '.repeat(deficit - left)
    }
    return text + ' '.repeat(deficit)
  }

  /** Wrap a cell's content into N physical lines, each ≤ width display
   *  cells. Uses wrapAnsi which already handles spaces + CJK width. For
   *  path/identifier-shaped cells (no whitespace, full of `/`, `_`, `-`
   *  separators), wrapAnsi's hard break can slice a number or suffix in
   *  two (`2026042` / `3.md` — ugly and unscannable). We insert a
   *  zero-width-ish break hint by temporarily rewriting those separators
   *  into "<sep>\u200B" (ZWSP): wrapAnsi treats ZWSP as a break point,
   *  so it prefers to snap the line at `/`, `_`, or `-` boundaries
   *  instead of hard-cutting through a digit run. If a single
   *  un-splittable run is still wider than width, wrapAnsi hard-cuts
   *  as a last resort.
   *
   *  ZWSP is stripped from the emitted pieces so terminal display isn't
   *  polluted with invisible-char widgets. */
  const SOFT_BREAK_RE = /([/_\-.])(?=\S)/g
  const ZWSP = '\u200B'
  const wrapCell = (text: string, width: number): string[] => {
    if (visibleWidth(text) <= width) return [text]
    const hinted = text.replace(SOFT_BREAK_RE, `$1${ZWSP}`)
    // hard=true as a last-resort guard for runs with no hint points.
    const wrapped = wrapAnsi(hinted, Math.max(1, width), { trim: false, hard: true })
    return wrapped.split('\n').map(line => line.replace(new RegExp(ZWSP, 'g'), ''))
  }

  /** Render one logical row spanning possibly multiple physical rows
   *  (when any cell wraps). All cells are padded to their column width
   *  and empty continuation lines are filled with spaces so the `│`
   *  separators line up vertically on every physical row. */
  const renderRow = (cells: string[], bold: boolean): string[] => {
    const wrappedPerCell = cells.map((cell, i) => wrapCell(renderInline(cell ?? ''), colWidths[i]!))
    const rowHeight = Math.max(1, ...wrappedPerCell.map(ws => ws.length))
    const physical: string[] = []
    for (let r = 0; r < rowHeight; r++) {
      const rowCells = wrappedPerCell.map((wrapped, i) => {
        const segment = wrapped[r] ?? ''
        const padded = padCell(segment, colWidths[i]!, table.alignments[i] ?? 'left')
        return bold ? `${BOLD}${padded}${RESET}` : padded
      })
      physical.push(`${tc}│${RESET} ${rowCells.join(` ${tc}│${RESET} `)} ${tc}│${RESET}`)
    }
    return physical
  }

  // Top + bottom borders close the table. Before 0.12.14 the table
  // rendered as header + separator + body only — rows looked disconnected
  // from whatever came before/after and on scrollback the table felt
  // like a sequence of unrelated bars rather than a single structure.
  const sepCells = colWidths.map(w => '─'.repeat(w))
  const lines: string[] = []
  lines.push(`${tc}┌─${sepCells.join('─┬─')}─┐${RESET}`)
  lines.push(...renderRow(table.headers, true))
  lines.push(`${tc}├─${sepCells.join('─┼─')}─┤${RESET}`)
  for (const row of table.rows) {
    lines.push(...renderRow(row, false))
  }
  lines.push(`${tc}└─${sepCells.join('─┴─')}─┘${RESET}`)

  return lines.join('\n')
}

// ─── Main renderer ──────────────────────────────────────────────

/** Render markdown text to ANSI-formatted terminal output. */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeBlockLang = ''
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        result.push(`${DIM}${'─'.repeat(40)}${RESET}`)
        inCodeBlock = false
        codeBlockLang = ''
      } else {
        codeBlockLang = line.trimStart().slice(3).trim()
        const label = codeBlockLang ? ` ${codeBlockLang} ` : ''
        result.push(`${DIM}${'─'.repeat(3)}${label}${'─'.repeat(Math.max(0, 37 - label.length))}${RESET}`)
        inCodeBlock = true
      }
      i++
      continue
    }

    if (inCodeBlock) {
      result.push(`  ${highlightCode(line, codeBlockLang)}`)
      i++
      continue
    }

    // Try to parse a GFM table starting at this line
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('|')) {
      const tableLines: string[] = []
      let j = i
      while (j < lines.length && lines[j]!.trim().includes('|')) {
        tableLines.push(lines[j]!)
        j++
      }
      const table = parseGfmTable(tableLines)
      if (table) {
        result.push(renderTable(table))
        i = j
        continue
      }
    }

    result.push(renderLine(line))
    i++
  }

  return result.join('\n')
}

// ─── Ordered list counter state (for depth-aware numbering) ─────

/** State for tracking ordered list counters across lines. */
interface OlState {
  depth: number
  count: number
}

let olStack: OlState[] = []

/** Reset ordered list state (call between renderMarkdown calls if needed). */
export function resetListState(): void {
  olStack = []
}

/** Render a single non-code-block line. */
function renderLine(line: string): string {
  // Headers. CommonMark requires whitespace between the `#` run and the
  // heading text (`## Title`), but models — particularly Chinese-LLM
  // output — frequently omit the space (`##1.完成情况`, `##标题`) because
  // CJK input flows naturally without ASCII spaces. Before this fix the
  // renderer treated those lines as plain prose while sibling `## Title`
  // lines rendered as bold headings, producing the mixed "some ###,
  // some not" look the user called out.
  //
  // We accept either whitespace OR a digit-start OR a CJK character
  // immediately after the `#` run. Still requires at least one
  // non-whitespace character so bare `##` alone stays literal.
  const headerMatch = line.match(/^(#{1,6})(?:\s+|(?=[0-9\u4e00-\u9fff]))(\S.*)$/)
  if (headerMatch) {
    const level = headerMatch[1]!.length
    const text = renderInline(headerMatch[2]!)
    if (level <= 2) return `${BOLD}${headerColor()}${text}${RESET}`
    return `${BOLD}${text}${RESET}`
  }

  // Horizontal rule
  if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
    return `${DIM}${'─'.repeat(40)}${RESET}`
  }

  // Task list items: - [ ] or - [x]
  const taskMatch = line.match(/^(\s*)[*\-+]\s+\[([ xX])\]\s+(.+)$/)
  if (taskMatch) {
    const indent = taskMatch[1] ?? ''
    const checked = taskMatch[2]!.toLowerCase() === 'x'
    const content = renderInline(taskMatch[3]!)
    const checkbox = checked
      ? `${listColor()}☑${RESET}`
      : `${DIM}☐${RESET}`
    return `${indent}${checkbox} ${content}`
  }

  // Unordered list items
  const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/)
  if (ulMatch) {
    const indent = ulMatch[1] ?? ''
    const content = renderInline(ulMatch[2]!)
    return `${indent}${listColor()}•${RESET} ${content}`
  }

  // Ordered list items with depth-aware numbering
  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/)
  if (olMatch) {
    const indent = olMatch[1] ?? ''
    const depth = Math.floor(indent.length / 2)
    const num = parseInt(olMatch[2]!, 10)
    const content = renderInline(olMatch[3]!)

    // Track numbering per depth level
    while (olStack.length > 0 && olStack[olStack.length - 1]!.depth > depth) {
      olStack.pop()
    }
    if (olStack.length === 0 || olStack[olStack.length - 1]!.depth < depth) {
      olStack.push({ depth, count: 1 })
    } else {
      olStack[olStack.length - 1]!.count++
    }
    const displayNum = formatListNumber(olStack[olStack.length - 1]!.count, depth)
    return `${indent}${listColor()}${displayNum}.${RESET} ${content}`
  }

  // Not a list item — reset ordered list stack
  if (line.trim() !== '') {
    olStack = []
  }

  // Blockquote
  if (line.startsWith('> ')) {
    return `${DIM}│${RESET} ${ITALIC}${renderInline(line.slice(2))}${RESET}`
  }

  return renderInline(line)
}

/** Render inline markdown: bold, italic, code, links. */
export function renderInline(text: string): string {
  let result = text

  // Inline code — color-only, no background block. The design canvas
  // pairs bg-input with a 1px hair-faint border + 4px padding +
  // border-radius which composites into a soft "code pill" in the
  // browser. Terminal cells are hard-edged and can't paint sub-cell
  // borders or radii, so any background block reads as a row of
  // sliced color tiles — visually noisier than the prose it lives in.
  // Dropping the bg and relying on `shimmer` fg keeps the verbatim
  // signal (color shift) without the tile artifact. The token
  // `inlineCodeBg` stays in the palette for callers that explicitly
  // want a chip surface.
  result = result.replace(/`([^`]+)`/g, `${themeColor('inlineCode')}$1${RESET}`)

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)

  // Bold — asterisk form can be intraword per CommonMark.
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
  // Bold — underscore form MUST NOT be intraword. Previously we accepted
  // `__x__` anywhere, which chewed up identifiers containing double
  // underscores (rare but real). Require a non-word char (or
  // start/end-of-string) flanking the opening and closing runs.
  result = result.replace(
    /(^|[^A-Za-z0-9_])__([^_\s](?:[^_]*[^_\s])?)__(?=$|[^A-Za-z0-9_])/g,
    `$1${BOLD}$2${RESET}`,
  )

  // Italic — asterisk form can be intraword.
  result = result.replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
  // Italic — underscore form MUST NOT be intraword. This is the CommonMark
  // rule that the old regex violated. Identifiers like
  // `reporting_source_connector_stub_client` were being shredded into
  // alternating italic segments, and because the replacement consumes the
  // `_` delimiters, the output lost every underscore in the identifier.
  // Real transcripts pasted by users came back as
  // `reportingsourceconnectorstubclient`, silently corrupting file paths,
  // config keys, and snake_case identifiers. The flanking check
  // `(^|[^A-Za-z0-9_]) ... (?=$|[^A-Za-z0-9_])` only opens emphasis when
  // there's whitespace/punctuation (or string boundary) around the run.
  result = result.replace(
    /(^|[^A-Za-z0-9_])_([^_\s](?:[^_]*[^_\s])?)_(?=$|[^A-Za-z0-9_])/g,
    `$1${ITALIC}$2${RESET}`,
  )

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${RESET} ${DIM}($2)${RESET}`)

  return result
}

/**
 * Streaming markdown renderer — buffers incoming text chunks and
 * emits ANSI-rendered output line-by-line as newlines arrive.
 *
 * Supports all block-level elements including code blocks and tables.
 *
 * Usage:
 *   const renderer = new StreamingMarkdownRenderer()
 *   onText(chunk) { const out = renderer.push(chunk); if (out) write(out) }
 *   onEnd()       { const out = renderer.flush(); if (out) write(out) }
 */
export class StreamingMarkdownRenderer {
  private buffer = ''
  private inCodeBlock = false
  private codeBlockLang = ''
  private tableBuffer: string[] = []
  private inTable = false

  /**
   * Feed a text chunk. Returns rendered output for any complete lines.
   * If the buffer grows large without a newline, flushes partial content
   * to avoid the "wall of text with no line breaks" problem.
   *
   * Loops through ALL structural break patterns so that even if a single
   * chunk contains multiple list items, every item gets its own line.
   */
  push(chunk: string): string {
    this.buffer += chunk
    const results: string[] = []

    // Phase 1: Process complete lines (terminated by \n)
    const nlIdx = this.buffer.lastIndexOf('\n')
    if (nlIdx !== -1) {
      const ready = this.buffer.slice(0, nlIdx)
      this.buffer = this.buffer.slice(nlIdx + 1)

      for (const line of ready.split('\n')) {
        const out = this.processLine(line)
        if (out !== null) results.push(out)
      }
    }

    // Phase 2: Apply structural break patterns in a LOOP.
    // Each iteration finds and emits the EARLIEST break, then continues
    // scanning the remaining buffer for more breaks.
    if (!this.inCodeBlock) {
      while (this.buffer.length > 8) {
        const broke = this.tryStructuralBreak()
        if (!broke) break
        results.push(broke)
      }
    }

    // Phase 3: CJK / Latin word-wrap for remaining long buffer
    if (!this.inCodeBlock) {
      const hasCJK = /[\u4e00-\u9fff]/.test(this.buffer)
      const WRAP_THRESHOLD = hasCJK ? 60 : 120

      if (this.buffer.length > WRAP_THRESHOLD) {
        if (hasCJK) {
          const wrapAt = this.findCJKBreakPoint(WRAP_THRESHOLD)
          if (wrapAt > 20) {
            results.push(renderLine(this.buffer.slice(0, wrapAt)))
            this.buffer = this.buffer.slice(wrapAt)
          }
        } else {
          const wrapAt = this.buffer.lastIndexOf(' ', WRAP_THRESHOLD)
          if (wrapAt > 40) {
            results.push(renderLine(this.buffer.slice(0, wrapAt)))
            this.buffer = this.buffer.slice(wrapAt + 1)
          }
        }
      }
    }

    return results.length > 0 ? results.join('\n') + '\n' : ''
  }

  /**
   * Try to find the EARLIEST structural break in the buffer.
   * Returns the rendered partial line if a break was found, or null.
   * Mutates this.buffer to remove the emitted portion.
   *
   * Uses non-greedy matching to find the FIRST break point, not the last.
   * Minimum thresholds are CJK-aware (8 chars ≈ 16 terminal columns).
   */
  private tryStructuralBreak(): string | null {
    const buf = this.buffer

    // Pattern 1: Sentence ender followed by list/header marker
    // Non-greedy: finds the EARLIEST sentence-ender + marker boundary
    const p1 = buf.match(
      /(.{8,}?)([.!?。！？：:])(\s*)([-*]\s|#{1,3}\s|\d+\.\s)/,
    )

    // Pattern 2: CJK character directly before list marker
    // Non-greedy: finds the FIRST CJK→marker boundary
    const p2 = buf.match(
      /(.{5,}?[\u4e00-\u9fff\u3000-\u303f])([-*]\s|\d+\.\s)/,
    )

    // Pattern 3: Emoji followed by space (📝 🔍 ⚙️ as list bullets)
    const p3 = buf.match(
      /(.{5,}?)([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?\s)/u,
    )

    // Pattern 4: Non-digit before numbered item (catches ASCII text too)
    const p4 = buf.match(
      /(.{5,}?[^\d])(\d+\.\s)/,
    )

    // Pattern 5: Break before bold markers (**text**) after sentence or CJK
    const p5 = buf.match(
      /(.{8,}?[.!?。！？：:\s])(\*\*[^*])/,
    )

    // Pattern 6: Break before horizontal rule (--- or *** or ___) concatenated with text
    const p6 = buf.match(
      /(.{3,}?)(---+|___+|\*\*\*+)(?=[^\s*_-])/,
    )

    // Pattern 6b: Break after horizontal rule at start of buffer
    const p6b = buf.match(
      /^(---+|___+|\*\*\*+)([^\s*_-])/,
    )

    // Pattern 7: Break after closing paren/bracket before CJK or letter start
    const p7 = buf.match(
      /(.{5,}?[)）\]】》」])([A-Z\u4e00-\u9fff])/,
    )

    // Pick the EARLIEST match across all patterns
    type Hit = { breakAt: number; trimLeading: boolean }
    const hits: Hit[] = []

    if (p1) {
      hits.push({
        breakAt: p1.index! + p1[1]!.length + p1[2]!.length,
        trimLeading: true,
      })
    }
    if (p2) {
      hits.push({
        breakAt: p2.index! + p2[1]!.length,
        trimLeading: false,
      })
    }
    if (p3) {
      hits.push({
        breakAt: p3.index! + p3[1]!.length,
        trimLeading: false,
      })
    }
    if (p4) {
      hits.push({
        breakAt: p4.index! + p4[1]!.length,
        trimLeading: false,
      })
    }
    if (p5) {
      hits.push({
        breakAt: p5.index! + p5[1]!.length,
        trimLeading: true,
      })
    }
    if (p6) {
      hits.push({
        breakAt: p6.index! + p6[1]!.length,
        trimLeading: false,
      })
    }
    if (p6b) {
      hits.push({
        breakAt: p6b[1]!.length,
        trimLeading: false,
      })
    }
    if (p7) {
      hits.push({
        breakAt: p7.index! + p7[1]!.length,
        trimLeading: false,
      })
    }

    if (hits.length === 0) return null

    // Choose the earliest break point
    hits.sort((a, b) => a.breakAt - b.breakAt)
    const best = hits[0]!

    // Avoid degenerate zero-length or very short fragments
    if (best.breakAt < 3) return null

    const partial = buf.slice(0, best.breakAt)
    this.buffer = best.trimLeading
      ? buf.slice(best.breakAt).replace(/^\s+/, '')
      : buf.slice(best.breakAt)
    return renderLine(partial)
  }

  /** Flush remaining buffer (call at end of response). */
  flush(): string {
    const parts: string[] = []

    // Flush any pending table
    if (this.inTable && this.tableBuffer.length > 0) {
      parts.push(this.flushTable())
    }

    if (this.buffer) {
      // Split buffer on structural patterns before rendering.
      // Models often concatenate list items without newlines.
      // Patterns:
      //   1. sentence enders + optional space before list/header markers
      //   2. CJK text directly before list markers
      //   3. non-digit character before numbered list (e.g. "概念3. 搜索")
      //   4. before emoji + space sequences (common as list bullet alternatives)
      //   5. before bold markers (**text**) after whitespace or sentence enders
      //   6. before horizontal rules (--- or ***) concatenated with text
      //   7. after closing paren/bracket before CJK or uppercase
      const segments = this.buffer.split(
        /(?<=[.!?。！？：:])(?:\s*)(?=[-*]\s|#{1,3}\s|\d+\.\s)|(?<=[\u4e00-\u9fff])(?=[-*]\s|\d+\.\s)|(?<=[^\d])(?=\d+\.\s)|(?<=\S[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?\s)(?=\S)|(?<=[.!?。！？：:\s])(?=\*\*[^*])|(?=---+|___+|\*\*\*+)(?<=\S)|(?<=[)）\]】》」])(?=[A-Z\u4e00-\u9fff])/u,
      )
      for (const seg of segments) {
        if (seg.trim()) parts.push(this.renderOneLine(seg))
      }
      this.buffer = ''
    }

    if (parts.length === 0) return ''
    return parts.join('\n') + '\n'
  }

  /** Reset state for a new response. */
  reset(): void {
    this.buffer = ''
    this.inCodeBlock = false
    this.codeBlockLang = ''
    this.tableBuffer = []
    this.inTable = false
    resetListState()
  }

  /**
   * Find a suitable break point for CJK text.
   * CJK characters can break between any two characters, but prefer
   * breaking after punctuation (。！？，；：) or before list markers.
   */
  private findCJKBreakPoint(threshold: number): number {
    // First try: break after CJK punctuation within threshold
    for (let i = Math.min(threshold, this.buffer.length - 1); i > 20; i--) {
      const ch = this.buffer[i]!
      if ('。！？，；：、）」』】'.includes(ch)) {
        return i + 1
      }
    }
    // Fallback: break between any two CJK characters
    for (let i = threshold; i > 20; i--) {
      const code = this.buffer.charCodeAt(i)
      if (code >= 0x4e00 && code <= 0x9fff) {
        return i
      }
    }
    return -1
  }

  /** Process a single line, handling table accumulation. Returns null if line is buffered. */
  private processLine(line: string): string | null {
    // If we're accumulating table lines
    if (this.inTable) {
      if (line.trim().includes('|')) {
        this.tableBuffer.push(line)
        return null // Keep buffering
      } else {
        // Table ended — flush it
        const tableOut = this.flushTable()
        const lineOut = this.renderOneLine(line)
        return tableOut + '\n' + lineOut
      }
    }

    // Check if this line starts a table (has pipe and next line might be separator)
    // We can't look ahead in streaming, so buffer potential table lines
    if (!this.inCodeBlock && line.trim().includes('|') && /\|/.test(line)) {
      this.inTable = true
      this.tableBuffer = [line]
      return null
    }

    return this.renderOneLine(line)
  }

  /** Flush accumulated table buffer. */
  private flushTable(): string {
    const lines = this.tableBuffer
    this.tableBuffer = []
    this.inTable = false

    if (lines.length < 2) {
      // Not enough for a table — render as normal lines
      return lines.map(l => renderLine(l)).join('\n')
    }

    const table = parseGfmTable(lines)
    if (table) {
      return renderTable(table)
    }

    // Not a valid table — render as normal lines
    return lines.map(l => renderLine(l)).join('\n')
  }

  private renderOneLine(line: string): string {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (this.inCodeBlock) {
        this.inCodeBlock = false
        this.codeBlockLang = ''
        return `${DIM}${'─'.repeat(40)}${RESET}`
      } else {
        this.codeBlockLang = line.trimStart().slice(3).trim()
        const label = this.codeBlockLang ? ` ${this.codeBlockLang} ` : ''
        this.inCodeBlock = true
        return `${DIM}${'─'.repeat(3)}${label}${'─'.repeat(Math.max(0, 37 - label.length))}${RESET}`
      }
    }

    if (this.inCodeBlock) {
      return `  ${highlightCode(line, this.codeBlockLang)}`
    }

    return renderLine(line)
  }
}
