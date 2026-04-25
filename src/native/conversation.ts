/**
 * OwlCoda Native Conversation Loop
 *
 * The core agentic loop: send request → parse response → execute tools → repeat.
 * Continues until the model returns end_turn or max iterations reached.
 */

import { createHash } from 'node:crypto'
import type {
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  Conversation,
  ConversationTurn,
  AssistantResponse,
} from './protocol/types.js'
import type { AnthropicMessagesRequest } from './protocol/types.js'
import type { AskUserQuestionOpts, ToolProgressEvent } from './tools/types.js'
import { buildRequest, sanitizeConversationTurns } from './protocol/request.js'
import { consumeStream } from './protocol/stream.js'
import { parseResponse } from './protocol/response.js'
import { ToolDispatcher, type ToolExecutionResult } from './dispatch.js'
import { estimateConversationTokens, estimateTokens } from './usage.js'
import {
  buildTaskContinuePrompt,
  buildTaskRealignPrompt,
  approveTaskWriteScope,
  describeTaskExecutionState,
  evaluateWriteGuard,
  ensureTaskExecutionState,
  markTaskCompleted,
  markTaskGuardBlocked,
  markTaskIteration,
  markTaskProgress,
  markTaskWaitingUser,
  markTaskWriteScopeBlocked,
} from './task-state.js'
import {
  classifyProviderRequestError,
  formatContinuationFailure,
  formatProviderDiagnostic,
  parseProviderDiagnosticFromPayload,
  parseProviderDiagnosticFromString,
  ProviderRequestError,
  type ContinuationContext,
  type ProviderRequestDiagnostic,
} from '../provider-error.js'

// Hard cap on agentic iterations per turn. The default is generous so that
// long sidecar / investigation runs don't get cut off by an over-eager
// safety valve — the user is always in the loop (Ctrl+C is authoritative).
// Override with OWLCODA_MAX_ITERATIONS=<n> (0 or "unlimited" disables the
// cap entirely; -1 also works).
function resolveDefaultMaxIterations(): number {
  const raw = process.env['OWLCODA_MAX_ITERATIONS']
  if (raw !== undefined && raw !== '') {
    const lowered = raw.trim().toLowerCase()
    if (lowered === 'unlimited' || lowered === 'infinity' || lowered === 'inf') {
      return Number.POSITIVE_INFINITY
    }
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return Number.POSITIVE_INFINITY
      return parsed
    }
  }
  return 200
}
const DEFAULT_MAX_ITERATIONS = resolveDefaultMaxIterations()

// Agentic mode.
//   free (default): convergence never forces synthesis; fan-out summary gate
//     never fires; the tool-only nudge never fires. The user is the only
//     authority that decides when the loop stops — Ctrl+C or an explicit
//     model-driven end_turn.
//   strict: restores the 0.12.6-and-earlier behavior — synthesis phase is
//     auto-entered after convergence signals, fan-out gates tool batches,
//     nudge injects after N consecutive tool-only turns.
//
// OWLCODA_AGENTIC_MODE = strict | converge   → strict
// anything else (including unset / free / unlimited / user) → free
function isAgenticStrict(): boolean {
  const v = (process.env['OWLCODA_AGENTIC_MODE'] ?? '').toLowerCase().trim()
  return v === 'strict' || v === 'converge'
}
const AUTO_COMPACT_THRESHOLD = 0.8 // compact at 80% context usage
const AUTO_COMPACT_KEEP_RATIO = 0.5 // keep 50% of turns after compact
const TOOL_LOOP_GUARD_WINDOW = 10
const TOOL_OUTPUT_MAX_CHARS = 20_000 // truncate individual tool outputs beyond this
const TOOL_DISPLAY_OUTPUT_MAX_CHARS = 8_000 // callback/display copy should be smaller than model retention
const TOOL_ONLY_NUDGE_THRESHOLD = 3
// How many consecutive summary-gate violations we tolerate before hard-stopping.
// A single violation used to break the loop immediately — too aggressive for
// multi-file investigation tasks. We nudge every violation and only stop after
// the model has clearly refused to synthesize `threshold` times in a row.
const SUMMARY_GATE_VIOLATION_STOP_THRESHOLD = 4
// Stall (consecutive no-text iterations) before a hard stop. Previously 6 —
// bumped so legitimate tool-heavy runs (reading many files, running smoke
// scripts) aren't cut short. Works in AND with shouldStopToolOnlyLoop which
// already requires no convergence progress, so this being higher is safe.
const TOOL_ONLY_STALL_THRESHOLD = 20
const OPEN_TASK_AUTO_CONTINUE_LIMIT = 2
const EXPLORATORY_TOOL_FANOUT_LIMIT = 4
const EXPLORATORY_TOOL_FANOUT_LIMIT_MAX = 8
const TARGETED_CHECK_TOOL_LIMIT = 1
const CONVERGENCE_ENTRY_SIGNAL_THRESHOLD = 3
const CONVERGENCE_ENTRY_TARGET_THRESHOLD = 4
const CONVERGENCE_ENTRY_BATCH_THRESHOLD = 2
const CONVERGENCE_ENTRY_REQUEST_THRESHOLD = 3
const CONVERGENCE_ENTRY_ELAPSED_MS = 20_000
const CONVERGENCE_FORCE_REQUEST_THRESHOLD = 8
const CONVERGENCE_FORCE_ELAPSED_MS = 90_000
const CONTINUATION_BUDGET_MAX = 4
const CONTINUATION_PROGRESS_WINDOW = 4
const CONTINUATION_STALE_TURN_THRESHOLD = 2
const CONTINUATION_FORCE_STALE_TURN_THRESHOLD = 3
const SYNTHESIS_MAX_TOKENS = 900
const FALLBACK_SYNTHESIS_MAX_TOKENS = 650
const TOOL_ONLY_NUDGE_TEXT = '[System: You have made 3 consecutive tool calls without producing any text output. Before requesting more tools, you MUST first write a text response summarizing what you have found so far and what you plan to do next. Do NOT call any tools in your next response — write text only.]'
const SYNTHESIS_STOP_SEQUENCES = ['\n[TOOL_CALL]', '\n<minimax:tool_call>', '\n<invoke name=', '\n```']
const PSEUDO_TOOL_CALL_RE = /(?:^|\n)\s*(?:\[\/?TOOL_CALL\]|<\s*minimax:tool_call\b|<\s*tool_call\b|<\s*invoke\b)/im
const SYNTHESIS_ESCAPE_RE = /\b(?:let me|i(?:'|’)ll|i will|next(?: step)?|need(?:s)? to|still need(?:s)?|want to)\b[\s,:-]{0,12}(?:read|search|grep|inspect|open|check|look|scan|fetch)\b/i
const WEAK_CONCLUSION_RE = /\b(?:need more evidence|insufficient evidence|unclear|unknown|more investigation|further investigation)\b/i
const TASK_WRITE_INTENT_RE = /\b(?:write|edit|patch|update|modify|create|add|implement|fix|rename|remove|delete|save|land|ship)\b|(?:写|改|修改|更新|补|新增|实现|修复|创建|生成|删除|落盘)/i
const TASK_NO_CHANGE_NEEDED_RE = /\b(?:no (?:changes?|edits?) (?:needed|required)|nothing to change|already (?:correct|implemented|done|up to date)|no fix required)\b|(?:无需修改|不需要改动|不用改|现有实现已满足)/i

interface ToolAttemptSignature {
  name: string
  category: string
  target: string
  intentTarget: string
  intentKey: string
  signature: string
  isError: boolean
}

type RuntimeConvergencePhase =
  | 'exploring'
  | 'targeted_check'
  | 'synthesizing'
  | 'fallback_synthesizing'
  | 'hard_stop'

type TurnRequestMode = 'normal' | 'task_realign' | 'targeted_check' | 'synthesis'

interface ConvergenceRuntimeState {
  phase: RuntimeConvergencePhase
  startedAtMs: number
  requestCount: number
  exploratoryBatchCount: number
  exploratoryTargets: Set<string>
  relevantSignalCount: number
  dominantHypothesis: string | null
  lastGap: string | null
  targetedCheckUsed: boolean
  summaryGatePending: boolean
  continuationBudget: number
  stagnantTurnCount: number
  recentProgress: ProgressObservation[]
  lastProgressAtMs: number
}

interface ProgressObservation {
  kind: 'text' | 'tool'
  newTargets: number
  repeatedTargets: number
  newSignals: number
  hypothesisChanged: boolean
  gapChanged: boolean
  productive: boolean
  timestampMs: number
}

interface TurnRequestPlan {
  mode: TurnRequestMode
  request: AnthropicMessagesRequest
}

interface ToolExecutionPlan {
  executeBlocks: AnthropicToolUseBlock[]
  runtimeBlocks: AnthropicTextBlock[]
  notices: string[]
  summaryGateTriggered: boolean
  targetedCheckConsumed: boolean
}

interface FinalAnswerContractResult {
  ok: boolean
  reason: string
  normalizedText?: string
}

type ActiveTaskState = NonNullable<NonNullable<Conversation['options']>['taskState']>

export interface ConversationCallbacks {
  /** Called when text is streamed from the model */
  onText?: (text: string) => void
  /** Called when a tool starts executing */
  onToolStart?: (toolName: string, input: Record<string, unknown>) => void
  /** Called when a tool finishes */
  onToolEnd?: (toolName: string, result: string, isError: boolean, durationMs: number, metadata?: Record<string, unknown>) => void
  /** Called with live progress updates during tool execution (e.g. bash output). */
  onToolProgress?: (toolName: string, event: ToolProgressEvent) => void
  /** Called when the model responds (text + any tool calls) */
  onResponse?: (response: AssistantResponse) => void
  /** Called on error */
  onError?: (error: string) => void
  /** Called for non-error notices (e.g. successful compaction) */
  onNotice?: (message: string) => void
  /** Called with token usage updates during streaming */
  onUsage?: (tokens: { input: number; output: number }) => void
  /**
   * Called when an API error occurs and the system will retry.
   * Receives the error message, retry delay in ms, attempt number, and max retries.
   * The REPL uses this to display a visible countdown.
   */
  onRetry?: (info: { error: string; delayMs: number; attempt: number; maxRetries: number }) => void
  /**
   * Called before a tool executes to request user approval.
   * Return true to proceed, false to skip.
   * If not provided, all tools auto-execute.
   */
  onToolApproval?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
  /**
   * Called when a tool write is inside the workspace but outside the current
   * task-contract write scope. This is separate from generic tool approval:
   * auto-approving Write should not silently broaden the task contract.
   */
  onTaskScopeApproval?: (request: {
    toolName: string
    input: Record<string, unknown>
    attemptedPath: string
    allowedPaths: string[]
    message: string
  }) => Promise<boolean>
  /**
   * Called when a tool needs to ask the user a free-text question.
   * Used by the AskUserQuestion tool path. When the host provides this
   * callback, the tool routes through the host UI (no direct
   * stdout.write, which would race Ink's frame paint). When omitted,
   * tools fall back to a readline prompt (headless/non-interactive).
   * Resolves with the user's answer; empty string = cancelled.
   */
  onUserQuestion?: (
    toolName: string,
    question: string,
    opts?: AskUserQuestionOpts,
  ) => Promise<string>
  /**
   * Called during extended thinking blocks.
   * event='start' when thinking begins, 'delta' for text chunks, 'end' when complete.
   */
  onThinking?: (event: 'start' | 'delta' | 'end', text?: string) => void
  /** Called when auto-compact triggers due to context window limit. */
  onAutoCompact?: (info: { before: number; after: number; threshold: number }) => void
}

export interface ConversationLoopOptions {
  /** Base URL for the Anthropic-compatible API */
  apiBaseUrl: string
  /** API key (sent as Bearer token) */
  apiKey: string
  /** Max agentic loop iterations before stopping */
  maxIterations?: number
  /** Callbacks for real-time display */
  callbacks?: ConversationCallbacks
  /** AbortSignal for request cancellation */
  signal?: AbortSignal
  /** Context window size in tokens (for auto-compact) */
  contextWindow?: number
  /** Per-request timeout in ms (default 180_000 = 3 minutes) */
  requestTimeoutMs?: number
  /** Fallback models to try when the primary model is exhausted/overloaded. Requires allowCrossModelFallback. */
  fallbackModels?: string[]
  /** Explicit opt-in for cross-model fallback; interactive REPL keeps this off. */
  allowCrossModelFallback?: boolean
}

export type ConversationRuntimeFailureKind =
  | 'pre_first_token_stream_close'
  | 'post_token_stream_close'
  | 'timeout'
  | 'abort'
  | 'http_error'
  | 'provider_error'

export type ConversationRuntimeFailurePhase = 'request' | 'continuation' | 'tool_continuation'

export interface ConversationRuntimeFailure {
  kind: ConversationRuntimeFailureKind
  phase: ConversationRuntimeFailurePhase
  message: string
  retryable: boolean
  diagnostic?: ProviderRequestDiagnostic
}

/**
 * Run one turn of the agentic loop:
 * 1. Send conversation to API
 * 2. Parse response
 * 3. If tool_use → execute tools → add results → recurse
 * 4. If end_turn → return final text
 */
export async function runConversationLoop(
  conversation: Conversation,
  dispatcher: ToolDispatcher,
  opts: ConversationLoopOptions,
): Promise<{
  conversation: Conversation
  finalText: string
  iterations: number
  stopReason: string | null
  usage: { inputTokens: number; outputTokens: number; requestCount: number }
  runtimeFailure: ConversationRuntimeFailure | null
}> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  let iterations = 0
  let finalText = ''
  let lastStopReason: string | null = null
  let runtimeFailure: ConversationRuntimeFailure | null = null
  let noTextIterations = 0 // consecutive iterations with no assistant text
  let summaryGateViolations = 0 // consecutive summary-gate refusals (tool-only reply after a nudge)
  let openTaskAutoContinueCount = 0
  const totalUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 }
  const toolAttempts: ToolAttemptSignature[] = []
  const convergence = createConvergenceRuntimeState()
  const taskState = ensureTaskExecutionState(conversation)

  opts.callbacks?.onNotice?.(describeTaskExecutionState(taskState))

  while (iterations < maxIterations) {
    // Check for cancellation between iterations
    if (opts.signal?.aborted) break
    iterations++
    markTaskIteration(taskState, {
      iterations,
      currentFocus: convergence.lastGap ?? convergence.dominantHypothesis,
      dominantGap: convergence.lastGap,
    })

    // Auto-compact: if context exceeds threshold, trim older turns
    const beforeCompact = conversation.turns.length
    const compacted = autoCompact(conversation, opts.contextWindow)
    if (compacted && opts.callbacks?.onAutoCompact) {
      opts.callbacks.onAutoCompact({
        before: beforeCompact,
        after: conversation.turns.length,
        threshold: opts.contextWindow ?? 0,
      })
    }

    // 1. Build request with hard budget gate
    let turnPlan = buildTurnRequestPlan(conversation, convergence, taskState)
    let request = turnPlan.request
    const requestTokens = estimateTokens(JSON.stringify(request))
    const hardLimit = opts.contextWindow ?? 0

    // Hard gate: if request exceeds model context window, aggressively compact
    if (hardLimit > 0 && requestTokens > hardLimit) {
      let compactAttempts = 0
      while (compactAttempts < 5) {
        compactAttempts++
        if (conversation.turns.length <= 2) break
        const beforeTurns = conversation.turns.length
        const keepRatio = Math.max(0.2, 1 - (compactAttempts * 0.2))
        conversation.turns = sanitizeConversationTurns(
          conversation.turns.slice(-Math.max(2, Math.floor(conversation.turns.length * keepRatio))),
        )
        opts.callbacks?.onAutoCompact?.({
          before: beforeTurns,
          after: conversation.turns.length,
          threshold: hardLimit,
        })
        turnPlan = buildTurnRequestPlan(conversation, convergence, taskState)
        request = turnPlan.request
        const newTokens = estimateTokens(JSON.stringify(request))
        if (newTokens <= hardLimit * 0.9) break
      }

      // Re-check: if STILL oversized after all compaction, refuse to send
      const finalTokens = estimateTokens(JSON.stringify(request))
      if (finalTokens > hardLimit) {
        if (turnPlan.mode === 'synthesis') {
          opts.callbacks?.onNotice?.('Hard stop: synthesis packet exceeded the context budget after compaction')
          opts.callbacks?.onError?.(
            `Synthesis packet still exceeds context limit after compaction (${finalTokens} est. > ${hardLimit} limit).`,
          )
          convergence.phase = 'hard_stop'
          lastStopReason = 'hard_stop'
        } else {
          opts.callbacks?.onError?.(
            `Request still exceeds context limit after compaction (${finalTokens} est. > ${hardLimit} limit). ` +
            `Use /clear to reset, or /model to switch to a model with a larger context window.`,
          )
        }
        break // do NOT send — break out of the conversation loop
      }
      opts.callbacks?.onNotice?.(`Context compacted: ${requestTokens} est. tokens → ${conversation.turns.length} turns, continuing…`)
    }

    let response: AssistantResponse

    try {
      response = await sendRequest(request, opts)
    } catch (err: unknown) {
      if (opts.signal?.aborted) break
      const msg = err instanceof Error ? err.message : String(err)

      // Context window exceeded (error code 2013 or similar) — auto-compact and retry
      if (isContextLimitError(msg) && conversation.turns.length > 2) {
        const beforeTurns = conversation.turns.length
        conversation.turns = sanitizeConversationTurns(
          conversation.turns.slice(-Math.max(2, Math.floor(conversation.turns.length * 0.5))),
        )
        opts.callbacks?.onAutoCompact?.({
          before: beforeTurns,
          after: conversation.turns.length,
          threshold: opts.contextWindow ?? 0,
        })
        opts.callbacks?.onNotice?.(`Context limit hit — compacted ${beforeTurns} → ${conversation.turns.length} turns, retrying…`)
        continue // retry with compacted conversation
      }

      // Backend exhaustion: try fallback models before giving up
      const isBackendDown = /exhaust|overload|50[0-9]|backend|no models|unavailable/i.test(msg)
      if (isBackendDown && opts.allowCrossModelFallback && opts.fallbackModels && opts.fallbackModels.length > 0) {
        const fallback = opts.fallbackModels.shift()!
        conversation.model = fallback
        opts.callbacks?.onError?.(`Model failed — falling back to ${fallback}`)
        request = buildRequest(conversation, true)
        continue
      }

      runtimeFailure = classifyConversationRuntimeFailure(err, conversation, iterations)

      // Prefer the structured diagnostic when sendRequest threw one —
      // it already carries provider/model/request-id/retryable. Fall back
      // to heuristic classification only when the cause isn't typed.
      if (runtimeFailure) {
        opts.callbacks?.onError?.(runtimeFailure.message)
      } else if (err instanceof ProviderRequestError) {
        opts.callbacks?.onError?.(formatProviderDiagnostic(err.diagnostic, { includeRequestId: true }))
      } else {
        opts.callbacks?.onError?.(explainRequestFailure(msg, conversation.model))
      }
      break
    }

    if (opts.signal?.aborted) break
    recordResponseUsage(totalUsage, convergence, response)

    if (turnPlan.mode === 'synthesis') {
      const settled = await settleSynthesisResponse(
        response,
        conversation,
        convergence,
        taskState,
        totalUsage,
        opts,
      )
      if (settled.response) {
        opts.callbacks?.onResponse?.(settled.response)
        conversation.turns.push({
          role: 'assistant',
          content: settled.response.textBlocks,
          timestamp: Date.now(),
        })
        finalText = settled.response.text
        lastStopReason = settled.response.stopReason
        break
      }
      lastStopReason = settled.stopReason
      break
    }

    let toolPlan: ToolExecutionPlan = {
      executeBlocks: response.toolUseBlocks,
      runtimeBlocks: [],
      notices: [],
      summaryGateTriggered: false,
      targetedCheckConsumed: false,
    }

    const wasSummaryGatePending = convergence.summaryGatePending
    if (convergence.summaryGatePending) {
      const violatesGate = !hasMeaningfulAssistantText(response.text)
        && response.toolUseBlocks.length > 0
        && response.toolUseBlocks.every((block) => isExploratoryToolUse(block))
      if (violatesGate) {
        summaryGateViolations += 1
        // Previously a single violation hard-stopped the loop. That was too
        // aggressive — legitimate multi-file investigations routinely need
        // another sweep of reads after the first summary nudge before the
        // model finally summarizes. Let the nudge re-fire a few times; only
        // stop when the model has clearly refused to switch modes N times
        // in a row. summaryGatePending stays true so the next iteration
        // re-injects the nudge instead of silently moving on.
        if (summaryGateViolations >= SUMMARY_GATE_VIOLATION_STOP_THRESHOLD) {
          opts.callbacks?.onError?.(
            `Model ignored the summary gate ${summaryGateViolations} times in a row. Stopping to avoid a tool loop. Press Ctrl+C earlier if you want to intervene.`,
          )
          lastStopReason = 'tool_loop'
          break
        }
        opts.callbacks?.onNotice?.(
          `Summary gate still pending (violation ${summaryGateViolations}/${SUMMARY_GATE_VIOLATION_STOP_THRESHOLD}). Prompting the model again for a text summary.`,
        )
      } else {
        summaryGateViolations = 0
        convergence.summaryGatePending = false
      }
    } else {
      summaryGateViolations = 0
    }

    if (response.toolUseBlocks.length > 0) {
      toolPlan = buildToolExecutionPlan(response.toolUseBlocks, turnPlan.mode, convergence)
      for (const notice of toolPlan.notices) {
        opts.callbacks?.onNotice?.(notice)
      }
      if (toolPlan.summaryGateTriggered) {
        convergence.summaryGatePending = true
      }
    }

    const effectiveResponse = applyToolExecutionPlan(response, toolPlan.executeBlocks)
    opts.callbacks?.onResponse?.(effectiveResponse)

    // Detect stall: tool_use with no blocks, or empty response entirely
    if (effectiveResponse.stopReason === 'tool_use' && effectiveResponse.toolUseBlocks.length === 0) {
      opts.callbacks?.onError?.('Model requested tool execution but returned no tool_use blocks. Use /retry to try again.')
      lastStopReason = 'stalled'
      break
    }
    if (!effectiveResponse.text && effectiveResponse.toolUseBlocks.length === 0 && !effectiveResponse.hasToolUse) {
      runtimeFailure = createEmptyResponseRuntimeFailure(conversation, iterations, response.stopReason)
      opts.callbacks?.onError?.(runtimeFailure.message)
      lastStopReason = 'stalled'
      break
    }

    // Accumulate usage and stop reason
    lastStopReason = effectiveResponse.stopReason

    // 2. Add assistant turn to conversation. Thinking blocks go FIRST —
    // Anthropic convention is thinking → text → tool_use, and thinking-aware
    // providers (kimi-for-coding) validate history by looking for
    // reasoning_content on prior assistant tool_call messages. If we drop
    // the block here, the next request for this model returns HTTP 400
    // "thinking is enabled but reasoning_content is missing".
    const assistantContent: AnthropicContentBlock[] = [
      ...effectiveResponse.thinkingBlocks,
      ...effectiveResponse.textBlocks,
      ...effectiveResponse.toolUseBlocks,
    ]
    conversation.turns.push({
      role: 'assistant',
      content: assistantContent,
      timestamp: Date.now(),
    })

    finalText = effectiveResponse.text
    updateConvergenceFromText(convergence, effectiveResponse.text)
    if (
      effectiveResponse.text.trim()
      && taskState.run.status !== 'waiting_user'
      && (taskState.run.status !== 'drifted' || turnPlan.mode === 'task_realign')
    ) {
      markTaskProgress(
        taskState,
        convergence.lastGap ?? convergence.dominantHypothesis ?? effectiveResponse.text,
      )
    }

    // Track no-progress stalls
    if (effectiveResponse.text) {
      noTextIterations = 0
    } else {
      noTextIterations++
    }

    // 3. If no tool use → done
    if (!effectiveResponse.hasToolUse) {
      if (turnPlan.mode === 'task_realign') {
        openTaskAutoContinueCount = 0
        if (taskState.run.status === 'waiting_user') {
          break
        }
        continue
      }
      if (turnPlan.mode === 'normal' && shouldAutoContinueOpenTask(taskState, effectiveResponse.text, openTaskAutoContinueCount)) {
        openTaskAutoContinueCount += 1
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildTaskContinuePrompt(taskState, effectiveResponse.text),
          }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(`Continue-while-open: task still looks active, nudging the model to keep executing (${openTaskAutoContinueCount}/${OPEN_TASK_AUTO_CONTINUE_LIMIT})`)
        continue
      }
      openTaskAutoContinueCount = 0
      if (turnPlan.mode === 'targeted_check') {
        convergence.phase = 'synthesizing'
        opts.callbacks?.onNotice?.(`Synthesis phase: ${describeConvergenceProgress(convergence)}`)
        continue
      }
      const convergenceDecision = decideConvergencePhase(convergence)
      if (convergenceDecision === 'targeted_check') {
        convergence.phase = 'targeted_check'
        opts.callbacks?.onNotice?.(`Targeted check: ${convergence.lastGap ?? 'Still missing one focused point before concluding.'} ${describeConvergenceProgress(convergence)}`)
        continue
      }
      if (convergenceDecision === 'synthesizing') {
        convergence.phase = 'synthesizing'
        opts.callbacks?.onNotice?.(`Synthesis phase: ${describeConvergenceProgress(convergence)}`)
        continue
      }
      if (wasSummaryGatePending && hasMeaningfulAssistantText(effectiveResponse.text)) {
        continue
      }
      break
    }

    // Free-mode: don't inject the "produce a text summary" nudge after N
    // consecutive tool turns. The user wanted unlimited agentic flow; a
    // mid-run nudge breaks that by forcing a synthesis-shaped response.
    const shouldNudgeToolOnlyTurn = isAgenticStrict()
      && noTextIterations === TOOL_ONLY_NUDGE_THRESHOLD
      && !toolPlan.summaryGateTriggered

    // 4. Execute tools
    const toolResults = await executeTools(
      effectiveResponse.toolUseBlocks,
      dispatcher,
      toolAttempts,
      opts.callbacks,
      opts.signal,
      taskState,
    )

    if (opts.signal?.aborted) {
      // Before breaking: synthesize tool_result blocks for any
      // tool_use block that didn't complete. Without this, the
      // assistant turn (which was pushed above at step 2) sits in
      // conversation.turns with orphaned tool_use IDs — the next
      // turn triggers validateAndRepairConversation which strips
      // the whole turn, and the model (seeing the user's original
      // query untouched) frequently re-executes the exact same
      // tool call the user just cancelled. Injecting an explicit
      // "[aborted] cancelled by user" tool_result keeps the turn
      // well-formed: the model reads "tool ran and was cancelled"
      // instead of "tool request vanished, retry it".
      const completedIds = new Set(toolResults.results.map((r) => r.toolUseId))
      const abortedFillers: ToolExecutionResult[] = []
      for (const block of effectiveResponse.toolUseBlocks) {
        if (completedIds.has(block.id)) continue
        abortedFillers.push({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: '[aborted] Tool cancelled by user',
            isError: true,
            metadata: { aborted: true },
          },
          durationMs: 0,
        })
      }
      const allResults = [...toolResults.results, ...abortedFillers]
      if (allResults.length > 0) {
        const resultBlocks = dispatcher.toContentBlocks(allResults)
        const truncatedBlocks = truncateToolResultBlocks(resultBlocks, TOOL_OUTPUT_MAX_CHARS)
        conversation.turns.push({
          role: 'user',
          content: truncatedBlocks,
          timestamp: Date.now(),
        })
      }
      break
    }
    if (toolResults.loopError) {
      markTaskGuardBlocked(taskState, toolResults.loopError)
      lastStopReason = 'tool_loop'
      break
    }
    openTaskAutoContinueCount = 0

    // 5. Add tool results as user turn — truncate oversized outputs
    const resultBlocks = dispatcher.toContentBlocks(toolResults.results)
    const truncatedBlocks = truncateToolResultBlocks(resultBlocks, TOOL_OUTPUT_MAX_CHARS)
    const turnContent = [
      ...truncatedBlocks,
      ...toolPlan.runtimeBlocks,
      ...(shouldNudgeToolOnlyTurn ? [createToolOnlyNudgeBlock()] : []),
    ]
    conversation.turns.push({
      role: 'user',
      content: turnContent,
      timestamp: Date.now(),
    })
    if (shouldNudgeToolOnlyTurn) {
      opts.callbacks?.onNotice?.('Nudge: requesting text summary after 3 consecutive tool-only turns')
    }
    const toolProgress = updateConvergenceFromToolBatch(convergence, effectiveResponse.toolUseBlocks, toolResults.results)
    if (toolResults.results.some((result) => !result.result.isError)) {
      markTaskProgress(taskState, convergence.lastGap ?? convergence.dominantHypothesis)
    }
    if (isAgenticStrict() && noTextIterations >= TOOL_ONLY_STALL_THRESHOLD && shouldStopToolOnlyLoop(convergence)) {
      opts.callbacks?.onError?.(`Model stalled: ${noTextIterations} consecutive tool calls with no text output. Use /retry or /model.`)
      lastStopReason = 'stalled'
      break
    }
    if (toolPlan.targetedCheckConsumed) {
      convergence.targetedCheckUsed = true
      if (shouldReopenAfterTargetedCheck(convergence, toolProgress)) {
        convergence.targetedCheckUsed = false
        convergence.phase = 'exploring'
        opts.callbacks?.onNotice?.(`Constrained continuation: focused verification produced new evidence, so the runtime reopened exploration. ${describeConvergenceProgress(convergence)}`)
      } else {
        convergence.phase = 'synthesizing'
        opts.callbacks?.onNotice?.(`Synthesis phase: ${describeConvergenceProgress(convergence)}`)
      }
    } else if (!toolPlan.summaryGateTriggered) {
      const convergenceDecision = decideConvergencePhase(convergence)
      if (convergenceDecision === 'targeted_check') {
        convergence.phase = 'targeted_check'
        opts.callbacks?.onNotice?.(`Targeted check: ${convergence.lastGap ?? 'Still missing one focused point before concluding.'} ${describeConvergenceProgress(convergence)}`)
      } else if (convergenceDecision === 'synthesizing') {
        convergence.phase = 'synthesizing'
        opts.callbacks?.onNotice?.(`Synthesis phase: ${describeConvergenceProgress(convergence)}`)
      }
    }

    // 6. Loop-time budget check: if conversation is growing too large,
    // aggressively truncate older tool-result turns to prevent context explosion.
    // This is critical for tool-heavy loops where each iteration adds more results.
    if (hardLimit > 0) {
      const midLoopTokens = estimateTokens(JSON.stringify(buildRequest(conversation, true)))
      if (midLoopTokens > hardLimit * 0.7) {
        // Truncate all tool_result content blocks in older turns (keep last 4 turns intact)
        const protectedTurns = 4
        for (let t = 0; t < conversation.turns.length - protectedTurns; t++) {
          const turn = conversation.turns[t]!
          for (let c = 0; c < turn.content.length; c++) {
            const block = turn.content[c] as any
            if (block.type === 'tool_result') {
              const content = typeof block.content === 'string' ? block.content : ''
              if (content.length > 500) {
                (turn.content[c] as any).content = content.slice(0, 200) + `\n[… ${content.length - 200} chars from earlier tool result trimmed for context budget …]`
              }
            }
          }
        }
        const afterTrim = estimateTokens(JSON.stringify(buildRequest(conversation, true)))
        if (afterTrim !== midLoopTokens) {
          opts.callbacks?.onNotice?.(`Loop budget: trimmed older tool results (${midLoopTokens} → ${afterTrim} est. tokens)`)
        }
      }
    }
  }

  if ((lastStopReason === null || lastStopReason === 'tool_use') && Number.isFinite(maxIterations) && iterations >= maxIterations) {
    lastStopReason = 'max_iterations'
  }

  if (finalText.trim() && lastStopReason === 'end_turn' && taskState.run.status !== 'waiting_user') {
    if (isDurableTaskCompletion(taskState, finalText)) {
      markTaskCompleted(taskState, finalText)
    } else if (taskState.run.status === 'open') {
      markTaskGuardBlocked(taskState, 'The model stopped at an interim progress update before finishing the requested deliverable.')
    }
  } else if (lastStopReason === 'stalled') {
    markTaskGuardBlocked(taskState, 'The loop stalled before producing a durable next step.')
  } else if (lastStopReason === 'max_iterations' && taskState.run.status === 'open') {
    markTaskGuardBlocked(taskState, `The loop hit the iteration cap (${iterations}/${maxIterations}) before the task finished.`)
  } else if (!finalText.trim() && taskState.run.status === 'open' && lastUserTurnHasSuccessfulToolResult(conversation.turns)) {
    markTaskGuardBlocked(taskState, 'The loop stopped after successful tool results before the assistant produced a durable next step.')
  }

  return { conversation, finalText, iterations, stopReason: lastStopReason, usage: totalUsage, runtimeFailure }
}

export function shouldShowNoResponseFallback(options: {
  finalText: string
  stopReason: string | null
  runtimeFailure: ConversationRuntimeFailure | null
  aborted: boolean
}): boolean {
  // A truly "no response" turn is one where the model gave us NOTHING
  // to continue from: no text, no tool calls, no abort/stall/loop
  // runtime signal, no upstream error. Tool-use turns are valid
  // responses — the model produced tool_use blocks that got executed,
  // and a subsequent failure (Server shutting down, rate limit, etc.)
  // should surface via runtimeFailure, not as "(No response)" on top
  // of the actual error. hard_stop is a runtime synthesis decision,
  // not a model no-op, so the runtime message (already surfaced above)
  // owns the narrative there too.
  return !options.finalText
    && !options.aborted
    && options.runtimeFailure === null
    && options.stopReason !== 'stalled'
    && options.stopReason !== 'tool_loop'
    && options.stopReason !== 'tool_use'
    && options.stopReason !== 'hard_stop'
}

function createEmptyResponseRuntimeFailure(
  conversation: Pick<Conversation, 'model' | 'turns'>,
  iterations: number,
  stopReason: string | null | undefined,
): ConversationRuntimeFailure {
  return {
    kind: 'provider_error',
    phase: deriveRuntimeFailurePhase(conversation, iterations),
    message: `No response from ${conversation.model}: provider returned no content (stop_reason: ${stopReason ?? 'none'}). Continuing is safe because the transcript is intact; use /model if it keeps happening.`,
    retryable: true,
  }
}

function createConvergenceRuntimeState(): ConvergenceRuntimeState {
  return {
    phase: 'exploring',
    startedAtMs: Date.now(),
    requestCount: 0,
    exploratoryBatchCount: 0,
    exploratoryTargets: new Set<string>(),
    relevantSignalCount: 0,
    dominantHypothesis: null,
    lastGap: null,
    targetedCheckUsed: false,
    summaryGatePending: false,
    continuationBudget: 0,
    stagnantTurnCount: 0,
    recentProgress: [],
    lastProgressAtMs: Date.now(),
  }
}

function buildTurnRequestPlan(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  taskState: ActiveTaskState,
): TurnRequestPlan {
  if (taskState.run.status === 'drifted' || taskState.run.status === 'waiting_user') {
    return {
      mode: 'task_realign',
      request: buildTaskRealignRequest(conversation, taskState),
    }
  }

  if (convergence.phase === 'targeted_check') {
    return {
      mode: 'targeted_check',
      request: buildTargetedCheckRequest(conversation, convergence),
    }
  }

  if (convergence.phase === 'synthesizing' || convergence.phase === 'fallback_synthesizing' || convergence.phase === 'hard_stop') {
    return {
      mode: 'synthesis',
      request: buildSynthesisRequest(conversation, convergence, SYNTHESIS_MAX_TOKENS, undefined, taskState),
    }
  }

  return {
    mode: 'normal',
    request: buildRequest(conversation, true),
  }
}

function buildTaskRealignRequest(
  conversation: Conversation,
  taskState: ActiveTaskState,
): AnthropicMessagesRequest {
  const request = buildRequest(conversation, true)
  request.messages = [
    ...request.messages,
    {
      role: 'user',
      content: [{
        type: 'text',
        text: buildTaskRealignPrompt(taskState),
      }],
    },
  ]
  return request
}

function buildTargetedCheckRequest(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
): AnthropicMessagesRequest {
  const request = buildRequest(conversation, true)
  request.messages = [
    ...request.messages,
    {
      role: 'user',
      content: [{
        type: 'text',
        text: `[Runtime targeted check] ${convergence.lastGap ?? 'Still missing one focused point before concluding.'} Use at most one focused verification tool call if absolutely necessary. Do not broaden the search. If the current evidence is already enough, answer with a short text summary instead of calling tools.`,
      }],
    },
  ]
  return request
}

function buildSynthesisRequest(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  maxTokens: number,
  fallbackReason?: string,
  taskState?: ActiveTaskState,
): AnthropicMessagesRequest {
  const temperature = conversation.temperature !== undefined
    ? Math.min(conversation.temperature, 0.3)
    : 0.2

  return {
    model: conversation.model,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: buildSynthesisPacket(conversation, convergence, fallbackReason, taskState),
      }],
    }],
    system: [{
      type: 'text',
      text: buildSynthesisSystemPrompt(Boolean(fallbackReason)),
      cache_control: { type: 'ephemeral' },
    }],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    tool_choice: { type: 'none' },
    stop_sequences: SYNTHESIS_STOP_SEQUENCES,
  }
}

function buildSynthesisSystemPrompt(isFallback: boolean): string {
  const fallbackLine = isFallback
    ? 'The previous synthesis attempt was unusable. You must salvage the current evidence and conclude anyway.'
    : 'You are closing the task based on the evidence already collected.'
  return [
    fallbackLine,
    'Return exactly four sections with these labels and nothing else:',
    'Conclusion:',
    'Evidence:',
    'Uncertainty:',
    'Next:',
    'Keep each section to 1-2 short sentences or bullets, and keep the whole answer under 140 words.',
    'Do not ask to read more files, run more tools, or perform more searches.',
    'Do not emit TOOL_CALL, XML tool tags, code fences, or planning prose.',
  ].join('\n')
}

function buildSynthesisPacket(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  fallbackReason?: string,
  taskState?: ActiveTaskState,
): string {
  const task = extractLatestUserTask(conversation, taskState)
  const evidenceLines = collectEvidenceLines(conversation)
  const lines = [
    `Task: ${task}`,
  ]

  if (convergence.dominantHypothesis) {
    lines.push(`Current hypothesis: ${convergence.dominantHypothesis}`)
  }
  if (fallbackReason) {
    lines.push(`Previous synthesis failed because: ${fallbackReason}`)
  }

  lines.push('Evidence:')
  for (const evidence of evidenceLines) {
    lines.push(`- ${evidence}`)
  }

  lines.push(`Known uncertainty: ${convergence.lastGap ?? 'State the main remaining uncertainty briefly without reopening exploration.'}`)
  lines.push('Respond now using the required final-answer contract only.')
  return lines.join('\n')
}

function extractLatestUserTask(
  conversation: Conversation,
  taskState?: ActiveTaskState,
): string {
  if (taskState?.contract.objective) {
    return normalizeWhitespace(taskState.contract.objective).slice(0, 280)
  }
  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const turn = conversation.turns[index]
    if (!turn || turn.role !== 'user') continue
    const text = turn.content
      .filter((block): block is AnthropicTextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .find((value) => value.length > 0 && !value.startsWith('['))
    if (text) {
      return normalizeWhitespace(text).slice(0, 280)
    }
  }
  return 'Produce the best final answer possible from the current conversation evidence.'
}

function collectEvidenceLines(conversation: Conversation): string[] {
  const evidence: string[] = []
  const turns = conversation.turns

  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]
    if (!turn) continue

    if (turn.role === 'assistant') {
      const assistantText = turn.content
        .filter((block): block is AnthropicTextBlock => block.type === 'text')
        .map((block) => normalizeWhitespace(block.text))
        .filter((text) => text.length > 0 && !text.startsWith('['))
        .join(' ')

      const insight = summarizeAssistantInsight(assistantText)
      if (insight) {
        evidence.push(`assistant: ${insight}`)
      }

      const toolUses = turn.content.filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use')
      const resultTurn = turns[index + 1]
      const toolResults = resultTurn?.role === 'user'
        ? resultTurn.content.filter((block): block is Extract<AnthropicContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
        : []

      for (const toolUse of toolUses) {
        const toolResult = toolResults.find((block) => block.tool_use_id === toolUse.id)
        const summary = summarizeToolEvidence(toolUse, toolResult)
        if (summary) {
          evidence.push(summary)
        }
      }
    }
  }

  return evidence.slice(-6)
}

function summarizeAssistantInsight(text: string): string | null {
  if (!text) return null
  if (SYNTHESIS_ESCAPE_RE.test(text) || /(?:summary gate|runtime targeted check|system:)/i.test(text)) {
    return null
  }

  const sentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? ''
  if (sentence.length < 24) return null
  return sentence.slice(0, 160)
}

function summarizeToolEvidence(
  toolUse: AnthropicToolUseBlock,
  toolResult?: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
): string | null {
  const content = extractToolResultText(toolResult)
  if (!content) return null
  const signal = firstMeaningfulLine(content)
  if (!signal) return null

  const target = toolTarget(toolUse.name, toolUse.input)
  const prefix = toolUse.name === 'bash'
    ? 'bash'
    : toolUse.name.toLowerCase()
  return `${prefix} ${target} -> ${signal.slice(0, 160)}`
}

function extractToolResultText(
  toolResult?: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
): string {
  if (!toolResult) return ''
  if (typeof toolResult.content === 'string') return toolResult.content
  if (Array.isArray(toolResult.content)) {
    return toolResult.content
      .filter((block): block is AnthropicTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

function firstMeaningfulLine(text: string): string {
  return text
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0 && !line.startsWith('[…') && !line.startsWith('...'))
    ?? ''
}

function hasMeaningfulAssistantText(text: string): boolean {
  return normalizeWhitespace(text).length > 0
}

function buildToolExecutionPlan(
  blocks: AnthropicToolUseBlock[],
  mode: TurnRequestMode,
  convergence: ConvergenceRuntimeState,
): ToolExecutionPlan {
  if (mode === 'task_realign' && blocks.length > 2) {
    return {
      executeBlocks: blocks.slice(0, 2),
      runtimeBlocks: [],
      notices: [`Task realign: keeping 2 tool calls and deferring ${blocks.length - 2} extra calls until the model re-centers on the contract`],
      summaryGateTriggered: false,
      targetedCheckConsumed: false,
    }
  }

  if (mode === 'targeted_check' && blocks.length > TARGETED_CHECK_TOOL_LIMIT) {
    return {
      executeBlocks: blocks.slice(0, TARGETED_CHECK_TOOL_LIMIT),
      runtimeBlocks: [],
      notices: [`Targeted check: keeping one focused verification and deferring ${blocks.length - TARGETED_CHECK_TOOL_LIMIT} extra tool calls`],
      summaryGateTriggered: false,
      targetedCheckConsumed: true,
    }
  }

  if (mode === 'targeted_check') {
    return {
      executeBlocks: blocks.slice(0, TARGETED_CHECK_TOOL_LIMIT),
      runtimeBlocks: [],
      notices: [],
      summaryGateTriggered: false,
      targetedCheckConsumed: true,
    }
  }

  // Free-mode: don't gate the tool fan-out. The model can issue N reads in
  // one batch; we run them all. The user stops the loop with Ctrl+C.
  if (!isAgenticStrict()) {
    return {
      executeBlocks: blocks,
      runtimeBlocks: [],
      notices: [],
      summaryGateTriggered: false,
      targetedCheckConsumed: false,
    }
  }

  const exploratoryOnly = blocks.length > 0 && blocks.every((block) => isExploratoryToolUse(block))
  const exploratoryFanoutLimit = computeExploratoryFanoutLimit(convergence)
  if (exploratoryOnly && blocks.length > exploratoryFanoutLimit) {
    const allowed = blocks.slice(0, exploratoryFanoutLimit)
    const deferredCount = blocks.length - allowed.length
    return {
      executeBlocks: allowed,
      runtimeBlocks: [{
        type: 'text',
        text: `[Runtime summary gate] You already explored ${allowed.length} file/search actions in this batch and ${deferredCount} more exploratory calls were deferred. Before asking for more tools, write a concise summary of the files inspected, the relevant signals, your dominant hypothesis, and the next best action. Do not call tools in your next response.`,
      }],
      notices: [`Summary gate: batched ${allowed.length} exploratory tools and deferred ${deferredCount} more until the assistant summarizes`],
      summaryGateTriggered: true,
      targetedCheckConsumed: false,
    }
  }

  return {
    executeBlocks: blocks,
    runtimeBlocks: [],
    notices: [],
    summaryGateTriggered: false,
    targetedCheckConsumed: false,
  }
}

function applyToolExecutionPlan(
  response: AssistantResponse,
  executeBlocks: AnthropicToolUseBlock[],
): AssistantResponse {
  return {
    ...response,
    toolUseBlocks: executeBlocks,
    hasToolUse: executeBlocks.length > 0,
  }
}

function recordResponseUsage(
  totalUsage: { inputTokens: number; outputTokens: number; requestCount: number },
  convergence: ConvergenceRuntimeState,
  response: AssistantResponse,
): void {
  totalUsage.inputTokens += response.usage.inputTokens
  totalUsage.outputTokens += response.usage.outputTokens
  totalUsage.requestCount += 1
  convergence.requestCount += 1
}

async function settleSynthesisResponse(
  response: AssistantResponse,
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  taskState: ActiveTaskState,
  totalUsage: { inputTokens: number; outputTokens: number; requestCount: number },
  opts: ConversationLoopOptions,
): Promise<{ response?: AssistantResponse; stopReason: string }> {
  const validation = validateFinalAnswerContract(response)
  if (validation.ok) {
    convergence.phase = 'exploring'
    return {
      response: normalizeFinalAnswerResponse(response, validation.normalizedText ?? response.text),
      stopReason: response.stopReason ?? 'end_turn',
    }
  }

  opts.callbacks?.onNotice?.(`Fallback synthesis: ${validation.reason}; retrying with a tighter evidence packet`)
  convergence.phase = 'fallback_synthesizing'

  let fallbackResponse: AssistantResponse
  try {
    fallbackResponse = await sendRequest(
      buildSynthesisRequest(conversation, convergence, FALLBACK_SYNTHESIS_MAX_TOKENS, validation.reason, taskState),
      opts,
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    opts.callbacks?.onNotice?.(`Hard stop: fallback synthesis request failed (${message})`)
    opts.callbacks?.onError?.(`Fallback synthesis failed: ${message}`)
    convergence.phase = 'hard_stop'
    return { stopReason: 'hard_stop' }
  }

  recordResponseUsage(totalUsage, convergence, fallbackResponse)
  const fallbackValidation = validateFinalAnswerContract(fallbackResponse)
  if (fallbackValidation.ok) {
    convergence.phase = 'exploring'
    return {
      response: normalizeFinalAnswerResponse(fallbackResponse, fallbackValidation.normalizedText ?? fallbackResponse.text),
      stopReason: fallbackResponse.stopReason ?? 'end_turn',
    }
  }

  opts.callbacks?.onNotice?.(`Hard stop: fallback synthesis could not produce a usable final answer (${fallbackValidation.reason})`)
  opts.callbacks?.onError?.(`Fallback synthesis could not produce a usable final answer: ${fallbackValidation.reason}`)
  convergence.phase = 'hard_stop'
  return { stopReason: 'hard_stop' }
}

function normalizeFinalAnswerResponse(
  response: AssistantResponse,
  text: string,
): AssistantResponse {
  return {
    ...response,
    text,
    textBlocks: [{ type: 'text', text }],
    toolUseBlocks: [],
    hasToolUse: false,
    stopReason: 'end_turn',
  }
}

function validateFinalAnswerContract(response: AssistantResponse): FinalAnswerContractResult {
  // Hard rejections — real signals the model hasn't actually concluded:
  if (response.toolUseBlocks.length > 0 || response.hasToolUse) {
    return {
      ok: false,
      reason: 'the synthesis response requested tools instead of concluding',
    }
  }

  const text = response.text.trim()
  if (!text) {
    return {
      ok: false,
      reason: 'the synthesis response came back empty',
    }
  }

  if (PSEUDO_TOOL_CALL_RE.test(text)) {
    return {
      ok: false,
      reason: 'the synthesis response emitted pseudo tool-call text',
    }
  }

  if (SYNTHESIS_ESCAPE_RE.test(text)) {
    return {
      ok: false,
      reason: 'the synthesis response kept asking for more exploration',
    }
  }

  // Structured-contract checks are now SOFT: we prefer the 4-section shape
  // (Conclusion / Evidence / Uncertainty / Next) but don't hard-reject when
  // the model writes a coherent-looking answer in a different shape. The old
  // strict contract trapped real workloads (long sessions, thinking models,
  // multi-iteration investigations) at hard_stop even after useful work
  // landed, because kimi-for-coding and friends don't naturally emit the
  // exact section labels at the end of a complex turn. Empty / tool-begging
  // responses are still the real signal; anything else we accept and
  // normalize best-effort.
  const sections = extractFinalAnswerSections(text)
  const requiredSections = ['Conclusion', 'Evidence', 'Uncertainty', 'Next'] as const
  const hasAllSections = requiredSections.every(
    (section) => sections[section] && sections[section]!.trim().length > 0,
  )
  if (hasAllSections) {
    if (WEAK_CONCLUSION_RE.test(sections['Conclusion']!)) {
      // Weak-conclusion is ALSO a real signal ("I need to keep investigating"
      // rather than an answer), so retry once. After the fallback, we accept
      // whatever comes back if it's non-empty and not tool-begging.
      return {
        ok: false,
        reason: 'the synthesis response avoided a concrete conclusion',
      }
    }
    const normalizedText = requiredSections
      .map((section) => `${section}: ${sections[section]!.trim()}`)
      .join('\n\n')
    return { ok: true, reason: 'ok', normalizedText }
  }

  // Free-form answer — accept it as-is. No pretty normalization; the model
  // already shaped the output the way it wanted to. Long-running agents
  // can ship without being gated on section prose.
  return { ok: true, reason: 'ok' }
}

function extractFinalAnswerSections(text: string): Record<'Conclusion' | 'Evidence' | 'Uncertainty' | 'Next', string | null> {
  const result: Record<'Conclusion' | 'Evidence' | 'Uncertainty' | 'Next', string | null> = {
    Conclusion: null,
    Evidence: null,
    Uncertainty: null,
    Next: null,
  }

  let current: keyof typeof result | null = null
  const buffers: Record<keyof typeof result, string[]> = {
    Conclusion: [],
    Evidence: [],
    Uncertainty: [],
    Next: [],
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const match = line.match(/^(?:[-*]\s*)?(?:\*\*)?(Conclusion|Evidence|Uncertainty|Next)(?:\*\*)?\s*:\s*(.*)$/i)
    if (match) {
      current = capitalizeSectionName(match[1]) as keyof typeof result
      if (match[2]) {
        buffers[current].push(match[2].trim())
      }
      continue
    }

    if (current) {
      buffers[current].push(rawLine.trim())
    }
  }

  for (const key of Object.keys(result) as Array<keyof typeof result>) {
    const value = buffers[key]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .trim()
    result[key] = value.length > 0 ? value : null
  }

  return result
}

function capitalizeSectionName(value: string): string {
  const lower = value.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function updateConvergenceFromText(
  convergence: ConvergenceRuntimeState,
  text: string,
): ProgressObservation | null {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return null

  const observation = createProgressObservation('text')

  const hypothesis = extractDominantHypothesis(normalized)
  if (hypothesis && hypothesis !== convergence.dominantHypothesis) {
    observation.hypothesisChanged = true
    convergence.dominantHypothesis = hypothesis
  }

  const gap = extractOutstandingGap(normalized)
  if (gap && gap !== convergence.lastGap) {
    observation.gapChanged = true
    convergence.lastGap = gap
  }

  const textSignals = countTextSignals(normalized)
  observation.newSignals = textSignals
  convergence.relevantSignalCount = Math.min(
    convergence.relevantSignalCount + textSignals,
    24,
  )
  recordProgressObservation(convergence, observation)
  return observation
}

function updateConvergenceFromToolBatch(
  convergence: ConvergenceRuntimeState,
  blocks: AnthropicToolUseBlock[],
  results: ToolExecutionResult[],
): ProgressObservation {
  const observation = createProgressObservation('tool')
  const exploratoryBlocks = blocks.filter((block) => isExploratoryToolUse(block))
  if (exploratoryBlocks.length > 0) {
    convergence.exploratoryBatchCount += 1
    for (const block of exploratoryBlocks) {
      const target = toolTarget(block.name, block.input)
      if (convergence.exploratoryTargets.has(target)) {
        observation.repeatedTargets += 1
      } else {
        convergence.exploratoryTargets.add(target)
        observation.newTargets += 1
      }
    }
  }

  let batchSignals = 0
  for (const result of results) {
    const text = normalizeWhitespace(result.result.output)
    if (!text) continue
    if (result.result.metadata?.['partial'] === true) {
      batchSignals += 1
      continue
    }
    if (/^No matches found$/i.test(text) || /^No files matched$/i.test(text)) {
      continue
    }
    if (result.result.isError || /(?:error|warning|match|found|expect|return|function|class|export|test)/i.test(text)) {
      batchSignals += 1
      continue
    }
    if (text.length > 24) {
      batchSignals += 1
    }
  }

  observation.newSignals = Math.min(batchSignals, 3)
  convergence.relevantSignalCount = Math.min(
    convergence.relevantSignalCount + observation.newSignals,
    24,
  )
  recordProgressObservation(convergence, observation)
  return observation
}

function decideConvergencePhase(
  convergence: ConvergenceRuntimeState,
): RuntimeConvergencePhase | null {
  // Free-mode (default): never auto-switch to synthesis. The user drove
  // the loop into exploration — they decide when to stop it.
  if (!isAgenticStrict()) return null

  if (convergence.phase !== 'exploring') return null

  const elapsedMs = Date.now() - convergence.startedAtMs
  if (!isConvergenceMature(convergence, elapsedMs)) {
    return null
  }

  if (isStillProductiveTask(convergence, elapsedMs)) {
    return null
  }

  const forceSynthesis = convergence.targetedCheckUsed
    || convergence.stagnantTurnCount >= CONTINUATION_FORCE_STALE_TURN_THRESHOLD
    || (convergence.requestCount >= CONVERGENCE_FORCE_REQUEST_THRESHOLD && convergence.stagnantTurnCount >= CONTINUATION_STALE_TURN_THRESHOLD)
    || (elapsedMs >= CONVERGENCE_FORCE_ELAPSED_MS && Date.now() - convergence.lastProgressAtMs >= 15_000)

  if (!forceSynthesis && convergence.lastGap && convergence.stagnantTurnCount >= CONTINUATION_STALE_TURN_THRESHOLD) {
    return 'targeted_check'
  }

  return 'synthesizing'
}

function describeConvergenceProgress(convergence: ConvergenceRuntimeState): string {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - convergence.startedAtMs) / 1000))
  return `scanned ${Math.max(convergence.exploratoryTargets.size, 1)} sources across ${Math.max(convergence.exploratoryBatchCount, 1)} exploratory batches, ${Math.max(convergence.requestCount, 1)} requests, ${elapsedSeconds}s, ${Math.max(convergence.relevantSignalCount, 1)} relevant signals, continuation budget ${convergence.continuationBudget}, and ${convergence.stagnantTurnCount} stagnant turns`
}

function createProgressObservation(kind: 'text' | 'tool'): ProgressObservation {
  return {
    kind,
    newTargets: 0,
    repeatedTargets: 0,
    newSignals: 0,
    hypothesisChanged: false,
    gapChanged: false,
    productive: false,
    timestampMs: Date.now(),
  }
}

function recordProgressObservation(
  convergence: ConvergenceRuntimeState,
  observation: ProgressObservation,
): void {
  observation.productive = observation.newTargets > 0
    || observation.newSignals > 0
    || observation.hypothesisChanged
    || observation.gapChanged

  convergence.recentProgress.push(observation)
  if (convergence.recentProgress.length > CONTINUATION_PROGRESS_WINDOW * 2) {
    convergence.recentProgress.splice(0, convergence.recentProgress.length - CONTINUATION_PROGRESS_WINDOW * 2)
  }

  if (observation.productive) {
    convergence.stagnantTurnCount = 0
    convergence.lastProgressAtMs = observation.timestampMs
    const gain = Math.min(
      2,
      (observation.newTargets > 0 ? 1 : 0)
      + (observation.newSignals > 0 ? 1 : 0)
      + (observation.hypothesisChanged || observation.gapChanged ? 1 : 0),
    )
    convergence.continuationBudget = Math.min(
      CONTINUATION_BUDGET_MAX,
      convergence.continuationBudget + Math.max(1, gain),
    )
    return
  }

  convergence.stagnantTurnCount += 1
  convergence.continuationBudget = Math.max(0, convergence.continuationBudget - 1)
}

function summarizeRecentProgress(
  convergence: ConvergenceRuntimeState,
): {
  productiveTurns: number
  newTargets: number
  repeatedTargets: number
  newSignals: number
  hypothesisChanges: number
  gapChanges: number
} {
  const recent = convergence.recentProgress.slice(-CONTINUATION_PROGRESS_WINDOW)
  return recent.reduce((summary, observation) => {
    summary.productiveTurns += observation.productive ? 1 : 0
    summary.newTargets += observation.newTargets
    summary.repeatedTargets += observation.repeatedTargets
    summary.newSignals += observation.newSignals
    summary.hypothesisChanges += observation.hypothesisChanged ? 1 : 0
    summary.gapChanges += observation.gapChanged ? 1 : 0
    return summary
  }, {
    productiveTurns: 0,
    newTargets: 0,
    repeatedTargets: 0,
    newSignals: 0,
    hypothesisChanges: 0,
    gapChanges: 0,
  })
}

function isConvergenceMature(
  convergence: ConvergenceRuntimeState,
  elapsedMs: number = Date.now() - convergence.startedAtMs,
): boolean {
  const enoughSignals = convergence.relevantSignalCount >= CONVERGENCE_ENTRY_SIGNAL_THRESHOLD
    || convergence.dominantHypothesis !== null
  const entryBudgetReached = convergence.exploratoryTargets.size >= CONVERGENCE_ENTRY_TARGET_THRESHOLD
    || convergence.exploratoryBatchCount >= CONVERGENCE_ENTRY_BATCH_THRESHOLD
    || convergence.requestCount >= CONVERGENCE_ENTRY_REQUEST_THRESHOLD
    || elapsedMs >= CONVERGENCE_ENTRY_ELAPSED_MS
  return enoughSignals && entryBudgetReached
}

function isStillProductiveTask(
  convergence: ConvergenceRuntimeState,
  elapsedMs: number = Date.now() - convergence.startedAtMs,
): boolean {
  const recent = summarizeRecentProgress(convergence)
  if (recent.productiveTurns === 0) {
    return false
  }
  if (convergence.stagnantTurnCount >= CONTINUATION_STALE_TURN_THRESHOLD) {
    return false
  }
  if (elapsedMs >= CONVERGENCE_FORCE_ELAPSED_MS && Date.now() - convergence.lastProgressAtMs > 15_000) {
    return false
  }
  if (recent.newTargets === 0 && recent.newSignals === 0 && recent.hypothesisChanges === 0 && recent.gapChanges === 0) {
    return false
  }
  if (recent.repeatedTargets > 0 && recent.newTargets === 0 && recent.newSignals === 0) {
    return false
  }
  return convergence.continuationBudget > 0
    || recent.newTargets > recent.repeatedTargets
    || recent.newSignals >= 2
}

function shouldStopToolOnlyLoop(convergence: ConvergenceRuntimeState): boolean {
  if (convergence.stagnantTurnCount >= CONTINUATION_STALE_TURN_THRESHOLD) {
    return true
  }
  const recent = summarizeRecentProgress(convergence)
  return recent.productiveTurns === 0
    || (recent.newTargets === 0 && recent.newSignals === 0)
}

function shouldReopenAfterTargetedCheck(
  convergence: ConvergenceRuntimeState,
  observation: ProgressObservation,
): boolean {
  if (!observation.productive) {
    return false
  }
  return observation.newTargets > 0
    || observation.newSignals >= 2
    || observation.hypothesisChanged
    || (convergence.continuationBudget > 0 && observation.gapChanged)
}

function computeExploratoryFanoutLimit(convergence: ConvergenceRuntimeState): number {
  const recent = summarizeRecentProgress(convergence)
  let limit = EXPLORATORY_TOOL_FANOUT_LIMIT
  if (recent.productiveTurns >= 2) {
    limit += 1
  }
  if (recent.newTargets > recent.repeatedTargets && recent.newSignals > 0) {
    limit += 1
  }
  if (convergence.continuationBudget >= 3) {
    limit += 1
  }
  return Math.min(EXPLORATORY_TOOL_FANOUT_LIMIT_MAX, limit)
}

function countTextSignals(text: string): number {
  let count = 0
  if (/(?:found|shows|showed|reveals|suggests|indicates|points to|root cause|dominant|relevant)/i.test(text)) {
    count += 1
  }
  if (/(?:because|therefore|so the issue is|the main issue|the fix)/i.test(text)) {
    count += 1
  }
  if (/(?:risk|uncertain|unknown|edge case)/i.test(text)) {
    count += 1
  }
  return count
}

function extractDominantHypothesis(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const sentence = sentences.find((candidate) => /(?:likely|suggests|indicates|root cause|dominant|primary issue|main issue|points to)/i.test(candidate))
  return sentence ? sentence.trim().slice(0, 220) : null
}

function extractOutstandingGap(text: string): string | null {
  const match = text.match(/(?:still need(?:s)?|missing|one more|remaining gap|need to verify)\s+([^.!?]+)/i)
  if (!match?.[1]) return null
  return normalizeWhitespace(match[1]).slice(0, 180)
}

function isExploratoryToolUse(block: AnthropicToolUseBlock): boolean {
  if (block.name === 'read' || block.name === 'glob' || block.name === 'grep' || block.name === 'WebFetch' || block.name === 'WebSearch') {
    return true
  }

  if (block.name !== 'bash') {
    return false
  }

  const command = normalizeWhitespace(String(block.input['command'] ?? '')).toLowerCase()
  return /\b(?:rg|grep|glob|find|fd|ls|cat|sed|head|tail|wc)\b/.test(command)
}

/** Send request to the Anthropic-compatible API with retry logic. */
async function sendRequest(
  request: AnthropicMessagesRequest,
  opts: ConversationLoopOptions,
): Promise<AssistantResponse> {
  const url = `${opts.apiBaseUrl}/v1/messages`
  const maxRetries = 3
  let lastError: Error | null = null
  const requestTimeoutMs = opts.requestTimeoutMs ?? 180_000 // 3 minutes default

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Combine user abort signal with per-request timeout
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const combinedSignal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(request),
        signal: combinedSignal,
      })

      if (!res.ok) {
        const body = await res.text()
        const diagnostic = buildRequestDiagnosticFromResponse(res, request.model, body)
        // Retry on 429 (rate limit) and 5xx errors
        if (diagnostic && shouldAutoRetryRequestDiagnostic(diagnostic) && attempt < maxRetries) {
          lastError = new ProviderRequestError(diagnostic)
          const delay = retryDelay(attempt, res.status)
          opts.callbacks?.onRetry?.({
            error: formatProviderDiagnostic(diagnostic),
            delayMs: delay,
            attempt: attempt + 1,
            maxRetries,
          })
          await sleep(delay, opts.signal)
          continue
        }
        if (diagnostic) {
          throw new ProviderRequestError(diagnostic)
        }
        // Classify the failure for actionable error messages
        if (res.status >= 500) {
          throw new Error(`Backend overloaded (HTTP ${res.status}) — all ${maxRetries} retries exhausted. ${body}`)
        }
        throw new Error(`API error ${res.status}: ${body}`)
      }

      // Streaming response
      if (request.stream && res.body) {
        // If the response is JSON (not SSE), parse it directly — proxy may return a JSON error
        const contentType = res.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const body = await res.json()
          const diagnostic = parseProviderDiagnosticFromPayload(body)
          if (diagnostic) {
            const requestId = res.headers.get('x-request-id') ?? undefined
            throw new ProviderRequestError({
              ...diagnostic,
              requestId: diagnostic.requestId ?? requestId,
            })
          }
          if (body.type === 'error' || body.error) {
            const errMsg = body.error?.message ?? body.message ?? JSON.stringify(body)
            throw new Error(`API error: ${errMsg}`)
          }
          const response = parseResponse(body)
          if (response.text) {
            // Some Anthropic-compatible backends downgrade a requested stream to
            // a single JSON message. Surface that text through the streaming
            // callback so interactive UIs still render the assistant reply.
            opts.callbacks?.onText?.(response.text)
          }
          return response
        }
        let streamedResponse: AssistantResponse
        try {
          streamedResponse = await consumeStream(
            res.body,
            opts.callbacks?.onText,
            opts.callbacks?.onUsage,
            opts.callbacks?.onThinking,
            opts.signal,
          )
        } catch (err: unknown) {
          const diagnostic = buildRequestDiagnosticFromError(err, request.model, url)
          if (diagnostic) {
            throw new ProviderRequestError({
              ...diagnostic,
              requestId: diagnostic.requestId ?? res.headers.get('x-request-id') ?? undefined,
            })
          }
          throw err
        }
        if (shouldRetryEmptyStream(streamedResponse)) {
          const fallbackResponse = await fetchNonStreamingResponse(url, request, opts)
          if (fallbackResponse.text) {
            opts.callbacks?.onText?.(fallbackResponse.text)
          }
          if (fallbackResponse.usage.inputTokens > 0 || fallbackResponse.usage.outputTokens > 0) {
            opts.callbacks?.onUsage?.({
              input: fallbackResponse.usage.inputTokens,
              output: fallbackResponse.usage.outputTokens,
            })
          }
          return fallbackResponse
        }
        return streamedResponse
      }

      // Non-streaming response
      const body = await res.json()
      const diagnostic = parseProviderDiagnosticFromPayload(body)
      if (diagnostic) {
        const requestId = res.headers.get('x-request-id') ?? undefined
        throw new ProviderRequestError({
          ...diagnostic,
          requestId: diagnostic.requestId ?? requestId,
        })
      }
      return parseResponse(body)
    } catch (err: unknown) {
      const diagnostic = buildRequestDiagnosticFromError(err, request.model, url)
      const msg = diagnostic ? formatProviderDiagnostic(diagnostic, { includeRequestId: true }) : err instanceof Error ? err.message : String(err)
      if (opts.signal?.aborted) {
        throw err
      }
      // Retry on connection errors (fetch rejects)
      if (attempt < maxRetries && (diagnostic ? shouldAutoRetryRequestDiagnostic(diagnostic) : isRetryableError(msg))) {
        lastError = diagnostic ? new ProviderRequestError(diagnostic) : err instanceof Error ? err : new Error(msg)
        const delay = retryDelay(attempt)
        opts.callbacks?.onRetry?.({
          error: diagnostic ? formatProviderDiagnostic(diagnostic) : msg,
          delayMs: delay,
          attempt: attempt + 1,
          maxRetries,
        })
        await sleep(delay, opts.signal)
        continue
      }
      if (diagnostic) {
        throw new ProviderRequestError(diagnostic)
      }
      throw err
    }
  }

  throw lastError ?? new Error('Request failed after retries')
}

function shouldRetryEmptyStream(response: AssistantResponse): boolean {
  return !response.text
    && !response.hasToolUse
    && response.usage.inputTokens === 0
    && response.usage.outputTokens === 0
}

async function fetchNonStreamingResponse(
  url: string,
  request: AnthropicMessagesRequest,
  opts: ConversationLoopOptions,
): Promise<AssistantResponse> {
  const timeoutSignal = AbortSignal.timeout(opts.requestTimeoutMs ?? 180_000)
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...request, stream: false }),
    signal: combinedSignal,
  })

  if (!res.ok) {
    const bodyText = await res.text()
    const diagnostic = buildRequestDiagnosticFromResponse(res, request.model, bodyText)
    if (diagnostic) {
      throw new ProviderRequestError(diagnostic)
    }
    throw new Error(`API error ${res.status}: ${bodyText}`)
  }

  const body = await res.json()
  const diagnostic = parseProviderDiagnosticFromPayload(body)
  if (diagnostic) {
    const requestId = res.headers.get('x-request-id') ?? undefined
    throw new ProviderRequestError({
      ...diagnostic,
      requestId: diagnostic.requestId ?? requestId,
    })
  }
  if (body.type === 'error' || body.error) {
    const errMsg = body.error?.message ?? body.message ?? JSON.stringify(body)
    throw new Error(`API error: ${errMsg}`)
  }
  return parseResponse(body)
}

/** Calculate retry delay with exponential backoff. Rate-limit (429) gets longer waits. */
function retryDelay(attempt: number, status?: number): number {
  const base = status === 429 ? 5000 : 1000
  return Math.min(base * Math.pow(2, attempt), 30_000)
}

function shouldAutoRetryRequestDiagnostic(diagnostic: ProviderRequestDiagnostic): boolean {
  if (!diagnostic.retryable) return false
  return diagnostic.kind !== 'stream_interrupted_before_first_token'
}

/** Detect context window limit errors (HTTP 400, error code 2013, token limit messages). */
export function isContextLimitError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    lower.includes('context window') ||
    lower.includes('context length') ||
    lower.includes('token limit') ||
    lower.includes('maximum context') ||
    lower.includes('prompt is too long') ||
    lower.includes('too many tokens') ||
    /\b2013\b/.test(msg)
  )
}

export function isRetryableError(msg: string): boolean {
  const diagnostic = parseProviderDiagnosticFromString(msg)
  if (diagnostic) return diagnostic.retryable
  const retryable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'network', 'socket']
  return retryable.some((s) => msg.toLowerCase().includes(s.toLowerCase()))
}

/**
 * Turn a raw transport error into something the user can act on.
 * Classifies common failure modes (network, auth, timeout, upstream 5xx,
 * provider-level rate limit) and appends a concrete next step (/doctor,
 * /model, /retry, check backend process). The original cause is preserved
 * in parentheses at the end so the user can still paste it into an issue.
 */
export function explainRequestFailure(rawMessage: string, currentModel: string): string {
  const diagnostic = parseProviderDiagnosticFromString(rawMessage)
  if (diagnostic) {
    return formatProviderDiagnostic(diagnostic, { includeRequestId: true })
  }

  const m = rawMessage || 'unknown error'
  const lower = m.toLowerCase()

  if (/^fetch failed$/i.test(m.trim()) || lower.includes('econnrefused') || lower.includes('getaddrinfo')) {
    return `${currentModel} request failed: connection failed. ` +
      `Run /doctor to check router health, or /model to switch providers. ` +
      `(${m})`
  }

  if (lower.includes('etimedout') || lower.includes('request timeout') || lower.includes('timed out')) {
    return `${currentModel} request failed: timed out. ` +
      `The model or router may be slow or stalled. Use /retry to try again, ` +
      `or /model to switch. (${m})`
  }

  if (/\b401\b/.test(m) || lower.includes('unauthorized') || lower.includes('authentication')) {
    return `${currentModel} request failed: authentication failed. ` +
      `Check the model's API key in config.json (or set via the admin UI), ` +
      `then /retry. (${m})`
  }

  if (/\b403\b/.test(m) || lower.includes('forbidden')) {
    return `${currentModel} request failed: forbidden. The key may lack access to this model. ` +
      `Use /model to try a different one. (${m})`
  }

  if (/\b429\b/.test(m) || lower.includes('rate limit')) {
    return `${currentModel} request failed: rate limited. ` +
      `Wait a bit and /retry, or /model to switch to a non-throttled provider. (${m})`
  }

  if (/\b5\d\d\b/.test(m) || lower.includes('upstream')) {
    return `${currentModel} request failed: upstream error. ` +
      `Provider may be degraded. /retry or /model to switch. (${m})`
  }

  if (lower.includes('ssl') || lower.includes('certificate')) {
    return `${currentModel} request failed: TLS / certificate problem. ` +
      `Check proxy/corporate SSL settings. (${m})`
  }

  return `${currentModel} request failed: ${m}. Use /retry or /model to switch.`
}

export function classifyConversationRuntimeFailure(
  err: unknown,
  conversation: Pick<Conversation, 'model' | 'turns'>,
  iterations: number,
): ConversationRuntimeFailure | null {
  if (isAbortError(err)) {
    return {
      kind: 'provider_error',
      phase: deriveRuntimeFailurePhase(conversation, iterations),
      message: `${conversation.model} request aborted before completion. Treating this as retryable unless the REPL task was explicitly interrupted.`,
      retryable: true,
    }
  }

  const diagnostic = extractProviderDiagnostic(err)
  if (!diagnostic) return null

  const phase = deriveRuntimeFailurePhase(conversation, iterations)
  const kind = mapRuntimeFailureKind(diagnostic)
  return {
    kind,
    phase,
    message: formatConversationRuntimeFailureMessage(phase, kind, diagnostic),
    retryable: diagnostic.retryable,
    diagnostic,
  }
}

function buildRequestDiagnosticFromResponse(
  res: Response,
  model: string,
  bodyText: string,
): ReturnType<typeof parseProviderDiagnosticFromPayload> | ReturnType<typeof classifyProviderRequestError> | null {
  const payload = safeJsonParse(bodyText)
  const existing = parseProviderDiagnosticFromPayload(payload)
  if (existing) {
    return {
      ...existing,
      requestId: existing.requestId ?? res.headers.get('x-request-id') ?? undefined,
    }
  }

  if (res.status >= 500 || res.status === 429) {
    return classifyProviderRequestError(new Error(`HTTP ${res.status}: ${bodyText}`), {
      model,
      requestId: res.headers.get('x-request-id') ?? undefined,
      status: res.status,
      detail: bodyText,
    })
  }

  return null
}

function buildRequestDiagnosticFromError(
  err: unknown,
  model: string,
  endpointUrl: string,
): ReturnType<typeof classifyProviderRequestError> | null {
  if (err instanceof ProviderRequestError) {
    return err.diagnostic
  }

  const payloadDiagnostic = parseProviderDiagnosticFromString(err instanceof Error ? err.message : String(err))
  if (payloadDiagnostic) return payloadDiagnostic

  if (err instanceof Error) {
    if (isAbortError(err)) {
      return {
        provider: 'owlcoda-server',
        model,
        kind: 'unknown_fetch_error',
        message: `${model} request failed: request aborted before completion`,
        status: 502,
        retryable: true,
        detail: 'request aborted before completion',
      }
    }
    const msg = err.message
    const looksLikeTransportFailure = err.name === 'AbortError'
      || err.name === 'TimeoutError'
      || err.name === 'StreamInterruptedError'
      || /fetch failed|enotfound|econn|etimedout|timed out|network|socket|stream closed|certificate|ssl|tls/i.test(msg)
    if (looksLikeTransportFailure) {
      return classifyProviderRequestError(err, {
        model,
        endpointUrl,
        provider: 'owlcoda-server',
      })
    }
  }

  return null
}

function extractProviderDiagnostic(err: unknown): ProviderRequestDiagnostic | null {
  if (err instanceof ProviderRequestError) return err.diagnostic
  if (err instanceof Error) {
    const fromString = parseProviderDiagnosticFromString(err.message)
    if (fromString) return fromString
    // Plain transport errors (StreamInterruptedError / TimeoutError / AbortError /
    // undici-style "fetch failed") carry no diagnostic payload in their
    // message. Classify them via the structured path so phase detection and
    // kind mapping still fire — otherwise these errors fall through to the
    // null branch and the REPL emits its low-info "(No response from …)"
    // tail instead of the structured runtimeFailure.
    const looksLikeTransport = err.name === 'AbortError'
      || err.name === 'TimeoutError'
      || err.name === 'StreamInterruptedError'
      || /fetch failed|enotfound|econn|etimedout|timed out|network|socket|stream closed|certificate|ssl|tls/i.test(err.message)
    if (looksLikeTransport) {
      return classifyProviderRequestError(err)
    }
    return null
  }
  return parseProviderDiagnosticFromString(String(err))
}

function mapRuntimeFailureKind(diagnostic: ProviderRequestDiagnostic): ConversationRuntimeFailureKind {
  // Structured "before first token" kind is the canonical signal now.
  if (diagnostic.kind === 'stream_interrupted_before_first_token') return 'pre_first_token_stream_close'
  if (diagnostic.kind === 'stream_interrupted') {
    // Back-compat: in-flight diagnostics whose kind is the generic
    // 'stream_interrupted' may still carry the phrase in message/detail.
    // Prefer the explicit kind above; fall through here for stragglers.
    return /before first token/i.test(diagnostic.detail) || /before first token/i.test(diagnostic.message)
      ? 'pre_first_token_stream_close'
      : 'post_token_stream_close'
  }
  if (diagnostic.kind === 'timeout') return 'timeout'
  if (diagnostic.kind === 'abort') return 'abort'
  if (diagnostic.kind === 'http_4xx' || diagnostic.kind === 'http_5xx') return 'http_error'
  return 'provider_error'
}

function deriveRuntimeFailurePhase(
  conversation: Pick<Conversation, 'turns'>,
  iterations: number,
): ConversationRuntimeFailurePhase {
  if (lastUserTurnHasSuccessfulToolResult(conversation.turns)) return 'tool_continuation'
  if (latestUserTextLooksLikeContinuation(conversation.turns) || iterations > 1) return 'continuation'
  return 'request'
}

function lastUserTurnHasSuccessfulToolResult(turns: Conversation['turns']): boolean {
  const lastTurn = turns[turns.length - 1]
  if (!lastTurn || lastTurn.role !== 'user') return false
  return lastTurn.content.some((block) => block.type === 'tool_result' && block.is_error !== true)
}

function latestUserTextLooksLikeContinuation(turns: Conversation['turns']): boolean {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (!turn || turn.role !== 'user') continue
    const hasToolResults = turn.content.some((block) => block.type === 'tool_result')
    if (hasToolResults) continue
    const text = turn.content
      .filter((block): block is AnthropicTextBlock => block.type === 'text')
      .map((block) => normalizeWhitespace(block.text))
      .join(' ')
      .trim()
    if (!text) continue
    return /^(?:继续|续跑|接着|继续一下|继续总结|继续说|continue|resume|go on|carry on)\b/i.test(text)
      || /(?:继续|续跑|接着)/.test(text)
  }
  return false
}

function shouldAutoContinueOpenTask(
  taskState: ActiveTaskState,
  text: string,
  autoContinueCount: number,
): boolean {
  if (taskState.run.status !== 'open') return false
  if (autoContinueCount >= OPEN_TASK_AUTO_CONTINUE_LIMIT) return false

  const normalized = normalizeWhitespace(text)
  if (!normalized) return false
  if (looksLikeCompletedTaskText(normalized)) return false
  if (looksLikeUserInputOrBlocker(normalized)) return false
  if (taskLikelyRequiresWrites(taskState) && taskState.contract.touchedPaths.length === 0) {
    return true
  }
  return looksLikeInterimProgressText(normalized)
}

function taskLikelyRequiresWrites(taskState: ActiveTaskState): boolean {
  const taskText = normalizeWhitespace(`${taskState.contract.objective} ${taskState.contract.sourceText}`)
  return TASK_WRITE_INTENT_RE.test(taskText)
}

function isDurableTaskCompletion(taskState: ActiveTaskState, text: string): boolean {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return false
  if (!taskLikelyRequiresWrites(taskState)) return true
  if (taskState.contract.touchedPaths.length > 0) return true
  return TASK_NO_CHANGE_NEEDED_RE.test(normalized)
}

function looksLikeCompletedTaskText(text: string): boolean {
  return /\b(?:done|completed|finished|implemented|fixed|resolved|all set|wrapped up)\b/i.test(text)
    && !/\b(?:next|then|follow(?:ing| up)?|will|i(?:'|’)ll|going to)\b/i.test(text)
}

function looksLikeUserInputOrBlocker(text: string): boolean {
  return /\b(?:need your|need the user|awaiting|waiting for|please confirm|which option|choose one|blocked|cannot continue|can't continue|permission|approval)\b/i.test(text)
}

function looksLikeInterimProgressText(text: string): boolean {
  return /\b(?:next|then|after that|i(?:'|’)ll|i will|going to|plan to|will now|continue with)\b/i.test(text)
}

function formatConversationRuntimeFailureMessage(
  phase: ConversationRuntimeFailurePhase,
  kind: ConversationRuntimeFailureKind,
  diagnostic: ProviderRequestDiagnostic,
): string {
  if (kind === 'pre_first_token_stream_close' || kind === 'post_token_stream_close') {
    const continuation: ContinuationContext = phase === 'tool_continuation'
      ? 'tool-success'
      : phase === 'continuation'
        ? 'user-continue'
        : 'none'
    return formatContinuationFailure(diagnostic, continuation, { includeRequestId: true })
  }
  return formatProviderDiagnostic(diagnostic, { includeRequestId: true })
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError(signal))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const maybeError = err as { name?: string; message?: string }
  return maybeError.name === 'AbortError'
    || maybeError.message === 'This operation was aborted'
    || maybeError.message === 'Request aborted'
}

/**
 * Auto-compact conversation if context usage exceeds threshold.
 * Keeps the most recent turns to stay within budget.
 */
export function autoCompact(conversation: Conversation, contextWindow?: number): boolean {
  if (!contextWindow || contextWindow <= 0) return false

  const { totalTokens } = estimateConversationTokens(conversation)
  if (totalTokens < contextWindow * AUTO_COMPACT_THRESHOLD) return false

  const totalTurns = conversation.turns.length
  if (totalTurns <= 2) return false // nothing to compact

  const keepCount = Math.max(2, Math.floor(totalTurns * AUTO_COMPACT_KEEP_RATIO))
  conversation.turns = sanitizeConversationTurns(conversation.turns.slice(-keepCount))
  return true
}

/**
 * Per-tool-type retention limits.
 * Search tools produce high-volume results that should be aggressively capped.
 * Code tools (read/edit/write) should retain more since their output is the work product.
 */
const TOOL_RETENTION_LIMITS: Record<string, number> = {
  grep: 8_000,
  glob: 5_000,
  bash: 15_000,
  read: 15_000,
  write: 3_000,
  edit: 8_000,
  WebFetch: 15_000,
  WebSearch: 8_000,
}

const TOOL_DISPLAY_RETENTION_LIMITS: Record<string, number> = {
  grep: 2_000,
  glob: 1_500,
  bash: 6_000,
  read: 4_000,
  write: 2_000,
  edit: 4_000,
  WebFetch: 6_000,
  WebSearch: 3_000,
}

/** Truncate oversized tool result text blocks to prevent context explosion. */
function truncateToolResultBlocks<T>(
  blocks: T[],
  defaultMaxChars: number,
): T[] {
  return blocks.map((block) => {
    const b = block as any
    if (b.type !== 'tool_result') return block

    // Find matching tool_use to determine tool-specific limit
    const toolName = b.tool_name ?? b.name ?? ''
    const maxChars = getToolRetentionLimit(toolName, TOOL_RETENTION_LIMITS, defaultMaxChars)

    const content = b.content
    if (typeof content === 'string' && content.length > maxChars) {
      return { ...b, content: truncateText(content, maxChars, toolName) } as T
    }
    if (Array.isArray(content)) {
      return { ...b, content: content.map((item: any) => {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > maxChars) {
          return { ...item, text: truncateText(item.text, maxChars, toolName) }
        }
        return item
      })} as T
    }
    return block
  })
}

function getToolRetentionLimit(
  toolName: string,
  limits: Record<string, number>,
  defaultMaxChars: number,
): number {
  return limits[toolName] ?? defaultMaxChars
}

function retainToolOutput(
  output: string,
  toolName: string,
  limits: Record<string, number>,
  defaultMaxChars: number,
): string {
  const maxChars = getToolRetentionLimit(toolName, limits, defaultMaxChars)
  if (output.length <= maxChars) {
    return output
  }
  return truncateText(output, maxChars, toolName)
}

function truncateText(text: string, maxChars: number, toolName: string): string {
  const head = text.slice(0, Math.floor(maxChars * 0.6))
  const tail = text.slice(-Math.floor(maxChars * 0.2))
  const omitted = text.length - head.length - tail.length
  return `${head}\n\n[… ${omitted} chars from ${toolName || 'tool'} output truncated — kept ${maxChars} of ${text.length} …]\n\n${tail}`
}

function createToolOnlyNudgeBlock(): AnthropicTextBlock {
  return {
    type: 'text',
    text: TOOL_ONLY_NUDGE_TEXT,
  }
}

/**
 * Hard deadline on the tool cancel path. After abort fires, a tool has
 * this long to unwind cooperatively before we synthesize an aborted
 * result and move on. Well-behaved tools (bash, grep, web-fetch, etc.)
 * respect the signal and return immediately; this catches rogue tools
 * (typically MCP / LSP / external-process wrappers) that would
 * otherwise hang the conversation loop and leave the UI stuck at
 * "Already cancelling…".
 *
 * 3s matches the bash tool's internal ABORT_HARD_DEADLINE_MS, so the
 * outer safety net fires at roughly the same moment bash would force-
 * settle on its own — no redundant wait.
 */
const TOOL_ABORT_HARD_DEADLINE_MS = 3000

/**
 * Race the tool's own Promise against an abort-triggered hard deadline.
 * If the signal fires and the tool hasn't returned within the deadline,
 * we synthesize an aborted ToolExecutionResult so the caller can
 * proceed to break out of the conversation loop.
 *
 * The real tool Promise is not cancelled here — it may still resolve
 * later, but its result is discarded. Callers must already be on the
 * abort path when this fallback fires, so the stale result is moot.
 */
async function executeToolWithAbortDeadline(
  dispatcher: ToolDispatcher,
  block: AnthropicToolUseBlock,
  context: { signal?: AbortSignal; onProgress?: (event: ToolProgressEvent) => void },
  signal: AbortSignal | undefined,
): Promise<ToolExecutionResult> {
  const execPromise = dispatcher.executeTool(block, context)
  if (!signal) return execPromise

  let hardDeadline: ReturnType<typeof setTimeout> | null = null
  let abortListener: (() => void) | null = null

  const deadlinePromise = new Promise<ToolExecutionResult>((resolve) => {
    const onAbort = (): void => {
      hardDeadline = setTimeout(() => {
        resolve({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: '[aborted] Tool cancelled — hard deadline reached before tool released',
            isError: true,
            metadata: { aborted: true, forcedRelease: true },
          },
          durationMs: 0,
        })
      }, TOOL_ABORT_HARD_DEADLINE_MS)
    }
    if (signal.aborted) {
      onAbort()
    } else {
      abortListener = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    return await Promise.race([execPromise, deadlinePromise])
  } finally {
    if (hardDeadline) clearTimeout(hardDeadline)
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}

/** Execute tool_use blocks and invoke callbacks. */
async function executeTools(
  blocks: AnthropicToolUseBlock[],
  dispatcher: ToolDispatcher,
  attempts: ToolAttemptSignature[],
  callbacks?: ConversationCallbacks,
  signal?: AbortSignal,
  taskState?: ActiveTaskState,
): Promise<{ results: ToolExecutionResult[]; loopError?: string }> {
  const results: ToolExecutionResult[] = []

  for (const block of blocks) {
    if (signal?.aborted) break

    const nextAttempt = buildToolAttempt(block.name, block.input)
    const loopError = isAgenticStrict() ? detectToolLoop(attempts, nextAttempt) : null
    if (loopError) {
      callbacks?.onError?.(loopError)
      return { results, loopError }
    }

    const guardViolation = evaluateWriteGuard(block.name, block.input, taskState)
    if (guardViolation && callbacks?.onTaskScopeApproval && taskState) {
      const approved = await callbacks.onTaskScopeApproval({
        toolName: block.name,
        input: block.input,
        attemptedPath: guardViolation.attemptedPath,
        allowedPaths: guardViolation.allowedPaths,
        message: guardViolation.message,
      })
      if (!approved || !approveTaskWriteScope(taskState, guardViolation.attemptedPath)) {
        if (signal?.aborted) break
        markTaskWriteScopeBlocked(taskState, guardViolation.message, guardViolation.attemptedPath)
        results.push({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: guardViolation.message,
            isError: true,
            metadata: {
              taskGuardBlocked: true,
              attemptedPath: guardViolation.attemptedPath,
              allowedPaths: guardViolation.allowedPaths,
            },
          },
          durationMs: 0,
        })
        continue
      }
    }

    // Ask for approval if callback is provided
    if (callbacks?.onToolApproval) {
      const approved = await callbacks.onToolApproval(block.name, block.input)
      if (!approved) {
        if (signal?.aborted) break
        if (taskState) {
          markTaskWaitingUser(taskState, `User denied ${block.name}; waiting for a new instruction or approval.`)
        }
        results.push({
          toolUseId: block.id,
          toolName: block.name,
          result: { output: 'Tool execution denied by user.', isError: true },
          durationMs: 0,
        })
        continue
      }
    }

    callbacks?.onToolStart?.(block.name, block.input)

    // Build execution context with progress + user-question callbacks
    // bound to this tool's identity. Both are optional: well-behaved
    // tools degrade gracefully when a callback is absent (headless).
    const context: {
      onProgress?: (event: ToolProgressEvent) => void
      signal?: AbortSignal
      taskState?: ActiveTaskState
      askUserQuestion?: (question: string, opts?: AskUserQuestionOpts) => Promise<string>
    } = { signal, taskState }
    if (callbacks?.onToolProgress) {
      context.onProgress = (event: ToolProgressEvent) => {
        if (!signal?.aborted) callbacks.onToolProgress!(block.name, event)
      }
    }
    if (callbacks?.onUserQuestion) {
      // Binding the toolName here keeps ToolExecutionContext narrow:
      // tools call context.askUserQuestion(q, opts) without having to
      // know their own registered name.
      context.askUserQuestion = (question: string, opts?: AskUserQuestionOpts) =>
        callbacks.onUserQuestion!(block.name, question, opts)
    }

    const result = await executeToolWithAbortDeadline(dispatcher, block, context, signal)
    if (signal?.aborted) break
    result.result.output = retainToolOutput(
      result.result.output,
      block.name,
      TOOL_RETENTION_LIMITS,
      TOOL_OUTPUT_MAX_CHARS,
    )
    const displayOutput = retainToolOutput(
      result.result.output,
      block.name,
      TOOL_DISPLAY_RETENTION_LIMITS,
      TOOL_DISPLAY_OUTPUT_MAX_CHARS,
    )
    if (result.result.metadata?.['taskGuardBlocked'] !== true) {
      recordToolAttempt(attempts, {
        ...nextAttempt,
        isError: result.result.isError,
      })
    }
    callbacks?.onToolEnd?.(
      block.name,
      displayOutput,
      result.result.isError,
      result.durationMs,
      result.result.metadata,
    )
    results.push(result)
  }

  return { results }
}

function buildToolAttempt(
  name: string,
  input: Record<string, unknown>,
  isError = false,
): ToolAttemptSignature {
  const category = toolCategory(name)
  const target = toolTarget(name, input)
  const intentTarget = toolIntentTarget(name, input)
  return {
    name,
    category,
    target,
    intentTarget,
    intentKey: `${category}:${intentTarget.toLowerCase()}`,
    signature: buildToolSignature(name, category, target, input),
    isError,
  }
}

function buildToolSignature(
  name: string,
  category: string,
  target: string,
  input: Record<string, unknown>,
): string {
  const fingerprint = toolFingerprint(name, input)
  if (!fingerprint) {
    return `${category}:${target.toLowerCase()}`
  }
  return `${category}:${target.toLowerCase()}#${fingerprint}`
}

function recordToolAttempt(attempts: ToolAttemptSignature[], attempt: ToolAttemptSignature): void {
  attempts.push(attempt)
  if (attempts.length > TOOL_LOOP_GUARD_WINDOW) {
    attempts.splice(0, attempts.length - TOOL_LOOP_GUARD_WINDOW)
  }
}

function detectToolLoop(
  attempts: ToolAttemptSignature[],
  next: ToolAttemptSignature,
): string | null {
  const recent = attempts.slice(-TOOL_LOOP_GUARD_WINDOW)
  const lastFour = [...recent.slice(-4), next]
  if (lastFour.length === 5) {
    const [a, b, c, d, e] = lastFour
    if (
      a.signature === c.signature
      && b.signature === d.signature
      && c.signature === e.signature
      && a.signature !== b.signature
    ) {
      return `task stuck in tool loop: repeated ${a.category}/${b.category} attempts`
    }
  }

  // Successful repetitions: a model may legitimately edit the same file many times
  // in one task (read → patch → verify → patch again). With content-aware signatures
  // (edit fingerprints include old/new string hash), identical signatures truly mean
  // identical operations. Threshold of 5 allows generous multi-pass workflows while
  // still catching infinite loops.
  const sameSuccessful = recent.filter((a) => a.signature === next.signature && !a.isError)
  if (sameSuccessful.length >= 5) {
    return `task stuck in tool loop: repeated ${next.category} attempts on ${next.target}`
  }

  // Error repetitions: if the tool keeps failing on the same target, stop quickly.
  const sameFailures = recent.filter((a) => a.signature === next.signature && a.isError)
  if (sameFailures.length >= 2) {
    return `task stuck in tool loop: repeated failing ${next.category} attempts on ${next.target}`
  }

  const sameIntentFailures = recent.filter((a) => a.intentKey === next.intentKey && a.isError)
  if (sameIntentFailures.length >= 3) {
    return `task stuck in tool loop: repeated failing ${next.category} attempts on ${next.intentTarget}`
  }

  return null
}

function toolCategory(name: string): string {
  switch (name) {
    case 'grep':
    case 'glob':
      return 'search'
    case 'edit':
    case 'write':
    case 'NotebookEdit':
      return 'update'
    default:
      return name.toLowerCase()
  }
}

function toolTarget(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'NotebookEdit':
      return normalizeTargetPath(input['path'] ?? input['notebook_path'])
    case 'grep':
      return `${normalizeTargetPath(input['path'] ?? process.cwd())}#${String(input['pattern'] ?? '').slice(0, 80)}`
    case 'glob':
      return `${normalizeTargetPath(input['cwd'] ?? process.cwd())}#${String(input['pattern'] ?? '').slice(0, 80)}`
    case 'bash':
      return `${normalizeTargetPath(input['cwd'] ?? process.cwd())}#$${normalizeWhitespace(String(input['command'] ?? '')).slice(0, 80)}`
    default:
      return normalizeWhitespace(JSON.stringify(input)).slice(0, 120) || name
  }
}

function toolIntentTarget(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'NotebookEdit':
      return normalizeTargetPath(input['path'] ?? input['notebook_path'])
    case 'grep':
      return normalizeTargetPath(input['path'] ?? process.cwd())
    case 'glob':
      return normalizeTargetPath(input['cwd'] ?? process.cwd())
    case 'bash':
      return `${normalizeTargetPath(input['cwd'] ?? process.cwd())}#$${normalizeBashIntent(String(input['command'] ?? ''))}`
    default:
      return toolTarget(name, input)
  }
}

function toolFingerprint(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read': {
      const rangeFingerprint = buildReadFingerprint(input)
      return rangeFingerprint ? hashToolPayload(rangeFingerprint) : ''
    }
    case 'edit':
      return hashToolPayload(
        `old:${normalizeToolPayload(input['oldStr'])}\nnew:${normalizeToolPayload(input['newStr'])}`,
      )
    case 'write':
      return hashToolPayload(
        `content:${normalizeToolPayload(input['content'])}`,
      )
    case 'NotebookEdit':
      return hashToolPayload(
        `mode:${normalizeWhitespace(String(input['edit_mode'] ?? 'replace'))}\n`
          + `cell:${normalizeWhitespace(String(input['cell_id'] ?? ''))}\n`
          + `type:${normalizeWhitespace(String(input['cell_type'] ?? ''))}\n`
          + `source:${normalizeToolPayload(input['new_source'])}`,
      )
    default:
      return ''
  }
}

function buildReadFingerprint(input: Record<string, unknown>): string {
  const fingerprints: string[] = []
  const rawPath = String(input['path'] ?? '').trim()
  const pathSuffix = rawPath.match(/:(\d+)(?::(\d+))?$/)
  if (pathSuffix) {
    fingerprints.push(`path-range:${pathSuffix[1]}:${pathSuffix[2] ?? ''}`)
  }

  const startLine = Number.isFinite(Number(input['startLine'])) ? Number(input['startLine']) : null
  const endLine = Number.isFinite(Number(input['endLine'])) ? Number(input['endLine']) : null
  if (startLine !== null || endLine !== null) {
    fingerprints.push(`lines:${startLine ?? ''}:${endLine ?? ''}`)
  }

  const offset = Number.isFinite(Number(input['offset'])) ? Number(input['offset']) : null
  const limit = Number.isFinite(Number(input['limit'])) ? Number(input['limit']) : null
  if (offset !== null || limit !== null) {
    fingerprints.push(`bytes:${offset ?? ''}:${limit ?? ''}`)
  }

  return fingerprints.join('\n')
}

function normalizeTargetPath(value: unknown): string {
  const raw = String(value ?? '').trim()
  return raw.replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/')
}

function normalizeBashIntent(command: string): string {
  let normalized = normalizeWhitespace(command)
  normalized = normalized.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+)\s+)+/, '')
  normalized = normalized.replace(/^cd\s+\S+\s*&&\s*/, '')
  const firstSegment = normalized.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? normalized
  const scrubbed = firstSegment
    .replace(/\/var\/folders\/[^\s"'`]+/g, '<tmp>')
    .replace(/\/tmp\/[^\s"'`]+/g, '<tmp>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\b[a-f0-9]{8,}\b/ig, '<id>')
  const tokens = scrubbed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [scrubbed]
  return tokens.slice(0, 6).join(' ')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeToolPayload(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n')
}

function hashToolPayload(value: string): string {
  return createHash('sha1')
    .update(`${value.length}:${value}`)
    .digest('hex')
    .slice(0, 12)
}

/** Create a new conversation. */
export function createConversation(opts: {
  system: string
  model: string
  maxTokens?: number
  tools?: Conversation['tools']
}): Conversation {
  return {
    id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    system: opts.system,
    turns: [],
    tools: opts.tools ?? [],
    model: opts.model,
    maxTokens: opts.maxTokens ?? 4096,
  }
}

/** Add a user message to the conversation. */
export function addUserMessage(conversation: Conversation, text: string): void {
  conversation.turns.push({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}
