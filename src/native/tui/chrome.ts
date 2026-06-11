/**
 * Transcript chrome vocabulary — single source of truth for how the REPL
 * presents information classes (spec: docs/superpowers/specs/
 * 2026-06-11-transcript-chrome-spec-design.md).
 *
 * S1 scope: the human display of tool results is decoupled from the model
 * payload. Bash's `[stdout]/[stderr]/[exit code: N]` protocol stays intact
 * for the model; humans get clean body lines plus a constant-shape fold
 * line. Presentation only — no markdown parsing, no repaint involvement.
 */

import { dim, sgr, themeColor, visibleWidth } from './colors.js'
import wrapText from '../../ink/wrap-text.js'
import { formatTokenCompact } from '../../model-capabilities.js'

// ─── Narration (what the model says) ─────────────────────────────────────
// S2: narration gets its own gutter so ⎿ can go back to meaning "output of
// the action above" exclusively. The chrome layer wraps to the terminal
// width with a hanging indent — long CJK lines no longer fall to col 0 when
// the terminal hard-wraps them.

const NARRATION_GLYPH = '●'
const NARRATION_INDENT = '  '

export interface NarrationOptions {
  /** true when this is the first rendered block of a narration segment */
  firstBlock: boolean
  columns: number
}

export function renderNarration(rendered: string, opts: NarrationOptions): string {
  const columns = Math.max(8, opts.columns)
  const contentWidth = Math.max(4, columns - NARRATION_INDENT.length)
  const logicalLines = rendered.split('\n')
  const out: string[] = []
  let first = opts.firstBlock

  logicalLines.forEach((logicalLine, index) => {
    const isTrailingEmpty = index === logicalLines.length - 1 && logicalLine === ''
    if (isTrailingEmpty) {
      out.push('')
      return
    }
    if (logicalLine === '') {
      // Blank separator rows stay byte-empty — selection-first: no
      // invisible indent padding in copied text.
      out.push('')
      return
    }
    const wrapped = wrapText(logicalLine, contentWidth, 'wrap').split('\n')
    for (const visual of wrapped) {
      if (first) {
        first = false
        out.push(`${themeColor('owl')}${NARRATION_GLYPH}${sgr.reset} ${visual}`)
      } else {
        out.push(`${NARRATION_INDENT}${visual}`)
      }
    }
  })

  return out.join('\n')
}

// ─── Result body collapse budgets ────────────────────────────────────────
// ok results show the head (the interesting part of a listing/log) and err
// results show the tail (errors accumulate at the end of output).
export const RESULT_HEAD_LINES: Record<string, number> = {
  bash: 5,
}
export const RESULT_HEAD_DEFAULT = 3
export const RESULT_ERR_TAIL_LINES = 10

export function resultBodyBudget(canonicalName: string, isError: boolean): number {
  if (isError) return RESULT_ERR_TAIL_LINES
  return RESULT_HEAD_LINES[canonicalName] ?? RESULT_HEAD_DEFAULT
}

// ─── Bash payload → display payload ──────────────────────────────────────

export interface BashDisplayPayload {
  /** stdout lines followed by stderr lines, protocol labels stripped */
  lines: string[]
  exitCode: number | null
  killed: boolean
}

const EXIT_CODE_RE = /^\[exit code: (-?\d+)\]$/m
const KILLED_RE = /^\[killed\] [^\n]*$/m

/**
 * Parse the model-facing bash tool_result protocol (bash.ts
 * formatBashOutput: `[stdout]\n…`, `[stderr]\n…`, `[killed] …`,
 * `[exit code: N]`) into a display payload. Returns null when the text
 * does not carry the protocol trailer — caller falls back to raw output.
 */
export function parseBashPayload(output: string): BashDisplayPayload | null {
  const exitMatch = output.match(EXIT_CODE_RE)
  if (!exitMatch) return null

  const killed = KILLED_RE.test(output)
  let body = output
    .replace(EXIT_CODE_RE, '')
    .replace(KILLED_RE, '')

  const lines: string[] = []
  let inSection = false
  for (const line of body.split('\n')) {
    if (line === '[stdout]' || line === '[stderr]') {
      inSection = true
      continue
    }
    if (!inSection) continue
    lines.push(line)
  }
  // The protocol joins sections with blank lines and the trailer leaves a
  // trailing gap — trim blank edges without touching interior blanks.
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()

  return {
    lines,
    exitCode: Number.parseInt(exitMatch[1]!, 10),
    killed,
  }
}

// ─── Folding ─────────────────────────────────────────────────────────────

export interface CollapseResult {
  shown: string[]
  hidden: number
  fromTail: boolean
}

export function collapseResultBody(
  lines: string[],
  opts: { isError: boolean; budget: number },
): CollapseResult {
  const budget = Math.max(1, opts.budget)
  if (lines.length <= budget) {
    return { shown: lines, hidden: 0, fromTail: false }
  }
  if (opts.isError) {
    return { shown: lines.slice(-budget), hidden: lines.length - budget, fromTail: true }
  }
  return { shown: lines.slice(0, budget), hidden: lines.length - budget, fromTail: false }
}

/**
 * Constant-shape fold line: `… +N lines · meta`. The shape is locked by
 * regression tests — every collapsed body in the transcript folds the same
 * way, so the eye learns it once.
 */
export function foldLine(hidden: number, meta?: string): string {
  const base = `… +${hidden} lines`
  return dim(meta ? `${base} · ${meta}` : base)
}

// ─── Notices, progress, key-value layout (S3) ────────────────────────────

export type NoticeKind = 'info' | 'success' | 'warning'

const NOTICE_GLYPHS: Record<NoticeKind, string> = {
  info: 'ⓘ',
  success: '✓',
  warning: '⚠',
}

/** One-line system notice: quiet, glyph-colored, never multi-line. */
export function renderNotice(text: string, kind: NoticeKind = 'info'): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' — ').trim()
  const color = kind === 'success'
    ? themeColor('success')
    : kind === 'warning'
      ? themeColor('warning')
      : themeColor('textSubtle')
  return `${color}${NOTICE_GLYPHS[kind]}${sgr.reset} ${dim(oneLine)}`
}

export interface TurnFooterOptions {
  iterations: number
  inputTokens: number
  outputTokens: number
  elapsedSeconds: number
}

/**
 * Per-turn progress footer — ONE quiet line replacing the old stacked
 * "(N iterations)" + "[X in / Y out — Z total] · 12.3s" pair:
 *
 *   ── 15 it · 7.6k in / 2.8k out · 96.1s
 */
export function renderTurnFooter(opts: TurnFooterOptions): string {
  const hasTokens = opts.inputTokens > 0 || opts.outputTokens > 0
  if (!hasTokens && opts.iterations <= 1) return ''
  const parts: string[] = []
  if (opts.iterations > 1) parts.push(`${opts.iterations} it`)
  if (hasTokens) {
    parts.push(`${formatTokenCompact(opts.inputTokens)} in / ${formatTokenCompact(opts.outputTokens)} out`)
  }
  parts.push(`${opts.elapsedSeconds.toFixed(1)}s`)
  return `${themeColor('textSubtle')}── ${parts.join(' · ')}${sgr.reset}`
}

/**
 * Aligned key-value block for slash-command panels (/status, /cost…).
 * Key column width is measured in display cells, so CJK keys align too.
 */
export function renderKeyValue(pairs: ReadonlyArray<readonly [string, string]>): string {
  const keyWidth = pairs.reduce((w, [k]) => Math.max(w, visibleWidth(k)), 0)
  return pairs
    .map(([k, v]) => `${dim(k)}${' '.repeat(keyWidth - visibleWidth(k) + 2)}${v}`)
    .join('\n')
}

/** Styled single-line section header for grouped slash output (/help). */
export function renderSection(title: string): string {
  return `${sgr.bold}${themeColor('owl')}${title.replace(/\n/g, ' ')}${sgr.reset}`
}

// ─── Full-output recall (/expand) ────────────────────────────────────────
// Ring buffer of recent full tool outputs so collapse never loses data.
// Interactive in-place expansion is future work (spec: C 方案); /expand
// re-prints the recorded output.

interface RecordedToolOutput {
  name: string
  output: string
  isError: boolean
  at: number
}

const RECORD_LIMIT = 20
const recordedOutputs: RecordedToolOutput[] = []

export function recordFullToolOutput(name: string, output: string, isError: boolean): void {
  recordedOutputs.push({ name, output, isError, at: Date.now() })
  if (recordedOutputs.length > RECORD_LIMIT) recordedOutputs.shift()
}

/** offset 0 = most recent. Returns null when out of range. */
export function getRecordedToolOutput(offset = 0): RecordedToolOutput | null {
  if (offset < 0 || offset >= recordedOutputs.length) return null
  return recordedOutputs[recordedOutputs.length - 1 - offset] ?? null
}

export function clearRecordedToolOutputs(): void {
  recordedOutputs.length = 0
}
