/**
 * Paste collapse for the composer.
 *
 * Large blobs of text pasted into the composer blow out the visible
 * height and destroy the authoring band's feel. Codex-cli solves this
 * by showing a compact placeholder like `[Pasted 1950 chars / 24 lines]`
 * in the visible field while retaining the raw content for submission.
 *
 * This module provides:
 *   - detectPasteInsert: given previous and next controlled values (and
 *     cursor positions), identify an insert that exceeds a size threshold
 *     — that's our heuristic for a paste. Typing adds a few chars per
 *     onChange; paste adds many at once.
 *   - collapsePaste: replace the inserted segment with a unique
 *     placeholder token in the visible value, stashing the raw segment
 *     in a store keyed by the token.
 *   - expandPlaceholders: substitute every placeholder token in a
 *     visible value with its stashed raw content (call before submit).
 *
 * Design choices:
 *   - Placeholder tokens are plain-text markers — not sentinel chars —
 *     so users can see what happened and copy/paste the composer value
 *     through the normal terminal paste path if desired.
 *   - Placeholder insertion point matches the user's insertion point,
 *     so history navigation / edits work as if the placeholder were a
 *     single atomic string. If the user edits inside the placeholder,
 *     the token pattern breaks and the raw content is silently dropped
 *     (submit falls back to the edited visible string). Acceptable —
 *     user visibly broke the token; they can retype.
 *
 * Threshold: 200 chars OR 5+ lines. Anything below reads as typed
 * content (even rapid typing rarely chunks above ~50 chars per onChange).
 */

const PASTE_CHAR_THRESHOLD = 200
const PASTE_LINE_THRESHOLD = 5

export interface PasteStore {
  /** Map from placeholder token → original pasted text. */
  readonly entries: Map<string, string>
  /** Sequential id counter for deterministic token naming. */
  nextId: number
}

export function createPasteStore(): PasteStore {
  return { entries: new Map(), nextId: 1 }
}

export function resetPasteStore(store: PasteStore): void {
  store.entries.clear()
  store.nextId = 1
}

/**
 * Build a placeholder token. Format is upstream-aligned:
 *   [Pasted text #N]           — single-line paste
 *   [Pasted text #N +X lines]  — multi-line paste (X = newline count)
 *
 * This format matches the deleteTokenBefore regex in Cursor.ts so
 * Backspace atomically removes the placeholder as a single token.
 * Must be long enough to avoid collision with normal typed content.
 *
 * Line count = number of \n occurrences in inserted (same convention
 * as upstream's getPastedTextRefNumLines which counts \n occurrences).
 */
function buildToken(id: number, inserted: string): string {
  const newlineCount = (inserted.match(/\n/g) ?? []).length
  if (newlineCount === 0) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${newlineCount} lines]`
}

export interface PasteInsert {
  readonly index: number
  readonly inserted: string
}

/**
 * Identify a pure-insert diff between `prev` and `next` by comparing
 * common prefix and suffix. Returns null when the change is not a pure
 * insert (e.g. a deletion, a replacement, or multi-point edit).
 *
 * Cursor positions are intentionally NOT required: TextInput's onChange
 * fires before the cursor-offset callback, so the parent has no reliable
 * cursor-at-change-time signal. Diff-by-prefix is robust enough for
 * paste detection because a single paste produces exactly one insertion
 * segment.
 */
export function detectPasteInsert(prev: string, next: string): PasteInsert | null {
  if (next.length <= prev.length) return null
  let prefix = 0
  const maxPrefix = Math.min(prev.length, next.length)
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < prev.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const insertLen = next.length - prev.length
  // The middle region of `next` between prefix and (length - suffix) is
  // what was inserted. For a pure insert its length equals the growth
  // delta; any mismatch means the user also edited around the cursor,
  // which we decline to collapse.
  if (next.length - prefix - suffix !== insertLen) return null
  const inserted = next.slice(prefix, prefix + insertLen)
  return { index: prefix, inserted }
}

export function shouldCollapse(inserted: string): boolean {
  if (inserted.length >= PASTE_CHAR_THRESHOLD) return true
  const lineCount = inserted.split('\n').length
  if (lineCount >= PASTE_LINE_THRESHOLD) return true
  return false
}

export interface CollapseResult {
  readonly value: string
  readonly cursor: number
  readonly token: string
}

/**
 * Replace the inserted segment with a placeholder token, registering
 * the original text in the store. Returns the new visible value and
 * the cursor position after the placeholder.
 */
export function collapsePaste(
  store: PasteStore,
  prev: string,
  insert: PasteInsert,
): CollapseResult {
  const id = store.nextId++
  const token = buildToken(id, insert.inserted)
  store.entries.set(token, insert.inserted)
  const value = prev.slice(0, insert.index) + token + prev.slice(insert.index)
  const cursor = insert.index + token.length
  return { value, cursor, token }
}

/**
 * Remove paste store entries whose token is no longer present in
 * `visibleValue`. Call this inside handleInputChange after any
 * setInputValue to GC orphaned entries (placeholder deleted by
 * Backspace, Ctrl+U, or select-all-delete).
 *
 * O(store.size) — at most ~5 entries in practice.
 */
export function pruneStaleTokens(store: PasteStore, visibleValue: string): void {
  if (store.entries.size === 0) return
  for (const token of store.entries.keys()) {
    if (!visibleValue.includes(token)) {
      store.entries.delete(token)
    }
  }
}

/**
 * Substitute every placeholder token present in `visible` with its
 * registered raw content. Tokens not found in the store are left
 * unchanged (user typed something that merely looks like a token).
 */
export function expandPlaceholders(visible: string, store: PasteStore): string {
  if (store.entries.size === 0) return visible
  let out = visible
  for (const [token, raw] of store.entries) {
    if (!out.includes(token)) continue
    // Split/join avoids regex escaping pitfalls with special chars.
    out = out.split(token).join(raw)
  }
  return out
}

/**
 * 0.13.72 chunked-paste burst detection.
 *
 * Background: macOS Terminal.app and iTerm2 normally send pasted
 * text wrapped in bracketed-paste sequences (CSI 200/201), and the
 * Ink fork delivers the whole blob as ONE input event with
 * `key.isPasted = true`. The 0.13.69 paste-collapse path (per-event
 * `detectPasteInsert` + `shouldCollapse(insert)`) handles this
 * cleanly — single insert ≥ 200 chars or ≥ 5 lines → placeholder.
 *
 * But several real-world paths break the single-event delivery:
 *   - SSH sessions through proxies that strip CSI 200/201
 *   - tmux/screen without `set -g allow-passthrough on`
 *   - Terminals that don't honor DECSET 2004
 *   - Slow stdin where a long paste straddles multiple readable
 *     events even with bracketed paste enabled
 *
 * On those paths the paste arrives as N text chunks, each 1–4 KB,
 * each one a small insert relative to the previous value. The
 * per-event `shouldCollapse` returns false on every chunk
 * individually; the long content accumulates as plain typed
 * content. Each accumulated state triggers a fresh
 * `MeasuredText(N) → wrapAnsi(N)` on render → O(n²) cost. User-
 * visible: the composer freezes for seconds during paste and the
 * placeholder never appears.
 *
 * The burst layer fixes this. It maintains an "anchor" value
 * captured at the start of a rapid input window. Each onChange
 * within the window is compared against the *anchor*, not the
 * immediate previous value. Once the cumulative growth from anchor
 * exceeds the collapse threshold, the burst is collapsed as a
 * single paste — visually equivalent to the bracketed-paste path.
 *
 * Window: 50 ms. Human typing produces ~5 onChange/sec at most;
 * paste chunks arrive much faster. 50 ms cleanly separates the two.
 *
 * Coexists with per-event collapse: a single big insert still
 * triggers immediate collapse on the existing path. Burst handles
 * the chunked case the per-event path misses.
 */
const PASTE_BURST_WINDOW_MS = 50

export interface BurstState {
  /** Value at the start of the current burst window. Empty when no burst is active. */
  anchorValue: string
  /** Wall-clock ms when the anchor was captured. 0 → no active burst. */
  anchorAt: number
}

export function createBurstState(): BurstState {
  return { anchorValue: '', anchorAt: 0 }
}

/**
 * Reset the burst state so the next onChange starts a fresh anchor.
 * Call after a successful collapse so subsequent typing isn't
 * re-collapsed against the stale anchor.
 */
export function resetBurst(state: BurstState): void {
  state.anchorValue = ''
  state.anchorAt = 0
}

export interface BurstCollapseResult {
  readonly value: string
  readonly cursor: number
  readonly token: string
}

/**
 * Detect whether the current onChange completes a chunked-paste
 * burst and, if so, collapse the entire accumulated insert (anchor
 * → next) into a placeholder. Returns null when the burst threshold
 * isn't met yet — caller should fall through to the per-event
 * collapse path.
 *
 * Side effects on `state`:
 *   - Refreshes the anchor (anchorValue=prev, anchorAt=now) when
 *     the previous burst window expired or no anchor exists.
 *   - Resets the anchor on a successful collapse so the placeholder
 *     becomes the new baseline.
 *
 * Caller is responsible for ensuring `prev` is the parent's current
 * controlled `inputValue` and `next` is the just-arrived value from
 * TextInput.
 */
export function tryBurstCollapse(
  state: BurstState,
  store: PasteStore,
  prev: string,
  next: string,
  now: number = Date.now(),
): BurstCollapseResult | null {
  // Shrink (deletion) — the user is editing back, not pasting.
  // Reset so the next forward growth captures a fresh anchor at the
  // current value rather than comparing against pre-deletion text.
  if (next.length < prev.length) {
    resetBurst(state)
    return null
  }
  // Refresh anchor when no burst is active OR the previous window
  // expired. The captured anchor is the value at the start of this
  // potential burst; subsequent calls within the window compare
  // against it cumulatively.
  const expired = state.anchorAt === 0 || now - state.anchorAt > PASTE_BURST_WINDOW_MS
  if (expired) {
    state.anchorValue = prev
    state.anchorAt = now
  }
  // Compare against the anchor (not prev). On a chunked paste, the
  // cumulative diff from anchor crosses the collapse threshold even
  // when each individual chunk's diff doesn't.
  const burstInsert = detectPasteInsert(state.anchorValue, next)
  if (!burstInsert) return null
  if (!shouldCollapse(burstInsert.inserted)) return null
  const { value, cursor, token } = collapsePaste(store, state.anchorValue, burstInsert)
  resetBurst(state)
  return { value, cursor, token }
}
