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
 * Build a placeholder token. Format is stable for tests and visible to
 * the user. Must be long enough to avoid collision with normal typed
 * content — a realistic user is very unlikely to type `[Pasted #N …]`
 * verbatim by hand.
 */
function buildToken(id: number, chars: number, lines: number): string {
  const lineFrag = lines > 1 ? ` / ${lines} lines` : ''
  return `[Pasted #${id} ${chars} chars${lineFrag}]`
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
  const chars = insert.inserted.length
  const lines = insert.inserted.split('\n').length
  const id = store.nextId++
  const token = buildToken(id, chars, lines)
  store.entries.set(token, insert.inserted)
  const value = prev.slice(0, insert.index) + token + prev.slice(insert.index)
  const cursor = insert.index + token.length
  return { value, cursor, token }
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
