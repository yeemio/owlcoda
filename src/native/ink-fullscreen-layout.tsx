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
  useMemo,
  useRef,
  useState,
  memo,
} from 'react'
import { Box, Text } from '../ink.js'

import { themeToInkHex } from './ink-theme.js'
import {
  applyTranscriptScrollDelta,
  buildScrollIndicatorBar,
  buildTranscriptOffsetsCache,
  reconcileTranscriptScrollOffset,
  selectVisibleTranscriptWindow,
  totalLinesFromCache,
  updateTranscriptOffsetsCache,
  type TranscriptItem,
  type TranscriptOffsetsCache,
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

// 0.13.74 React.memo + 0.13.76 row-virtualization.
//
// History:
// - Pre-0.13.74: each transcript item rendered as N `<Text>` per
//   logical line, no memoization. Spinner ticker re-renders churned
//   every line every ~90ms.
// - 0.13.74: wrapped per-item rendering in `React.memo` so unchanged
//   items skip React reconciliation entirely.
// - 0.13.75 collapsed N Text into 1 Text per item to reduce Yoga
//   measurement count. That fixed perf but broke the visual: each
//   line in a user-block carries pre-baked bg+accent+pad chrome from
//   renderUserBlock, and Ink's default wrap="wrap" on a multi-line
//   Text re-flowed the chrome incorrectly (bg ended mid-row).
// - 0.13.76 introduced `selectVisibleTranscriptWindow` (line-precise
//   virtualization in repl-shared.ts) which slices the long item to
//   the viewport budget BEFORE this component sees it. Visible-item
//   line count is bounded by viewport, not content. With
//   virtualization in place, 0.13.75's single-Text optimization
//   becomes unnecessary — the per-line node count is already
//   capped by the budget — so we revert to per-line Text to restore
//   the correct visual rendering.
//
// React.memo bails out when `item` ref is unchanged (transcript
// items are immutable post-creation; appendTranscript always pushes
// fresh items via spread). The `cols` prop is stable across spinner
// ticks, so the second prop check also bails out.
//
// `wrap="truncate-end"` per Text matches the original visual:
// individual lines that exceed terminal width get truncated rather
// than wrapped (long file paths, tool result lines).
const TranscriptItemRow = React.memo(function TranscriptItemRow({
  item,
  cols,
}: { item: TranscriptItem; cols: number }): React.ReactElement {
  // useMemo gates the split + chrome scan to (item, cols) — same
  // memoization window React.memo uses for the whole component.
  // Avoids re-allocating the lines array on every parent re-render
  // that doesn't actually change item or cols.
  void cols // future row-level cap; currently informational only
  const lines = useMemo(() => item.text.split('\n'), [item])
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`${item.id}-${index}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
})

// ─── ScrollIndicatorLeaf ─────────────────────────────────────
//
// Leaf component that owns its own spinner frame state via a local interval.
// Extracted from ScrollableTranscript so that spinner ticks do NOT propagate
// through the transcript subtree — React.memo on ScrollableTranscript can now
// bail out on tick boundaries when items/budget/cols are stable.
//
// 250ms when loading (matches existing spinner cadence), 1000ms otherwise.

interface ScrollIndicatorLeafProps {
  isLoading: boolean
  isScrolledAway: boolean
  indicatorOptions: Omit<Parameters<typeof buildScrollIndicatorBar>[0], 'frame'>
}

const ScrollIndicatorLeaf = memo(function ScrollIndicatorLeaf({
  isLoading,
  isScrolledAway,
  indicatorOptions,
}: ScrollIndicatorLeafProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!isScrolledAway) return
    const ms = isLoading ? 250 : 1000
    const id = setInterval(() => setFrame((f) => f + 1), ms)
    return () => clearInterval(id)
  }, [isLoading, isScrolledAway])

  if (!isScrolledAway) return null

  const text = buildScrollIndicatorBar({ ...indicatorOptions, frame })

  if (isLoading) {
    return (
      <Text color={themeToInkHex('owl')} bold wrap="truncate-end">
        {text}
      </Text>
    )
  }
  return (
    <Text color={themeToInkHex('textDim')} wrap="truncate-end">
      {text}
    </Text>
  )
})

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
  // Persistent offsets cache: replaces countTranscriptLines useMemo.
  // On each render, updateTranscriptOffsetsCache costs O(new items) instead
  // of O(all items). The cached totalLines is then used everywhere
  // currentTotalLines was referenced.
  const cacheRef = useRef<TranscriptOffsetsCache | null>(null)
  if (cacheRef.current === null) {
    cacheRef.current = buildTranscriptOffsetsCache(items, transcriptCols)
  } else {
    updateTranscriptOffsetsCache(cacheRef.current, items, transcriptCols)
  }
  const currentTotalLines = totalLinesFromCache(cacheRef.current)
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
  const txWindow = useMemo(
    () => selectVisibleTranscriptWindow(
      items,
      transcriptCols,
      transcriptBudget,
      scrollLineOffset,
      cacheRef.current ?? undefined,
    ),
    [items, transcriptBudget, transcriptCols, scrollLineOffset],
  )
  const visibleItems = txWindow.visible
  const isScrollable = txWindow.totalLines > transcriptBudget
  const isLive = txWindow.clampedOffset === 0
  const isScrolledAway = !isLive && userScrolledRef.current

  // Scroll indicator options (passed to leaf — frame is owned by the leaf).
  const scrollIndicatorOptions = useMemo(
    () => ({
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
    }),
    [
      isLoading,
      isScrollable,
      isScrolledAway,
      transcriptBudget,
      transcriptCols,
      txWindow.clampedOffset,
      txWindow.maxScrollOffset,
      txWindow.totalLines,
      txWindow.viewEndLine,
    ],
  )

  // ── Render ──
  return (
    <Box flexDirection="row" height={height} overflow="hidden">
      {/* Content column */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
        {/* Transcript items are PRIMARY content (the user's own just-submitted
            message lives here). flexShrink={0} stops Yoga from collapsing them
            to zero when the live-preview tail below would otherwise overflow a
            short viewport — without it, a long streaming preview squeezes the
            newest transcript rows (the echoed user message) out of view, so the
            user sees their wrapped message only partially until the turn
            settles. The window already caps these to `transcriptBudget` lines,
            so they fit; the tail is the shrinkable/clippable secondary content. */}
        <Box flexDirection="column" flexShrink={0}>
          {visibleItems.map((item) => (
            <TranscriptItemRow key={item.id} item={item} cols={transcriptCols} />
          ))}
        </Box>
        <ScrollIndicatorLeaf
          isLoading={isLoading}
          isScrolledAway={isScrolledAway}
          indicatorOptions={scrollIndicatorOptions}
        />
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
