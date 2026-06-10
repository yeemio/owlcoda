/**
 * OwlCoda TUI Box Drawing
 *
 * Renders bordered boxes with text content, padding, and optional titles.
 * Uses Unicode box-drawing characters for clean terminal rendering.
 *
 * Supports multiple border styles (round, sharp, double, heavy, dashed, ascii)
 * and embedded titles in top/bottom borders.
 */

import { sgr, resolveColor, stripAnsi, visibleWidth, themed, themeColor, type OwlTheme } from './colors.js'
import { padRight, truncate } from './text.js'

// ─── Border character sets ────────────────────────────────────

export type BorderChars = {
  topLeft: string;     top: string;     topRight: string
  left: string;                          right: string
  bottomLeft: string;  bottom: string;  bottomRight: string
}

/** Named border styles. */
export const BORDER_STYLES = {
  round: {
    topLeft: '╭', top: '─', topRight: '╮',
    left: '│',               right: '│',
    bottomLeft: '╰', bottom: '─', bottomRight: '╯',
  },
  sharp: {
    topLeft: '┌', top: '─', topRight: '┐',
    left: '│',               right: '│',
    bottomLeft: '└', bottom: '─', bottomRight: '┘',
  },
  double: {
    topLeft: '╔', top: '═', topRight: '╗',
    left: '║',               right: '║',
    bottomLeft: '╚', bottom: '═', bottomRight: '╝',
  },
  heavy: {
    topLeft: '┏', top: '━', topRight: '┓',
    left: '┃',               right: '┃',
    bottomLeft: '┗', bottom: '━', bottomRight: '┛',
  },
  dashed: {
    topLeft: ' ', top: '╌', topRight: ' ',
    left: '╎',               right: '╎',
    bottomLeft: ' ', bottom: '╌', bottomRight: ' ',
  },
  ascii: {
    topLeft: '+', top: '-', topRight: '+',
    left: '|',               right: '|',
    bottomLeft: '+', bottom: '-', bottomRight: '+',
  },
  none: {
    topLeft: ' ', top: ' ', topRight: ' ',
    left: ' ',               right: ' ',
    bottomLeft: ' ', bottom: ' ', bottomRight: ' ',
  },
} as const satisfies Record<string, BorderChars>

export type BorderStyleName = keyof typeof BORDER_STYLES

/** Horizontal separator character (heavy). */
export const HEAVY_LINE = '━'
export const LIGHT_LINE = '─'
export const DOUBLE_LINE = '═'

// ─── Box rendering ────────────────────────────────────────────

export interface BoxOptions {
  /** Width of the box (including borders). Auto-calculated if omitted. */
  width?: number
  /** Border style name or custom chars. Default: 'round'. */
  border?: BorderStyleName | BorderChars
  /** ANSI color string for the border. Uses theme border color if omitted. */
  borderColor?: string
  /** Dim the border. Default: false. */
  borderDim?: boolean
  /** Padding inside the box (left/right). Default: 1. */
  paddingX?: number
  /** Padding inside the box (top/bottom lines). Default: 0. */
  paddingY?: number
  /** Title embedded in the top border. */
  title?: string
  /** Title color (ANSI string). */
  titleColor?: string
  /** Title alignment in border. Default: 'start'. */
  titleAlign?: 'start' | 'center' | 'end'
  /** Footer embedded in the bottom border. */
  footer?: string
  /** Footer color (ANSI string). */
  footerColor?: string
}

/**
 * Render a bordered box around content lines.
 *
 * ```
 * ╭─── Title ───────────────╮
 * │ content line 1           │
 * │ content line 2           │
 * ╰──────────────────────────╯
 * ```
 */
export function renderBox(contentLines: string[], opts: BoxOptions = {}): string {
  const chars = resolveBorder(opts.border ?? 'round')
  const px = opts.paddingX ?? 1
  const py = opts.paddingY ?? 0
  const borderCol = opts.borderColor ?? themeColor('border')
  const dimBorder = opts.borderDim ?? false

  // Calculate inner width
  const maxContentWidth = contentLines.reduce(
    (max, line) => Math.max(max, visibleWidth(line)),
    0,
  )
  const innerWidth = opts.width
    ? opts.width - 2 // subtract left+right border
    : maxContentWidth + px * 2

  const totalWidth = innerWidth + 2 // +2 for borders

  // Style helper for border characters
  const bc = (s: string): string => {
    let styled = `${borderCol}${s}${sgr.reset}`
    if (dimBorder) styled = `${sgr.dim}${borderCol}${s}${sgr.reset}`
    return styled
  }

  const lines: string[] = []

  // Top border
  const topFill = chars.top.repeat(Math.max(0, innerWidth))
  if (opts.title) {
    const titleStyled = opts.titleColor
      ? `${opts.titleColor}${opts.title}${sgr.reset}`
      : opts.title
    const titleText = ` ${titleStyled} `
    const titleVisWidth = visibleWidth(titleText)
    const topLine = embedTitle(topFill, titleText, titleVisWidth, opts.titleAlign ?? 'start', chars.top)
    lines.push(`${bc(chars.topLeft)}${bc(topLine)}${bc(chars.topRight)}`)
  } else {
    lines.push(`${bc(chars.topLeft)}${bc(topFill)}${bc(chars.topRight)}`)
  }

  // Top padding
  for (let i = 0; i < py; i++) {
    lines.push(`${bc(chars.left)}${' '.repeat(innerWidth)}${bc(chars.right)}`)
  }

  // Content lines
  for (const content of contentLines) {
    const pad = ' '.repeat(px)
    const visible = visibleWidth(content)
    const rightPad = Math.max(0, innerWidth - px * 2 - visible)
    lines.push(`${bc(chars.left)}${pad}${content}${' '.repeat(rightPad)}${pad.slice(0, Math.max(0, innerWidth - px - visible - rightPad))}${bc(chars.right)}`)
  }

  // Hmm, the above right-padding logic is tricky. Let me simplify:
  // Actually let's redo content lines properly.
  lines.length = 0 // Reset

  // Re-render top
  if (opts.title) {
    const titleStyled = opts.titleColor
      ? `${opts.titleColor}${opts.title}${sgr.reset}`
      : opts.title
    const titleText = ` ${titleStyled} `
    const topLine = embedTitle(topFill, titleText, visibleWidth(titleText), opts.titleAlign ?? 'start', chars.top)
    lines.push(`${bc(chars.topLeft)}${bc(topLine)}${bc(chars.topRight)}`)
  } else {
    lines.push(`${bc(chars.topLeft)}${bc(topFill)}${bc(chars.topRight)}`)
  }

  // Top padding
  for (let i = 0; i < py; i++) {
    lines.push(`${bc(chars.left)}${' '.repeat(innerWidth)}${bc(chars.right)}`)
  }

  // Content with correct padding
  for (const content of contentLines) {
    const padded = padContentLine(content, innerWidth, px)
    lines.push(`${bc(chars.left)}${padded}${bc(chars.right)}`)
  }

  // Bottom padding
  for (let i = 0; i < py; i++) {
    lines.push(`${bc(chars.left)}${' '.repeat(innerWidth)}${bc(chars.right)}`)
  }

  // Bottom border
  const bottomFill = chars.bottom.repeat(Math.max(0, innerWidth))
  if (opts.footer) {
    const footerStyled = opts.footerColor
      ? `${opts.footerColor}${opts.footer}${sgr.reset}`
      : opts.footer
    const footerText = ` ${footerStyled} `
    const bottomLine = embedTitle(bottomFill, footerText, visibleWidth(footerText), 'center', chars.bottom)
    lines.push(`${bc(chars.bottomLeft)}${bc(bottomLine)}${bc(chars.bottomRight)}`)
  } else {
    lines.push(`${bc(chars.bottomLeft)}${bc(bottomFill)}${bc(chars.bottomRight)}`)
  }

  return lines.join('\n')
}

/**
 * Render a simple horizontal separator line.
 */
export function renderSeparator(width: number, style: 'light' | 'heavy' | 'double' | 'dashed' = 'light'): string {
  const chars: Record<string, string> = {
    light: '─', heavy: '━', double: '═', dashed: '╌',
  }
  const borderCol = themeColor('borderDim')
  return `${borderCol}${(chars[style] ?? '─').repeat(width)}${sgr.reset}`
}

/**
 * Render a colored divider with optional title.
 * Used by Pane-style components to draw a top border line.
 *
 * ```
 * ─────────── Title ───────────
 * ```
 */
export function renderDivider(opts: {
  /** Optional title shown centered in the divider line. */
  title?: string
  /** Theme color for the divider. Default: dimmed border. */
  color?: string
  /** Width. Default: terminal width. */
  width?: number
  /** Divider character. Default: '─'. */
  char?: string
} = {}): string {
  const cols = opts.width ?? (process.stdout.columns ?? 80)
  const ch = opts.char ?? '─'
  const color = opts.color ? themeColor(opts.color as any) : themeColor('borderDim')

  if (!opts.title) {
    return `${color}${ch.repeat(cols)}${sgr.reset}`
  }

  const titleVis = visibleWidth(opts.title)
  const sideWidth = Math.max(0, Math.floor((cols - titleVis - 2) / 2))
  const rightWidth = Math.max(0, cols - sideWidth - titleVis - 2)
  return `${color}${ch.repeat(sideWidth)}${sgr.reset} ${opts.title} ${color}${ch.repeat(rightWidth)}${sgr.reset}`
}

/**
 * Render a two-column layout side by side.
 * Each column is an array of lines.
 */
export function renderColumns(
  left: string[],
  right: string[],
  opts: {
    leftWidth: number
    rightWidth: number
    divider?: string
    dividerColor?: string
  },
): string[] {
  const maxRows = Math.max(left.length, right.length)
  const divider = opts.divider ?? '│'
  const divCol = opts.dividerColor ?? themeColor('borderDim')
  const div = `${divCol}${divider}${sgr.reset}`
  const lines: string[] = []

  for (let i = 0; i < maxRows; i++) {
    const l = padRight(left[i] ?? '', opts.leftWidth)
    const r = padRight(right[i] ?? '', opts.rightWidth)
    lines.push(`${l} ${div} ${r}`)
  }
  return lines
}

// ─── Internals ────────────────────────────────────────────────

function resolveBorder(style: BorderStyleName | BorderChars): BorderChars {
  if (typeof style === 'string') {
    return BORDER_STYLES[style] ?? BORDER_STYLES.round
  }
  return style
}

/** Pad a content line to fill the inner width with horizontal padding. */
function padContentLine(content: string, innerWidth: number, px: number): string {
  const leftPad = ' '.repeat(px)
  const contentWidth = visibleWidth(content)
  const rightPad = Math.max(0, innerWidth - px - contentWidth)
  // If the content is wider than innerWidth - px, just let it overflow
  if (contentWidth + px >= innerWidth) {
    return `${leftPad}${content}`
  }
  return `${leftPad}${content}${' '.repeat(rightPad)}`
}

/** Embed a title string into a border line at the given alignment. */
function embedTitle(
  borderLine: string,
  titleText: string,
  titleVisWidth: number,
  align: 'start' | 'center' | 'end',
  borderChar: string,
): string {
  const borderLen = borderLine.length

  if (titleVisWidth >= borderLen - 2) {
    return titleText.slice(0, borderLen)
  }

  let pos: number
  switch (align) {
    case 'center':
      pos = Math.floor((borderLen - titleVisWidth) / 2)
      break
    case 'end':
      pos = borderLen - titleVisWidth - 2
      break
    case 'start':
    default:
      pos = 2
      break
  }

  pos = Math.max(1, Math.min(pos, borderLen - titleVisWidth - 1))

  const before = borderChar.repeat(pos)
  const after = borderChar.repeat(Math.max(0, borderLen - pos - titleVisWidth))
  return `${before}${titleText}${after}`
}
