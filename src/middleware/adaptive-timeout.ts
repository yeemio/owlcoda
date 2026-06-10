/**
 * 0.14.1 — input-size-aware request timeout budget.
 *
 * Replaces the flat `requestTimeoutMs` (120s default) at /v1/messages
 * non-streaming entry, and the flat `streamFirstTokenTimeoutMs` (90s)
 * at streaming first-chunk watchdog, with budgets that scale with
 * estimated input token count.
 *
 * Why this exists:
 *   The 0.13.97 stream-lifecycle split fixed the "wall-clock kills
 *   active stream" bug, but left two flat budgets in place. With a
 *   17K-token input on a non-streaming cloud route, the model needs
 *   ~120s+ just to *produce* first output — the flat 120s budget kills
 *   the request before any response can be assembled. Same on the
 *   streaming side: 17K input → first chunk often >90s → watchdog fires.
 *
 *   This module estimates input size from the request body and adds a
 *   linear extension per 10K input tokens, capped to avoid runaway
 *   budgets on accidental massive inputs.
 *
 * What this is NOT:
 *   - NOT a heuristic for output length. Output budgets stay flat —
 *     a model that has produced first token but stalls afterward
 *     should be caught by the per-chunk idle timer, not by a fat
 *     up-front budget.
 *   - NOT model-aware. Different models have very different
 *     tokens/second rates, but we don't have reliable per-route rate
 *     telemetry. Users who need per-route tuning use per-route
 *     `timeoutMs` overrides on the model record (which is already
 *     supported; this only adjusts the *outer* wall-clock).
 *   - NOT a replacement for explicit per-route timeouts. The cap
 *     applies to the final return value, but a route that sets its
 *     own much-shorter `timeoutMs` will still override at fetch time
 *     (messages.ts:282).
 *
 * Disable: set `middleware.adaptiveTimeoutEnabled = false` in config
 * to restore 0.14.0 flat behavior.
 */

import type { MiddlewareConfig } from '../config.js'

/** Default extension added per 10K estimated input tokens. Initially
 *  60s (0.14.1) but bumped to 90s (0.14.3) after a real-world failure:
 *  33.7K-token MES-AI architecture review request hit the exactly-
 *  300s 0.14.1 adaptive budget (120 + 3 × 60s) at 300.5s elapsed with
 *  no response back. 60s/10K was too tight on slow cloud routes.
 *  90s/10K gives 33.7K → 390s budget, with the 600s cap reached at
 *  ~53K input. Tuneable via `middleware.adaptiveTimeoutExtensionPer10kMs`. */
export const DEFAULT_ADAPTIVE_EXTENSION_PER_10K_MS = 90_000

/** Default absolute cap on the adaptive budget. 10 minutes is large
 *  enough for legitimate long-context tasks (e.g. evaluating a 100K
 *  token codebase summary) without leaving an obviously-hung request
 *  pegging the queue. Tuneable via `middleware.adaptiveTimeoutCapMs`. */
export const DEFAULT_ADAPTIVE_CAP_MS = 600_000

/** Char-to-token estimator constant. Public LLM tokenizers cluster
 *  around 3.5–4.5 chars / token for mixed English+code; CJK averages
 *  more like 1.5 chars / token but we deliberately overshoot the
 *  estimate so the budget is generous, not stingy. */
const CHARS_PER_TOKEN = 4

/** Minimal subset of an Anthropic /v1/messages request we need for
 *  estimation. We accept any shape that looks roughly Anthropic-y;
 *  unknown fields are ignored. The body comes from the wire and is
 *  not pre-validated when we run, so be defensive. */
export interface EstimatableBody {
  system?: unknown
  messages?: unknown
}

/** Estimate input character count by walking the standard Anthropic
 *  body shape. Counts the `system` field plus each message's content
 *  (string or array of `{type: text, text}` / `{type: image, ...}` /
 *  `{type: tool_use, input}` / `{type: tool_result, content}` blocks).
 *
 *  This is intentionally a rough estimator — we only need an order-of-
 *  magnitude signal to decide "small (<5K tokens, default budget) vs
 *  medium (~20K, +120s) vs large (~50K, +300s)". Don't add complex
 *  tokenizer logic here; it's not worth the dependency. */
export function estimateInputChars(body: EstimatableBody): number {
  let total = 0
  if (typeof body.system === 'string') {
    total += body.system.length
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        total += ((block as { text: string }).text).length
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') {
        total += content.length
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') {
            total += (b.text as string).length
          } else if (typeof b.content === 'string') {
            // tool_result with string content
            total += (b.content as string).length
          } else if (Array.isArray(b.content)) {
            // tool_result with array-of-blocks content
            for (const sub of b.content) {
              if (sub && typeof sub === 'object' && typeof (sub as { text?: unknown }).text === 'string') {
                total += ((sub as { text: string }).text).length
              }
            }
          } else if (b.input && typeof b.input === 'object') {
            // tool_use — serialize JSON as a cheap proxy
            try {
              total += JSON.stringify(b.input).length
            } catch {
              // circular ref or weird shape — skip
            }
          }
        }
      }
    }
  }
  return total
}

/** Convert char count to a rough input-token estimate. Intentionally
 *  conservative (overshoots English, undershoots CJK) — see
 *  CHARS_PER_TOKEN docstring. */
export function estimateInputTokens(body: EstimatableBody): number {
  return Math.ceil(estimateInputChars(body) / CHARS_PER_TOKEN)
}

export interface AdaptiveTimeoutInputs {
  /** The base budget (already-resolved fallback default). For
   *  non-streaming this is typically `middleware.requestTimeoutMs ?? 120_000`;
   *  for streaming first-token, `middleware.streamFirstTokenTimeoutMs ?? 90_000`. */
  baseMs: number
  /** The request body. May be partially populated; estimator is
   *  defensive. */
  body: EstimatableBody
  /** Middleware config block. */
  middleware: MiddlewareConfig | undefined
}

export interface AdaptiveTimeoutResult {
  /** The final budget to use (after extension and cap). Always >= baseMs. */
  timeoutMs: number
  /** Estimated input tokens (for telemetry / diagnostics). */
  estimatedInputTokens: number
  /** Extension applied above baseMs, in ms. 0 means adaptive was
   *  disabled or input too small to extend. */
  extensionMs: number
  /** True if the cap clamped the result. Useful for diagnostics
   *  ("we'd have given 720s but capped at 600s"). */
  cappedAtMaxMs: boolean
}

/** Compute the adaptive budget. Returns `baseMs` unchanged when
 *  `middleware.adaptiveTimeoutEnabled === false` (opt-out). */
export function computeAdaptiveTimeoutMs(inputs: AdaptiveTimeoutInputs): AdaptiveTimeoutResult {
  const { baseMs, body, middleware } = inputs
  const mw = middleware ?? {}
  const enabled = mw.adaptiveTimeoutEnabled !== false  // default ON
  if (!enabled) {
    return {
      timeoutMs: baseMs,
      estimatedInputTokens: 0,
      extensionMs: 0,
      cappedAtMaxMs: false,
    }
  }
  const tokens = estimateInputTokens(body)
  const per10k = mw.adaptiveTimeoutExtensionPer10kMs ?? DEFAULT_ADAPTIVE_EXTENSION_PER_10K_MS
  const cap = mw.adaptiveTimeoutCapMs ?? DEFAULT_ADAPTIVE_CAP_MS
  // Number of *full* 10K-token blocks above 0. We don't extend for
  // anything under 10K — those fit comfortably in the base budget.
  const blocks = Math.floor(tokens / 10_000)
  const extensionMs = blocks * per10k
  const uncapped = baseMs + extensionMs
  const cappedAtMaxMs = uncapped > cap
  return {
    timeoutMs: Math.min(uncapped, cap),
    estimatedInputTokens: tokens,
    extensionMs,
    cappedAtMaxMs,
  }
}
