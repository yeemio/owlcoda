import type { Cursor } from './cursor.js'
import type { Size } from './layout/geometry.js'
import type { ScrollHint } from './render-node-to-output.js'
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './screen.js'

export type Frame = {
  readonly screen: Screen
  readonly viewport: Size
  readonly cursor: Cursor
  /** DECSTBM scroll optimization hint (alt-screen only, null otherwise). */
  readonly scrollHint?: ScrollHint | null
  /** A ScrollBox has remaining pendingScrollDelta — schedule another frame. */
  readonly scrollDrainPending?: boolean
  /**
   * Watermark-v2: committed-to-scrollback content for this frame.
   *
   * When set with `rowCount > 0`, log.render prepends the commit ANSI
   * to the returned Diff and forces a full-reset for the dynamic region
   * below. A commit with `rowCount === 0` is treated as a no-op and
   * falls through to the incremental-diff path (no flicker cost).
   *
   *   text: pre-broken logical lines separated by `\n`. Caller is
   *         responsible for line-breaking (no terminal-wrap reliance).
   *         A trailing `\n` is tolerated — the CUP-to-bottom patch
   *         that follows always repositions absolutely, so extra
   *         cursor motion from a terminal-emitted newline is harmless.
   *   rowCount: number of display rows the text occupies (= text.split('\n').length).
   *         Determines how many `\n` terminators are emitted at absolute
   *         bottom to scroll the pre-commit viewport into scrollback.
   *
   * Side-effect warning: setting this field causes ONE frame of visible
   * flicker because the dynamic region is force-reset via
   * fullResetSequence_CAUSES_FLICKER. This is intentional — a scrollback
   * commit invalidates incremental-diff state and the cleanest recovery
   * is a full repaint. Do not set this field speculatively; only when
   * there is actually content to push into scrollback.
   */
  readonly staticCommit?: {
    readonly text: string
    readonly rowCount: number
  }
}

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

export type FlickerReason = 'resize' | 'offscreen' | 'clear' | 'periodic_scrub' | 'safe_repaint'

export type FrameEvent = {
  durationMs: number
  /** Phase breakdown in ms + patch count. Populated when the ink instance
   *  has frame-timing instrumentation enabled (via onFrame wiring). */
  phases?: {
    /** createRenderer output: DOM → yoga layout → screen buffer */
    renderer: number
    /** LogUpdate.render(): screen diff → Patch[] (the hot path this PR optimizes) */
    diff: number
    /** optimize(): patch merge/dedupe */
    optimize: number
    /** writeDiffToTerminal(): serialize patches → ANSI → stdout */
    write: number
    /** Pre-optimize patch count (proxy for how much changed this frame) */
    patches: number
    /** yoga calculateLayout() time (runs in resetAfterCommit, before onRender) */
    yoga: number
    /** React reconcile time: scrollMutated → resetAfterCommit. 0 if no commit. */
    commit: number
    /** layoutNode() calls this frame (recursive, includes cache-hit returns) */
    yogaVisited: number
    /** measureFunc (text wrap/width) calls — the expensive part */
    yogaMeasured: number
    /** early returns via _hasL single-slot cache */
    yogaCacheHits: number
    /** total yoga Node instances alive (create - free). Growth = leak. */
    yogaLive: number
  }
  flickers: Array<{
    desiredHeight: number
    availableHeight: number
    reason: FlickerReason
  }>
}

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      // Telemetry-only marker. Carries the reason a frame triggered a
      // full repaint (resize, scrollback drift, periodic scrub, etc.).
      // writeDiffToTerminal emits ZERO bytes for this patch — the actual
      // repaint ANSI rides in subsequent 'stdout' / 'styleStr' /
      // 'cursorTo' patches built by safeFullRepaint(). onRender reads this
      // patch type into the flickers[] telemetry stream and routes
      // findOwnerChainAtRow attribution.
      //
      // INVARIANT: this is the ONLY way main-screen rendering signals
      // "we are about to do a full repaint". No path may emit a literal
      // \x1b[2J on main screen except the user-driven /clear command and
      // alt-screen mode transitions.
      type: 'flickerMarker'
      reason: FlickerReason
      debug?: { triggerY: number; prevLine: string; nextLine: string }
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  // Pre-serialized style transition string from StylePool.transition() —
  // cached by (fromId, toId), zero allocations after warmup.
  | { type: 'styleStr'; str: string }

export type Diff = Patch[]

/**
 * Determines whether the screen should be cleared based on the current and previous frame.
 * Returns the reason for clearing, or undefined if no clear is needed.
 *
 * Screen clearing is triggered when:
 * 1. Terminal has been resized (viewport dimensions changed) → 'resize'
 * 2. Current frame screen height exceeds available terminal rows → 'offscreen'
 * 3. Previous frame screen height exceeded available terminal rows → 'offscreen'
 */
export function shouldClearScreen(
  prevFrame: Frame,
  frame: Frame,
): FlickerReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width
  if (didResize) {
    return 'resize'
  }

  const currentFrameOverflows = frame.screen.height >= frame.viewport.height
  const previousFrameOverflowed =
    prevFrame.screen.height >= prevFrame.viewport.height
  if (currentFrameOverflows || previousFrameOverflowed) {
    return 'offscreen'
  }

  return undefined
}
