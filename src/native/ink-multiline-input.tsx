import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import sliceAnsi from 'slice-ansi'
import stringWidth from 'string-width'

import { themeToInkHex } from './ink-theme.js'
import {
  detectBufferedInputSignals,
  stripBufferedMouseArtifacts,
  stripModifiedEnterArtifacts,
} from './repl-shared.js'
import { stripAnsi } from './tui/colors.js'

interface MultilineInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  focus?: boolean
  maxVisibleLines?: number
  disabled?: boolean
  mode?: 'normal' | 'bash'
  hint?: string
}

interface LineDeletionResult {
  value: string
  cursorRow: number
  cursorCol: number
}

interface RenderedCursorLine {
  before: string
  cursorChar: string
  after: string
}

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

function splitGraphemes(text: string): string[] {
  if (!text) return []
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment)
  }
  return Array.from(text)
}

function getLineLength(line: string): number {
  return splitGraphemes(line).length
}

function splitLineAtCursor(line: string, cursorCol: number): {
  before: string
  after: string
  graphemes: string[]
  boundedCol: number
} {
  const graphemes = splitGraphemes(line)
  const boundedCol = Math.max(0, Math.min(cursorCol, graphemes.length))
  return {
    before: graphemes.slice(0, boundedCol).join(''),
    after: graphemes.slice(boundedCol).join(''),
    graphemes,
    boundedCol,
  }
}

function findPrevWordBoundary(line: string, col: number): number {
  const graphemes = splitGraphemes(line)
  let pos = Math.min(col, graphemes.length)
  // Skip whitespace backward
  while (pos > 0 && /\s/.test(graphemes[pos - 1] ?? '')) pos--
  // Skip word chars backward
  while (pos > 0 && /\S/.test(graphemes[pos - 1] ?? '')) pos--
  return pos
}

function findNextWordBoundary(line: string, col: number): number {
  const graphemes = splitGraphemes(line)
  let pos = Math.min(col, graphemes.length)
  // Skip word chars forward
  while (pos < graphemes.length && /\S/.test(graphemes[pos] ?? '')) pos++
  // Skip whitespace forward
  while (pos < graphemes.length && /\s/.test(graphemes[pos] ?? '')) pos++
  return pos
}

function padDisplayWidth(text: string, width: number): string {
  const padding = Math.max(0, width - stringWidth(text))
  return text + ' '.repeat(padding)
}

function resolveLines(value: string): string[] {
  const split = value.split('\n')
  return split.length > 0 ? split : ['']
}

function clampPosition(lines: string[], cursorRow: number, cursorCol: number): {
  row: number
  col: number
} {
  const row = Math.max(0, Math.min(cursorRow, lines.length - 1))
  const col = Math.max(0, Math.min(cursorCol, getLineLength(lines[row] ?? '')))
  return { row, col }
}

export function deleteToLineStart(
  value: string,
  cursorRow: number,
  cursorCol: number,
): LineDeletionResult {
  const lines = [...resolveLines(value)]
  const { row, col } = clampPosition(lines, cursorRow, cursorCol)

  if (col === 0) {
    return {
      value: lines.join('\n'),
      cursorRow: row,
      cursorCol: 0,
    }
  }

  const current = lines[row] ?? ''
  lines[row] = splitLineAtCursor(current, col).after
  return {
    value: lines.join('\n'),
    cursorRow: row,
    cursorCol: 0,
  }
}

export function deleteToLineEnd(
  value: string,
  cursorRow: number,
  cursorCol: number,
): LineDeletionResult {
  const lines = [...resolveLines(value)]
  const { row, col } = clampPosition(lines, cursorRow, cursorCol)
  const current = lines[row] ?? ''

  if (col >= current.length) {
    return {
      value: lines.join('\n'),
      cursorRow: row,
      cursorCol: col,
    }
  }

  lines[row] = splitLineAtCursor(current, col).before
  return {
    value: lines.join('\n'),
    cursorRow: row,
    cursorCol: col,
  }
}

export function computeVisibleLineWindow(
  line: string,
  cursorCol: number,
  width: number,
): {
  startCol: number
  displayLine: string
  cursorDisplayCol: number
} {
  const plainLine = stripAnsi(line)
  const safeWidth = Math.max(1, width)
  const { before, graphemes, boundedCol } = splitLineAtCursor(plainLine, cursorCol)
  const cursorChar = graphemes[boundedCol] ?? ' '
  const cursorWidth = Math.max(1, stringWidth(cursorChar))
  const prefixWidth = stringWidth(before)
  const renderText = graphemes[boundedCol] ? plainLine : `${plainLine} `
  const virtualWidth = Math.max(stringWidth(renderText), prefixWidth + cursorWidth)
  const maxStart = Math.max(0, virtualWidth - safeWidth)
  const startCol = Math.max(0, Math.min(prefixWidth + cursorWidth - safeWidth, maxStart))
  const displayLine = padDisplayWidth(sliceAnsi(renderText, startCol, startCol + safeWidth), safeWidth)
  const cursorDisplayCol = Math.max(0, Math.min(prefixWidth - startCol, safeWidth - 1))
  return {
    startCol,
    displayLine,
    cursorDisplayCol,
  }
}

function computeRenderedCursorLine(
  line: string,
  cursorCol: number,
  width: number,
): RenderedCursorLine {
  const plainLine = stripAnsi(line)
  const safeWidth = Math.max(1, width)
  const { before, after, graphemes, boundedCol } = splitLineAtCursor(plainLine, cursorCol)
  const cursorChar = graphemes[boundedCol] ?? ' '
  const cursorWidth = Math.max(1, stringWidth(cursorChar))
  const prefixWidth = stringWidth(before)
  const renderText = graphemes[boundedCol] ? plainLine : `${plainLine} `
  const virtualWidth = Math.max(stringWidth(renderText), prefixWidth + cursorWidth)
  const maxStart = Math.max(0, virtualWidth - safeWidth)
  const startCol = Math.max(0, Math.min(prefixWidth + cursorWidth - safeWidth, maxStart))
  const endCol = startCol + safeWidth
  const renderedBefore = sliceAnsi(before, startCol, prefixWidth)
  const renderedAfter = sliceAnsi(after, 0, Math.max(0, endCol - prefixWidth - cursorWidth))
  const visibleWidth = stringWidth(renderedBefore) + cursorWidth + stringWidth(renderedAfter)

  return {
    before: renderedBefore,
    cursorChar,
    after: renderedAfter + ' '.repeat(Math.max(0, safeWidth - visibleWidth)),
  }
}

function stripKnownModifiedEnterFragments(text: string): string {
  return text
    .replace(/\x1b?\[27;2;13~/g, '')
    .replace(/\x1b?\[27;2;/g, '')
    .replace(/\x1b?\[27;2/g, '')
    .replace(/\x1b?\[13;2u/g, '')
    .replace(/\x1b?\[13~/g, '')
    .replace(/\x1b?\[13;/g, '')
}

function hasModifiedEnterArtifact(text: string): boolean {
  return /(?:\x1b?\[)?(?:13;2u|13~|27;2;13~|27;2;)$/.test(text)
}

const MODIFIED_ENTER_TOKEN_RE = /\x1b\[27;2;13~|\[27;2;13~|27;2;13~|\x1b\[13;2u|\[13;2u|13;2u|\x1b\[13~|\[13~|13~/g

type InputToken =
  | { type: 'text'; value: string }
  | { type: 'continue' }
  | { type: 'backspace' }
  | { type: 'deleteLinePrefix' }
  | { type: 'deleteLineSuffix' }

function tokenizeInputChunk(text: string): InputToken[] {
  const tokens: InputToken[] = []
  let buffer = ''
  let index = 0

  while (index < text.length) {
    MODIFIED_ENTER_TOKEN_RE.lastIndex = index
    const match = MODIFIED_ENTER_TOKEN_RE.exec(text)
    if (match && match.index === index) {
      if (buffer.length > 0) {
        tokens.push({ type: 'text', value: buffer })
        buffer = ''
      }
      tokens.push({ type: 'continue' })
      index += match[0].length
      continue
    }

    const char = text[index]!
    if (char === '\u007f' || char === '\u0008' || char === '\b') {
      if (buffer.length > 0) {
        tokens.push({ type: 'text', value: buffer })
        buffer = ''
      }
      tokens.push({ type: 'backspace' })
      index += 1
      continue
    }

    if (char === '\u0015') {
      if (buffer.length > 0) {
        tokens.push({ type: 'text', value: buffer })
        buffer = ''
      }
      tokens.push({ type: 'deleteLinePrefix' })
      index += 1
      continue
    }

    if (char === '\u000b') {
      if (buffer.length > 0) {
        tokens.push({ type: 'text', value: buffer })
        buffer = ''
      }
      tokens.push({ type: 'deleteLineSuffix' })
      index += 1
      continue
    }

    buffer += char
    index += 1
  }

  if (buffer.length > 0) {
    tokens.push({ type: 'text', value: buffer })
  }

  return tokens
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  maxVisibleLines = 8,
  disabled = false,
  mode = 'normal',
  hint,
}: MultilineInputProps): React.ReactElement {
  const { stdout } = useStdout()
  const terminalCols = stdout.columns || 80
  const innerWidth = Math.max(8, terminalCols - 4)

  const lines = useMemo(() => {
    const split = value.split('\n')
    return split.length > 0 ? split : ['']
  }, [value])

  const [cursorRow, setCursorRow] = useState(0)
  const [cursorCol, setCursorCol] = useState(0)
  const valueRef = useRef(value)
  const cursorRowRef = useRef(0)
  const cursorColRef = useRef(0)
  const signalRemainderRef = useRef('')
  const mouseRemainderRef = useRef('')

  const clampCursor = useCallback((row: number, col: number, sourceLines: string[]) => {
    const nextRow = Math.max(0, Math.min(row, sourceLines.length - 1))
    const nextCol = Math.max(0, Math.min(col, getLineLength(sourceLines[nextRow] ?? '')))
    cursorRowRef.current = nextRow
    cursorColRef.current = nextCol
    setCursorRow(nextRow)
    setCursorCol(nextCol)
  }, [])

  const applyValue = useCallback((
    nextValue: string,
    nextRow: number,
    nextCol: number,
    sourceLines: string[],
  ) => {
    valueRef.current = nextValue
    onChange(nextValue)
    clampCursor(nextRow, nextCol, sourceLines)
  }, [clampCursor, onChange])

  useEffect(() => {
    valueRef.current = value
    const nextLines = value.split('\n')
    const boundedRow = Math.max(0, Math.min(cursorRow, nextLines.length - 1))
    const boundedCol = Math.max(0, Math.min(cursorCol, getLineLength(nextLines[boundedRow] ?? '')))
    cursorRowRef.current = boundedRow
    cursorColRef.current = boundedCol
    if (boundedRow !== cursorRow) setCursorRow(boundedRow)
    if (boundedCol !== cursorCol) setCursorCol(boundedCol)
  }, [value, cursorCol, cursorRow])

  const insertLineBreak = useCallback(() => {
    const currentLines = valueRef.current.split('\n')
    const nextLines = currentLines.length > 0 ? [...currentLines] : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, nextLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(nextLines[activeRow] ?? '')))
    const current = nextLines[activeRow] ?? ''
    const { before, after } = splitLineAtCursor(current, activeCol)
    nextLines[activeRow] = before
    nextLines.splice(activeRow + 1, 0, after)
    applyValue(nextLines.join('\n'), activeRow + 1, 0, nextLines)
  }, [applyValue])

  const deleteBackward = useCallback(() => {
    const currentLines = valueRef.current.split('\n')
    const nextLines = currentLines.length > 0 ? [...currentLines] : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, nextLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(nextLines[activeRow] ?? '')))
    const current = nextLines[activeRow] ?? ''
    const graphemes = splitGraphemes(current)

    if (activeCol > 0) {
      nextLines[activeRow] = graphemes.slice(0, activeCol - 1).join('') + graphemes.slice(activeCol).join('')
      applyValue(nextLines.join('\n'), activeRow, activeCol - 1, nextLines)
      return
    }

    if (activeRow > 0) {
      const prevLine = nextLines[activeRow - 1] ?? ''
      nextLines.splice(activeRow, 1)
      nextLines[activeRow - 1] = prevLine + current
      applyValue(nextLines.join('\n'), activeRow - 1, getLineLength(prevLine), nextLines)
    }
  }, [applyValue])

  const deleteLinePrefix = useCallback(() => {
    const result = deleteToLineStart(
      valueRef.current,
      cursorRowRef.current,
      cursorColRef.current,
    )
    applyValue(
      result.value,
      result.cursorRow,
      result.cursorCol,
      resolveLines(result.value),
    )
  }, [applyValue])

  const deleteLineSuffix = useCallback(() => {
    const result = deleteToLineEnd(
      valueRef.current,
      cursorRowRef.current,
      cursorColRef.current,
    )
    applyValue(
      result.value,
      result.cursorRow,
      result.cursorCol,
      resolveLines(result.value),
    )
  }, [applyValue])

  const deleteWordBefore = useCallback(() => {
    const currentLines = valueRef.current.split('\n')
    const nextLines = currentLines.length > 0 ? [...currentLines] : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, nextLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(nextLines[activeRow] ?? '')))
    const current = nextLines[activeRow] ?? ''

    if (activeCol === 0) {
      // At start of line: merge with previous line (like backspace)
      if (activeRow > 0) {
        const prevLine = nextLines[activeRow - 1] ?? ''
        nextLines.splice(activeRow, 1)
        nextLines[activeRow - 1] = prevLine + current
        applyValue(nextLines.join('\n'), activeRow - 1, getLineLength(prevLine), nextLines)
      }
      return
    }

    const boundary = findPrevWordBoundary(current, activeCol)
    const graphemes = splitGraphemes(current)
    nextLines[activeRow] = graphemes.slice(0, boundary).join('') + graphemes.slice(activeCol).join('')
    applyValue(nextLines.join('\n'), activeRow, boundary, nextLines)
  }, [applyValue])

  const deleteWordAfter = useCallback(() => {
    const currentLines = valueRef.current.split('\n')
    const nextLines = currentLines.length > 0 ? [...currentLines] : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, nextLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(nextLines[activeRow] ?? '')))
    const current = nextLines[activeRow] ?? ''
    const graphemes = splitGraphemes(current)

    if (activeCol >= graphemes.length) {
      // At end of line: merge next line
      if (activeRow < nextLines.length - 1) {
        const nextLine = nextLines[activeRow + 1] ?? ''
        nextLines[activeRow] = current + nextLine
        nextLines.splice(activeRow + 1, 1)
        applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
      }
      return
    }

    const boundary = findNextWordBoundary(current, activeCol)
    nextLines[activeRow] = graphemes.slice(0, activeCol).join('') + graphemes.slice(boundary).join('')
    applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
  }, [applyValue])

  const insertText = useCallback((text: string) => {
    if (!text) return
    const currentLines = valueRef.current.split('\n')
    const liveLines = currentLines.length > 0 ? [...currentLines] : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, liveLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(liveLines[activeRow] ?? '')))
    const normalized = text.replace(/\r/g, '\n')

    if (/^\n+$/.test(normalized)) {
      return
    }

    if (normalized.includes('\n')) {
      const chunks = normalized.split('\n')
      const current = liveLines[activeRow] ?? ''
      const { before, after } = splitLineAtCursor(current, activeCol)
      liveLines[activeRow] = before + (chunks[0] ?? '')
      for (let index = 1; index < chunks.length; index++) {
        liveLines.splice(activeRow + index, 0, chunks[index] ?? '')
      }
      const lastIndex = activeRow + chunks.length - 1
      liveLines[lastIndex] = (liveLines[lastIndex] ?? '') + after
      applyValue(liveLines.join('\n'), lastIndex, getLineLength(liveLines[lastIndex] ?? '') - getLineLength(after), liveLines)
      return
    }

    const current = liveLines[activeRow] ?? ''
    const { before, after } = splitLineAtCursor(current, activeCol)
    liveLines[activeRow] = before + normalized + after
    applyValue(liveLines.join('\n'), activeRow, activeCol + getLineLength(normalized), liveLines)
  }, [applyValue])

  useInput((input, key) => {
    if (disabled) return
    if (input.includes('\u0003')) return

    const mouseState = stripBufferedMouseArtifacts(input, mouseRemainderRef.current)
    mouseRemainderRef.current = mouseState.remainder

    const currentLines = valueRef.current.split('\n')
    const liveLines = currentLines.length > 0 ? currentLines : ['']
    const activeRow = Math.max(0, Math.min(cursorRowRef.current, liveLines.length - 1))
    const activeCol = Math.max(0, Math.min(cursorColRef.current, getLineLength(liveLines[activeRow] ?? '')))

    const previousRemainder = signalRemainderRef.current
    const signalState = detectBufferedInputSignals(mouseState.cleaned, previousRemainder)
    signalRemainderRef.current = signalState.remainder
    let processedInput = (previousRemainder + mouseState.cleaned)
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
    if (signalState.remainder.length > 0 && processedInput.endsWith(signalState.remainder)) {
      processedInput = processedInput.slice(0, -signalState.remainder.length)
    }
    const sanitizedInput = stripKnownModifiedEnterFragments(
      stripModifiedEnterArtifacts(
        processedInput,
      ),
    )
    const chunkTokens = tokenizeInputChunk(sanitizedInput)

    const artifactContinue = hasModifiedEnterArtifact(input)

    if ((signalState.continueMultiline || artifactContinue) && !key.return) {
      insertLineBreak()
      return
    }

    if (!sanitizedInput && (signalState.remainder.length > 0 || signalState.pasteStart || signalState.pasteEnd)) {
      return
    }

    // Same-batch text+Enter detection: when text and Enter arrive in a single
    // stdin chunk (e.g. `tmux send-keys 'hello' Enter`), Ink delivers them as
    // one event with key.return=false because parseKeypress only recognizes
    // Return when the *entire* input equals '\r'. Detect trailing \r/\n in the
    // raw input and treat it as: insert text, then submit.
    if (!key.return && /[\r\n]+$/.test(input)) {
      const textPart = sanitizedInput.replace(/[\r\n]+/g, '')
      if (textPart) {
        insertText(textPart)
      }
      if (key.shift || key.meta) {
        insertLineBreak()
        return
      }
      if (valueRef.current.trim().length > 0) {
        onSubmit(valueRef.current)
      }
      return
    }

    if (
      !key.return &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.upArrow &&
      !key.downArrow &&
      !key.tab &&
      chunkTokens.some((token) => token.type !== 'text')
    ) {
      for (const token of chunkTokens) {
        if (token.type === 'text') {
          insertText(token.value)
        } else if (token.type === 'continue') {
          insertLineBreak()
        } else if (token.type === 'backspace') {
          deleteBackward()
        } else if (token.type === 'deleteLinePrefix') {
          deleteLinePrefix()
        } else if (token.type === 'deleteLineSuffix') {
          deleteLineSuffix()
        }
      }
      return
    }

    if (key.return) {
      // When text and Enter arrive in the same batch (e.g. tmux paste, fast
      // typing), the text tokens in this batch haven't been inserted yet
      // because the chunked-token path at line 458 is gated on !key.return.
      // Flush any pending text into the value before deciding to submit.
      if (sanitizedInput) {
        const textOnly = sanitizedInput.replace(/[\r\n]+/g, '')
        if (textOnly) {
          insertText(textOnly)
        }
      }

      if (key.shift || key.meta) {
        insertLineBreak()
        return
      }

      if (valueRef.current.trim().length > 0) {
        onSubmit(valueRef.current)
      }
      return
    }

    const isCtrlU = input === '\u0015' || sanitizedInput === '\u0015' || (key.ctrl && input.toLowerCase() === 'u')
    const isCtrlK = input === '\u000b' || sanitizedInput === '\u000b' || (key.ctrl && input.toLowerCase() === 'k')

    if (isCtrlU) {
      deleteLinePrefix()
      return
    }

    if (isCtrlK) {
      deleteLineSuffix()
      return
    }

    // Emacs: Ctrl+A — start of line
    if (key.ctrl && input.toLowerCase() === 'a') {
      clampCursor(activeRow, 0, liveLines)
      return
    }

    // Emacs: Ctrl+E — end of line
    if (key.ctrl && input.toLowerCase() === 'e') {
      clampCursor(activeRow, getLineLength(liveLines[activeRow] ?? ''), liveLines)
      return
    }

    // Emacs: Ctrl+D — delete forward (or do nothing on empty)
    if (key.ctrl && input.toLowerCase() === 'd') {
      const current = liveLines[activeRow] ?? ''
      const graphemes = splitGraphemes(current)
      if (activeCol < graphemes.length) {
        const nextLines = [...liveLines]
        nextLines[activeRow] = graphemes.slice(0, activeCol).join('') + graphemes.slice(activeCol + 1).join('')
        applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
      } else if (activeRow < liveLines.length - 1) {
        const nextLines = [...liveLines]
        const nextLine = nextLines[activeRow + 1] ?? ''
        nextLines[activeRow] = current + nextLine
        nextLines.splice(activeRow + 1, 1)
        applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
      }
      return
    }

    // Emacs: Ctrl+W — delete word before cursor
    if (key.ctrl && input.toLowerCase() === 'w') {
      deleteWordBefore()
      return
    }

    // Emacs: Ctrl+B — left (matches upstream)
    if (key.ctrl && input.toLowerCase() === 'b') {
      if (activeCol > 0) {
        clampCursor(activeRow, activeCol - 1, liveLines)
      } else if (activeRow > 0) {
        clampCursor(activeRow - 1, getLineLength(liveLines[activeRow - 1] ?? ''), liveLines)
      }
      return
    }

    // Emacs: Ctrl+F — right (matches upstream)
    if (key.ctrl && input.toLowerCase() === 'f') {
      if (activeCol < getLineLength(liveLines[activeRow] ?? '')) {
        clampCursor(activeRow, activeCol + 1, liveLines)
      } else if (activeRow < liveLines.length - 1) {
        clampCursor(activeRow + 1, 0, liveLines)
      }
      return
    }

    // Emacs: Ctrl+P — up (matches upstream)
    if (key.ctrl && input.toLowerCase() === 'p') {
      if (activeRow > 0) {
        clampCursor(activeRow - 1, activeCol, liveLines)
      }
      return
    }

    // Emacs: Ctrl+N — down (matches upstream)
    if (key.ctrl && input.toLowerCase() === 'n') {
      if (activeRow < liveLines.length - 1) {
        clampCursor(activeRow + 1, activeCol, liveLines)
      }
      return
    }

    const isBackspace = key.backspace
      || (key.ctrl && input.toLowerCase() === 'h')
      || sanitizedInput === '\u007f'
      || sanitizedInput === '\b'
      || sanitizedInput === '\u0008'
    const isDelete = key.delete

    if (isBackspace || isDelete) {
      const current = liveLines[activeRow] ?? ''
      const graphemes = splitGraphemes(current)
      const treatDeleteAsBackspace = isDelete
        && activeCol > 0
        && activeCol === graphemes.length
        && activeRow >= 0
        && !key.ctrl
        && !key.meta
        && !key.shift

      if ((isBackspace || treatDeleteAsBackspace) && activeCol > 0) {
        const nextLines = [...liveLines]
        nextLines[activeRow] = graphemes.slice(0, activeCol - 1).join('') + graphemes.slice(activeCol).join('')
        applyValue(nextLines.join('\n'), activeRow, activeCol - 1, nextLines)
      } else if ((isBackspace || treatDeleteAsBackspace) && activeRow > 0) {
        const nextLines = [...liveLines]
        const prevLine = nextLines[activeRow - 1] ?? ''
        nextLines.splice(activeRow, 1)
        nextLines[activeRow - 1] = prevLine + current
        applyValue(nextLines.join('\n'), activeRow - 1, getLineLength(prevLine), nextLines)
      } else if (isDelete && activeCol < graphemes.length) {
        const nextLines = [...liveLines]
        nextLines[activeRow] = graphemes.slice(0, activeCol).join('') + graphemes.slice(activeCol + 1).join('')
        applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
      } else if (isDelete && activeRow < liveLines.length - 1) {
        const nextLines = [...liveLines]
        const nextLine = nextLines[activeRow + 1] ?? ''
        nextLines[activeRow] = current + nextLine
        nextLines.splice(activeRow + 1, 1)
        applyValue(nextLines.join('\n'), activeRow, activeCol, nextLines)
      }
      return
    }

    // Word navigation: Ctrl+Left or Alt+Left — previous word
    if (key.leftArrow && (key.ctrl || key.meta)) {
      const boundary = findPrevWordBoundary(liveLines[activeRow] ?? '', activeCol)
      if (boundary < activeCol) {
        clampCursor(activeRow, boundary, liveLines)
      } else if (activeRow > 0) {
        clampCursor(activeRow - 1, getLineLength(liveLines[activeRow - 1] ?? ''), liveLines)
      }
      return
    }

    // Word navigation: Ctrl+Right or Alt+Right — next word
    if (key.rightArrow && (key.ctrl || key.meta)) {
      const boundary = findNextWordBoundary(liveLines[activeRow] ?? '', activeCol)
      if (boundary > activeCol) {
        clampCursor(activeRow, boundary, liveLines)
      } else if (activeRow < liveLines.length - 1) {
        clampCursor(activeRow + 1, 0, liveLines)
      }
      return
    }

    if (key.leftArrow) {
      if (activeCol > 0) {
        clampCursor(activeRow, activeCol - 1, liveLines)
      } else if (activeRow > 0) {
        clampCursor(activeRow - 1, getLineLength(liveLines[activeRow - 1] ?? ''), liveLines)
      }
      return
    }

    if (key.rightArrow) {
      if (activeCol < getLineLength(liveLines[activeRow] ?? '')) {
        clampCursor(activeRow, activeCol + 1, liveLines)
      } else if (activeRow < liveLines.length - 1) {
        clampCursor(activeRow + 1, 0, liveLines)
      }
      return
    }

    if (key.upArrow) {
      if (activeRow > 0) {
        clampCursor(activeRow - 1, activeCol, liveLines)
      }
      return
    }

    if (key.downArrow) {
      if (activeRow < liveLines.length - 1) {
        clampCursor(activeRow + 1, activeCol, liveLines)
      }
      return
    }

    // Home key — start of line
    if (input === '\x1b[H' || input === '\x1b[1~' || input === '\x1bOH' || key.home) {
      clampCursor(activeRow, 0, liveLines)
      return
    }

    // End key — end of line
    if (input === '\x1b[F' || input === '\x1b[4~' || input === '\x1bOF' || key.end) {
      clampCursor(activeRow, getLineLength(liveLines[activeRow] ?? ''), liveLines)
      return
    }

    if (key.tab) {
      const nextLines = [...liveLines]
      const current = nextLines[activeRow] ?? ''
      const { before, after } = splitLineAtCursor(current, activeCol)
      nextLines[activeRow] = before + '  ' + after
      applyValue(nextLines.join('\n'), activeRow, activeCol + 2, nextLines)
      return
    }

    // Alt+B — previous word (matches upstream useTextInput)
    if (key.meta && input.toLowerCase() === 'b') {
      const boundary = findPrevWordBoundary(liveLines[activeRow] ?? '', activeCol)
      clampCursor(activeRow, boundary, liveLines)
      return
    }

    // Alt+F — next word (matches upstream useTextInput)
    if (key.meta && input.toLowerCase() === 'f') {
      const boundary = findNextWordBoundary(liveLines[activeRow] ?? '', activeCol)
      clampCursor(activeRow, boundary, liveLines)
      return
    }

    // Alt+D — delete word after cursor (matches upstream useTextInput)
    if (key.meta && input.toLowerCase() === 'd') {
      deleteWordAfter()
      return
    }

    // Alt+Backspace — delete word before cursor
    if (key.meta && key.backspace) {
      deleteWordBefore()
      return
    }

    if (key.ctrl || key.meta || !sanitizedInput) {
      return
    }

    insertText(sanitizedInput)
  }, { isActive: focus })

  const visibleRows = Math.max(1, Math.min(lines.length, maxVisibleLines))
  const maxStart = Math.max(0, lines.length - visibleRows)
  const startRow = Math.max(0, Math.min(cursorRow - visibleRows + 1, maxStart))
  const visibleLines = lines.slice(startRow, startRow + visibleRows)
  const cursorVisibleRow = cursorRow - startRow

  const accentColor = mode === 'bash' ? themeToInkHex('bashBorder') : themeToInkHex('owl')
  const title = mode === 'bash' ? 'Shell' : 'Message'
  const effectiveHint = hint ?? (
    mode === 'bash'
      ? 'Enter run · Shift+Enter newline · Ctrl+C cancel'
      : 'Enter send · Shift+Enter newline · Ctrl+C cancel'
  )
  const topContent = `${title} · ${effectiveHint}`
  const topPadding = Math.max(0, innerWidth - stringWidth(stripAnsi(topContent)) - 1)
  const topLine = `╭─ ${topContent}${' '.repeat(topPadding)}─╮`
  const bottomLine = `╰${'─'.repeat(innerWidth + 2)}╯`

  return (
    <Box flexDirection="column">
      <Text color={accentColor}>{topLine}</Text>
      {visibleLines.map((line, index) => {
        const isCursorLine = focus && !disabled && index === cursorVisibleRow
        const plainLine = stripAnsi(line)

        if (!isCursorLine) {
          const displayLine = padDisplayWidth(sliceAnsi(plainLine, 0, innerWidth), innerWidth)
          return (
            <Text key={index} color={accentColor}>
              │ <Text color="white">{displayLine}</Text> │
            </Text>
          )
        }

        const { before, cursorChar, after } = computeRenderedCursorLine(
          plainLine,
          cursorCol,
          innerWidth,
        )

        return (
          <Text key={index} color={accentColor}>
            │ <Text color="white">{before}</Text>
            <Text backgroundColor={accentColor} color="black">{cursorChar}</Text>
            <Text color="white">{after}</Text> │
          </Text>
        )
      })}
      <Text color={accentColor}>{bottomLine}</Text>
    </Box>
  )
}
