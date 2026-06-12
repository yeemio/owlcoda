/**
 * OwlCoda Markdown-to-ANSI Renderer
 *
 * Lightweight terminal markdown rendering for LLM output.
 * Handles: bold, italic, code, code blocks, headers, lists,
 *          links, tables, task lists, blockquotes, status badges,
 *          and report-style key/value lines.
 * Uses TUI theme colors for consistent appearance.
 *
 * Design note: Strikethrough (~~text~~) is intentionally disabled.
 * LLMs frequently use `~` for approximation (e.g. ~100) which triggers
 * false positives. This keeps rendering predictable for the native terminal UI.
 */

import { sgr, themeColor, dim as dimFn, stripAnsi, visibleWidth } from './tui/colors.js'
import { MarkdownBlockNormalizer, type NormalizedLine } from './markdown-normalizer.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { appendFileSync } from 'node:fs'

// Env-gated raw-stream dump for diagnosing real-world glue cases.
// Set OWLCODA_DEBUG_MD_RAW=/path/to/file to capture every push() chunk.
// Each record is one JSON line: {"t":"push"|"flush","ms":<epoch_ms>,"chunk":"..."}.
function debugDumpRaw(t: 'push' | 'flush', chunk: string): void {
  const target = process.env.OWLCODA_DEBUG_MD_RAW
  if (!target) return
  try {
    appendFileSync(target, JSON.stringify({ t, ms: Date.now(), chunk }) + '\n')
  } catch { /* best-effort */ }
}

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
function statusColor(label: string): string {
  const upper = label.toUpperCase()
  if (upper === 'WARN' || upper === 'WARNING') return themeColor('warning')
  if (upper === 'FAIL' || upper === 'ERROR') return themeColor('error')
  return themeColor('success')
}

const STATUS_LABEL_RE = 'OK|PASS|WARN|WARNING|FAIL|ERROR'
// Uppercase-only on purpose: lowercase `[ok]` is more often prose ("press [ok]
// to continue") than a structured status badge. Models that want a status
// pill should emit uppercase, the convention every CI / runner already uses.
const STATUS_BRACKET_RE = new RegExp(`\\[(${STATUS_LABEL_RE})\\]`, 'g')
// Match an entire `LABEL:N` chain (one or more contiguous `LABEL:N`
// elements) bounded by non-word chars on both sides. Coloring then happens
// inside the matched chain.
//
// Whole-chain matching is structurally cleaner than per-label matching:
//   - The negative lookbehind `(?<![A-Za-z0-9_])` blocks `HTTP200OK:1`
//     (digit prefix) and `A1WARN:2` from coloring — per-label matching
//     could only check letters/underscore, missing the digit case.
//   - The lookahead `(?![A-Za-z0-9_])` ensures the chain ends cleanly:
//     `PASS:14OKAY` does not color `PASS:14` because the chain would have
//     to end with `OKAY` continuing as alphanumeric.
//   - `PASS:14WARN:1FAIL:0` matches as one chain; each label is then
//     colored individually inside the chain.
const STATUS_CHAIN_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:(?:${STATUS_LABEL_RE}):\\d+)+(?![A-Za-z0-9_])`,
  'g',
)
const STATUS_METRIC_INNER_RE = new RegExp(`(${STATUS_LABEL_RE}):(\\d+)`, 'g')

function renderStatusBadge(label: string): string {
  return `${BOLD}${statusColor(label)}[${label}]${RESET}`
}

function renderStatusMetric(label: string, count: string): string {
  return `${BOLD}${statusColor(label)}${label}${RESET}${DIM}:${RESET}${count}`
}

const KV_LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]{0,40})([:=])\s+(.{1,160})$/
const KV_KEYS = new Set([
  'admin',
  'admin_url',
  'backend',
  'backendmodel',
  'backend_model',
  'code',
  'cost',
  'ctx',
  'cwd',
  'duration',
  'duration_ms',
  'endpoint',
  'error',
  'error_kind',
  'file',
  'home',
  'id',
  'input_tokens',
  'latency',
  'model',
  'output_tokens',
  'path',
  'provider',
  'request',
  'request_id',
  'route',
  'runtime',
  'status',
  'total_tokens',
  'tokens',
  'url',
  'version',
])

function isKvKey(key: string): boolean {
  return (
    KV_KEYS.has(key.toLowerCase())
    || key.includes('_')
    || key.includes('.')
    || key.includes('-')
    || /^[A-Z][A-Z0-9_]{1,40}$/.test(key)
  )
}

// Reject values that look like English prose so allowlisted single-word
// keys (cost, path, status, code, error, …) don't capture sentences:
//   "Status: in progress"     → value starts with lowercase-word + 3+ lowercase
//   "Cost: 100 total"         → value starts with digit-run + 3+ lowercase
//   "Path: through the woods" → same
// Preserved: identifier values ("kimi-2.6"), number+known-unit ("108 ms",
// "108 sec", "100 bytes"), CJK / parenthetical / quoted values, proper-noun
// values ("Yi Miao") — none of those match the leading-lowercase /
// leading-digit + lowercase-word shape after the unit allowlist filter.
const PROSE_VALUE_RE = /^(?:\d+|[a-z]+)\s+([a-z]{3,})\b/
// Whitelist of common units that follow a number in a kv value. Lowercase
// only — these match against the second token of a `\d+ word` value pair.
// Short units (≤ 2 chars: ms, s, m, b, kb, …) bypass the prose regex
// already because `[a-z]{3,}` doesn't match them; the allowlist exists for
// 3+ char units that would otherwise be rejected as prose.
const VALUE_UNITS = new Set([
  // time
  'sec', 'secs', 'second', 'seconds',
  'min', 'mins', 'minute', 'minutes',
  'hour', 'hours',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  // size
  'kib', 'mib', 'gib', 'tib',
  'byte', 'bytes',
  // rate / throughput
  'rps', 'qps', 'tps', 'ops', 'req', 'reqs',
  'rpm', 'bps', 'mbps', 'gbps',
  // counts (common report units)
  'times', 'calls', 'rows', 'items', 'chars', 'lines', 'tokens',
  // misc
  'pct', 'percent',
])

function isProseValue(value: string): boolean {
  const m = value.match(PROSE_VALUE_RE)
  if (!m) return false
  // If the second token is a known unit, treat as data (number + unit
  // shape: "108 sec", "100 bytes"), not prose.
  return !VALUE_UNITS.has(m[1]!.toLowerCase())
}

function matchKvLine(line: string): RegExpMatchArray | null {
  const match = line.match(KV_LINE_RE)
  if (!match) return null
  if (!isKvKey(match[2]!)) return null
  if (isProseValue(match[4]!)) return null
  return match
}

// Whether `text` contains any line that would be classified as kvLine.
// Used by renderMarkdown to skip the no-markdown-syntax fast path when a
// kvLine is present — without this, the fast path emits the lines as plain
// prose (no block boundary blank) while the streaming path routes through
// TokenRenderer and inserts a blank between kvLine and the next paragraph.
// Cheap pre-check on `:` / `=` short-circuits long plain text.
function hasKvLine(text: string): boolean {
  if (text.indexOf(':') === -1 && text.indexOf('=') === -1) return false
  for (const line of text.split('\n')) {
    if (matchKvLine(line)) return true
  }
  return false
}

function renderKvLine(line: string): string | null {
  const match = matchKvLine(line)
  if (!match) return null
  const indent = match[1]!
  const key = match[2]!
  const sep = match[3]!
  const value = match[4]!
  return `${indent}${DIM}${key}${sep}${RESET} ${renderInline(value)}`
}

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
  // 0.13.87 boundary breaks for CJK/ASCII mixed content. Three transitions
  // where breaking is far less ugly than mid-token hard-cut:
  //   1. ASCII/digit run before CJK: "0.13.85的" prefers break before 的
  //   2. CJK before ASCII/digit: "的0.13.85" prefers break before identifier
  //   3. CJK punctuation: "测试，但是" snaps at the comma, not mid-character
  const CJK_RANGE = '\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff'
  const CJK_ASCII_BOUNDARY_RE = new RegExp(`([\\w.\\-+]+)(?=[${CJK_RANGE}])`, 'g')
  const ASCII_AFTER_CJK_RE = new RegExp(`([${CJK_RANGE}])(?=[A-Za-z0-9])`, 'g')
  const CJK_PUNCT_RE = /([，、；：。！？])(?=\S)/g
  const ZWSP = '\u200B'
  const wrapCell = (text: string, width: number): string[] => {
    if (visibleWidth(text) <= width) return [text]
    const hinted = text
      .replace(SOFT_BREAK_RE, `$1${ZWSP}`)
      .replace(CJK_ASCII_BOUNDARY_RE, `$1${ZWSP}`)
      .replace(ASCII_AFTER_CJK_RE, `$1${ZWSP}`)
      .replace(CJK_PUNCT_RE, `$1${ZWSP}`)
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

/** Render markdown text to ANSI-formatted terminal output.
 *
 * 0.13.90: routes through MarkdownBlockNormalizer so the streaming path can
 * share the same block-boundary recognition. Per-token rendering is in
 * `renderTokens` below; this thin wrapper just feeds the full text. */
// 0.13.95: MD-syntax fast path. If the input contains no markdown structural
// markers, skip the normalizer + renderer entirely — the rendered output is
// just `renderLine(text)` (inline formatting) per line. This is the hot path
// for short prose / tool-output tails / plain assistant replies. We sample
// the first 500 chars only — markdown structure usually appears early
// (headers, fences, list markers). Long plain-text tails do not.
// 0.13.98: also detect `---+` (3+ consecutive ASCII dashes) anywhere — covers
// HR lines, HR-glued-to-prose (`...导入---`), and `---` frontmatter
// terminators. Em dash `—` (U+2014) is a single char and won't match.
const MD_SYNTAX_RE = /[#*`|>~_[\]]|^\s*[-+]\s|^\s*\d+\.\s|^\s{4,}\S|\n\n|\n\s*[-+#*`|>]|\n\s*\d+\.\s|-{3,}/m
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

// 0.13.95: LRU cache for renderMarkdown. Virtual-scroll re-renders the same
// historical message many times; the same input always produces the same
// rendered output. Cache up to ~256 keyed by raw text. Eviction is
// insertion-order (Map iterator) with MRU promotion on hit.
const RENDER_CACHE_MAX = 256
const renderCache = new Map<string, string>()

export function renderMarkdown(text: string): string {
  // Fast path: plain text → join inline-rendered lines, no normalizer/renderer.
  // Bypass when kvLine is present: the fast path skips TokenRenderer.emit's
  // block-boundary logic, so a `model: kimi` line followed by a paragraph
  // would diverge from the streaming path (which inserts a blank between
  // kvLine and paragraph kinds).
  if (text === '') return ''
  if (!hasMarkdownSyntax(text) && !hasKvLine(text)) {
    const lines = text.split('\n')
    return lines.map(l => l === '' ? '' : renderLine(l)).join('\n')
  }
  const cached = renderCache.get(text)
  if (cached !== undefined) {
    // MRU promote — without this, scrolling back evicts the very item the
    // user is looking at (FIFO eviction).
    renderCache.delete(text)
    renderCache.set(text, cached)
    return cached
  }
  const norm = new MarkdownBlockNormalizer()
  const tokens = norm.feedAll(text)
  const out = renderTokens(tokens)
  if (renderCache.size >= RENDER_CACHE_MAX) {
    const first = renderCache.keys().next().value
    if (first !== undefined) renderCache.delete(first)
  }
  renderCache.set(text, out)
  return out
}

/** Block-kind identifier for spacing rules.
 *
 * Each rendered line is tagged with a BlockKind. Adjacent non-blank lines
 * with different block-ids get a blank inserted between them ('block
 * boundary'). Singleton kinds (heading, softHeading, hr) always get a new
 * block-id per occurrence; group kinds (list, kvLine, paragraph, table, code)
 * reuse the current block-id while consecutive same-kind lines flow.
 */
type BlockKind = 'heading' | 'softHeading' | 'hr' | 'list' | 'kvLine' | 'paragraph' | 'table' | 'code' | 'blank'

const SOFT_HEADING_RE = /^\s*\*\*[^*]+\*\*[:：]?\s*$/
const LIST_ITEM_RE = /^\s*(?:[-*+]\s|\d+\.\s)/
const HR_RE = /^\s*(?:---+|\*\*\*+|___+)\s*$/

/** Classify a `text` token's raw content into its block kind. Used to apply
 *  the right spacing rules: list items group, paragraphs group, soft headings
 *  / HRs are singletons. */
function classifyTextKind(rawText: string): 'list' | 'softHeading' | 'hr' | 'kvLine' | 'paragraph' {
  if (HR_RE.test(rawText)) return 'hr'
  if (SOFT_HEADING_RE.test(rawText)) return 'softHeading'
  if (LIST_ITEM_RE.test(rawText)) return 'list'
  if (matchKvLine(rawText)) return 'kvLine'
  return 'paragraph'
}

/** Stateful renderer for a stream of NormalizedLine tokens, with the v1
 *  spacing rules applied at emit-time:
 *
 *  R1 (heading bracket): each # heading is a singleton block, so consecutive
 *     headings get blank between; entering/leaving any heading inserts blank.
 *  R2 (soft heading): a `text` token whose entire content is `**X**` or
 *     `**X**:` is treated as singleton — same bracketing as R1.
 *  R3 (table bracket): the boxed table block is one logical block; entering
 *     and leaving it inserts blank.
 *  R4 (code bracket): the fenced code block (open + lines + close) is one
 *     block; entering and leaving inserts blank.
 *  R5 (list compactness): consecutive list items share one block-id (no
 *     blanks between); list-to-non-list transitions insert blank.
 *  R6 (paragraph/report break): consecutive paragraph or kvLine rows share
 *     one block-id; crossing into a different text kind inserts blank.
 *  R7 (collapse): never emit two consecutive blanks; collapse to one.
 *  R8 (terminal cap): finalize() trims trailing blanks before returning.
 *
 *  Holds across calls (state):
 *   - codeLang: current fenced-code language for syntax highlighting
 *   - pendingTable: held until next non-table token, then flushed as boxed
 *   - prevKind / currentBlockId / blockCounter: drive spacing decisions
 */
export class TokenRenderer {
  private codeLang = ''
  private pendingTable: ParsedTable | null = null
  private prevKind: BlockKind | null = null
  private currentBlockId: string | null = null
  private blockCounter = 0
  // Tracks whether the most recently emitted line — across render() calls —
  // is a blank. The streaming caller (`StreamingMarkdownRenderer.processLine`)
  // hands TokenRenderer a fresh `out` array per line, so the previous
  // `out.length > 0` check inside the blank handler always saw an empty
  // array and dropped standalone-blank tokens. Full-pass batched all tokens
  // into one `out` and didn't hit this. Tracking the state on `this` keeps
  // the two paths in sync. (See fixture 10-inline-code-with-md-chars.)
  private lastEmittedBlank = false

  render(tokens: NormalizedLine[]): string[] {
    const out: string[] = []
    for (const tok of tokens) {
      this.handleToken(tok, out)
    }
    return out
  }

  finalize(): string[] {
    const out: string[] = []
    this.flushTableTo(out)
    // R8: trim trailing blanks.
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out
  }

  reset(): void {
    this.codeLang = ''
    this.pendingTable = null
    this.prevKind = null
    this.currentBlockId = null
    this.blockCounter = 0
    this.lastEmittedBlank = false
  }

  /** Emit a rendered ANSI line tagged with a BlockKind. Inserts a boundary
   *  blank before if block-id changes; collapses consecutive blanks. */
  private emit(out: string[], kind: BlockKind, line: string): void {
    if (kind === 'blank') {
      // R7: never two consecutive blanks. Don't update prevKind so the
      // following non-blank token still sees its true predecessor for
      // boundary detection (model-supplied blank doesn't reset block-id).
      // Use cross-call `lastEmittedBlank` instead of `out.length`/last-elem
      // — streaming hands us a fresh `out` per line.
      if (this.prevKind !== null && !this.lastEmittedBlank) {
        out.push('')
        this.lastEmittedBlank = true
      }
      return
    }

    // Determine block-id for this line.
    const isSingleton = kind === 'heading' || kind === 'softHeading' || kind === 'hr'
    if (isSingleton || this.prevKind !== kind) {
      this.blockCounter += 1
      this.currentBlockId = `${kind}-${this.blockCounter}`
    }

    // Boundary insertion: blank between distinct adjacent block-ids.
    if (this.prevKind !== null) {
      const prevWasSameId = !isSingleton && this.prevKind === kind
      if (!prevWasSameId && !this.lastEmittedBlank) {
        out.push('')
        this.lastEmittedBlank = true
      }
    }

    out.push(line)
    this.prevKind = kind
    this.lastEmittedBlank = false
  }

  private flushTableTo(out: string[]): void {
    if (this.pendingTable) {
      const rendered = renderTable(this.pendingTable)
      this.pendingTable = null
      // renderTable returns multi-line ANSI string; emit each line tagged
      // 'table' so they share a block-id (no blanks between rows).
      for (const tableLine of rendered.split('\n')) {
        this.emit(out, 'table', tableLine)
      }
    }
  }

  private handleToken(tok: NormalizedLine, out: string[]): void {
    // Headings, code blocks, and tables render without going through
    // renderLine, so they must end the current ordered list here — the
    // renderLine-side reset never sees them (1-6 → 7-12 counter leak).
    if (tok.kind === 'heading' || tok.kind === 'code-fence-open' || tok.kind === 'table-header') {
      resetListState()
    }
    switch (tok.kind) {
      case 'code-fence-open': {
        this.flushTableTo(out)
        this.codeLang = tok.lang
        const label = this.codeLang ? ` ${this.codeLang} ` : ''
        this.emit(out, 'code', `${DIM}${'─'.repeat(3)}${label}${'─'.repeat(Math.max(0, 37 - label.length))}${RESET}`)
        break
      }
      case 'code-fence-close': {
        this.flushTableTo(out)
        this.codeLang = ''
        this.emit(out, 'code', `${DIM}${'─'.repeat(40)}${RESET}`)
        break
      }
      case 'code-line': {
        this.flushTableTo(out)
        this.emit(out, 'code', `  ${highlightCode(tok.text, this.codeLang)}`)
        break
      }
      case 'table-header': {
        this.flushTableTo(out)
        this.pendingTable = { headers: tok.cells, alignments: [], rows: [] }
        break
      }
      case 'table-separator': {
        if (this.pendingTable) {
          this.pendingTable.alignments = tok.alignSpec.map((cell): TableAlign => {
            const left = cell.startsWith(':')
            const right = cell.endsWith(':')
            if (left && right) return 'center'
            if (right) return 'right'
            return 'left'
          })
        } else {
          // Stray separator with no header — render as plain prose line.
          this.emit(out, 'paragraph', renderLine('|' + tok.alignSpec.join('|') + '|'))
        }
        break
      }
      case 'table-row': {
        if (this.pendingTable) {
          this.pendingTable.rows.push(tok.cells)
        } else {
          // Stray row with no header — render as plain prose line.
          this.emit(out, 'paragraph', renderLine('|' + tok.cells.join('|') + '|'))
        }
        break
      }
      case 'heading': {
        this.flushTableTo(out)
        const inlineText = renderInline(tok.text)
        this.emit(out, 'heading', tok.level <= 2
          ? `${BOLD}${headerColor()}${inlineText}${RESET}`
          : `${BOLD}${inlineText}${RESET}`)
        break
      }
      case 'blank': {
        this.flushTableTo(out)
        this.emit(out, 'blank', '')
        break
      }
      case 'text': {
        this.flushTableTo(out)
        const textKind = classifyTextKind(tok.text)
        this.emit(out, textKind, renderLine(tok.text))
        break
      }
    }
  }
}

/** One-shot token rendering — for full-pass renderMarkdown. */
export function renderTokens(tokens: NormalizedLine[]): string {
  const r = new TokenRenderer()
  const lines = r.render(tokens)
  lines.push(...r.finalize())
  return lines.join('\n')
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

const OL_ITEM_RE = /^(\s*)(\d+)\.\s+(.+)$/

/** Render a single non-code-block line. */
function renderLine(line: string): string {
  // Any non-blank, non-OL line ends the current ordered list — headings,
  // rules, UL items, prose. Doing this up front (instead of on the prose
  // fall-through only) is what keeps early-return branches like `## …`
  // from leaking the counter into the next list (1-6 → 7-12 bug).
  if (line.trim() !== '' && !OL_ITEM_RE.test(line)) {
    olStack = []
  }
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
  const olMatch = line.match(OL_ITEM_RE)
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
      // CommonMark: the first item's number sets the list start.
      olStack.push({ depth, count: num })
    } else {
      olStack[olStack.length - 1]!.count++
    }
    const displayNum = formatListNumber(olStack[olStack.length - 1]!.count, depth)
    return `${indent}${listColor()}${displayNum}.${RESET} ${content}`
  }

  // Blockquote
  if (line.startsWith('> ')) {
    return `${DIM}│${RESET} ${ITALIC}${renderInline(line.slice(2))}${RESET}`
  }

  const renderedKv = renderKvLine(line)
  if (renderedKv !== null) return renderedKv

  return renderInline(line)
}

/** Render inline markdown: bold, italic, code, links. */
export function renderInline(text: string): string {
  let result = text
  const codeSpans: string[] = []

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
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSpans.length
    codeSpans.push(`${themeColor('inlineCode')}${code}${RESET}`)
    return `\x00OC_CODE_${idx}\x00`
  })

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
  // Italic — underscore form is INTENTIONALLY DISABLED for OwlCoda 0.13.98+.
  //
  // Background: CommonMark says `_word_` is italic. Earlier OwlCoda
  // versions tried to honor that with various flanking-boundary tricks
  // (still visible in the bold __x__ regex above). The fundamental
  // problem: `_` is the dominant identifier character in code-heavy and
  // architecture-diagram prose — `_admission_*`, `runtime_governance`,
  // `_controls`, `cache_pre_gate`, etc. ALL had `_word_`-shaped fragments
  // that matched the italic pattern even with strict flanking checks
  // (a trailing `*` or punctuation satisfies the boundary regex).
  //
  // Real-world content where the italic-disable matters:
  //   - architecture diagrams listing identifier names
  //   - shell exports / env variable references
  //   - snake_case API symbols cited in prose without backticks
  //
  // Real-world content where the italic-disable hurts:
  //   - prose using `_emphasis_` for emphasis. Users who want emphasis
  //     can use `*emphasis*` (asterisk form, still italic) or
  //     `**bold**`. Underscore italic is not load-bearing for any
  //     known OwlCoda workflow.
  //
  // Net trade: keep code identifiers verbatim, lose CommonMark `_x_`
  // italic compatibility. Same trade we already made for `__x__` bold
  // (disabled because of double-underscore identifiers).
  // result = result.replace(... underscore italic ...)  // intentionally absent

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${RESET} ${DIM}($2)${RESET}`)

  // Status tokens: compact test/report summaries in assistant output.
  result = result.replace(STATUS_BRACKET_RE, (_match, label: string) => renderStatusBadge(label))
  // Match a contiguous `LABEL:N(LABEL:N)*` chain, then color each label
  // within the chain. Whole-chain matching keeps the "structured metric
  // run" boundary aligned with the chain-end lookahead.
  result = result.replace(STATUS_CHAIN_RE, (chain: string) =>
    chain.replace(
      STATUS_METRIC_INNER_RE,
      (_m: string, label: string, count: string) => renderStatusMetric(label, count),
    ),
  )

  return result.replace(/\x00OC_CODE_(\d+)\x00/g, (_match, idx: string) => codeSpans[Number(idx)] ?? '')
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
  // 0.13.90: routes through MarkdownBlockNormalizer + TokenRenderer so the
  // streaming path produces structurally identical output to the full-pass
  // renderMarkdown() for the same input. The normalizer holds at most one
  // pending line (next-line lookahead for |cells|+separator detection); the
  // renderer holds at most one pending table token chain. tryStructuralBreak
  // and the CJK word-wrap remain — they handle in-flight buffer state that
  // the normalizer cannot (it's line-level).
  private buffer = ''
  private normalizer = new MarkdownBlockNormalizer()
  private renderer = new TokenRenderer()

  /**
   * Feed a text chunk. Returns rendered output for any complete lines.
   * If the buffer grows large without a newline, flushes partial content
   * to avoid the "wall of text with no line breaks" problem.
   *
   * Loops through ALL structural break patterns so that even if a single
   * chunk contains multiple list items, every item gets its own line.
   */
  push(chunk: string): string {
    debugDumpRaw('push', chunk)
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
    if (!this.normalizer.isInCodeFence()) {
      while (this.buffer.length > 8) {
        const broke = this.tryStructuralBreak()
        if (!broke) break
        results.push(broke)
      }
    }

    // Phase 3: CJK / Latin word-wrap for remaining long buffer
    //
    // Skip when the buffer looks like a table line (starts with '|' and has
    // 2+ pipes). The line-aware normalizer + renderer handle table content
    // when the closing '\n' arrives; mid-buffer wrap would slice through
    // a |cells|cells| row and render the partial as plain text, leaving
    // a stray '| col | col | col …' fragment above the eventual boxed table.
    const trimmedForWrap = this.buffer.trimStart()
    const looksLikeTableLine = trimmedForWrap.startsWith('|') &&
      (trimmedForWrap.match(/\|/g) ?? []).length >= 2
    if (!this.normalizer.isInCodeFence() && !looksLikeTableLine) {
      const hasCJK = /[\u4e00-\u9fff]/.test(this.buffer)
      // 0.13.100: raised from 60/120 \u2192 400/800. The lower thresholds caused
      // stream-token path-equivalence to break on any CJK paragraph longer
      // than ~60 chars: full-pass kept the line as one paragraph, but
      // streaming chunked it mid-sentence and emitted separate render lines.
      // Same with long Latin prose at 120. New thresholds are deliberately
      // generous \u2014 terminal-side soft wrap already handles visual line
      // breaks; this guard exists only as a "never let buffer grow
      // unbounded if model emits one massive line without \n" safety net.
      // See fixture 07/10 path-equivalence regression in 0.13.95-era.
      const WRAP_THRESHOLD = hasCJK ? 400 : 800

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

    // Skip when inside a fenced code block — code content must not be split
    // by structural-break heuristics (would corrupt code).
    if (this.normalizer.isInCodeFence()) return null

    // Skip when the partial buffer looks like a Markdown structural element
    // that the line-based processLine path will own once a `\n` arrives.
    // Without this guard, Phase 2's hrule pattern (p6: `(.{3,}?)(---+|...)`)
    // greedily matches the dashes inside a table separator like
    // `|------|------|`, emits `|--` as a partial line, and the eventual
    // table render is preceded by a stray `|--` ── divider artifact.
    // Same risk for partial headers (`## title`-in-progress).
    const trimmed = buf.trimStart()
    if (trimmed.startsWith('|')) return null
    if (/^#{1,6}(?:\s|[\d一-鿿])/.test(trimmed)) return null

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

    // 0.13.100: Pattern 4 (`[^\d]\d+\.\s` — break before any numbered list
    // marker after any non-digit char) was DISABLED. It fired on inline
    // text like `归入子包 2. 合约` (model emits 3 list items on one line)
    // and split mid-buffer, then renderTokens **renumbered** the resulting
    // items from 1 again (ordered list contract). Full-pass kept the
    // same input as one paragraph, breaking path-equivalence (fixture 11).
    //
    // Pattern 1 (sentence-ender + list marker) still handles the legitimate
    // case `...完成。1. 第一步`. Disabling p4 only removes the over-eager
    // split when there's no sentence-ender to lean on.
    const p4: RegExpMatchArray | null = null

    // Pattern 5: Break before bold markers (**text**) after sentence ender
    // (not whitespace). Whitespace alone false-positives on '- **bold** content'
    // where the space after the list marker would qualify.
    const p5 = buf.match(
      /(.{8,}?[.!?。！？：:])(\*\*[^*])/,
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
    // p4 disabled at definition (see above). Block kept as no-op to
    // preserve the hit-collection layout in case p4 needs to come back
    // in a more conservative form (e.g. requires sentence-ender prefix).
    void p4
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

  /** Flush remaining buffer (call at end of response).
   *
   * Drain order:
   *   1. Split any leftover in-flight buffer on no-newline structural
   *      patterns (concatenated list items, mid-line headings, etc.) and
   *      feed each segment through the normalizer + renderer.
   *   2. Drain the normalizer's pending line (if any) — emits as plain
   *      heading-or-text since there's no next line to lookahead at.
   *   3. Drain the renderer's pending table (if any).
   */
  flush(): string {
    debugDumpRaw('flush', '')
    const parts: string[] = []

    if (this.buffer) {
      // Split buffer on structural patterns before rendering. Models often
      // concatenate list items without newlines:
      //   1. sentence enders + optional space before list/header markers
      //   2. CJK text directly before list markers
      //   3. non-digit character before numbered list (e.g. "概念3. 搜索")
      //   4. before emoji + space sequences (common as list bullet alternatives)
      //   5. before bold markers (**text**) after whitespace or sentence enders
      //   6. before horizontal rules (--- or ***) concatenated with text
      //   7. after closing paren/bracket before CJK or uppercase
      const segments = this.buffer.split(
        /(?<=[.!?。！？：:])(?:\s*)(?=[-*]\s|#{1,3}\s|\d+\.\s)|(?<=[\u4e00-\u9fff])(?=[-*]\s|\d+\.\s)|(?<=[^\d])(?=\d+\.\s)|(?<=\S[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?\s)(?=\S)|(?<=[.!?。！？：:])(?:\s*)(?=\*\*[^*])|(?=---+|___+|\*\*\*+)(?<=\S)|(?<=[)）\]】》」])(?=[A-Z\u4e00-\u9fff])/u,
      )
      for (const seg of segments) {
        const trimmed = seg.trim()
        if (trimmed === '') continue
        const tokens = this.normalizer.feedLine(seg)
        parts.push(...this.renderer.render(tokens))
      }
      this.buffer = ''
    }

    // Drain normalizer's held pending (if any) — emits as plain text/heading.
    const finalNormTokens = this.normalizer.finalize()
    parts.push(...this.renderer.render(finalNormTokens))

    // Drain renderer's pending table (if any).
    parts.push(...this.renderer.finalize())

    if (parts.length === 0) return ''
    return parts.join('\n') + '\n'
  }

  /** Reset state for a new response. */
  reset(): void {
    this.buffer = ''
    this.normalizer.reset()
    this.renderer.reset()
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

  /** Process a single complete line through the normalizer + renderer.
   *  Returns null when the line is held (no output yet — pending lookahead
   *  in the normalizer or pendingTable accumulation in the renderer).
   *  Returns rendered text otherwise (may span multiple lines if the
   *  normalizer/renderer flushes a held block on this token). */
  private processLine(line: string): string | null {
    const tokens = this.normalizer.feedLine(line)
    const lines = this.renderer.render(tokens)
    if (lines.length === 0) return null
    return lines.join('\n')
  }

}
