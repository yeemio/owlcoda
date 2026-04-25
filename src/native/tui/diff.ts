/**
 * OwlCoda TUI Diff Renderer
 *
 * Terminal port of the design's `oc-diff` block.
 *
 * Anatomy:
 *   ┌──────────────────────────────────────────────────────────┐  hair-faint border
 *   │ {dir/}{file}                       +N -M                 │  bgRaise head
 *   ├──────────────────────────────────────────────────────────┤
 *   │ @@ -48,9 +48,12 @@ context                               │  bgCard, info color
 *   │  48   48   export function useConversation() {           │  bgInput gutter, dim code
 *   │  51    -    const appendToken = (tok: string) => {       │  errSoft bg, error fg
 *   │       51    const appendToken = useCallback(...);        │  successSoft bg, success fg
 *   │ ...                                                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The `renderChangeBlockLines` / `renderFileCreateLines` helpers continue
 * to render compact, border-less inline edit hunks (used inside tool result
 * trees) — those just need the new soft tints and brand colors so they
 * agree with the rest of the design system.
 */

import { sgr, themeColor, themeBg, visibleWidth } from './colors.js'
import { renderBox } from './box.js'
import { truncate } from './text.js'

/**
 * Render a hunk header band — design's `oc-diff-hunk-head`:
 *
 *   @@ -48,9 +48,12 @@ context
 *
 * Painted in --info on --bg-card so it sits as a clear axis between the
 * file header and the line bodies. Returns a single string with bg + fg
 * SGR; caller is responsible for the surrounding indent.
 */
export function renderHunkHeader(opts: {
  oldStart: number
  oldLen: number
  newStart: number
  newLen: number
  context?: string
  width: number
  indent?: string
}): string {
  const { oldStart, oldLen, newStart, newLen, context, width, indent = '     ' } = opts
  const marker = `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`
  const ctx = context ? ` ${context}` : ''
  const text = `${marker}${ctx}`
  const bandWidth = Math.max(0, width - indent.length - 1)
  const truncated = truncate(text, bandWidth)
  const pad = Math.max(0, bandWidth - visibleWidth(truncated))
  // bg-card band + info fg, padded across the body width so the band reads
  // as a clean horizontal rule (not a dangling tag).
  return `${indent}${themeBg('bgCard')}${themeColor('info')} ${truncated}${' '.repeat(pad)}${sgr.reset}`
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  content: string
  lineNum?: number
}

/**
 * Create a unified diff between old and new text.
 * Returns colored diff lines ready for display.
 */
export function createUnifiedDiff(oldText: string, newText: string, filePath?: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: DiffLine[] = []

  if (filePath) {
    result.push({ type: 'header', content: `--- ${filePath}` })
    result.push({ type: 'header', content: `+++ ${filePath}` })
  }

  let i = 0
  let j = 0

  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
    result.push({ type: 'context', content: oldLines[i]!, lineNum: i + 1 })
    i++
    j++
  }

  let oldEnd = oldLines.length - 1
  let newEnd = newLines.length - 1
  const trailingContext: DiffLine[] = []
  while (oldEnd > i && newEnd > j && oldLines[oldEnd] === newLines[newEnd]) {
    trailingContext.unshift({ type: 'context', content: oldLines[oldEnd]!, lineNum: oldEnd + 1 })
    oldEnd--
    newEnd--
  }

  while (i <= oldEnd) {
    result.push({ type: 'remove', content: oldLines[i]!, lineNum: i + 1 })
    i++
  }
  while (j <= newEnd) {
    result.push({ type: 'add', content: newLines[j]!, lineNum: j + 1 })
    j++
  }

  result.push(...trailingContext)
  return result
}

/**
 * Format diff lines as colored terminal strings.
 *
 * Updated to use the design's brand colors (success/error) and shorter
 * one-cell sign columns so the body sits flush with the gutter.
 */
export function formatDiffLines(lines: DiffLine[]): string[] {
  return lines.map((line) => {
    switch (line.type) {
      case 'header':
        return `${sgr.bold}${themeColor('textDim')}${line.content}${sgr.reset}`
      case 'add':
        return `${themeColor('success')}+ ${line.content}${sgr.reset}`
      case 'remove':
        return `${themeColor('error')}- ${line.content}${sgr.reset}`
      case 'context':
        return `${themeColor('textDim')}  ${line.content}${sgr.reset}`
    }
  })
}

/**
 * Render a complete file diff as the design's bordered diff card.
 *
 * Header band: bgRaise + path/stats. Body: bgInput, formatted lines.
 * Top accent border uses `success` for CREATE, `info` for UPDATE.
 */
export function renderDiffBox(
  oldText: string,
  newText: string,
  filePath: string,
  action: 'CREATE' | 'UPDATE' = 'UPDATE',
): string {
  const diffLines = createUnifiedDiff(oldText, newText, filePath)
  const formatted = formatDiffLines(diffLines)
  const stats = countDiffStats(oldText, newText)
  const statsLabel =
    action === 'CREATE'
      ? `${themeColor('success')}+${stats.added}${sgr.reset}`
      : `${themeColor('success')}+${stats.added}${sgr.reset} ${themeColor('error')}-${stats.removed}${sgr.reset}`
  const actionLabel = action === 'CREATE'
    ? `${themeColor('success')}CREATE${sgr.reset}`
    : `${themeColor('info')}UPDATE${sgr.reset}`

  return renderBox(formatted, {
    border: 'round',
    title: `${actionLabel} ${filePath}  ${statsLabel}`,
    titleColor: themeColor('text'),
    borderColor: themeColor(action === 'CREATE' ? 'success' : 'info'),
    paddingX: 1,
    paddingY: 0,
  })
}

// ─── Change block (selection-first evidence lines) ───────────
//
// Inline edit hunks rendered inside tool result trees. Avoids box-drawing
// borders so drag-select / copy in Terminal.app and tmux stays clean. Uses
// the design's brand colors (success/error) and pre-blended soft tints
// (successSoft/errSoft) for the band background — exactly matching the
// `oc-diff-line.is-add` / `is-del` styling from terminal-theme.css.

const FG_DEFAULT = '\x1b[39m'
const DIM_ON = '\x1b[2m'
const DIM_OFF = '\x1b[22m'

export interface ChangeBlockOptions {
  startLine?: number
  maxLines?: number
  indent?: string
  termCols?: number
}

function termColsFor(opts: ChangeBlockOptions): number {
  const c = opts.termCols ?? process.stdout?.columns ?? 80
  return c >= 40 ? c : 80
}

function dropTrailingBlank(lines: string[]): string[] {
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1)
  }
  return lines
}

function normalizeForDiff(text: string): string {
  return dropTrailingBlank(text.split('\n')).join('\n')
}

type RowKind = 'add' | 'remove' | 'context'

/**
 * Paint one diff row.
 *
 * Color routing (matches design's `oc-diff-line.is-add` / `is-del` rules):
 *   add      → bg=successSoft  glyph=success   body=success
 *   remove   → bg=errSoft      glyph=error     body=error
 *   context  → bg=none         glyph=dim       body=dim
 *
 * Word-level diff colours (`diffAddedWord` / `diffRemovedWord`) are kept
 * as a higher-saturation variant on the +/- glyph so the change axis
 * pops one notch above the line bg. The body color uses the canonical
 * `success` / `error` brand tokens.
 */
function paintRow(
  kind: RowKind,
  num: string,
  glyph: string,
  content: string,
  indent: string,
  barWidth: number,
): string {
  const bg =
    kind === 'add'    ? themeBg('successSoft')
    : kind === 'remove' ? themeBg('errSoft')
    : ''
  const glyphFg =
    kind === 'add'    ? themeColor('success')
    : kind === 'remove' ? themeColor('error')
    : themeColor('textDim')
  const bodyFg =
    kind === 'add'    ? themeColor('success')
    : kind === 'remove' ? themeColor('error')
    : themeColor('textDim')

  const rowPlainLen = num.length + 1 + 1 + 1 + visibleWidth(content)
  const pad = Math.max(0, barWidth - rowPlainLen)

  if (!bg) {
    return `${indent}${DIM_ON}${num}${DIM_OFF} ${glyphFg}${glyph}${FG_DEFAULT} ${bodyFg}${content}${sgr.reset}`
  }
  return (
    `${indent}${bg}${DIM_ON}${num}${DIM_OFF} ${glyphFg}${glyph}${FG_DEFAULT} ${bodyFg}${content}` +
    `${' '.repeat(pad)}${sgr.reset}`
  )
}

/**
 * Render a compact hunk-style change block for a single local edit.
 *
 *      42    context
 *      43  - old line         ← errSoft band
 *      43  + new line         ← successSoft band
 *      44    context
 */
export function renderChangeBlockLines(
  oldText: string,
  newText: string,
  opts: ChangeBlockOptions = {},
): string[] {
  const indent = opts.indent ?? '     '
  const maxLines = opts.maxLines ?? 20
  const cols = termColsFor(opts)
  const bodyBudget = Math.max(16, cols - indent.length - 7)
  const barWidth = Math.max(bodyBudget + 7, cols - indent.length - 1)
  const offset = Math.max(0, (opts.startLine ?? 1) - 1)

  const raw = createUnifiedDiff(normalizeForDiff(oldText), normalizeForDiff(newText))
    .filter((d) => d.type !== 'header')

  const body = raw.length > maxLines ? raw.slice(0, maxLines) : raw
  const omitted = raw.length - body.length

  const out: string[] = []

  // Emit the design's `@@ -oldStart,oldLen +newStart,newLen @@` hunk band
  // when the body actually contains changes. Computed from line numbers
  // baked into createUnifiedDiff: each entry already carries lineNum, so
  // we just measure the contiguous old/new ranges they cover. For the
  // common single-edit case this is exactly the hunk we'd see in
  // `git diff`, which is what makes the band a real navigation anchor
  // rather than decorative chrome.
  const hasChange = body.some((d) => d.type === 'add' || d.type === 'remove')
  if (hasChange) {
    const oldNums = body.filter((d) => d.type !== 'add').map((d) => d.lineNum).filter((n): n is number => typeof n === 'number')
    const newNums = body.filter((d) => d.type !== 'remove').map((d) => d.lineNum).filter((n): n is number => typeof n === 'number')
    const oldStart = (oldNums.length > 0 ? Math.min(...oldNums) : 1) + offset
    const oldEnd   = (oldNums.length > 0 ? Math.max(...oldNums) : 1) + offset
    const newStart = (newNums.length > 0 ? Math.min(...newNums) : 1) + offset
    const newEnd   = (newNums.length > 0 ? Math.max(...newNums) : 1) + offset
    out.push(
      renderHunkHeader({
        oldStart, oldLen: Math.max(1, oldEnd - oldStart + 1),
        newStart, newLen: Math.max(1, newEnd - newStart + 1),
        width: cols, indent,
      }),
    )
  }

  for (const line of body) {
    const absLine = line.lineNum !== undefined ? line.lineNum + offset : undefined
    const num = absLine !== undefined ? String(absLine).padStart(4) : '    '
    const glyph = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
    const kind: RowKind = line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : 'context'
    const bodyText = truncate(line.content, bodyBudget)
    out.push(paintRow(kind, num, glyph, bodyText, indent, barWidth))
  }
  if (omitted > 0) {
    out.push(
      `${indent}${DIM_ON}${themeColor('textMute')}… +${omitted} more hunk line${omitted === 1 ? '' : 's'}${sgr.reset}`,
    )
  }
  return out
}

/**
 * Render a create-file change block: every line treated as an addition,
 * with 1-based line numbers, successSoft band, and a truncation tail.
 */
export function renderFileCreateLines(
  content: string,
  opts: Omit<ChangeBlockOptions, 'startLine'> = {},
): string[] {
  const indent = opts.indent ?? '     '
  const maxLines = opts.maxLines ?? 20
  const cols = termColsFor(opts)
  const bodyBudget = Math.max(16, cols - indent.length - 7)
  const barWidth = Math.max(bodyBudget + 7, cols - indent.length - 1)

  const allLines = dropTrailingBlank(content.split('\n'))
  const shown = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines
  const omitted = allLines.length - shown.length

  const out: string[] = []
  // Hunk header — for new files the old range is empty (0,0); design's
  // `@@ -0,0 +1,N @@` matches what `git diff` emits for a creation.
  if (shown.length > 0) {
    out.push(
      renderHunkHeader({
        oldStart: 0, oldLen: 0,
        newStart: 1, newLen: shown.length,
        context: 'new file',
        width: cols, indent,
      }),
    )
  }
  shown.forEach((line, i) => {
    const num = String(i + 1).padStart(4)
    out.push(paintRow('add', num, '+', truncate(line, bodyBudget), indent, barWidth))
  })
  if (omitted > 0) {
    out.push(
      `${indent}${DIM_ON}${themeColor('textMute')}… +${omitted} more line${omitted === 1 ? '' : 's'}${sgr.reset}`,
    )
  }
  return out
}

/**
 * Count added / removed lines in a change region.
 */
export function countDiffStats(oldText: string, newText: string): { added: number; removed: number } {
  const diffLines = createUnifiedDiff(normalizeForDiff(oldText), normalizeForDiff(newText))
  let added = 0
  let removed = 0
  for (const line of diffLines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}

/**
 * Render a simple file creation display (no diff, just show content).
 */
export function renderFileCreate(filePath: string, content: string, maxLines = 20): string {
  let lines = content.split('\n')
  let truncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines)
    truncated = true
  }

  const formatted = lines.map((l) => `${themeColor('success')}+ ${l}${sgr.reset}`)
  if (truncated) {
    formatted.push(`${themeColor('textMute')}  … (truncated)${sgr.reset}`)
  }

  return renderBox(formatted, {
    border: 'round',
    title: `${themeColor('success')}CREATE${sgr.reset} ${filePath}  ${themeColor('success')}+${lines.length}${sgr.reset}`,
    titleColor: themeColor('text'),
    borderColor: themeColor('success'),
    paddingX: 1,
  })
}
