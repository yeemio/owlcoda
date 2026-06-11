/**
 * agent_timeout_policy_v1 (0.13.57) — two-axis subagent watchdog.
 *
 * Background: 0.13.55 soft loop intercept handles conversation-level
 * repeated tool failure but does not catch lower-level wedges
 * (subprocess hang, Promise that never resolves, infinite generator).
 * Pre-0.13.57 the only outer safety on the Agent tool was the
 * post-abort grace period (TOOL_ABORT_HARD_DEADLINE_MS = 3s) — there
 * was no wall-clock deadline at all, so a quiet subagent could
 * theoretically run forever.
 *
 * 0.13.57 introduces a two-axis policy:
 *
 *   1. Idle timeout (`OWLCODA_AGENT_IDLE_TIMEOUT_MS`, default 5 min)
 *      — abort if no real progress signal arrives for this long. The
 *      reset signals are not "stdout/text from the model" alone (that
 *      would punish quiet but productive subagents that grind on tool
 *      use without narrating); they include any of: assistant text,
 *      tool_use start, tool_result end, tool progress chunk, runtime
 *      notice. So a subagent doing back-to-back read/grep on a 4000-
 *      line file keeps the watchdog awake even if the model never
 *      streams a token.
 *
 *   2. Max runtime (`OWLCODA_AGENT_MAX_RUNTIME_MS`, default 30 min)
 *      — absolute ceiling; fires regardless of progress. This is the
 *      true deadlock catcher.
 *
 * Both knobs accept `0` to disable. Default for both is on; the
 * recommended posture is "keep idle on; keep max on; only override
 * for genuinely long-running batch jobs".
 *
 * Industry reference (per 2026-05-06 survey):
 *   - Aider / Continue: per-request timeout, no idle vs max split
 *   - Codex CLI: `max_runtime_seconds` per subagent (1800s default)
 *   - Claude Code, Cursor: no built-in deadline; user-Esc only
 *   - OpenHands: Stuck Detector (semantic loop, not wall-clock)
 *
 * 0.13.57 picks idle+max with progress-signal heartbeat — closer to
 * OpenHands' philosophy ("watch productive progress, not silence")
 * but still gives operators wall-clock guardrails.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 min
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000 // 30 min

/** Progress event types that reset the idle clock. */
export type AgentProgressType =
  | 'agent_start'
  | 'assistant_text'
  | 'tool_start'
  | 'tool_end'
  | 'tool_progress'
  | 'notice'

export interface AgentProgressMark {
  type: AgentProgressType
  at: number
  // Optional human-readable detail; surfaced in the abort message so
  // operators can see "last progress was tool_start:bash" rather than
  // just "last progress 87s ago".
  detail?: string
}

/** What the watchdog observed at the moment it fired. */
export interface AgentTimeoutFiring {
  kind: 'idle' | 'max'
  at: number
  startTime: number
  lastProgress: AgentProgressMark
  idleTimeoutMs: number
  maxRuntimeMs: number
}

/**
 * Read an env-var-or-undefined as ms count with a default. Rules:
 *  - empty / unset / not-a-number → defaultMs
 *  - non-finite or negative → defaultMs (fail safe to default)
 *  - 0 (literal) → returned as 0 (caller treats as "disabled")
 *  - positive number → returned as integer ms
 */
export function parseAgentTimeoutMs(
  raw: string | undefined,
  defaultMs: number,
): number {
  if (raw === undefined || raw === '') return defaultMs
  const trimmed = String(raw).trim()
  if (trimmed === '') return defaultMs
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return defaultMs
  if (n < 0) return defaultMs
  return Math.floor(n)
}

/** Resolve the active idle/max policy from env, with defaults. */
export function resolveAgentTimeoutPolicy(env: NodeJS.ProcessEnv = process.env): {
  idleTimeoutMs: number
  maxRuntimeMs: number
} {
  return {
    idleTimeoutMs: parseAgentTimeoutMs(env['OWLCODA_AGENT_IDLE_TIMEOUT_MS'], DEFAULT_IDLE_TIMEOUT_MS),
    maxRuntimeMs: parseAgentTimeoutMs(env['OWLCODA_AGENT_MAX_RUNTIME_MS'], DEFAULT_MAX_RUNTIME_MS),
  }
}

export interface AgentWatchdogHandle {
  /** AbortSignal that fires when either timeout trips. Caller threads
   *  this into runConversationLoop so the LLM fetch and downstream
   *  tools cancel cooperatively. */
  signal: AbortSignal
  /** Record a progress event. Idempotent in spirit; any call resets
   *  the idle clock. */
  recordProgress: (type: AgentProgressType, detail?: string) => void
  /** Surface the firing event (null if the watchdog never tripped). */
  getFiring: () => AgentTimeoutFiring | null
  /** Last recorded progress mark. */
  getLastProgress: () => AgentProgressMark
  /** Stop the interval and detach external listeners. Idempotent. */
  dispose: () => void
}

export interface AgentWatchdogOptions {
  idleTimeoutMs: number
  maxRuntimeMs: number
  /** Caller's external abort source (e.g. user Esc). When this fires,
   *  the watchdog also aborts. Optional. */
  externalSignal?: AbortSignal
  /** Caller-supplied tick interval; default 500ms. Tests can pass a
   *  smaller value to make assertions cheap. */
  tickMs?: number
  /** Time source override for tests. Defaults to Date.now. */
  now?: () => number
  /** setInterval / clearInterval injection points for tests. */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/**
 * Build the watchdog. Caller is expected to:
 *   1. Wrap their conversation callbacks so each callback type
 *      fires `recordProgress(<type>, <detail>)` once.
 *   2. Pass `signal` into runConversationLoop's `opts.signal`.
 *   3. After the run, check `getFiring()` to format an actionable
 *      timeout message, otherwise fall through to normal completion.
 *   4. Always call `dispose()` in a `finally` block.
 */
export function createAgentWatchdog(opts: AgentWatchdogOptions): AgentWatchdogHandle {
  const tickMs = opts.tickMs ?? 500
  const now = opts.now ?? (() => Date.now())
  const setIntv = opts.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms))
  const clearIntv = opts.clearIntervalImpl ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

  const startTime = now()
  const controller = new AbortController()
  let lastProgress: AgentProgressMark = { type: 'agent_start', at: startTime }
  let firing: AgentTimeoutFiring | null = null
  let interval: unknown = null
  let externalListener: (() => void) | null = null
  let disposed = false

  const recordProgress = (type: AgentProgressType, detail?: string): void => {
    if (disposed) return
    if (controller.signal.aborted) return
    lastProgress = detail !== undefined ? { type, at: now(), detail } : { type, at: now() }
  }

  const checkOnce = (): void => {
    if (controller.signal.aborted) return
    const t = now()
    if (opts.idleTimeoutMs > 0 && t - lastProgress.at >= opts.idleTimeoutMs) {
      firing = {
        kind: 'idle',
        at: t,
        startTime,
        lastProgress,
        idleTimeoutMs: opts.idleTimeoutMs,
        maxRuntimeMs: opts.maxRuntimeMs,
      }
      controller.abort()
      return
    }
    if (opts.maxRuntimeMs > 0 && t - startTime >= opts.maxRuntimeMs) {
      firing = {
        kind: 'max',
        at: t,
        startTime,
        lastProgress,
        idleTimeoutMs: opts.idleTimeoutMs,
        maxRuntimeMs: opts.maxRuntimeMs,
      }
      controller.abort()
      return
    }
  }

  // Only schedule a watchdog tick if at least one axis is enabled.
  if (opts.idleTimeoutMs > 0 || opts.maxRuntimeMs > 0) {
    interval = setIntv(checkOnce, tickMs)
  }

  // Forward external aborts (user Esc) without recording a firing —
  // that path is "user cancelled", not a timeout.
  if (opts.externalSignal) {
    if (opts.externalSignal.aborted) {
      controller.abort()
    } else {
      externalListener = (): void => {
        if (!controller.signal.aborted) controller.abort()
      }
      opts.externalSignal.addEventListener('abort', externalListener, { once: true })
    }
  }

  return {
    signal: controller.signal,
    recordProgress,
    getFiring: () => firing,
    getLastProgress: () => lastProgress,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (interval !== null) clearIntv(interval)
      if (externalListener && opts.externalSignal) {
        opts.externalSignal.removeEventListener('abort', externalListener)
      }
    },
  }
}

/**
 * Build the operator-facing abort message when the watchdog fired.
 * Always includes the last-progress evidence so "my agent died at 5
 * minutes" can be diagnosed without re-running.
 */
export function formatAgentTimeoutMessage(firing: AgentTimeoutFiring): string {
  const elapsedMs = firing.at - firing.startTime
  const idleMs = firing.at - firing.lastProgress.at
  const lp = firing.lastProgress
  const lpDetail = lp.detail ? ` (${lp.detail})` : ''
  const lpAgoSec = ((firing.at - lp.at) / 1000).toFixed(1)
  const elapsedSec = (elapsedMs / 1000).toFixed(1)
  const idleSec = (idleMs / 1000).toFixed(1)

  if (firing.kind === 'idle') {
    return [
      `[Agent timeout — idle]`,
      `The sub-agent ran for ${elapsedSec}s but had no progress for ${idleSec}s ` +
      `(idle timeout = ${(firing.idleTimeoutMs / 1000).toFixed(0)}s).`,
      `Last progress event: ${lp.type}${lpDetail} ${lpAgoSec}s ago.`,
      `Tune via OWLCODA_AGENT_IDLE_TIMEOUT_MS=<ms> ` +
      `(currently ${firing.idleTimeoutMs}; set 0 to disable idle timeout) or ` +
      `OWLCODA_AGENT_MAX_RUNTIME_MS=<ms> ` +
      `(currently ${firing.maxRuntimeMs}; set 0 to disable hard ceiling, not recommended).`,
    ].join('\n')
  }
  return [
    `[Agent timeout — max runtime]`,
    `The sub-agent exceeded the maximum runtime ` +
    `(${elapsedSec}s > ${(firing.maxRuntimeMs / 1000).toFixed(0)}s ceiling).`,
    `Last progress event: ${lp.type}${lpDetail} ${lpAgoSec}s ago.`,
    `Tune via OWLCODA_AGENT_MAX_RUNTIME_MS=<ms> ` +
    `(currently ${firing.maxRuntimeMs}; set 0 to disable hard ceiling, not recommended).`,
  ].join('\n')
}
