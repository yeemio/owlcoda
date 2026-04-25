/**
 * OwlCoda Fullscreen Layout
 *
 * Layout primitives mirroring an upstream Ink FullscreenLayout +
 * ScrollBox + VirtualMessageList chain.
 *
 * - ScrollableTranscript: virtual-scrolling transcript container
 *   with imperative scroll API and scroll indicators. Owns app-side
 *   keyboard scrolling while leaving mouse selection, copy, and wheel
 *   scrollback to the terminal.
 *
 * - FullscreenLayout: splits the terminal into scrollable top + fixed bottom,
 *   matching upstream's two-slot design.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Box, Text } from 'ink'

import { themeToInkHex } from './ink-theme.js'
import {
  applyTranscriptScrollDelta,
  buildScrollIndicatorBar,
  countTranscriptLines,
  reconcileTranscriptScrollOffset,
  selectVisibleTranscriptWindow,
  type TranscriptItem,
} from './repl-shared.js'

// ─── Scroll Handle ────────────────────────────────────────────
// Imperative API matching upstream ScrollBoxHandle semantics.

export interface ScrollHandle {
  /** Scroll to absolute line offset from bottom (0 = live). */
  scrollTo(y: number): void
  /** Scroll by delta lines (negative = older/up, positive = newer/down). */
  scrollBy(dy: number): void
  /** Jump to live (bottom) and re-enable sticky follow. */
  scrollToBottom(): void
  /** Current scroll offset from live. */
  getScrollOffset(): number
  /** True when scroll follows new content (at live position). */
  isSticky(): boolean
  /** Repin to live, clear new-content counter. */
  repin(): void
}

// ─── ScrollableTranscript ─────────────────────────────────────

export interface ScrollableTranscriptProps {
  /** Transcript items to render. */
  items: TranscriptItem[]
  /** Extra content after items (live response preview, inline status). */
  tail?: React.ReactNode
  /** Footer below tail (notices, hints). */
  footer?: React.ReactNode
  /** Height of this area in terminal rows. */
  height: number
  /** Full terminal width. */
  cols: number
  /** Lines consumed by tail content (for budget calculation). */
  tailLines: number
  /** Lines consumed by footer content. */
  footerLines: number
  /** Is a task currently active? Affects scroll indicator. */
  isLoading: boolean
  /** Animation frame counter for spinner/pulse. */
  spinnerFrame: number
  /** Imperative scroll control. */
  scrollRef?: React.Ref<ScrollHandle>
}

export const ScrollableTranscript = React.memo(function ScrollableTranscript({
  items,
  tail,
  footer,
  height,
  cols,
  tailLines,
  footerLines,
  isLoading,
  spinnerFrame,
  scrollRef,
}: ScrollableTranscriptProps): React.ReactElement {
  // ── Scroll state ──
  const [scrollLineOffset, setScrollLineOffset] = useState(0)
  const userScrolledRef = useRef(false)
  const newContentCountRef = useRef(0)
  const transcriptCols = Math.max(1, cols)
  const showTail = !userScrolledRef.current
  const effectiveTailLines = showTail ? tailLines : 0
  const scrollIndicatorReserve = scrollLineOffset > 0 ? 1 : 0
  const transcriptBudget = Math.max(
    3,
    height - effectiveTailLines - footerLines - scrollIndicatorReserve,
  )
  const currentTotalLines = countTranscriptLines(items, transcriptCols)
  const prevItemCountRef = useRef(items.length)
  const prevTotalLinesRef = useRef(currentTotalLines)
  const prevBudgetRef = useRef(transcriptBudget)

  const applyManualScrollDelta = useCallback((dy: number) => {
    setScrollLineOffset((prev) => {
      const next = applyTranscriptScrollDelta(prev, dy)
      if (next === 0) {
        userScrolledRef.current = false
        newContentCountRef.current = 0
      } else {
        userScrolledRef.current = true
      }
      return next
    })
  }, [])

  // When new transcript items arrive while the user is reading history, keep
  // the viewport anchored to the same history lines instead of the same
  // distance from live.
  useLayoutEffect(() => {
    const prevItemCount = prevItemCountRef.current
    const prevTotalLines = prevTotalLinesRef.current
    const prevBudgetLines = prevBudgetRef.current
    const itemGrowth = Math.max(0, items.length - prevItemCount)

    if (userScrolledRef.current) {
      if (itemGrowth > 0) {
        newContentCountRef.current += itemGrowth
      }

      const nextOffset = reconcileTranscriptScrollOffset({
        scrollOffset: scrollLineOffset,
        isSticky: false,
        prevTotalLines,
        nextTotalLines: currentTotalLines,
        prevBudgetLines,
        nextBudgetLines: transcriptBudget,
      })

      if (nextOffset === 0) {
        userScrolledRef.current = false
        newContentCountRef.current = 0
      }
      if (nextOffset !== scrollLineOffset) {
        setScrollLineOffset(nextOffset)
      }
    } else if (currentTotalLines > prevTotalLines && scrollLineOffset !== 0) {
      setScrollLineOffset(0)
    }

    prevItemCountRef.current = items.length
    prevTotalLinesRef.current = currentTotalLines
    prevBudgetRef.current = transcriptBudget
  }, [currentTotalLines, items.length, scrollLineOffset, transcriptBudget])

  // Selection-first: the main REPL must not enable mouse tracking, or
  // terminal-native transcript selection/copy will break. Explicitly disable
  // common mouse modes on mount in case a prior fullscreen app left them on.
  useEffect(() => {
    if (!process.stdout.isTTY) return
    process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l')
    return () => {
      process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l')
    }
  }, [])

  // ── Imperative handle ──
  useImperativeHandle(scrollRef, () => ({
    scrollTo(y: number) {
      userScrolledRef.current = y > 0
      if (y <= 0) newContentCountRef.current = 0
      setScrollLineOffset(Math.max(0, Math.floor(y)))
    },
    scrollBy(dy: number) {
      applyManualScrollDelta(dy)
    },
    scrollToBottom() {
      userScrolledRef.current = false
      newContentCountRef.current = 0
      setScrollLineOffset(0)
    },
    getScrollOffset() {
      return scrollLineOffset
    },
    isSticky() {
      return !userScrolledRef.current
    },
    repin() {
      userScrolledRef.current = false
      newContentCountRef.current = 0
      setScrollLineOffset(0)
    },
  }))

  // ── Viewport computation ──
  const txWindow = selectVisibleTranscriptWindow(
    items,
    transcriptCols,
    transcriptBudget,
    scrollLineOffset,
  )
  const visibleItems = txWindow.visible
  const isScrollable = txWindow.totalLines > transcriptBudget
  const isLive = txWindow.clampedOffset === 0
  const isScrolledAway = !isLive && userScrolledRef.current

  // Horizontal scroll indicator (shown when scrolled away)
  const scrollIndicatorText = buildScrollIndicatorBar({
    cols: transcriptCols,
    totalLines: txWindow.totalLines,
    budgetLines: transcriptBudget,
    scrollOffset: txWindow.clampedOffset,
    maxScrollOffset: txWindow.maxScrollOffset,
    viewEndLine: txWindow.viewEndLine,
    isScrolledAway,
    isScrollable,
    isLoading,
    newContentCount: newContentCountRef.current,
    frame: spinnerFrame,
  })

  // ── Render ──
  return (
    <Box flexDirection="row" height={height} overflow="hidden">
      {/* Content column */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
        {visibleItems.map((item) => (
          <Box key={item.id} flexDirection="column">
            {item.text.split('\n').map((line, index) => (
              <Text key={`${item.id}-${index}`} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ))}
        {isScrolledAway && isLoading ? (
          <Text color={themeToInkHex('owl')} bold wrap="truncate-end">
            {scrollIndicatorText}
          </Text>
        ) : isScrolledAway ? (
          <Text color={themeToInkHex('textDim')} wrap="truncate-end">
            {scrollIndicatorText}
          </Text>
        ) : null}
        {showTail ? tail : null}
        {footer}
      </Box>
    </Box>
  )
})

// ─── FullscreenLayout ─────────────────────────────────────────
// Upstream-aligned: scrollable top fills available space,
// fixed bottom pinned and never pushed off-screen.

export interface FullscreenLayoutProps {
  /** Scrollable content (transcript area). */
  scrollable: React.ReactNode
  /** Fixed bottom (input area + status bar). */
  bottom: React.ReactNode
  /** Total terminal height. */
  height: number
}

export function FullscreenLayout({
  scrollable,
  bottom,
  height,
}: FullscreenLayoutProps): React.ReactElement {
  return (
    <Box flexDirection="column" height={height}>
      {scrollable}
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>
    </Box>
  )
}
