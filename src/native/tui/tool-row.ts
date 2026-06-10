/**
 * Tool row — terminal port of the design's `oc-tool` block.
 *
 * Header layout (single line):
 *   {chev} {verb-in-accent} {arg-in-ink/dim} … {dur in mute} {status glyph}
 *   ▾  Read src/host/bridge.ts                   0.05s ✓
 *
 * Body (when expanded): indented block with a faint vertical rule on the
 * left edge, dim foreground, optional `… +N more` truncation tail.
 */

import { dim, stripAnsi, themeColor, visibleWidth, sgr } from './colors.js'
import { padRight, truncate } from './text.js'

export type ToolRowState = 'run' | 'ok' | 'err' | 'pending'

export interface ToolRowOptions {
  verb: string
  arg: string
  state: ToolRowState
  duration?: string
  meta?: string
  columns?: number
  expanded?: boolean
  bodyLines?: readonly string[]
  maxBodyLines?: number
}

const DEFAULT_COLUMNS = 80
const DEFAULT_MAX_BODY_LINES = 8
// Body rule + indent: `│  ` painted in hairFaint, then dim body text.
// Width = 3 cells (rule + 2 spaces) — matches the design's 14px-of-padding
// after a 1px left rule, scaled to char-cell terms.
const BODY_RULE = '│'
const BODY_INDENT = '  '

export function renderToolRow(opts: ToolRowOptions): string {
  const columns = normalizeColumns(opts.columns)
  const lines = [renderHeader(opts, columns)]

  if (opts.expanded && opts.bodyLines && opts.bodyLines.length > 0) {
    lines.push(...renderBody(opts.bodyLines, columns, opts.maxBodyLines))
  }

  return lines.join('\n')
}

function renderHeader(opts: ToolRowOptions, columns: number): string {
  const chevron = opts.expanded ? '▾' : '▸'
  const verb = cleanInline(opts.verb)
  const arg = cleanInline(opts.arg)
  const meta = opts.meta ? ` ${dim(cleanInline(opts.meta))}` : ''

  // Chevron in subtle ink; verb in accent (cyan); arg in default ink/dim.
  const chevPart = `${themeColor('textSubtle')}${chevron}${sgr.reset} `
  const verbPart = `${themeColor('owl')}${verb}${sgr.reset} `
  const leftPrefix = `${chevPart}${verbPart}`

  const suffix = renderSuffix(opts)
  const argBudget = Math.max(1, columns - visibleWidth(leftPrefix) - visibleWidth(meta) - visibleWidth(suffix))
  // Arg uses dim ink so it visually steps back from the verb.
  const argRendered = `${themeColor('textDim')}${truncate(arg, argBudget)}${sgr.reset}`

  const line = `${leftPrefix}${argRendered}${meta}${suffix}`
  return fitLine(line, columns)
}

function renderSuffix(opts: ToolRowOptions): string {
  const status = statusGlyph(opts.state)
  const statusColor = statusColorFor(opts.state)
  const dur = opts.duration ? cleanInline(opts.duration) : ''
  const durPart = dur ? `${themeColor('textMute')}${dur}${sgr.reset} ` : ''
  // Two leading spaces let the trailing dur+status sit clear of the arg
  // even on busy rows; the status glyph is the right-most visual anchor.
  return `  ${durPart}${statusColor}${status}${sgr.reset}`
}

function renderBody(bodyLines: readonly string[], columns: number, maxBodyLines?: number): string[] {
  const limit = Math.max(0, Math.floor(maxBodyLines ?? DEFAULT_MAX_BODY_LINES))
  const shown = bodyLines.slice(0, limit)
  const omitted = bodyLines.length - shown.length
  const rulePart = `${themeColor('hairFaint')}${BODY_RULE}${sgr.reset}${BODY_INDENT}`
  const ruleWidth = visibleWidth(rulePart)
  const contentWidth = Math.max(0, columns - ruleWidth)

  const out = shown.map((line) => {
    const body = truncate(stripAnsi(String(line)), contentWidth)
    return fitLine(`${rulePart}${themeColor('textDim')}${body}${sgr.reset}`, columns)
  })

  if (omitted > 0) {
    const tail = `… +${omitted} more line${omitted === 1 ? '' : 's'}`
    out.push(fitLine(`${rulePart}${themeColor('textMute')}${truncate(tail, contentWidth)}${sgr.reset}`, columns))
  }

  return out
}

function fitLine(line: string, columns: number): string {
  const truncated = truncate(line, columns)
  if (visibleWidth(truncated) >= columns) return truncated
  return padRight(truncated, visibleWidth(truncated))
}

function statusGlyph(state: ToolRowState): string {
  switch (state) {
    case 'ok':      return '✓'
    case 'err':     return '✗'
    case 'run':     return '●'   // solid pulse glyph (oc-rail style)
    case 'pending': return '·'
  }
}

function statusColorFor(state: ToolRowState): string {
  switch (state) {
    case 'ok':      return themeColor('success')
    case 'err':     return themeColor('error')
    case 'run':     return themeColor('owl')      // accent pulse while running
    case 'pending': return themeColor('textSubtle')
  }
}

function cleanInline(value: string): string {
  return stripAnsi(String(value)).replace(/\s+/g, ' ').trim()
}

function normalizeColumns(columns?: number): number {
  if (!Number.isFinite(columns)) return DEFAULT_COLUMNS
  return Math.max(1, Math.floor(columns!))
}
