/**
 * OwlCoda TUI Text Utilities
 *
 * Width-aware text wrapping, truncation, and measurement.
 * Handles ANSI escape codes correctly during wrapping/truncation.
 */

import { stripAnsi, visibleWidth, sgr } from './colors.js'
import stringWidth from 'string-width'

/**
 * Truncate a string to `maxWidth` visible characters, adding ellipsis.
 * Preserves ANSI codes (removed from width calculation).
 */
export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  if (visibleWidth(text) <= maxWidth) return text
  if (maxWidth <= 0) return ''
  const ellipsisWidth = visibleWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth)

  const target = maxWidth - ellipsisWidth
  let visible = 0
  let i = 0

  while (i < text.length && visible < target) {
    // Skip ANSI escape sequences
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i)
      if (end !== -1) {
        i = end + 1
        continue
      }
    }
    const char = text[i]!
    visible += stringWidth(char)
    i += char.length
    if (visible > target) {
      i -= char.length
      break
    }
  }

  return text.slice(0, i) + sgr.reset + ellipsis
}

/**
 * Truncate in the middle: keep start and end, replace middle with ellipsis.
 * Useful for file paths.
 */
export function truncateMiddle(text: string, maxWidth: number, ellipsis = '…'): string {
  const plain = stripAnsi(text)
  if (visibleWidth(plain) <= maxWidth) return text
  if (maxWidth <= visibleWidth(ellipsis)) return ellipsis.slice(0, maxWidth)

  const available = maxWidth - visibleWidth(ellipsis)
  const headLen = Math.ceil(available / 2)
  const tailLen = Math.floor(available / 2)
  let head = ''
  let tail = ''
  let headWidth = 0
  let tailWidth = 0

  for (const char of Array.from(plain)) {
    const width = stringWidth(char)
    if (headWidth + width > headLen) break
    head += char
    headWidth += width
  }

  for (const char of Array.from(plain).reverse()) {
    const width = stringWidth(char)
    if (tailWidth + width > tailLen) break
    tail = char + tail
    tailWidth += width
  }

  return head + ellipsis + tail
}

/**
 * Wrap text to fit within `maxWidth` visible columns.
 * Respects word boundaries when possible.
 * Strips existing ANSI codes and re-applies aren't practical for word-wrap,
 * so this operates on plain text.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]

  const lines: string[] = []

  for (const rawLine of text.split('\n')) {
    const plain = stripAnsi(rawLine)
    if (visibleWidth(plain) <= maxWidth) {
      lines.push(rawLine)
      continue
    }

    // Word-break wrapping
    const words = plain.split(/(\s+)/)
    let current = ''
    for (const word of words) {
      if (visibleWidth(current) + visibleWidth(word) > maxWidth && current.length > 0) {
        lines.push(current)
        current = word.trimStart()
      } else {
        current += word
      }
    }
    if (current.length > 0) {
      lines.push(current)
    }
  }

  return lines
}

/**
 * Hard wrap: break at exactly maxWidth characters regardless of words.
 */
export function hardWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]

  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const plain = stripAnsi(rawLine)
    if (visibleWidth(plain) <= maxWidth) {
      lines.push(rawLine)
      continue
    }

    let current = ''
    let currentWidth = 0
    for (const char of Array.from(plain)) {
      const width = stringWidth(char)
      if (currentWidth + width > maxWidth && currentWidth > 0) {
        lines.push(current)
        current = char
        currentWidth = width
      } else {
        current += char
        currentWidth += width
      }
    }
    if (current.length > 0) {
      lines.push(current)
    }
  }
  return lines
}

/**
 * Pad a string to a fixed visible width (right-padded with spaces).
 */
export function padRight(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return text
  return text + ' '.repeat(width - visible)
}

/**
 * Pad a string to a fixed visible width (left-padded with spaces).
 */
export function padLeft(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return text
  return ' '.repeat(width - visible) + text
}

/**
 * Center a string within a fixed visible width.
 */
export function center(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return text
  const leftPad = Math.floor((width - visible) / 2)
  const rightPad = width - visible - leftPad
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
}

/**
 * Repeat a character to fill a width.
 */
export function repeat(char: string, width: number): string {
  if (width <= 0) return ''
  return char.repeat(width)
}
