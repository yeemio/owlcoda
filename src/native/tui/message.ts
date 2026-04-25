/**
 * OwlCoda TUI Message Display
 *
 * Formats conversation messages and tool use blocks for terminal display.
 * Each message type has its own visual treatment.
 *
 * Visual notes:
 * - ⏺ (U+23FA) blinking indicator for tool in-progress
 * - ⎿ (U+23BF) tree bracket for nested tool output
 * - Dashed borders for file diffs
 * - Truncated command display (2 lines / 160 chars max)
 */

import { sgr, themeColor, themed, dim, bold, colorize } from './colors.js'
import { renderBox } from './box.js'
import { truncate, padRight } from './text.js'
import { visibleWidth, stripAnsi } from './colors.js'
import { renderUserBlock } from './user-block.js'
import { renderToolRow } from './tool-row.js'
import { renderBanner } from './banner.js'

// ─── Constants (native terminal visual characters) ──────────

/** Tool in-progress indicator for tool activity. */
const PROGRESS_DOT = process.platform === 'darwin' ? '⏺' : '●'
/** Tree bracket for nested tool output. */
const TREE_BRACKET = '⎿'
/** Prefix for nested output lines: "  ⎿  " */
const TREE_PREFIX = `  ${TREE_BRACKET}  `

// ─── Tool use display ─────────────────────────────────────────

/** Icons for each tool type. */
const TOOL_ICONS: Record<string, string> = {
  bash:            '🔧',
  read:            '📄',
  write:           '✏️',
  edit:            '🔧',
  glob:            '🔍',
  grep:            '🔎',
  WebFetch:        '🌐',
  WebSearch:       '🔎',
  TodoWrite:       '📋',
  AskUserQuestion: '❓',
  Sleep:           '💤',
  Agent:           '🤖',
  // Plan tools
  EnterPlanMode:   '📝',
  ExitPlanMode:    '✅',
  // MCP
  MCPTool:         '🔌',
  // Task
  TaskCreate:      '⚡',
  TaskGet:         '📊',
  TaskList:        '📊',
  TaskStop:        '⏹',
}

/**
 * Format a tool invocation header for terminal display.
 *
 * ```
 * ⏺ bash  echo "hello world"
 * ```
 */
/**
 * Maximum display lines for tool output by category.
 * Bash search/read results get collapsed, file writes show max 10 lines.
 */
const MAX_TOOL_OUTPUT_LINES: Record<string, number> = {
  bash: 15,
  read: 10,
  write: 10,
  edit: 10,
  glob: 20,
  grep: 20,
}

/** Maximum characters for command display (2 lines / 160 chars). */
const MAX_COMMAND_DISPLAY_CHARS = 160
const MAX_COMMAND_DISPLAY_LINES = 2

/**
 * Map internal tool names to user-facing display names.
 * bash→Bash, read→Read, write→Write, edit→Update, glob→Search, grep→Search.
 */
const USER_FACING_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Update',
  glob: 'Search',
  grep: 'Search',
}

export function userFacingToolName(name: string): string {
  return USER_FACING_TOOL_NAMES[name] ?? name
}

export function formatToolUseHeader(name: string, input: Record<string, unknown>): string {
  const displayName = userFacingToolName(name)
  const summary = summarizeToolInput(name, input)
  // Truncate command display to keep it readable (2 lines / 160 chars)
  const truncatedSummary = truncateCommandDisplay(summary)
  // Fullscreen-first tool row: one clean row under whatever preceded it.
  // Keep the historical `(summary)` shape so existing transcript tests and
  // scrollback expectations stay stable while the visual chrome changes.
  return renderToolRow({
    verb: displayName,
    arg: `(${truncatedSummary})`,
    state: 'run',
    columns: process.stdout.columns ?? 80,
  })
}

/** Truncate command/summary to 2 lines, 160 chars. */
function truncateCommandDisplay(text: string): string {
  const lines = text.split('\n')
  let result: string
  if (lines.length > MAX_COMMAND_DISPLAY_LINES) {
    result = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n') + '…'
  } else {
    result = text
  }
  if (result.length > MAX_COMMAND_DISPLAY_CHARS) {
    result = result.slice(0, MAX_COMMAND_DISPLAY_CHARS - 1) + '…'
  }
  return result
}

/**
 * Format a tool in-progress message ("Running…" style).
 *
 * ```
 *   ⎿  Running…
 * ```
 */
export function formatToolProgress(message = 'Running…'): string {
  return `${dim(TREE_PREFIX)}${dim(message)}`
}

// ─── JSON formatting for tool output ──────────────────────────

/** Maximum output size (chars) before skipping JSON formatting. */
const JSON_FORMAT_MAX_CHARS = 10_000

/**
 * Try to pretty-print JSON content in tool output.
 * Keeps one-line JSON readable in the native terminal UI:
 * - Each line is independently checked for valid JSON
 * - Valid JSON is re-formatted with 2-space indentation
 * - Skipped if formatted output exceeds JSON_FORMAT_MAX_CHARS
 * - Precision loss detection for large numbers
 */
export function tryJsonFormatOutput(output: string): string {
  if (!output || output.length > JSON_FORMAT_MAX_CHARS) return output
  // Quick check: does it look like JSON at all?
  const trimmed = output.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) {
    return output
  }
  try {
    const parsed = JSON.parse(trimmed)
    const formatted = JSON.stringify(parsed, null, 2)
    // Skip if formatted output is too large
    if (formatted.length > JSON_FORMAT_MAX_CHARS) return output
    // Precision loss check: if any number > 2^53 exists, don't format
    if (/\d{16,}/.test(trimmed)) {
      const origNums = trimmed.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g) ?? []
      const fmtNums = formatted.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g) ?? []
      if (origNums.length !== fmtNums.length || origNums.some((n, i) => n !== fmtNums[i])) {
        return output
      }
    }
    return formatted
  } catch {
    return output
  }
}

/**
 * Format a tool result with tree bracket nesting.
 *
 * Success:
 * ```
 *   ⎿  ✓ bash  (1.2s)
 * ```
 *
 * Error:
 * ```
 *   ⎿  ✗ bash  (50ms)
 *        Error: not found
 * ```
 */
export function formatToolResult(
  name: string,
  output: string,
  isError: boolean,
  durationMs: number,
): string {
  if (name === 'TodoWrite' && !isError) {
    return formatTodoWriteResult(output, durationMs)
  }

  const icon = isError
    ? `${themeColor('error')}✗`
    : `${themeColor('success')}✓`
  const dur = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`

  const lines: string[] = []
  // Tree bracket prefix for the result header
  const displayName = userFacingToolName(name)
  lines.push(`${dim(TREE_PREFIX)}${icon} ${displayName}${sgr.reset} ${dim(`(${dur})`)}`)

  // Show output (truncated) with indentation matching tree bracket
  const indent = '     ' // 5 chars to align under tree bracket content
  if (output && output.trim().length > 0) {
    // Extract and show special warnings before main output
    const { cleanOutput, warnings } = extractOutputWarnings(name, output)
    for (const warning of warnings) {
      lines.push(`${indent}${themeColor('warning')}⚠ ${warning}${sgr.reset}`)
    }

    // Try JSON pretty-printing for bash tool output.
    const formattedOutput = (name === 'bash') ? tryJsonFormatOutput(cleanOutput) : cleanOutput

    const outputLines = formattedOutput.split('\n')
    // Per-tool max lines (error gets more) to keep output readable.
    const maxLines = isError ? 30 : (MAX_TOOL_OUTPUT_LINES[name] ?? 15)
    const display = outputLines.length > maxLines
      ? [...outputLines.slice(0, maxLines), `… (+${outputLines.length - maxLines} lines)`]
      : outputLines

    for (const line of display) {
      const color = isError ? themeColor('error') : ''
      const reset = isError ? sgr.reset : ''
      // Expand literal tabs — Ink / terminal tab-stop handling inside a
      // nested indent-box is unreliable (Read tool's `N\tcontent` format
      // was rendering as "1te#..." on the user's mac terminal where the
      // tab stop fell inside adjacent text). 4-space expansion keeps
      // column alignment without depending on the host terminal's stops.
      const expanded = line.replace(/\t/g, '    ')
      lines.push(`${indent}${color}${dim(truncate(expanded, 120))}${reset}`)
    }
  } else if (!isError) {
    // Empty output shows "(No output)" dimmed
    lines.push(`${indent}${dim('(No output)')}`)
  }

  return lines.join('\n')
}

/**
 * Todo block — terminal port of the design's `oc-todo` card.
 *
 *   ┌─────────────────────────────────────────┐  hair-faint border, bgCard
 *   │ TODO                          3/6 done  │  small caps head + count right
 *   │                                         │
 *   │ ✓ task one                              │  done: success ✓, mute body, strike
 *   │ ✓ task two                              │
 *   │ ▸ task three                            │  current: accent ▸, ink-hi body
 *   │ ⊘ task four (blocked)                   │  blocked: warn ⊘, dim body
 *   │ □ task five                             │  pending: dim □, dim body
 *   │ □ task six                              │
 *   └─────────────────────────────────────────┘
 *
 * The upstream TodoWrite tool emits a plain-text body where each line
 * begins with one of:
 *   ✓   completed   → done
 *   ▶   in_progress → current
 *   ○   pending     → todo
 * and may append `[completed|in_progress|pending|blocked]`. We re-parse
 * those signals into the design's four states so the card carries the
 * full status axis instead of three slightly-different glyphs.
 */
type TodoState = 'done' | 'current' | 'blocked' | 'pending'

interface TodoEntry {
  state: TodoState
  text: string
}

const STRIKE_ON = '\x1b[9m'
const STRIKE_OFF = '\x1b[29m'

function parseTodoLine(line: string): TodoEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Detect explicit `[state]` suffix first — it's the most reliable signal
  // and survives glyph swaps in upstream changes.
  const tagMatch = trimmed.match(/\[(completed|in_progress|pending|blocked)\]\s*$/)
  let state: TodoState | null = null
  let body = trimmed
  if (tagMatch) {
    body = trimmed.slice(0, -tagMatch[0].length).trim()
    switch (tagMatch[1]) {
      case 'completed':   state = 'done';    break
      case 'in_progress': state = 'current'; break
      case 'pending':     state = 'pending'; break
      case 'blocked':     state = 'blocked'; break
    }
  }

  // Strip the leading glyph and reuse it as a fallback signal.
  const glyphMatch = body.match(/^([✓▶▸○⊘□])\s+/)
  if (glyphMatch) {
    body = body.slice(glyphMatch[0].length)
    if (state === null) {
      switch (glyphMatch[1]) {
        case '✓': state = 'done'; break
        case '▶':
        case '▸': state = 'current'; break
        case '⊘': state = 'blocked'; break
        case '○':
        case '□':
        default:  state = 'pending'; break
      }
    }
  }

  if (state === null) return null
  return { state, text: body }
}

function renderTodoEntry(entry: TodoEntry, contentWidth: number): string {
  switch (entry.state) {
    case 'done': {
      const glyph = `${themeColor('success')}✓${sgr.reset}`
      const text = `${themeColor('textMute')}${STRIKE_ON}${truncate(entry.text, contentWidth - 2)}${STRIKE_OFF}${sgr.reset}`
      return `${glyph} ${text}`
    }
    case 'current': {
      const glyph = `${themeColor('owl')}${sgr.bold}▸${sgr.reset}`
      const text = `${themeColor('textHi')}${sgr.bold}${truncate(entry.text, contentWidth - 2)}${sgr.reset}`
      return `${glyph} ${text}`
    }
    case 'blocked': {
      const glyph = `${themeColor('warning')}⊘${sgr.reset}`
      const text = `${themeColor('textDim')}${truncate(entry.text, contentWidth - 2)}${sgr.reset}`
      return `${glyph} ${text}`
    }
    case 'pending': {
      const glyph = `${themeColor('textDim')}□${sgr.reset}`
      const text = `${themeColor('textDim')}${truncate(entry.text, contentWidth - 2)}${sgr.reset}`
      return `${glyph} ${text}`
    }
  }
}

function formatTodoWriteResult(output: string, durationMs: number): string {
  const dur = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`

  // Parse and partition entries by state.
  const entries = output
    .split('\n')
    .map(parseTodoLine)
    .filter((e): e is TodoEntry => e !== null)

  // No structured entries — fall back to a single tree-prefixed status row
  // so we don't render an empty bordered card.
  if (entries.length === 0) {
    return `${dim(TREE_PREFIX)}${themeColor('success')}✓ Plan updated${sgr.reset} ${dim(`(${dur})`)}`
  }

  const doneCount    = entries.filter((e) => e.state === 'done').length
  const totalCount   = entries.length
  const currentCount = entries.filter((e) => e.state === 'current').length

  // Card widths — body matches the rest of the tool-result indent (5).
  const cols = Math.max(40, process.stdout.columns ?? 80)
  const cardWidth   = Math.min(cols - 6, 80)
  const contentWidth = cardWidth - 6  // padding (2) + glyph (1) + space (1) + safety (2)
  const headerCount = currentCount > 0
    ? `${doneCount}/${totalCount} done · 1 active`
    : `${doneCount}/${totalCount} done`
  const header = `${themeColor('textDim')}TODO${sgr.reset}`
    + `${' '.repeat(Math.max(2, contentWidth - 4 - visibleWidth(headerCount)))}`
    + `${themeColor('textMute')}${headerCount}${sgr.reset}`

  // Cap to 12 entries — fits a dense plan card without hijacking the pane.
  const SHOW_MAX = 12
  const shown = entries.slice(0, SHOW_MAX)
  const omitted = entries.length - shown.length

  const bodyLines: string[] = [header, '']
  for (const entry of shown) {
    bodyLines.push(renderTodoEntry(entry, contentWidth))
  }
  if (omitted > 0) {
    bodyLines.push(`${themeColor('textMute')}… ${omitted} more${sgr.reset}`)
  }

  // Indent the bordered card under the tree prefix so it lines up with
  // every other tool result. The renderBox border uses hair-faint to keep
  // the card quiet — it's structure, not decoration.
  const card = renderBox(bodyLines, {
    border: 'round',
    width: cardWidth,
    borderColor: themeColor('hairFaint'),
    paddingX: 1,
    paddingY: 0,
  })
  const indent = '   '
  const indented = card.split('\n').map((row) => `${indent}${row}`).join('\n')

  // One status header above the card so the result still reads as a
  // tool call (matches how every other tool-result begins).
  const headerLine = `${dim(TREE_PREFIX)}${themeColor('success')}✓ Plan updated${sgr.reset} ${dim(`(${dur})`)}`
  return `${headerLine}\n${indented}`
}

// ─── Change block tool result ────────────────────────────────

export type ChangeAction = 'update' | 'create' | 'overwrite'

export interface ChangeBlockResultOptions {
  toolName: string
  action: ChangeAction
  path: string
  added: number
  removed: number
  durationMs: number
  /** Pre-rendered change-block body lines (indented, selection-safe). */
  bodyLines: string[]
  isError?: boolean
}

function formatChangeActionLabel(action: ChangeAction): string {
  switch (action) {
    case 'create':    return 'Create'
    case 'overwrite': return 'Rewrite'
    case 'update':    return 'Update'
  }
}

/** Collapse long absolute paths to the last two segments so headers stay readable in narrow panes. */
function displayPath(path: string, budget: number): string {
  if (path.length <= budget) return path
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return truncate(path, budget)
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * Format a tool result whose evidence is a change block.
 *
 * Emits:
 * ```
 *   ⎿  ✓ Update src/foo.ts · +2 -1  (1.2s)
 *       42    context line
 *       43  - old line
 *       43  + new line
 *       44    context line
 * ```
 *
 * The path is shown in the header so the user sees *what* changed before
 * scanning the hunk; the `+N -M` summary doubles as a headline. Selection-
 * first: no borders, no background bands in the header — a drag-select
 * pulls raw diff lines, not decoration.
 */
export function formatChangeBlockResult(opts: ChangeBlockResultOptions): string {
  const dur = opts.durationMs < 1000
    ? `${opts.durationMs}ms`
    : `${(opts.durationMs / 1000).toFixed(1)}s`
  const icon = opts.isError
    ? `${themeColor('error')}✗`
    : `${themeColor('success')}✓`
  const actionLabel = formatChangeActionLabel(opts.action)

  const cols = process.stdout?.columns ?? 80
  const pathBudget = Math.max(12, cols - 28)
  const shownPath = displayPath(opts.path, pathBudget)

  const statParts: string[] = []
  if (opts.added > 0)   statParts.push(`${themeColor('diffAdded')}+${opts.added}${sgr.reset}`)
  if (opts.removed > 0) statParts.push(`${themeColor('diffRemoved')}-${opts.removed}${sgr.reset}`)
  const stats = statParts.length > 0 ? ` ${dim('·')} ${statParts.join(' ')}` : ''

  const header = `${dim(TREE_PREFIX)}${icon} ${actionLabel} ${shownPath}${sgr.reset}${stats} ${dim(`(${dur})`)}`
  return [header, ...opts.bodyLines].join('\n')
}

/**
 * Extract special warnings from tool output (cwd change, image data, etc).
 * Returns cleaned output and any extracted warnings.
 */
function extractOutputWarnings(name: string, output: string): { cleanOutput: string; warnings: string[] } {
  const warnings: string[] = []
  let cleanOutput = output

  // Detect "Shell cwd was reset" pattern (bash tool)
  if (name === 'Bash' || name === 'bash') {
    const cwdMatch = cleanOutput.match(/Shell cwd was reset to (.+)/)
    if (cwdMatch) {
      warnings.push(`Working directory changed to ${cwdMatch[1]}`)
      cleanOutput = cleanOutput.replace(/Shell cwd was reset to .+\n?/, '')
    }
  }

  // Detect image/binary data in output
  if (/\bdata:image\/\w+;base64,/.test(cleanOutput) || /\[Image data detected\]/.test(cleanOutput)) {
    warnings.push('Image data detected (not shown)')
    cleanOutput = cleanOutput.replace(/data:image\/\w+;base64,[A-Za-z0-9+/=]+/g, '[image data]')
  }

  return { cleanOutput: cleanOutput.trim(), warnings }
}

/**
 * Format a tool result for transcript display.
 *
 * Previous version wrapped every output line with `│ … │` via renderBox
 * — when a tool errored and produced 15-30 lines of diagnostic output,
 * every row drew a bright red `│` on both sides, producing a "wall of
 * red verticals" that dominated the transcript and made the real error
 * message hard to pick out.
 *
 * New layout, git-log-ish:
 *
 *   ╴╴╴ ✗ Bash (11.2s) ╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴
 *     ▎ cat: /var/folders/…/tmp.xxx/smoke_reporting.log
 *     ▎ No such file or directory
 *     ▎ …
 *
 * Header: single horizontal rule prefixed with the status icon + tool
 * name + duration, colored by outcome (success green / error red).
 * Body: each output line indented and tagged with a single thin left
 * rail `▎` — one vertical glyph per row, dimmed for success and
 * colored for error. No right border, no bottom border. Quieter in
 * scrollback, still easy to visually bracket.
 */
export function formatToolResultBox(
  name: string,
  output: string,
  isError: boolean,
  durationMs: number,
): string {
  const dur = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`

  const icon = isError ? '✗' : '✓'
  const accent = isError ? themeColor('error') : themeColor('success')
  const displayName = userFacingToolName(name)

  const outputLines = output.split('\n').slice(0, 30)
  const truncated = output.split('\n').length > 30

  const cols = Math.max(40, process.stdout.columns ?? 80)
  // Leave room for the assistant-prefix indent that ink-repl.tsx adds
  // around every transcript item (`⎿ ` + 2-space indent = 4 cols).
  const ruleWidth = Math.max(20, cols - 10)
  const title = ` ${icon} ${displayName} (${dur}) `
  const titleVisWidth = visibleWidth(title)
  const remainingRule = Math.max(3, ruleWidth - titleVisWidth - 3)

  const header = `${accent}╴╴╴${title}${'╴'.repeat(remainingRule)}${sgr.reset}`

  const rail = isError ? `${accent}▎${sgr.reset}` : `${themeColor('textDim')}▎${sgr.reset}`
  const body = outputLines.map((line) => `  ${rail} ${line}`)
  if (truncated) body.push(`  ${rail} ${dim('… (truncated)')}`)

  return [header, ...body].join('\n')
}

// ─── Tool Result Collapsing ───────────────────────────────────

/**
 * Collapsible tool categories — these tools get auto-grouped when
 * they occur in sequence to keep repeated read/search output compact.
 */
const COLLAPSIBLE_TOOLS = new Set(['read', 'glob', 'grep', 'WebSearch', 'WebFetch'])

interface CollapsedToolEntry {
  name: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  durationMs: number
}

/**
 * Groups consecutive collapsible tool results into a collapsed summary.
 *
 * Repeated read/search/list tool uses collapse
 * into "Read N files, searched M patterns" with Ctrl+O to expand.
 * Our version: collapsed summary line, /verbose to expand.
 */
export class ToolResultCollector {
  private buffer: CollapsedToolEntry[] = []
  private _verbose = false

  get verbose(): boolean { return this._verbose }
  set verbose(v: boolean) { this._verbose = v }

  /** Check if a tool name is collapsible. */
  isCollapsible(name: string): boolean { return COLLAPSIBLE_TOOLS.has(name) }

  /** Add a tool result to the current group. Returns null if buffered, or flush text if non-collapsible. */
  add(entry: CollapsedToolEntry): string | null {
    if (this.isCollapsible(entry.name)) {
      this.buffer.push(entry)
      return null // buffered
    }
    // Non-collapsible tool — flush any buffered group first, then return its own result
    return null
  }

  /** Flush any buffered group into display text and reset. */
  flush(): string {
    if (this.buffer.length === 0) return ''
    const entries = [...this.buffer]
    this.buffer = []

    if (this._verbose || entries.length === 1) {
      // Verbose mode — show each result individually
      return entries.map(e => formatToolResult(e.name, e.output, e.isError, e.durationMs)).join('\n')
    }

    // Collapsed summary
    return renderCollapsedGroup(entries)
  }

  /** Number of buffered entries. */
  get pending(): number { return this.buffer.length }

  /** Drop any buffered entries without rendering them. */
  clear(): void {
    this.buffer = []
  }
}

/** Render a collapsed group of tool results as a summary line. */
function renderCollapsedGroup(entries: CollapsedToolEntry[]): string {
  const counts: Record<string, number> = {}
  let totalMs = 0
  let hasError = false

  for (const e of entries) {
    counts[e.name] = (counts[e.name] ?? 0) + 1
    totalMs += e.durationMs
    if (e.isError) hasError = true
  }

  // Build summary: "Read 3 files, searched 2 patterns"
  const parts: string[] = []
  for (const [tool, count] of Object.entries(counts)) {
    switch (tool) {
      case 'read':
        parts.push(`read ${count} file${count > 1 ? 's' : ''}`)
        break
      case 'glob':
        parts.push(`listed ${count} pattern${count > 1 ? 's' : ''}`)
        break
      case 'grep':
        parts.push(`searched ${count} pattern${count > 1 ? 's' : ''}`)
        break
      case 'WebFetch':
        parts.push(`fetched ${count} URL${count > 1 ? 's' : ''}`)
        break
      case 'WebSearch':
        parts.push(`searched ${count} quer${count > 1 ? 'ies' : 'y'}`)
        break
      default:
        parts.push(`${tool} ×${count}`)
    }
  }

  const icon = hasError
    ? `${themeColor('error')}✗`
    : `${themeColor('success')}✓`
  const dur = totalMs < 1000
    ? `${totalMs}ms`
    : `${(totalMs / 1000).toFixed(1)}s`

  const summary = parts.join(', ')
  return `${dim(TREE_PREFIX)}${icon} ${summary}${sgr.reset} ${dim(`(${dur})`)}`
}

// ─── Message formatting ───────────────────────────────────────

/**
 * Format the REPL prompt character.
 * ❯ (U+276F) — bright when ready, dimmed when loading.
 */
export function formatPrompt(opts: { dimmed?: boolean; mode?: 'normal' | 'bash' } = {}): string {
  const { dimmed = false, mode = 'normal' } = opts
  const char = mode === 'bash' ? '!' : '│'
  const color = mode === 'bash' ? themeColor('bashBorder') : themeColor('owl')
  if (dimmed) return `${sgr.dim}${color}${char}${sgr.reset} `
  return `${color}${char}${sgr.reset} `
}

export interface PromptDockFrameOptions {
  dimmed?: boolean
  mode?: 'normal' | 'bash'
  multiline?: boolean
  multilineRows?: number
}

export interface PromptDockFrame {
  width: number
  contentWidth: number
  height: number
  bodyRows: number
  top: string
  promptLine: string
  fillerLines: string[]
  bottom: string
  cursorColumn: number
  leftBorder: string
  rightBorder: string
  multiline: boolean
}

/**
 * Render a compact dock header above the readline prompt.
 * This keeps the input surface visually explicit without replacing readline.
 */
export function formatPromptDock(opts: { dimmed?: boolean; mode?: 'normal' | 'bash' } = {}): string {
  const { dimmed = false, mode = 'normal' } = opts
  const cols = process.stdout.columns ?? 80
  const accent = mode === 'bash' ? themeColor('bashBorder') : themeColor('owl')
  const title = mode === 'bash' ? 'Shell' : 'Message'
  const hint = mode === 'bash'
    ? 'Run a command'
    : '/ commands · Shift+Enter multi-line'
  const maxWidth = Math.max(36, cols - 2)
  const plain = truncate(`${title} · ${hint}`, maxWidth - 6)
  const content = plain === title
    ? `${sgr.bold}${title}${sgr.reset}`
    : `${sgr.bold}${title}${sgr.reset}${dim(` · ${plain.slice(title.length + 3)}`)}`
  const fill = '─'.repeat(Math.max(0, maxWidth - visibleWidth(stripAnsi(content)) - 4))
  const line = `${accent}╭─ ${content} ${fill}╮${sgr.reset}`
  return dimmed ? `${sgr.dim}${line}${sgr.reset}` : line
}

/**
 * Render a full-frame prompt dock. The prompt line is prepainted so readline can
 * type inside a visually complete box, and multiline mode gets filler rows with `~`.
 */
export function renderPromptDockFrame(opts: PromptDockFrameOptions = {}): PromptDockFrame {
  const { dimmed = false, mode = 'normal', multiline = false, multilineRows } = opts
  const cols = process.stdout.columns ?? 80
  const terminalRows = process.stdout.rows ?? 24
  const accent = mode === 'bash' ? themeColor('bashBorder') : themeColor('owl')
  const title = mode === 'bash' ? 'Shell' : 'Message'
  const hint = mode === 'bash'
    ? 'Run a command'
    : multiline
      ? 'Shift+Enter continue · Enter send · Ctrl+C cancel'
      : '/ commands · Shift+Enter multi-line'
  const width = Math.max(36, cols - 2)
  const contentWidth = Math.max(8, width - 3)
  const topPlain = truncate(`${title} · ${hint}`, width - 6)
  const topContent = topPlain === title
    ? `${sgr.bold}${title}${sgr.reset}`
    : `${sgr.bold}${title}${sgr.reset}${dim(` · ${topPlain.slice(title.length + 3)}`)}`
  const topFill = '─'.repeat(Math.max(0, width - visibleWidth(stripAnsi(topContent)) - 4))
  const top = `${accent}╭─ ${topContent} ${topFill}╮${sgr.reset}`
  const leftBorder = `${accent}│${sgr.reset} `
  const rightBorder = `${accent}│${sgr.reset}`
  const promptLine = `${leftBorder}${' '.repeat(contentWidth)}${rightBorder}`
  const fillerTemplate = `${themeColor('textDim')}~${sgr.reset}`
  const minMultilineBodyRows = 4
  const maxMultilineBodyRows = Math.max(minMultilineBodyRows, Math.min(8, terminalRows - 6))
  const bodyRows = multiline
    ? Math.max(
        minMultilineBodyRows,
        Math.min(multilineRows ?? minMultilineBodyRows, maxMultilineBodyRows),
      )
    : 1
  const fillerLines = multiline
    ? Array.from(
        { length: Math.max(0, bodyRows - 1) },
        () => `${leftBorder}${fillerTemplate}${' '.repeat(Math.max(0, contentWidth - 1))}${rightBorder}`,
      )
    : []
  const bottom = `${accent}╰${'─'.repeat(Math.max(0, width - 2))}╯${sgr.reset}`
  const frame = {
    width,
    contentWidth,
    height: bodyRows + 2,
    bodyRows,
    top,
    promptLine,
    fillerLines,
    bottom,
    cursorColumn: visibleWidth(stripAnsi(leftBorder)) + 1,
    leftBorder,
    rightBorder,
    multiline,
  }
  if (!dimmed) return frame
  return {
    ...frame,
    top: `${sgr.dim}${top}${sgr.reset}`,
    promptLine: `${sgr.dim}${promptLine}${sgr.reset}`,
    fillerLines: fillerLines.map((line) => `${sgr.dim}${line}${sgr.reset}`),
    bottom: `${sgr.dim}${bottom}${sgr.reset}`,
  }
}

export function renderPromptDockInputLine(frame: PromptDockFrame, input = ''): string {
  const safeInput = stripAnsi(input)
  const visibleInput = truncate(safeInput, frame.contentWidth)
  const padding = ' '.repeat(Math.max(0, frame.contentWidth - visibleWidth(visibleInput)))
  return `${frame.leftBorder}${visibleInput}${padding}${frame.rightBorder}`
}

/**
 * Format a user message display.
 */
export function formatUserMessage(text: string): string {
  return renderUserBlock(text)
}

/**
 * Format an assistant text response header.
 */
export function formatAssistantHeader(): string {
  return `\n${themeColor('owl')}🦉${sgr.reset}`
}

/**
 * Thinking block — terminal port of the design's `oc-thinking`:
 *
 *   ▾ THINKING                 0.4s        ← head: small caps + chev + dur
 *   │ {body line 1}                        ← left hair-faint rule on every body row
 *   │ {body line 2}
 *
 * Collapsed (active && no text): one-line head w/ a pulsing dot.
 * Expanded: head + body lines, body indented past a vertical rule.
 */
export function formatThinking(opts: { active?: boolean; text?: string; durationMs?: number } = {}): string {
  const { active = true, text, durationMs } = opts
  if (!active && !text) return ''
  const chev = text ? '▾' : '▸'
  const label = active ? 'THINKING' : 'THOUGHT'
  const live = active
    ? `  ${themeColor('owl')}● live${sgr.reset}`
    : ''
  const dur = typeof durationMs === 'number' && durationMs > 0
    ? `  ${themeColor('textSubtle')}${(durationMs / 1000).toFixed(1)}s${sgr.reset}`
    : ''
  const header = `${themeColor('textSubtle')}${chev}${sgr.reset} `
    + `${themeColor('textDim')}${label}${sgr.reset}${live}${dur}`
  if (!text) return header
  // Body — each line prefixed with a hair-faint vertical rule (12px-equiv
  // indent in char terms = `│  `), body in ink-mute. Mirrors design's
  // `.oc-thinking { border-left: 1px solid var(--hair); padding: 2px 0 2px 12px; }`.
  const rulePrefix = `${themeColor('hairFaint')}│${sgr.reset}  `
  const body = text.split('\n').map((l) => `${rulePrefix}${themeColor('textMute')}${l}${sgr.reset}`).join('\n')
  return `${header}\n${body}`
}

/**
 * Marker — terminal port of the design's `oc-marker`:
 *
 *   —  cwd ~/code/owlcoda · branch main · no pending changes
 *   —  ↯ INTERRUPTED BY USER · 0.4s INTO TOOL CALL
 *
 * Used for low-noise lifecycle events (cwd / branch echo, /clear,
 * /resume, interrupts, session restored). Three kinds:
 *   info  → mute em-dash + dim body
 *   warn  → warn em-dash + warn body  (interrupts, queue dropped)
 *   err   → err  em-dash + err  body  (session abort)
 *
 * Body text is rendered VERBATIM. The design's CSS uses
 * `text-transform: uppercase + letter-spacing: 0.12em` for visual
 * "metadata" feel — but in a terminal, mechanically uppercasing and
 * inserting thin spaces between every glyph mangles paths
 * (`~/AI/gitrep/owlcoda` becomes unreadable) and loses case-sensitive
 * info. We render exactly what the caller passes; the caller can
 * choose to write `INTERRUPTED BY USER` themselves when the text is a
 * label rather than data.
 */
export type MarkerKind = 'info' | 'warn' | 'err'

export function formatMarker(text: string, kind: MarkerKind = 'info'): string {
  const gutterColor =
    kind === 'warn' ? themeColor('warning')
    : kind === 'err' ? themeColor('error')
    : themeColor('textSubtle')
  const bodyColor =
    kind === 'warn' ? themeColor('warning')
    : kind === 'err' ? themeColor('error')
    : themeColor('textDim')

  const body = text.replace(/\s+/g, ' ').trim()
  return `${gutterColor}—${sgr.reset}  ${bodyColor}${body}${sgr.reset}`
}

/**
 * Format a system/notification message.
 *
 * Lifecycle events (clear/resume/interrupt) render as quiet markers;
 * substantive notices (errors with body, MCP connect, rate limit) keep
 * the more visible banner treatment.
 */
export function formatSystemMessage(text: string): string {
  return formatMarker(text, 'info')
}

export type PlatformEventKind = 'session' | 'router'

/**
 * Format a runtime/platform event that should remain readable in the transcript.
 */
export function formatPlatformEvent(kind: PlatformEventKind, text: string): string {
  if (kind === 'router') {
    return renderBanner({
      kind: 'info',
      title: 'Router',
      body: text,
      columns: process.stdout.columns ?? 80,
    })
  }
  return renderBanner({ kind: 'info', title: text, columns: process.stdout.columns ?? 80 })
}

/**
 * Format an error message with box.
 */
export function formatErrorMessage(error: string): string {
  return renderBanner({
    kind: 'err',
    title: 'Error',
    body: error,
    columns: process.stdout.columns ?? 80,
  })
}

/**
 * Format an error message inside a box.
 */
export function formatErrorBox(title: string, detail: string): string {
  const lines = detail.split('\n').map(l => `${themeColor('error')}${l}${sgr.reset}`)
  return renderBox(lines, {
    border: 'round',
    title,
    titleColor: themeColor('error'),
    borderColor: themeColor('error'),
    paddingX: 1,
  })
}

// ─── Token usage / metadata ───────────────────────────────────

/**
 * Format token usage display after a response.
 */
export function formatTokenUsage(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens
  return dim(`[${formatNum(inputTokens)} in / ${formatNum(outputTokens)} out — ${formatNum(total)} total]`)
}

/**
 * Format stop reason (only shown for unusual stops).
 */
export function formatStopReason(reason: string | null): string {
  if (!reason) return ''
  switch (reason) {
    case 'end_turn': return ''
    case 'tool_use': return ''
    case 'max_tokens':
      return `${themeColor('warning')}⚠ Truncated (max tokens reached)${sgr.reset}`
    case 'stop_sequence':
      return dim('(stop sequence)')
    default:
      return dim(`(${reason})`)
  }
}

/**
 * Format iteration count.
 */
export function formatIterations(count: number): string {
  return dim(`(${count} iterations)`)
}

// ─── Status bar ───────────────────────────────────────────────

export interface StatusBarOptions {
  model: string
  tokens?: { input: number; output: number; max: number }
  agents?: number
  approve?: boolean
  mode?: string
  /** Estimated cost in USD (optional). */
  cost?: number
  /** Number of conversation turns. */
  turns?: number
  /** Duration of last request in ms. */
  durationMs?: number
  /** Per-tool approved count. */
  perToolApproved?: number
  /** Current working directory (truncated basename shown in status). */
  cwd?: string
}

/**
 * Render a compact status line for the bottom of the terminal.
 * Compact density: model │ context │ cost │ approval │ duration
 */
export function renderStatusBar(opts: StatusBarOptions): string {
  const parts: string[] = []

  // Model (truncated)
  parts.push(`${themed(truncate(opts.model, 28), 'owl')}`)

  // Token / context budget with visual bar
  if (opts.tokens) {
    const used = opts.tokens.input + opts.tokens.output
    const pct = opts.tokens.max > 0 ? Math.round((used / opts.tokens.max) * 100) : 0
    const bar = renderMiniBar(pct)
    parts.push(`${bar} ${dim(`${pct}% (${formatNum(used)}/${formatNum(opts.tokens.max)})`)}`)
  }

  // Cost estimate
  if (opts.cost !== undefined && opts.cost > 0) {
    parts.push(dim(`$${opts.cost.toFixed(3)}`))
  }

  // Agent count
  if (opts.agents && opts.agents > 0) {
    parts.push(`${themeColor('agentBlue')}⚡ ${opts.agents} agent${opts.agents > 1 ? 's' : ''}${sgr.reset}`)
  }

  // Approve mode with per-tool count
  if (opts.approve !== undefined) {
    let label: string
    if (opts.approve) {
      label = `${themeColor('success')}✓ Auto${sgr.reset}`
    } else {
      const ptCount = opts.perToolApproved ?? 0
      label = ptCount > 0
        ? `${themeColor('warning')}⚠ Ask${sgr.reset} ${dim(`(${ptCount} allowed)`)}`
        : `${themeColor('warning')}⚠ Ask${sgr.reset}`
    }
    parts.push(label)
  }

  // Mode indicators (brief/fast/effort)
  if (opts.mode) {
    parts.push(`${themeColor('fastMode')}${opts.mode}${sgr.reset}`)
  }

  // Turns count for context awareness
  if (opts.turns !== undefined && opts.turns > 0) {
    parts.push(dim(`${opts.turns} turn${opts.turns !== 1 ? 's' : ''}`))
  }

  // CWD
  if (opts.cwd) {
    const base = opts.cwd.split('/').pop() ?? opts.cwd
    parts.push(dim(truncate(base, 20)))
  }

  // Duration (optional)
  if (opts.durationMs !== undefined && opts.durationMs > 0) {
    const sec = (opts.durationMs / 1000).toFixed(1)
    parts.push(dim(`${sec}s`))
  }

  return dim('[') + parts.join(dim(' │ ')) + dim(']')
}

/**
 * Compact single-line rail for the composer panel's bottom.
 *
 * Fields (left-to-right, separated by · ):
 *   model · mode · status · context · draft
 * Right-aligned hint:
 *   Ctrl+C interrupt  (when busy)
 *   Enter send · Shift+Enter newline  (when idle)
 */
export interface ComposerRailOptions {
  readonly model: string
  readonly mode: 'plan' | 'act' | 'auto' | 'manual'
  readonly busy: boolean
  readonly queued: number
  readonly contextTokens: number
  readonly contextMax: number
  readonly draftChars: number
  /**
   * Low-churn terminals can render a stable draft-presence cell instead of
   * changing the rail on every typed character.
   */
  readonly draftCellMode?: 'count' | 'presence' | 'hidden'
  readonly interruptRequested: boolean
  /** Available terminal columns. Enables fullscreen-first width pruning. */
  readonly columns?: number
  /** True when a permission prompt owns the composer. */
  readonly approval?: boolean
  /** Active tool name while busy, if known. */
  readonly activeToolName?: string
  /** True when the visible REPL state is a recoverable error. */
  readonly error?: boolean
  /** Estimated session cost in USD (UsageTracker.cost snapshot). */
  readonly cost?: number
  /** Active git branch (welcome.ts readGitBranch helper). */
  readonly branch?: string | null
  /** Connected MCP server count (MCPManager). */
  readonly mcpConnected?: number
  /**
   * Active overlay/panel context — drives the right-aligned hint. The
   * design's rail surfaces different hotkeys depending on what owns the
   * pane: `↵ resume · d delete · esc close` in /sessions, etc.
   */
  readonly hintContext?: 'idle' | 'busy' | 'approval' | 'sessions' | 'settings' | 'mcp' | 'slash' | 'at' | 'model' | 'theme'
}

/**
 * Status rail — terminal port of the design's `oc-rail` footer.
 *
 * Anatomy (cells separated by hair-faint │):
 *   ● {state-label-in-state-color} │ MODEL {model in ink} │
 *   CTX {n/m in ink} │ MODE {label} │ DRAFT {n} │ … {hint right-aligned}
 *
 * State colors mirror the design's `.cell.is-{state}` rules:
 *   ready=success · busy/tool=accent · wait/queue=warn · err=error.
 */
export function renderComposerRail(opts: ComposerRailOptions): string {
  const columns = Math.max(20, opts.columns ?? process.stdout.columns ?? 80)
  const stateInfo = formatRailStateCell(opts)
  const hint = formatRailHint(opts)

  // Build cell sequence in priority order. State always first, model
  // always second; later cells drop off as width tightens.
  //
  // No MODE cell: today `mode` is just a derived `busy ? 'act' : 'plan'`
  // — exactly what the state pulse (●) on the left already signals. We
  // accept the prop on opts for forwards-compat (so a real plan/act
  // toggle can land later without changing the call sites), but we don't
  // paint it as a separate cell while it carries no independent signal.
  void opts.mode
  const cells: RailCell[] = [
    { kind: 'state', text: stateInfo.text, color: stateInfo.color },
    { kind: 'kv', label: 'model', value: truncateModel(opts.model, columns >= 100 ? 28 : 18) },
  ]
  if (opts.contextMax > 0) {
    cells.push({ kind: 'kv', label: 'ctx', value: formatContextPressure(opts.contextTokens, opts.contextMax) })
  }
  if (typeof opts.cost === 'number' && opts.cost > 0) {
    cells.push({ kind: 'kv', label: 'cost', value: formatRailCost(opts.cost) })
  }
  if (opts.branch) {
    cells.push({ kind: 'kv', label: 'branch', value: truncate(opts.branch, 24) })
  }
  if (typeof opts.mcpConnected === 'number' && opts.mcpConnected > 0) {
    // MCP cell only appears when at least one server is connected — `0 on`
    // reads as a contradiction, and an always-visible zero cell eats rail
    // budget that CTX/COST/BRANCH need. `/mcp` is the authoritative surface
    // when no servers are wired.
    cells.push({
      kind: 'kv',
      label: 'mcp',
      value: `${opts.mcpConnected} on`,
      valueColor: themeColor('success'),
    })
  }
  if (opts.queued > 0) {
    cells.push({ kind: 'kv', label: 'queued', value: String(opts.queued), valueColor: themeColor('warning') })
  }
  const draftCellMode = opts.draftCellMode ?? 'count'
  if (opts.draftChars > 0 && draftCellMode !== 'hidden') {
    cells.push({
      kind: 'kv',
      label: 'draft',
      value: draftCellMode === 'presence' ? 'active' : String(opts.draftChars),
    })
  }

  const fit = (s: string): boolean => visibleWidth(stripAnsi(s)) <= columns
  const render = (visible: RailCell[], includeHint: boolean): string => {
    const body = visible.map(renderRailCell).join(`${themeColor('hairFaint')} │ ${sgr.reset}`)
    if (!includeHint) return body
    const hintText = `${themeColor('textMute')}${hint}${sgr.reset}`
    const used = visibleWidth(stripAnsi(body))
    const hintWidth = visibleWidth(stripAnsi(hintText))
    const gap = Math.max(2, columns - used - hintWidth)
    return `${body}${' '.repeat(gap)}${hintText}`
  }

  let pruning = [...cells]
  let out = render(pruning, true)
  if (fit(out)) return out

  // Drop hint, then drop tail cells one at a time until we fit.
  out = render(pruning, false)
  if (fit(out)) return out
  while (pruning.length > 2) {
    pruning = pruning.slice(0, -1)
    out = render(pruning, false)
    if (fit(out)) return out
  }
  return truncate(out, columns)
}

interface RailCellState {
  kind: 'state'
  text: string
  color: string
}
interface RailCellKv {
  kind: 'kv'
  label: string
  value: string
  valueColor?: string
}
type RailCell = RailCellState | RailCellKv

function renderRailCell(cell: RailCell): string {
  if (cell.kind === 'state') {
    // State pulse glyph + label in tier color.
    return `${cell.color}● ${cell.text}${sgr.reset}`
  }
  // Label uppercase mute + value in ink (or override).
  const valueColor = cell.valueColor ?? themeColor('text')
  return `${themeColor('textMute')}${cell.label.toUpperCase()}${sgr.reset} `
    + `${valueColor}${cell.value}${sgr.reset}`
}

function truncateModel(model: string, max: number): string {
  if (model.length <= max) return model
  return model.slice(0, max - 1) + '…'
}

function formatRailStateCell(opts: ComposerRailOptions): { text: string; color: string } {
  if (opts.error)              return { text: 'error',         color: themeColor('error') }
  if (opts.approval)           return { text: 'awaiting approval', color: themeColor('warning') }
  if (opts.interruptRequested) return { text: 'interrupting…', color: themeColor('warning') }
  if (opts.busy && opts.activeToolName) {
    return { text: `running ${truncate(opts.activeToolName, 18)}`, color: themeColor('owl') }
  }
  if (opts.busy && opts.queued > 0) return { text: `busy · ${opts.queued} queued`, color: themeColor('warning') }
  if (opts.busy)                    return { text: 'thinking…',  color: themeColor('owl') }
  return { text: 'ready', color: themeColor('success') }
}

function formatContextPressure(tokens: number, max: number): string {
  const k = (n: number) => n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`
  return `${k(tokens)}/${k(max)}`
}

/**
 * Cost cell — short USD formatting. Below $0.01 we show "<$0.01" so the
 * cell never renders as the misleading `$0.000`. Above $1 we drop the
 * fraction past two decimals to keep the cell narrow.
 */
function formatRailCost(cost: number): string {
  if (cost < 0.01) return '<$0.01'
  if (cost < 1)    return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/**
 * Rail hint — per-context hotkey row painted at the right edge.
 *
 * Mirrors the design's per-scene rail (scene 11 sessions, scene 12
 * settings, scene 13 mcp, etc.). When `hintContext` is unspecified we
 * fall back to the original three-state mapping (idle / busy / approval)
 * so call sites that haven't opted in still get sensible hints.
 */
function formatRailHint(opts: ComposerRailOptions): string {
  const ctx = opts.hintContext
  if (ctx === 'sessions') return '↵ resume · d delete · esc close'
  if (ctx === 'settings') return 'tab section · space toggle · esc close'
  if (ctx === 'mcp')      return 'a add · r reload · esc close'
  if (ctx === 'slash')    return '↑↓ move · ↵ run · esc close'
  if (ctx === 'at')       return '↑↓ move · ↵ attach · esc close'
  if (ctx === 'model' || ctx === 'theme') return '↑↓ move · ↵ select · esc close'

  if (opts.approval) return 'y allow · n deny · a always'
  if (opts.busy)     return 'ctrl+c interrupt'
  return 'enter send · shift+enter newline'
}

// ─── Helpers ──────────────────────────────────────────────────

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return String(input['command'] ?? '')
    case 'read':
      return String(input['path'] ?? '')
    case 'write':
      return String(input['path'] ?? '')
    case 'edit':
      return String(input['path'] ?? '')
    case 'glob':
      return String(input['pattern'] ?? '')
    case 'grep':
      return `/${String(input['pattern'] ?? '')}/ ${String(input['path'] ?? '.')}`
    case 'Agent':
      return truncate(String(input['description'] ?? ''), 80)
    case 'WebFetch':
      return truncate(String(input['url'] ?? ''), 80)
    case 'WebSearch':
      return truncate(String(input['query'] ?? ''), 80)
    default:
      return truncate(JSON.stringify(input), 80)
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Sub-character precision progress bar for the native terminal UI. */
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

function renderMiniBar(pct: number): string {
  const width = 10
  const ratio = Math.min(1, Math.max(0, pct / 100))
  const whole = Math.floor(ratio * width)
  const segments: string[] = [BLOCKS[BLOCKS.length - 1]!.repeat(whole)]
  if (whole < width) {
    const remainder = ratio * width - whole
    const middle = Math.floor(remainder * BLOCKS.length)
    segments.push(BLOCKS[middle]!)
    const empty = width - whole - 1
    if (empty > 0) {
      segments.push(BLOCKS[0]!.repeat(empty))
    }
  }
  const fillColor = pct > 80 ? themeColor('warning') : themeColor('success')
  const emptyColor = dim('')
  return `${fillColor}${segments.join('')}${emptyColor}${sgr.reset}`
}

// ─── Keyboard shortcut hints ────────────────────────────────

/**
 * Format a keyboard shortcut hint: "Enter to confirm · Esc to cancel"
 * Keyboard shortcut hint + byline pattern.
 */
export function formatKeyHint(
  hints: Array<{ key: string; action: string }>,
): string {
  return dim(
    hints
      .map((h) => `${sgr.reset}${themeColor('textDim')}${h.key}${sgr.reset}${dim(` ${h.action}`)}`)
      .join(dim(' · ')),
  )
}

/**
 * Format a rate-limit countdown message.
 * Rate-limit countdown timer.
 */
export function formatRateLimitCountdown(
  remainingMs: number,
  total: number,
  current: number,
): string {
  const secs = Math.ceil(remainingMs / 1000)
  const pct = total > 0 ? Math.round((current / total) * 100) : 0
  const bar = renderMiniBar(pct)
  const label = secs > 0 ? `Rate limited — retry in ${secs}s` : 'Rate limit cleared'
  return renderBanner({
    kind: secs > 0 ? 'warn' : 'ok',
    title: label,
    body: `${bar} ${pct}%`,
    columns: process.stdout.columns ?? 80,
  })
}

// ─── Persistent Status Bar ───────────────────────────────────

/**
 * Always-visible status bar pinned to the terminal bottom row.
 *
 * Uses ANSI scroll-region + cursor-save/restore to reserve the
 * last terminal row for status info without disrupting normal
 * output flow.
 *
 * Architecture uses an imperative ANSI layout rather than a React box tree —
 * we use imperative ANSI escape sequences.
 */
export class PersistentStatusBar {
  private lastContent = ''
  private installed = false
  private reservedRows = 1

  /** Number of bottom rows reserved for dock + status chrome. */
  setReservedRows(rows: number): void {
    const terminalRows = process.stdout.rows || 24
    const maxReserved = Math.max(1, terminalRows - 1)
    const next = Math.max(1, Math.min(rows, maxReserved))
    if (next === this.reservedRows) return
    this.reservedRows = next
    if (!this.installed) return
    this.applyScrollRegion()
    this.repaintLastContent()
  }

  getReservedRows(): number {
    return this.reservedRows
  }

  getScrollBottomRow(): number {
    const terminalRows = process.stdout.rows || 24
    return Math.max(1, terminalRows - this.reservedRows)
  }

  private applyScrollRegion(): void {
    const scrollBottom = this.getScrollBottomRow()
    process.stdout.write(`\x1b7`)
    process.stdout.write(`\x1b[1;${scrollBottom}r`)
    process.stdout.write(`\x1b8`)
  }

  private repaintLastContent(): void {
    if (!this.lastContent) return
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    process.stdout.write(
      `\x1b7` +
      `\x1b[${rows};1H` +
      `\x1b[2K` +
      `${padToWidth(this.lastContent, cols)}` +
      `\x1b8`
    )
  }

  /** Reserve the bottom row by setting a scroll region. */
  install(): void {
    if (this.installed) return
    this.applyScrollRegion()
    this.installed = true
  }

  /** Release the bottom row and restore full-screen scroll. */
  uninstall(): void {
    if (!this.installed) return
    const rows = process.stdout.rows || 24
    process.stdout.write(`\x1b7`)
    process.stdout.write(`\x1b[1;${rows}r`)
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`)
    process.stdout.write(`\x1b8`)
    this.installed = false
    this.lastContent = ''
  }

  /** Paint / repaint the status bar content on the reserved bottom row. */
  update(opts: StatusBarOptions): void {
    const content = renderStatusBar(opts)
    if (content === this.lastContent) return
    this.lastContent = content

    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80

    // Save cursor, jump to status row, clear line, write, restore cursor
    process.stdout.write(
      `\x1b7` +                          // save cursor
      `\x1b[${rows};1H` +                // move to last row
      `\x1b[2K` +                        // clear entire line
      `${padToWidth(content, cols)}` +    // padded status content
      `\x1b8`                             // restore cursor
    )
  }

  /** Handle terminal resize — reinstall scroll region with new dimensions. */
  handleResize(): void {
    if (!this.installed) return
    this.applyScrollRegion()
    this.repaintLastContent()
  }

  get isInstalled(): boolean { return this.installed }
}

/** Pad a string (ignoring ANSI escapes) to fill terminal width. */
function padToWidth(s: string, width: number): string {
  // Strip ANSI to measure visible length
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}
