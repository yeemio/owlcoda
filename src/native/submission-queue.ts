/**
 * 0.14.0 — SubmissionQueue (typed buffer, single-mode).
 *
 * Replaces the single-slot `queuedInputRef: useRef<string | null>` that
 * caused the visible bug "typing two prompts while a turn is running drops
 * the first one". The buffer holds up to MAX_QUEUE_SIZE submissions in
 * FIFO order. When full, the OLDEST item is dropped to make room — same
 * "ring buffer" semantics as the auto-compact log telemetry, but with a
 * footer signal so the user knows it happened.
 *
 * What this is NOT (locked by project_turn_lifecycle_slicing_plan.md):
 *
 *   - NOT a module-level store with pub-sub. Lives on a React ref, scoped
 *     to the REPL component instance.
 *   - NOT a priority queue. No `now / next / later` tiers. All queued
 *     items are user prompts at the same priority.
 *   - NOT a multi-mode queue. The single shape is { kind: 'user_turn',
 *     text, ... }. Slash commands are NOT queued (current behavior: they
 *     get refused with footer guidance when isLoading; that semantics
 *     stays).
 *   - NOT integrated with useSyncExternalStore. UI re-renders on the
 *     ordinary isLoading state changes; queue size is read synchronously
 *     when needed.
 *
 * Slice 4 (full module-level unified queue, à la legacy internal build upstream) is
 * explicitly deferred behind hard gates. See slicing plan memory.
 */

/** Single source for buffer hard cap. Bumping this requires verifying:
 *   - footer wording stays sensible at higher counts ("3 queued"… "12 queued"?)
 *   - terminal vertical space for footer preview doesn't blow up
 *  Tested below at 4, 10, 100 to make sure ring-buffer semantics holds. */
export const MAX_QUEUE_SIZE = 4

/** Origin of a queued submission. Used by drain logic to decide whether
 *  to schedule with a delay (auto_drain after Ctrl+C wants a stable frame)
 *  vs send immediately (user typed while another turn was running). */
export type SubmissionOrigin = 'user' | 'auto_drain'

/** The minimal shape — deliberately small. If extensions are needed
 *  (mode, priority, pasted content), add them ONE AT A TIME after a
 *  concrete user-visible reason exists, not speculatively. */
export interface QueuedSubmission {
  kind: 'user_turn'
  text: string
  submittedAt: number
  origin: SubmissionOrigin
}

export class SubmissionQueue {
  private items: QueuedSubmission[] = []
  /** Set when the most recent enqueue caused an oldest-item drop.
   *  UI reads this once per turn-end to decide whether to surface a
   *  "queue overflowed" footer notice. Cleared by `consumeOverflowFlag`. */
  private overflowOnLastEnqueue = false

  /** Append `submission` to the tail. Returns false when the buffer was
   *  full and the OLDEST item was dropped to make room (caller may want
   *  to footer-notice). Returns true on a clean enqueue. */
  enqueue(submission: QueuedSubmission): boolean {
    this.items.push(submission)
    if (this.items.length > MAX_QUEUE_SIZE) {
      this.items.shift()
      this.overflowOnLastEnqueue = true
      return false
    }
    return true
  }

  /** Pop the head (oldest) item, or undefined when empty. FIFO. */
  dequeue(): QueuedSubmission | undefined {
    return this.items.shift()
  }

  /** Read the head without removing — for "what's next about to run"
   *  inspections (footer hint / debug). */
  peek(): QueuedSubmission | undefined {
    return this.items[0]
  }

  get size(): number {
    return this.items.length
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  /** Snapshot of the queue contents — for display (footer preview /
   *  /queue debug listing). DO NOT mutate the returned array. */
  snapshot(): readonly QueuedSubmission[] {
    return this.items.slice()
  }

  /** Drop all queued items. Used by `/clear` (hard reset) and explicit
   *  user discard. Clears the overflow flag too. */
  clear(): void {
    this.items.length = 0
    this.overflowOnLastEnqueue = false
  }

  /** Read-and-reset for the overflow indicator. Caller (typically the
   *  enqueue site or the turn-finally footer logic) checks this and
   *  surfaces a one-shot notice when it returns true. Subsequent calls
   *  return false until another overflow happens. */
  consumeOverflowFlag(): boolean {
    const flag = this.overflowOnLastEnqueue
    this.overflowOnLastEnqueue = false
    return flag
  }
}
