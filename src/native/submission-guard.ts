/**
 * 0.13.99 — SubmissionGuard.
 *
 * Three-state interlock for "who owns the in-flight turn". Co-exists with
 * the pre-existing layers, does NOT replace them:
 *
 *   - `isLoading` (React state)  — UI spinner + queue-decision projection
 *   - `runtimeRef.activeTask`    — task-execution-detail (phase, abort,
 *                                  outputGateToken)
 *   - `ReplPhase` 7-state        — composing/awaiting_model/tool_execution/...
 *   - `outputGateToken`          — stream-write race防御 (different scope)
 *
 * What this guard adds on top: a synchronous source-of-truth for "is there
 * an owned turn lifecycle slot right now, and what generation is it?". Used
 * to:
 *
 *   1. Reject concurrent runConversationTurn invocations (auto-retry timer
 *      firing during a user submit; queued drain firing during an in-flight
 *      turn; cancel+resubmit race where the cancelled turn's finally is
 *      still pending). All those callers race-tryStart the guard; second
 *      caller gets null and skips its body cleanly.
 *
 *   2. Provide a generation counter so the stale `finally` block from a
 *      cancelled turn doesn't tear down state owned by the freshly-started
 *      new turn. `end(gen)` returns false when gen doesn't match the
 *      current generation — caller's cleanup should be skipped.
 *
 * Hard rules (locked in project_turn_lifecycle_slicing_plan.md):
 *
 *   - 不动 isLoading / runtimeRef.activeTask / outputGateToken / ReplPhase
 *   - 不引入 useSyncExternalStore（保持 boolean projection path）
 *   - 不强制取代 ad-hoc clearScheduledAutoRetry()（那是 timer-canceling
 *     optimization, this is interlock invariant; both stay）
 *
 * State machine:
 *
 *      idle ──reserve()──→ dispatching ──tryStart()──→ running
 *       │ ↑                       │            ↑           │
 *       │ │ cancelReservation()   │            │           │ end(gen)
 *       │ └───────────────────────┘            │           │
 *       └──────────────────tryStart()──────────┘           │
 *       ↑                                                  │
 *       │                                                  │
 *       └──────────────forceEnd() (any state)──────────────┘
 *
 * Why `dispatching` matters: the queue-processor / setTimeout drain path
 * reserves the slot BEFORE the async chain that eventually calls
 * onQuery. During that gap, isActive must already be true so re-entrant
 * effect fires don't dequeue a second item. Direct user submit may skip
 * dispatching entirely (idle → running via tryStart).
 *
 * No subscribe/notify — callers read `isActive` synchronously. If a React
 * component needs to re-render when the guard changes, gate it behind
 * isLoading (which IS React state) instead. The guard does not drive UI.
 */

/** Three states the guard can be in. Synchronous; not React-state-batched. */
export type GuardStatus = 'idle' | 'dispatching' | 'running'

export class SubmissionGuard {
  private _status: GuardStatus = 'idle'
  /** Monotonically increasing per tryStart() / forceEnd(). The generation
   *  is the contract between a turn's tryStart-returned-token and its
   *  later end(gen) call. forceEnd() bumps it too so stale finally blocks
   *  from cancelled turns see a mismatch and skip cleanup. */
  private _generation = 0

  /** Reserve the slot for queue / timer processing. Transitions
   *  `idle → dispatching`. Returns false if not idle (another caller
   *  already owns the lifecycle). Use the matching tryStart() shortly
   *  after — `dispatching` is meant to be brief; long-held dispatching
   *  state is a leak symptom. */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    return true
  }

  /** Cancel a reservation when the dispatching caller decided not to
   *  proceed to onQuery (e.g. queue processor peeked nothing actionable,
   *  or processUserInput threw before reaching onQuery). Transitions
   *  `dispatching → idle`. No-op if already running or idle — safe to
   *  call from `finally` blocks unconditionally. */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
  }

  /** Atomically attempt to start a turn. Two legal sources:
   *   - direct user submit (status===idle):    idle → running
   *   - queue/timer drain (status===dispatching): dispatching → running
   *
   *  Returns the generation number on success — caller MUST stash it
   *  and pass back to end(gen) for the cleanup to count. Returns null
   *  when status===running (another turn already owns the slot) —
   *  caller should bail out cleanly with no side effects. */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    return this._generation
  }

  /** End a turn. Returns true if this generation is still current,
   *  meaning the caller's cleanup should run. Returns false if a newer
   *  turn has already started (stale finally from a cancelled turn) —
   *  caller should skip side effects (setIsLoading(false), spinner
   *  reset, footer notice, etc.). */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    return true
  }

  /** Force-end the current turn regardless of generation. Used by
   *  /clear and Ctrl+C / interrupt paths where any in-flight turn must
   *  be torn down. Bumps generation so the cancelled turn's eventual
   *  finally call to end(staleGen) returns false and skips its
   *  cleanup — the new turn (or idle state) owns the lifecycle now. */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
  }

  /** Synchronous "is the guard owning a slot right now (dispatching OR
   *  running)?". Use this for the gate that decides "should I queue
   *  this submit or run it immediately?". */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  /** Current state — exposed for debug / telemetry only. Do not branch
   *  on the specific status in production code; use isActive instead. */
  get status(): GuardStatus {
    return this._status
  }

  /** Current generation counter — exposed for tests + telemetry. */
  get generation(): number {
    return this._generation
  }

  /** Reset to fresh state. Test helper only. NOT for production use —
   *  forceEnd() handles the lifecycle reset path. */
  reset(): void {
    this._status = 'idle'
    this._generation = 0
  }
}
