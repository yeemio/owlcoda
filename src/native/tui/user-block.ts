/**
 * Render a user turn as an authored panel block for the transcript.
 *
 * Per display row we emit:
 *
 *   {bg}{accent}▎{fgReset}  {line}{pad-to-width}{bgReset}
 *
 * Why space-pad instead of EL (`\x1b[K`)?
 *
 *   <Static> serializes rendered text through Ink's wrap/measure pipeline,
 *   which strips `\x1b[K` (it's not a character, it's a cursor-state
 *   command that Ink can't account for in width). Space-padding each row
 *   to the current terminal width forces a real full-width bg band that
 *   survives Static's pass and reads as a proper color-block.
 *
 *   Trade-off: block width is frozen at submit time. If the terminal
 *   resizes afterward, old blocks keep their old pad width. Acceptable —
 *   submitted messages are historical artifacts; live resize fidelity
 *   belongs to the composer, not the transcript.
 *
 * Wrap behavior for long logical lines: we still set bg BEFORE the
 * accent bar, so bg is "on" at the moment the terminal wraps a row into
 * its next display row. Wrap-continuation cells inherit bg from current
 * ANSI state; the pad spaces we emit are AFTER the wrap happens, so
 * they fill trailing empty cells on the same (last) row the logical
 * line produced.
 */

import { stringWidth } from '../../ink/stringWidth.js'
import wrapText from '../../ink/wrap-text.js'
import { authoringTokensFor } from './theme-tokens.js'
import { getThemeName, themeColor, sgr } from './colors.js'
import { parseInputAttachments } from './composer.js'

const FG_RESET = '\x1b[39m'
const FULL_RESET = '\x1b[0m'
const BOLD_ON = '\x1b[1m'
const BOLD_OFF = '\x1b[22m'
const ACCENT_BAR = '\u258E' // ▎
const ACCENT_WIDTH = 1
const LEFT_PAD_WIDTH = 2    // two spaces after the bar

/**
 * Heuristic: does a logical line read as a section label?
 *
 * Rules (all must hold):
 *   - ends with `:` or `：` (full-width CJK colon), optionally followed
 *     by whitespace
 *   - non-empty body before the colon
 *   - display width of the line ≤ 24 cells (keeps out long sentences
 *     that happen to end with a colon)
 *   - doesn't start with a list marker (`-`, `*`, `•`, `1.`, `(1)`,
 *     etc.) — list items with colons are content, not headings
 *
 * Matches "结论：", "下一步：", "新分发表：", "两个执行体：" as used in
 * the round-1 user feedback screenshots. Misses free-form sentences
 * that aren't trying to be titles. When in doubt, prefer not to bold —
 * a missed heading is invisible; a false-positive bolded sentence is
 * loud.
 */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trimEnd()
  if (trimmed.length === 0) return false
  const lastChar = trimmed[trimmed.length - 1]
  if (lastChar !== ':' && lastChar !== '\uFF1A') return false
  const body = trimmed.slice(0, -1).trim()
  if (body.length === 0) return false
  if (stringWidth(trimmed) > 24) return false
  // Reject list-marker prefixes so "- 注意：" stays a list item.
  if (/^(?:[-*•·]|\d+[.)]|\(\d+\))\s/.test(body)) return false
  return true
}

/**
 * Two invariants keep the block from contaminating neighboring
 * transcript items under Ink Static / ScrollableTranscript re-wrap:
 *
 * 1. Every emitted row's total display width equals cols exactly. We
 *    pre-wrap long logical lines into width-bounded segments via
 *    wrapText (wrap-ansi, display-width-aware) so the terminal never
 *    sees an over-length row to wrap itself. Ink's measure/re-wrap
 *    pass sees rows that already fit and does not reshape them — the
 *    bgReset stays on the visible edge of every row and cannot
 *    strand, so neighboring transcript items never inherit our tint.
 *
 * 2. Every row ends with both `\x1b[49m` (bg-only reset) AND `\x1b[0m`
 *    (full SGR reset). The full reset is a belt-and-suspenders guard
 *    against Ink's wrap pass re-ordering ANSI codes: even if the
 *    bg-only reset gets shuffled, the full reset at the absolute end
 *    guarantees a clean slate before the next transcript row.
 */
/**
 * Render the inline `@path` chip row that sits above a user message in
 * the transcript — terminal port of the design's
 * `<OcConv.UserTurn attachments={[...]}>`.
 *
 * Each chip is `@path` with the `@` painted in accent and the path in
 * mute ink, separated by two spaces. Chips wrap by joining with two
 * spaces and letting the host terminal break the run when it overflows;
 * this is good enough for the typical 1-3 attachments per message and
 * doesn't require us to manually wrap-and-pad against the bg band.
 *
 * Returns null when the text contains no `@path` references so the
 * caller can skip the row entirely.
 */
function renderUserAttachmentRow(text: string, contentWidth: number): string | null {
  const attachments = parseInputAttachments(text)
  if (attachments.length === 0) return null
  const accent = themeColor('owl')
  const mute   = themeColor('textMute')
  const reset  = sgr.reset
  const chips = attachments.map((att) => `${accent}@${reset}${mute}${att.name}${reset}`)
  // Pre-truncate the joined chip string to the content width so the bg
  // band's pad math (later) still produces an exact-width row. Visible
  // overflow is rare — the typical case is 1-3 short repo paths.
  const joined = chips.join('  ')
  const visible = joined.replace(/\x1b\[[0-9;]*m/g, '')
  if (stringWidth(visible) <= contentWidth) return joined
  // If we overflow, drop the tail chips and append a "+N more" tag.
  let kept = ''
  let visibleSoFar = 0
  let count = 0
  for (const chip of chips) {
    const chipPlain = chip.replace(/\x1b\[[0-9;]*m/g, '')
    const candidate = kept ? `${kept}  ${chip}` : chip
    const candidatePlain = candidate.replace(/\x1b\[[0-9;]*m/g, '')
    const candidateWidth = stringWidth(candidatePlain)
    if (candidateWidth + 8 > contentWidth) break  // 8 reserved for "+N more"
    kept = candidate
    visibleSoFar = candidateWidth
    count += 1
  }
  void visibleSoFar
  if (kept.length === 0) return chips[0]!
  if (count < chips.length) {
    kept = `${kept}  ${mute}+${chips.length - count} more${reset}`
  }
  return kept
}

export function renderUserBlock(text: string): string {
  const tokens = authoringTokensFor(getThemeName())
  const cols = Math.max(10, process.stdout.columns || 80)
  // Render at `cols - 2`, not `cols`. ScrollableTranscript in
  // ink-repl.tsx derives its per-item display width as
  // `transcriptCols = cols - 2` (two columns reserved for outer chrome)
  // and calls `selectVisibleTranscriptWindow → getDisplayLines(text,
  // transcriptCols)` which re-wraps any row wider than transcriptCols.
  //
  // Padding to full `cols` made each logical row measure 60 chars on a
  // 60-col terminal, which getDisplayLines then re-wrapped against a 58
  // ceiling — every user-block row became two display-lines (the
  // second being a bg-only pad remainder). A 3-row user block inflated
  // to 6 lines, blowing the viewport budget and cropping the top row
  // (alpha) out of the committed view. Matching the transcript's
  // render width keeps line count = row count: no re-wrap, no crop.
  const paneWidth = Math.max(5, cols - 2)
  const contentWidth = Math.max(1, paneWidth - ACCENT_WIDTH - LEFT_PAD_WIDTH)

  const rows: string[] = []
  // Prepend the @path chip row when the message references attachments.
  // The row uses the same bg + accent-bar chrome as content rows so it
  // sits inside the user block band, not above it.
  const attachmentChips = renderUserAttachmentRow(text, contentWidth)
  if (attachmentChips !== null) {
    const chipPlain = attachmentChips.replace(/\x1b\[[0-9;]*m/g, '')
    const padCount = Math.max(0, contentWidth - stringWidth(chipPlain))
    const pad = padCount > 0 ? ' '.repeat(padCount) : ''
    rows.push(
      `${tokens.bg}${tokens.accent}${ACCENT_BAR}${FG_RESET}  ${attachmentChips}${pad}${tokens.bgReset}${FULL_RESET}`,
    )
  }
  for (const logicalLine of text.split('\n')) {
    // Pre-wrap every logical line into width-bounded segments BEFORE we
    // emit bg + pad. This is the only way to guarantee every emitted
    // row has display width exactly `cols`, which in turn is the only
    // way to stop Ink Static's measure/re-wrap pass from reshaping our
    // ANSI and leaving bg bleed or empty slots on wrap-continuation
    // rows (seen visually as the next transcript item's text showing
    // through between our pad spaces).
    //
    // wrapText(..., 'wrap') invokes wrap-ansi with hard=true — it
    // measures display width (not byte count) so CJK graphemes land on
    // boundaries without corruption. Empty logical lines preserve as
    // a single empty segment.
    const segments = logicalLine.length === 0
      ? ['']
      : wrapText(logicalLine, contentWidth, 'wrap').split('\n')
    const heading = isHeadingLine(logicalLine)
    for (const segment of segments) {
      const w = stringWidth(segment)
      const padCount = Math.max(0, contentWidth - w)
      const pad = padCount > 0 ? ' '.repeat(padCount) : ''
      // Bold sits inside the bg span so it only affects the segment
      // text, not the left bar or the pad. This gives section labels
      // ("结论：", "下一步：", …) extra weight without disturbing
      // layout or leaking bold into the neighboring transcript row.
      const body = heading ? `${BOLD_ON}${segment}${BOLD_OFF}` : segment
      rows.push(
        `${tokens.bg}${tokens.accent}${ACCENT_BAR}${FG_RESET}  ${body}${pad}${tokens.bgReset}${FULL_RESET}`,
      )
    }
  }
  // No leading `\n`. A leading newline on a transcript item text clashes
  // with Ink Static's commit pass (ScrollableTranscript → scrollback):
  // the implicit cursor position at the end of the previous item plus
  // our `\n` + first content row produced an off-by-one where the first
  // row overwrote the previous item's last line and effectively
  // disappeared from the committed view. Spacing above the block is
  // already provided by Ink flex gaps between transcript items; we
  // don't need to bake it into the string.
  return rows.join('\n')
}
