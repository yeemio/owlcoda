/**
 * OwlCoda Native Agent Tool
 *
 * Spawns a sub-conversation (sub-agent) with its own tool dispatcher.
 * The sub-agent runs the prompt to completion and returns the result.
 *
 * Supports agent types:
 *   - "general-purpose" (default): all tools available
 *   - "Explore": read-only subset (bash, read, glob, grep)
 */

import { randomUUID } from 'node:crypto'
import type { Conversation } from '../protocol/types.js'
import { ProviderRequestError, formatProviderDiagnostic } from '../../provider-error.js'
import type { NativeToolDef, ToolResult } from './types.js'
import {
  createConversation,
  addUserMessage,
  runConversationLoop,
  type ConversationLoopOptions,
  type ConversationCallbacks,
} from '../conversation.js'
import { ToolDispatcher } from '../dispatch.js'
import { buildNativeToolDefs } from '../tool-defs.js'
import { buildSystemPrompt } from '../system-prompt.js'
import { classifyTaskContract } from '../task-contract.js'
import type { TaskPathScope } from '../protocol/types.js'
import {
  createAgentWatchdog,
  formatAgentTimeoutMessage,
  resolveAgentTimeoutPolicy,
  type AgentTimeoutFiring,
} from './agent-timeout.js'
import { detectCompletionClaim } from '../task-state.js'
import {
  adaptiveConcurrencyKeyFromApiBaseUrl,
  resolveAdaptiveAgentLimit,
  resolveAgentConcurrencyCap,
} from '../adaptive-concurrency.js'

export interface AgentInput {
  /** Short 3-5 word description of the task */
  description: string
  /** The full task prompt for the sub-agent */
  prompt: string
  /** Agent type: "general-purpose" or "Explore" */
  subagent_type?: string
  /**
   * Optional model id for the sub-agent. When omitted, the sub-agent uses
   * the parent conversation's model (or the OWLCODA_SUBAGENT_MODEL operator
   * default). Specifying a different model lets orchestration sub-agents run
   * off a separate backend from a data-generation parent, so one backend
   * outage does not fail the parent and every sibling at once (P0-8).
   */
  model?: string
  /** Optional iteration budget for long-running sub-agent work. */
  max_iterations?: number
  /**
   * Slice 5: agent artifact contract. When non-empty, the sub-agent MUST
   * touch at least one path matching each expected artifact before the
   * parent considers the run successful. Unmatched artifacts cause the tool
   * to return isError=true even if the sub-agent itself exited cleanly.
   *
   * Text-deliverable / research agents that don't write files should omit
   * this field entirely — absence means "no artifact enforcement".
   */
  expectedArtifacts?: TaskPathScope[]
  /** Parent task ID for traceability (optional). */
  parentTaskId?: string
  /** Parent step ID for traceability (optional). */
  parentStepId?: string
}

/** Read-only tools for Explore agent */
const EXPLORE_TOOLS = new Set(['bash', 'read', 'glob', 'grep', 'WebFetch', 'WebSearch'])

function getExploreSystemPrompt(): string {
  return `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob for broad file pattern matching
- Use grep for searching file contents with regex
- Use read when you know the specific file path
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, or any modification

Complete the search request efficiently and report your findings clearly.`
}

/** Sub-agents indexed by their run ID for status queries */
const runningAgents = new Map<string, { description: string; startTime: number }>()

export function getRunningAgents(): Map<string, { description: string; startTime: number }> {
  return runningAgents
}

const DEFAULT_GENERAL_AGENT_MAX_ITERATIONS = 200
const DEFAULT_EXPLORE_AGENT_MAX_ITERATIONS = 80

// ---------------------------------------------------------------------------
// 2026-05-28: Sub-agent concurrency semaphore.
//
// When a parent LLM fan-outs N sub-agents in one turn (e.g. 5 parallel research
// deliverables), all N tool calls dispatch concurrently and each opens its own
// upstream request. Some providers (observed: mimo-v25-pro) reject the burst
// with HTTP 400 + "Cluster rate limit exceeded, request queued but not
// admitted" — a non-standard rate-limit shape that doesn't count as 429.
//
// Patch 1 (provider-error.ts) makes owlcoda treat that 400 as retryable, but
// retry-after-burst still re-burst. The structural fix is to cap concurrent
// in-flight sub-agents so the parent fan-out never produces a burst in the
// first place.
//
// Default: 1 (fully serial sub-agents). Override the cap via
// OWLCODA_AGENT_MAX_CONCURRENCY=N. With OWLCODA_AGENT_ADAPTIVE_CONCURRENCY=1,
// the cap becomes a ceiling and the effective limit slow-starts from 1.
//
// Tracked in KANBAN [SUBAGENT-FAILURE-CONTRACT] companion to the failure
// isolation hotfix shipped 9f3179c.
// ---------------------------------------------------------------------------

class AgentSemaphore {
  private states = new Map<string, { inFlight: number; waiters: Array<() => void> }>()

  constructor(private readonly resolveMax: (key: string) => number) {}

  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const state = this.stateFor(key)
    if (signal?.aborted) {
      throw new Error('Agent acquire aborted before slot was available')
    }
    if (state.inFlight < this.resolveMax(key)) {
      state.inFlight++
      return () => this.release(key)
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = (): void => {
        if (signal) signal.removeEventListener('abort', onAbort)
        state.inFlight++
        resolve(() => this.release(key))
      }
      const onAbort = (): void => {
        const idx = state.waiters.indexOf(waiter)
        if (idx >= 0) state.waiters.splice(idx, 1)
        reject(new Error('Agent acquire aborted while waiting for a concurrency slot'))
      }
      state.waiters.push(waiter)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private release(key: string): void {
    const state = this.stateFor(key)
    state.inFlight = Math.max(0, state.inFlight - 1)
    const next = state.waiters.shift()
    if (next) next()
  }

  /** Test-only inspection of in-flight + queued state. Don't mutate. */
  getStateForTesting(key?: string): { inFlight: number; waiting: number; max: number } {
    if (key) {
      const state = this.stateFor(key)
      return { inFlight: state.inFlight, waiting: state.waiters.length, max: this.resolveMax(key) }
    }
    let inFlight = 0
    let waiting = 0
    for (const state of this.states.values()) {
      inFlight += state.inFlight
      waiting += state.waiters.length
    }
    return { inFlight, waiting, max: resolveAgentConcurrencyCap() }
  }

  private stateFor(key: string): { inFlight: number; waiters: Array<() => void> } {
    const existing = this.states.get(key)
    if (existing) return existing
    const created = { inFlight: 0, waiters: [] as Array<() => void> }
    this.states.set(key, created)
    return created
  }
}

const agentSemaphore = new AgentSemaphore((key) => resolveAdaptiveAgentLimit(key))

/** Test-only inspection of the module-level semaphore. */
export function __getAgentSemaphoreStateForTesting(key?: string): { inFlight: number; waiting: number; max: number } {
  return agentSemaphore.getStateForTesting(key)
}

// ---------------------------------------------------------------------------
// 2026-05-28 (R7 follow-up): sub-agent isolated-failure output formatter.
//
// The isolation contract puts failure routing signals in metadata
// (subAgentIsolatedFailure / completion_status / failureCategory). But the
// parent LLM does NOT see metadata — it only sees the tool_result content
// (the `output` string). So a parent LLM looking at a failed Agent call has
// no structured way to route ("retry once / skip / abort") and can fall
// back to its weakest pattern: re-dispatch the same prompt and watch it
// fail again the same way.
//
// This helper wraps each failure path's existing detail text with a
// structured header + an explicit routing block so the parent LLM has the
// same routing guidance the metadata would have given a programmatic
// consumer. The detail text is unchanged — only header and guidance are
// added on top. Header line is greppable for downstream parsers if any
// ever emerge.
// ---------------------------------------------------------------------------

type IsolatedFailureReason =
  | 'max_iterations'
  | 'no_deliverable'
  | 'artifact_contract'
  | 'watchdog_timeout'
  | 'provider_error'
  | 'unknown'

interface IsolatedFailureOutputOptions {
  reason: IsolatedFailureReason
  /**
   * 'failed'  = clean failure, parent can routinely retry/skip/abort.
   * 'partial' = some artifacts produced but not all expected ones,
   *             AND the model did NOT claim completion. Skip+flag is
   *             a safe option.
   * 'inferred' = HIGH RISK: expected artifacts not produced AND the model
   *             claimed completion anyway. Parent must NOT silently skip —
   *             that would propagate a false completion claim into the
   *             final summary. Must verify directly or abort.
   */
  status: 'failed' | 'partial' | 'inferred'
  detail: string
  /**
   * When true, the upstream provider call was classified as retryable
   * (e.g. rate-limit shape) and owlcoda already retried once before
   * surfacing it. In that case "retry the same prompt" is NOT a useful
   * suggestion — the runtime already tried.
   */
  alreadyAutoRetried?: boolean
}

const STANDARD_ROUTING_OPTIONS = [
  '== How the parent should handle this failure ==',
  '',
  'This failure is isolated to this sub-agent; the parent task continues',
  'and sibling sub-agents are unaffected. Choose ONE of:',
  '',
  '  1. Retry once with a narrower prompt and an explicit output path',
  '     (only if the previous failure looks transient or the prompt was',
  '     ambiguous — do NOT retry verbatim).',
  '  2. Skip this deliverable and flag it in your final summary so the',
  '     user can see which sub-agent did not complete.',
  '  3. Abort the whole parent task ONLY if this deliverable is a hard',
  '     prerequisite for the rest.',
  '',
  'Do NOT re-dispatch the same prompt unchanged — that will not converge.',
].join('\n')

const INFERRED_ROUTING_OPTIONS = [
  '== How the parent should handle this failure ==',
  '',
  'This is a HIGH-RISK failure: the sub-agent claimed completion but the',
  'expected artifacts are missing. The result may contain hallucinated',
  'summaries of work that did not actually happen. Choose ONE of:',
  '',
  '  1. Verify directly: read the missing artifacts yourself (or run the',
  '     check the sub-agent should have run). Do NOT trust the sub-agent\'s',
  '     completion claim at face value.',
  '  2. Abort the deliverable and report to the user that the sub-agent',
  '     produced a misleading completion claim. The user must decide how',
  '     to proceed.',
  '',
  'Do NOT silently skip this failure — the parent must NOT propagate the',
  'false completion claim into the final summary.',
].join('\n')

const AUTO_RETRIED_ROUTING_OPTIONS = [
  '== How the parent should handle this failure ==',
  '',
  'This failure is isolated to this sub-agent; the parent task continues.',
  'The runtime already auto-retried the upstream call once before',
  'surfacing this error, so plain "retry the same prompt" is unlikely to',
  'help. Choose ONE of:',
  '',
  '  1. Skip this deliverable and flag it in your final summary.',
  '  2. Retry with a substantially different prompt or a different model',
  '     (the previous attempt already exhausted the auto-retry budget).',
  '  3. Abort the whole parent task ONLY if this deliverable is a hard',
  '     prerequisite for the rest.',
].join('\n')

// ---------------------------------------------------------------------------
// 2026-05-28 Patch 5: agent_invocation telemetry emitter.
//
// Emits one gate-event per Agent tool call when the sub-agent settles
// (success or any failure path). Attribute names are intentionally stable
// (`gen_ai.agent.*` / `gen_ai.operation.*`) so downstream exporters can map
// them without changing the runtime event schema.
// ---------------------------------------------------------------------------

import { recordGateEvent } from '../gate-telemetry.js'

interface AgentInvocationTelemetry {
  agentId: string
  agentType: string
  status: 'success' | 'failed' | 'partial' | 'inferred' | 'cancelled'
  failureCategory?: string
  stopReason?: string | null
  iterations?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  touchedPathCount?: number
  touchedPaths?: string[]
  expectedArtifactCount?: number
  expectedArtifactPaths?: string[]
  parentTaskId?: string | null
  parentStepId?: string | null
  subConvId?: string
}

function emitAgentInvocation(opts: AgentInvocationTelemetry): void {
  recordGateEvent({
    ts: Date.now(),
    kind: 'agent_invocation',
    conversationId: opts.subConvId ?? opts.agentId,
    iteration: opts.iterations ?? 0,
    contract: {
      cwd: process.cwd(),
      scopeMode: 'sub-agent',
      confidence: 'low',
      allowedWritePathsByOrigin: {},
      touchedPathsCount: opts.touchedPathCount ?? 0,
      scratchArtifactPathsCount: 0,
    },
    lastToolSignatures: [],
    agentId: opts.agentId,
    agentType: opts.agentType,
    agentStatus: opts.status,
    ...(opts.failureCategory ? { agentFailureCategory: opts.failureCategory } : {}),
    ...(opts.stopReason ? { agentStopReason: opts.stopReason } : {}),
    ...(opts.iterations !== undefined ? { agentIterations: opts.iterations } : {}),
    ...(opts.durationMs !== undefined ? { agentDurationMs: opts.durationMs } : {}),
    ...(opts.inputTokens !== undefined ? { agentInputTokens: opts.inputTokens } : {}),
    ...(opts.outputTokens !== undefined ? { agentOutputTokens: opts.outputTokens } : {}),
    ...(opts.touchedPathCount !== undefined ? { agentTouchedPathCount: opts.touchedPathCount } : {}),
    ...(opts.touchedPaths !== undefined ? { agentTouchedPaths: opts.touchedPaths.slice(0, 20) } : {}),
    ...(opts.expectedArtifactCount !== undefined ? { agentExpectedArtifactCount: opts.expectedArtifactCount } : {}),
    ...(opts.expectedArtifactPaths !== undefined ? { agentExpectedArtifactPaths: opts.expectedArtifactPaths.slice(0, 20) } : {}),
    ...(opts.parentTaskId !== undefined ? { agentParentTaskId: opts.parentTaskId } : {}),
    ...(opts.parentStepId !== undefined ? { agentParentStepId: opts.parentStepId } : {}),
  })
}

function getAgentTouchedPaths(subConv: Conversation): string[] {
  const paths = subConv.options?.taskState?.contract.touchedPaths ?? []
  return [...new Set(paths)].slice(0, 20)
}

function getAgentExpectedArtifactPaths(input: AgentInput): string[] {
  const paths = input.expectedArtifacts?.map((artifact) => artifact.path) ?? []
  return [...new Set(paths)].slice(0, 20)
}

/**
 * 2026-05-28 Patch 6 helper: detect sub-agent completion claims for inferred-vs-
 * partial classification on the artifact_contract failure path.
 *
 * The conversation-loop's detectCompletionClaim is intentionally conservative
 * (it gates a delivery-check nudge that runs mid-task; false positives there
 * waste a model turn). The sub-agent inferred-detector needs to be wider:
 * any phrase like "Done.", "I generated everything you asked for", "Wrote
 * the deck" is a completion claim from a sub-agent's POV. That wider net is
 * safe here because the inferred path is double-gated — expectedArtifacts
 * non-empty AND artifact contract failed — so wider phrasing matching never
 * fires on read-only / text-deliverable agents.
 */
function subAgentClaimsCompletion(text: string): boolean {
  if (!text) return false
  // Reuse the runtime's strict detector first — anything it catches is
  // unambiguously a completion claim.
  if (detectCompletionClaim(text)) return true
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  // Sub-agent-specific looser patterns. Each must be near the start of a
  // sentence to avoid mid-paragraph false matches.
  // "Done." / "Done!" / "Done so the deck..." at start of text or sentence.
  if (/(?:^|[.!?。！？\n]\s*)(?:done|finished|complete)\b[\s.!]/i.test(trimmed)) return true
  // "I have/Generated/Wrote/Created/Built/Produced ... everything|all|the deck|the report|the notes|the file"
  if (/\b(?:generated|wrote|created|built|produced|finalized|finished)\b[^.!?。！？\n]*\b(?:everything|all|deck|report|notes?|files?|html|markdown|the\s+\w+)\b/i.test(trimmed)) return true
  return false
}

export function formatIsolatedFailureOutput(opts: IsolatedFailureOutputOptions): string {
  const header = `[Sub-agent failed in isolation — status: ${opts.status}, reason: ${opts.reason}]`
  const guidance = opts.status === 'inferred'
    ? INFERRED_ROUTING_OPTIONS
    : opts.alreadyAutoRetried
      ? AUTO_RETRIED_ROUTING_OPTIONS
      : STANDARD_ROUTING_OPTIONS
  const detail = opts.detail.trim()
  const sections = detail.length > 0 ? [header, '', detail, '', guidance] : [header, '', guidance]
  return sections.join('\n')
}

function buildWatchdogTimeoutResult(opts: {
  firing: AgentTimeoutFiring
  agentId: string
  agentType: string
  input: AgentInput
  subConv: Conversation
  result?: {
    iterations: number
    stopReason: string | null
    usage?: { inputTokens?: number; outputTokens?: number }
  }
  elapsedSeconds?: number
}): ToolResult {
  const { firing, agentId, agentType, input, subConv, result, elapsedSeconds } = opts
  emitAgentInvocation({
    agentId,
    agentType,
    status: 'failed',
    failureCategory: 'agent:watchdog_timeout',
    stopReason: result?.stopReason ?? `watchdog:${firing.kind}`,
    iterations: result?.iterations,
    durationMs: firing.at - firing.startTime,
    inputTokens: result?.usage?.inputTokens,
    outputTokens: result?.usage?.outputTokens,
    touchedPathCount: getAgentTouchedPaths(subConv).length,
    touchedPaths: getAgentTouchedPaths(subConv),
    expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
    expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
    parentTaskId: input.parentTaskId ?? null,
    parentStepId: input.parentStepId ?? null,
    subConvId: subConv.id,
  })

  const metadata: Record<string, unknown> = {
    agentId,
    agentType,
    cancelled: true,
    agentTimeout: true,
    timeoutKind: firing.kind,
    elapsedMs: firing.at - firing.startTime,
    idleMs: firing.at - firing.lastProgress.at,
    lastProgress: firing.lastProgress,
    idleTimeoutMs: firing.idleTimeoutMs,
    maxRuntimeMs: firing.maxRuntimeMs,
    subAgentIsolatedFailure: true,
    completion_status: 'failed',
    failureCategory: 'agent:watchdog_timeout',
  }
  if (result) {
    metadata['iterations'] = result.iterations
    metadata['stopReason'] = result.stopReason
    metadata['usage'] = result.usage
  }
  if (elapsedSeconds !== undefined) {
    metadata['elapsedSeconds'] = elapsedSeconds
  }

  return {
    output: formatIsolatedFailureOutput({
      reason: 'watchdog_timeout',
      status: 'failed',
      detail: formatAgentTimeoutMessage(firing),
    }),
    isError: true,
    metadata,
  }
}

function parsePositiveIterationBudget(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

function resolveAgentMaxIterations(input: AgentInput, isExplore: boolean): number {
  const requested = parsePositiveIterationBudget(input.max_iterations)
  if (requested !== null) return requested

  const specificEnv = process.env[isExplore ? 'OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS' : 'OWLCODA_AGENT_MAX_ITERATIONS']
  const envBudget = parsePositiveIterationBudget(specificEnv)
  if (envBudget !== null) return envBudget

  return isExplore ? DEFAULT_EXPLORE_AGENT_MAX_ITERATIONS : DEFAULT_GENERAL_AGENT_MAX_ITERATIONS
}

export interface AgentToolDeps {
  /** API base URL for sub-agent requests */
  apiBaseUrl: string
  /** API key */
  apiKey: string
  /** Model to use for sub-agent */
  model: string
  /** Resolve the latest active model at execution time. */
  getModel?: () => string
  /** Resolve the latest context window at execution time. */
  getContextWindow?: () => number
  /** Max tokens per response */
  maxTokens: number
  /** Optional callbacks for sub-agent output */
  callbacks?: ConversationCallbacks
  /** Context window size */
  contextWindow?: number
}

export function createAgentTool(deps: AgentToolDeps): NativeToolDef<AgentInput> {
  return {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle a specific task. The sub-agent runs in its own conversation context with access to tools. Use for delegating independent subtasks.',

    async execute(input: AgentInput, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      const { description, prompt, subagent_type } = input

      if (!prompt || typeof prompt !== 'string') {
        return { output: 'Error: prompt is required', isError: true }
      }
      if (!description || typeof description !== 'string') {
        return { output: 'Error: description is required', isError: true }
      }

      // Wait for a concurrency slot before opening any upstream conversation.
      // See AgentSemaphore comment block above for rationale (mimo-v25-pro
      // cluster rate-limit on bursts).
      const concurrencyKey = adaptiveConcurrencyKeyFromApiBaseUrl(deps.apiBaseUrl)
      let releaseSlot: () => void
      try {
        releaseSlot = await agentSemaphore.acquire(concurrencyKey, context?.signal)
      } catch (err) {
        const cancelled = err instanceof Error && /aborted/i.test(err.message)
        emitAgentInvocation({
          agentId: 'pre-acquire',
          agentType: subagent_type ?? 'general-purpose',
          status: 'cancelled',
          failureCategory: 'agent:semaphore_acquire',
        })
        return {
          output: cancelled
            ? 'Agent cancelled while waiting for a concurrency slot.'
            : `Agent semaphore acquire failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          metadata: {
            agentId: 'pre-acquire',
            agentType: subagent_type ?? 'general-purpose',
            cancelled,
            subAgentIsolatedFailure: true,
            completion_status: 'failed',
            failureCategory: 'agent:semaphore_acquire',
          },
        }
      }

      try {
      const agentType = subagent_type ?? 'general-purpose'
      const agentId = `agent-${randomUUID().slice(0, 8)}`
      const isExplore = agentType.toLowerCase() === 'explore'
      // Model precedence: explicit per-call input.model > OWLCODA_SUBAGENT_MODEL
      // operator default > parent conversation model. Blank/whitespace inputs
      // fall through so a stray empty string never forces an invalid model.
      const requestedModel = typeof input.model === 'string' && input.model.trim()
        ? input.model.trim()
        : undefined
      const operatorDefaultModel = process.env['OWLCODA_SUBAGENT_MODEL']?.trim() || undefined
      const parentModel = deps.getModel ? deps.getModel() : deps.model
      const activeModel = requestedModel ?? operatorDefaultModel ?? parentModel

      // Create sub-agent dispatcher
      const subDispatcher = new ToolDispatcher()

      // For Explore, remove write/edit tools
      if (isExplore) {
        const names = subDispatcher.getToolNames()
        for (const name of names) {
          if (!EXPLORE_TOOLS.has(name)) {
            subDispatcher.unregister(name)
          }
        }
      }

      // Build system prompt
      const systemPrompt = isExplore ? getExploreSystemPrompt() : buildSystemPrompt()

      // Create sub-conversation
      const subConv = createConversation({
        system: systemPrompt,
        model: activeModel,
        maxTokens: deps.maxTokens,
        tools: buildNativeToolDefs(subDispatcher),
      })

      addUserMessage(subConv, prompt)

      // Track this agent
      runningAgents.set(agentId, { description, startTime: Date.now() })

      // 0.13.57 agent_timeout_policy_v1 — two-axis watchdog. Idle timeout
      // resets on any progress signal (assistant text, tool start/end,
      // tool progress chunk, runtime notice); max-runtime is the
      // absolute hard ceiling. Both env-tunable; both default ON. See
      // agent-timeout.ts for the design notes.
      const policy = resolveAgentTimeoutPolicy()
      const watchdog = createAgentWatchdog({
        idleTimeoutMs: policy.idleTimeoutMs,
        maxRuntimeMs: policy.maxRuntimeMs,
        externalSignal: context?.signal,
      })

      // Wrap callbacks to prefix with agent label AND record progress
      // marks so the watchdog idle clock resets on real activity.
      const label = `[${agentType}:${agentId}]`
      const wrappedCallbacks: ConversationCallbacks = {
        onText: (text) => {
          watchdog.recordProgress('assistant_text')
          deps.callbacks?.onText?.(`${label} ${text}`)
        },
        onToolStart: (name, inp) => {
          watchdog.recordProgress('tool_start', name)
          deps.callbacks?.onToolStart?.(name, inp)
        },
        onToolEnd: (name, result, isErr, dur) => {
          watchdog.recordProgress('tool_end', name)
          deps.callbacks?.onToolEnd?.(name, result, isErr, dur)
        },
        onToolProgress: (name, event) => {
          watchdog.recordProgress('tool_progress', name)
          deps.callbacks?.onToolProgress?.(name, event)
        },
        onNotice: (msg) => {
          watchdog.recordProgress('notice')
          deps.callbacks?.onNotice?.(msg)
        },
        onError: (err) => deps.callbacks?.onError?.(`${label} ${err}`),
      }

      const loopOpts: ConversationLoopOptions = {
        apiBaseUrl: deps.apiBaseUrl,
        apiKey: deps.apiKey,
        maxIterations: resolveAgentMaxIterations(input, isExplore),
        callbacks: wrappedCallbacks,
        contextWindow: deps.getContextWindow?.() ?? deps.contextWindow,
        signal: watchdog.signal,
      }

      try {
        const result = await runConversationLoop(subConv, subDispatcher, loopOpts)

        const elapsedSeconds = (Date.now() - runningAgents.get(agentId)!.startTime) / 1000
        const elapsed = elapsedSeconds.toFixed(1)
        const firing = watchdog.getFiring()
        runningAgents.delete(agentId)
        watchdog.dispose()

        // 2026-05-28 Bug F: runConversationLoop can observe the watchdog's
        // abort signal and exit cooperatively (for example with
        // stopReason='tool_use') instead of throwing. That is still a
        // watchdog timeout. Check the firing before any silent/no-deliverable
        // classification, otherwise the parent sees the misleading
        // "no_deliverable" cap instead of the real timeout evidence.
        if (firing) {
          return buildWatchdogTimeoutResult({
            firing,
            agentId,
            agentType,
            input,
            subConv,
            result,
            elapsedSeconds: parseFloat(elapsed),
          })
        }

        if (result.runtimeFailure) {
          // 2026-05-28 Patch 8: previously this normal-return path emitted a
          // raw "Agent error: ..." string without the isolation wrapper, the
          // isolation metadata trio, or a telemetry event. R7-1 (3383e18) had
          // covered the four catch branches below but missed this ninth path
          // where runConversationLoop returns normally with runtimeFailure set
          // (provider error exhausted auto-retries, http_error, empty response,
          // stream close, timeout, etc. — anything classifyConversationRuntime-
          // Failure catches). Without the wrap, parent LLMs got no routing
          // guidance; without the isolation trio, loop-guard counters would
          // happily aggregate same-class failures across siblings; without the
          // telemetry event, dogfood data underreports.
          const failure = result.runtimeFailure
          const elapsedMs = parseFloat(elapsed) * 1000

          // Abort: user-initiated cancellation. Mirror the catch-path abort
          // handling (no routing wrap — parent already initiated this).
          if (failure.kind === 'abort') {
            emitAgentInvocation({
              agentId,
              agentType,
              status: 'cancelled',
              failureCategory: 'agent:aborted',
              stopReason: result.stopReason,
              iterations: result.iterations,
              durationMs: elapsedMs,
              parentTaskId: input.parentTaskId ?? null,
              parentStepId: input.parentStepId ?? null,
              subConvId: subConv.id,
              touchedPathCount: getAgentTouchedPaths(subConv).length,
              touchedPaths: getAgentTouchedPaths(subConv),
              expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
              expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            })
            return {
              output: 'Agent cancelled',
              isError: true,
              metadata: {
                agentId,
                agentType,
                iterations: result.iterations,
                stopReason: result.stopReason,
                usage: result.usage,
                elapsedSeconds: parseFloat(elapsed),
                cancelled: true,
                runtimeFailure: failure,
                subAgentIsolatedFailure: true,
                completion_status: 'failed',
                failureCategory: 'agent:aborted',
              },
            }
          }

          const isTimeoutKind = failure.kind === 'timeout' || failure.kind === 'stream_idle_timeout'
          const reason: IsolatedFailureReason = isTimeoutKind ? 'watchdog_timeout' : 'provider_error'
          const failureCategory = `agent:${reason}`

          emitAgentInvocation({
            agentId,
            agentType,
            status: 'failed',
            failureCategory,
            stopReason: result.stopReason ?? `runtime:${failure.kind}`,
            iterations: result.iterations,
            durationMs: elapsedMs,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            touchedPathCount: getAgentTouchedPaths(subConv).length,
            touchedPaths: getAgentTouchedPaths(subConv),
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })

          return {
            output: formatIsolatedFailureOutput({
              reason,
              status: 'failed',
              detail: `Agent error: ${failure.message}`,
              alreadyAutoRetried: failure.retryable === true,
            }),
            isError: true,
            metadata: {
              agentId,
              agentType,
              iterations: result.iterations,
              stopReason: result.stopReason,
              usage: result.usage,
              elapsedSeconds: parseFloat(elapsed),
              runtimeFailure: failure,
              subAgentIsolatedFailure: true,
              completion_status: 'failed',
              failureCategory,
              failureMessage: failure.message,
            },
          }
        }

        // If the subagent finished without a final message (hit iteration cap,
        // tool_use stop with no follow-up text, streaming glitch, etc.), we
        // synthesise a useful summary from what DID happen — tools it called,
        // last non-empty assistant text it produced, stop reason, iteration
        // count. A black-box "(Agent completed with no text output)" is a
        // trust killer for long runs, so this fallback is always non-empty
        // when the loop returned without throwing.
        const silent = result.finalText.trim().length === 0
        const output = silent
          ? summarizeSilentAgent(subConv, result.iterations, result.stopReason, parseFloat(elapsed))
          : result.finalText

        if (silent && result.stopReason === 'max_iterations') {
          emitAgentInvocation({
            agentId,
            agentType,
            status: 'failed',
            failureCategory: 'agent:max_iterations',
            stopReason: result.stopReason,
            iterations: result.iterations,
            durationMs: Date.now() - (runningAgents.get(agentId)?.startTime ?? Date.now()),
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            touchedPathCount: getAgentTouchedPaths(subConv).length,
            touchedPaths: getAgentTouchedPaths(subConv),
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })
          return {
            output: formatIsolatedFailureOutput({
              reason: 'max_iterations',
              status: 'failed',
              detail: output,
            }),
            isError: true,
            metadata: {
              agentId,
              agentType,
              iterations: result.iterations,
              stopReason: result.stopReason,
              usage: result.usage,
              elapsedSeconds: parseFloat(elapsed),
              silent: true,
              agentIncomplete: true,
              // 2026-05-27 sub-agent failure isolation hotfix:
              // sub-agent failures used to set terminalToolFailure=true which
              // dispatch.ts upgrades to a parent terminal_tool_failure, killing
              // sibling sub-agents in a fan-out pipeline. Per hierarchical
              // orchestrator-subagent pattern ("errors are data, not exceptions"),
              // sub-agent failures must stay isolated. The parent LLM sees this
              // result as isError=true and can decide retry/skip/abort itself.
              // See KANBAN [SUBAGENT-FAILURE-CONTRACT] ADR for full refactor plan.
              subAgentIsolatedFailure: true,
              completion_status: 'failed',
              failureCategory: 'agent:max_iterations',
              failureMessage: 'Sub-agent hit max_iterations before producing a final message.',
            },
          }
        }

        if (subAgentRequiresWritesButTouchedNothing(subConv)) {
          emitAgentInvocation({
            agentId,
            agentType,
            status: 'failed',
            failureCategory: 'agent:no_deliverable',
            stopReason: result.stopReason,
            iterations: result.iterations,
            durationMs: parseFloat(elapsed) * 1000,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            touchedPathCount: 0,
            touchedPaths: getAgentTouchedPaths(subConv),
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })
          return {
            output: formatIsolatedFailureOutput({
              reason: 'no_deliverable',
              status: 'failed',
              detail: summarizeNoDeliverableAgent(subConv, output, result.iterations, result.stopReason, parseFloat(elapsed)),
            }),
            isError: true,
            metadata: {
              agentId,
              agentType,
              iterations: result.iterations,
              stopReason: result.stopReason,
              usage: result.usage,
              elapsedSeconds: parseFloat(elapsed),
              agentIncomplete: true,
              agentNoDeliverable: true,
              // See max_iterations branch above for the isolation rationale.
              subAgentIsolatedFailure: true,
              completion_status: 'failed',
              failureCategory: 'agent:no_deliverable',
              failureMessage: 'Sub-agent task required file output but completed without touching any durable path.',
              touchedPaths: subConv.options?.taskState?.contract.touchedPaths ?? [],
              scratchArtifactPaths: subConv.options?.taskState?.run.scratchArtifactPaths ?? [],
            },
          }
        }

        // Slice 5: agent artifact contract enforcement.
        // If the caller specified expectedArtifacts, every artifact must be
        // satisfied by at least one touchedPath before we report success.
        // Text/research agents without expectedArtifacts are unaffected.
        const touchedPaths: string[] = subConv.options?.taskState?.contract.touchedPaths ?? []
        const artifactCheck = checkArtifactContract(input.expectedArtifacts, touchedPaths)
        if (!artifactCheck.passed) {
          // 2026-05-28 Patch 6: inferred-vs-partial narrow detector.
          //
          // When the sub-agent produced a final text claiming completion
          // (per detectCompletionClaim) BUT did not actually produce all the
          // expected artifacts, the result is HIGH RISK — the model is
          // confidently asserting work it did not do. This is the failure
          // shape qubytes' fan-out failure contract calls 'inferred', and
          // it needs a stricter routing path than 'partial' (parent must
          // NOT silently skip — that would propagate the false completion
          // claim to the user).
          //
          // The judgement is narrow: only kicks in when
          //   1. expectedArtifacts was set (we have something to verify against)
          //   2. artifactCheck failed (not all artifacts matched)
          //   3. final text contains a completion-claim phrase
          // Read-only / research / text-deliverable agents never reach this
          // branch because they have empty expectedArtifacts.
          const claimedCompletion = subAgentClaimsCompletion(result.finalText)
          const inferred = claimedCompletion
          const statusForOutput = inferred ? 'inferred' : 'partial'
          emitAgentInvocation({
            agentId,
            agentType,
            status: statusForOutput,
            failureCategory: 'agent:artifact_contract',
            stopReason: result.stopReason,
            iterations: result.iterations,
            durationMs: parseFloat(elapsed) * 1000,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            touchedPathCount: touchedPaths.length,
            touchedPaths,
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })
          return {
            output: formatIsolatedFailureOutput({
              reason: 'artifact_contract',
              status: statusForOutput,
              detail: buildArtifactContractFailureMessage(artifactCheck.unmatched, touchedPaths),
            }),
            isError: true,
            metadata: {
              agentId,
              agentType,
              iterations: result.iterations,
              stopReason: result.stopReason,
              usage: result.usage,
              elapsedSeconds: parseFloat(elapsed),
              agentIncomplete: true,
              artifactContractFailed: true,
              // See max_iterations branch above for the isolation rationale.
              subAgentIsolatedFailure: true,
              completion_status: statusForOutput,
              inferredCompletionClaim: claimedCompletion,
              failureCategory: 'agent:artifact_contract',
              failureMessage: inferred
                ? 'Sub-agent claimed completion but did not produce all expected artifacts (high-risk inferred result).'
                : 'Sub-agent did not produce all expected artifacts.',
              parentTaskId: input.parentTaskId ?? null,
              parentStepId: input.parentStepId ?? null,
              expectedArtifacts: input.expectedArtifacts,
              touchedPaths,
              unmatchedArtifacts: artifactCheck.unmatched.map(a => a.path),
              artifactMatched: false,
            },
          }
        }

        emitAgentInvocation({
          agentId,
          agentType,
          status: 'success',
          stopReason: result.stopReason,
          iterations: result.iterations,
          durationMs: parseFloat(elapsed) * 1000,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          touchedPathCount: touchedPaths.length,
          touchedPaths,
          expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
          expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
          parentTaskId: input.parentTaskId ?? null,
          parentStepId: input.parentStepId ?? null,
          subConvId: subConv.id,
        })
        return {
          output,
          isError: false,
          metadata: {
            agentId,
            agentType,
            iterations: result.iterations,
            stopReason: result.stopReason,
            usage: result.usage,
            elapsedSeconds: parseFloat(elapsed),
            silent: result.finalText.trim().length === 0,
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            expectedArtifacts: input.expectedArtifacts ?? null,
            touchedPaths,
            artifactMatched: (input.expectedArtifacts?.length ?? 0) > 0 ? true : null,
          },
        }
      } catch (err: unknown) {
        runningAgents.delete(agentId)
        const firing = watchdog.getFiring()
        watchdog.dispose()
        // 0.13.57: distinguish watchdog timeout from generic abort.
        // If the watchdog fired, return a structured timeout error
        // with the last-progress evidence the operator needs to
        // diagnose without re-running.
        //
        // 2026-05-28 isolation contract: also stamp the sub-agent isolated-
        // failure trio (subAgentIsolatedFailure / completion_status /
        // failureCategory) so the parent loop's dispatcher does not
        // upgrade this into a parent terminal_tool_failure. See KANBAN
        // [SUBAGENT-FAILURE-CONTRACT].
        if (firing) {
          return buildWatchdogTimeoutResult({ firing, agentId, agentType, input, subConv })
        }
        // Abort stays distinct from provider failure — user cancelled, not
        // a network/upstream problem.
        if (err instanceof Error && (err.name === 'AbortError' || err.message === 'This operation was aborted')) {
          emitAgentInvocation({
            agentId,
            agentType,
            status: 'cancelled',
            failureCategory: 'agent:aborted',
            touchedPathCount: getAgentTouchedPaths(subConv).length,
            touchedPaths: getAgentTouchedPaths(subConv),
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })
          return {
            output: 'Agent cancelled',
            isError: true,
            metadata: {
              agentId,
              agentType,
              cancelled: true,
              subAgentIsolatedFailure: true,
              completion_status: 'failed',
              failureCategory: 'agent:aborted',
            },
          }
        }
        // Structured provider errors pass through their formatted form so the
        // headline/provider/request-id stays visible.
        if (err instanceof ProviderRequestError) {
          emitAgentInvocation({
            agentId,
            agentType,
            status: 'failed',
            failureCategory: 'agent:provider_error',
            stopReason: `provider:${err.diagnostic.kind}`,
            touchedPathCount: getAgentTouchedPaths(subConv).length,
            touchedPaths: getAgentTouchedPaths(subConv),
            expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
            expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
            parentTaskId: input.parentTaskId ?? null,
            parentStepId: input.parentStepId ?? null,
            subConvId: subConv.id,
          })
          return {
            output: formatIsolatedFailureOutput({
              reason: 'provider_error',
              status: 'failed',
              detail: `Agent error: ${formatProviderDiagnostic(err.diagnostic, { includeRequestId: true })}`,
              alreadyAutoRetried: err.diagnostic.retryable === true,
            }),
            isError: true,
            metadata: {
              agentId,
              agentType,
              diagnostic: err.diagnostic,
              subAgentIsolatedFailure: true,
              completion_status: 'failed',
              failureCategory: 'agent:provider_error',
              providerRetryable: err.diagnostic.retryable,
            },
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        emitAgentInvocation({
          agentId,
          agentType,
          status: 'failed',
          failureCategory: 'agent:unknown',
          touchedPathCount: getAgentTouchedPaths(subConv).length,
          touchedPaths: getAgentTouchedPaths(subConv),
          expectedArtifactCount: input.expectedArtifacts?.length ?? 0,
          expectedArtifactPaths: getAgentExpectedArtifactPaths(input),
          parentTaskId: input.parentTaskId ?? null,
          parentStepId: input.parentStepId ?? null,
          subConvId: subConv.id,
        })
        return {
          output: formatIsolatedFailureOutput({
            reason: 'unknown',
            status: 'failed',
            detail: `Agent error: ${msg}`,
          }),
          isError: true,
          metadata: {
            agentId,
            agentType,
            subAgentIsolatedFailure: true,
            completion_status: 'failed',
            failureCategory: 'agent:unknown',
          },
        }
      }
      } finally {
        releaseSlot()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Slice 5: artifact contract helpers
// ---------------------------------------------------------------------------

interface ArtifactCheckResult {
  passed: boolean
  unmatched: TaskPathScope[]
}

/**
 * Check whether every expected artifact has at least one matching touchedPath.
 *
 * Matching rules (in priority order):
 *   1. Exact path match (case-sensitive)
 *   2. basename match — the artifact path's basename appears in any touchedPath
 *
 * When expectedArtifacts is empty or undefined, passes unconditionally (no
 * contract was specified — text/research agents are unaffected).
 */
function checkArtifactContract(
  expected: TaskPathScope[] | undefined,
  touchedPaths: string[],
): ArtifactCheckResult {
  if (!expected || expected.length === 0) {
    return { passed: true, unmatched: [] }
  }

  const unmatched: TaskPathScope[] = []
  for (const artifact of expected) {
    const artifactPath = artifact.path
    const artifactBasename = artifactPath.split(/[\\/]/).pop() ?? artifactPath

    const satisfied = touchedPaths.some(tp => {
      if (tp === artifactPath) return true
      // basename match: touchedPath ends with the artifact basename
      const tpBasename = tp.split(/[\\/]/).pop() ?? tp
      return tpBasename === artifactBasename
    })

    if (!satisfied) {
      unmatched.push(artifact)
    }
  }

  return { passed: unmatched.length === 0, unmatched }
}

function buildArtifactContractFailureMessage(
  unmatched: TaskPathScope[],
  touchedPaths: string[],
): string {
  const lines = [
    `Agent artifact contract failed: ${unmatched.length} expected artifact${unmatched.length === 1 ? '' : 's'} not produced.`,
    '',
    'Missing artifacts:',
    ...unmatched.map(a => `  - ${a.path} (${a.kind})`),
  ]
  if (touchedPaths.length > 0) {
    lines.push('')
    lines.push('Files actually written:')
    lines.push(...touchedPaths.slice(0, 10).map(p => `  - ${p}`))
    if (touchedPaths.length > 10) {
      lines.push(`  … and ${touchedPaths.length - 10} more`)
    }
  } else {
    lines.push('')
    lines.push('No files were written by the sub-agent.')
  }
  return lines.join('\n')
}

function subAgentRequiresWritesButTouchedNothing(subConv: Conversation): boolean {
  const taskState = subConv.options?.taskState
  if (!taskState) return false
  const taskText = normalizeWhitespace(`${taskState.contract.objective} ${taskState.contract.sourceText}`)
  if (classifyTaskContract(taskText).kind !== 'write_required') return false
  return taskState.contract.touchedPaths.length === 0
}

function summarizeNoDeliverableAgent(
  subConv: Conversation,
  fallbackOutput: string,
  iterations: number,
  stopReason: string | null,
  elapsedSeconds: number,
): string {
  const taskState = subConv.options?.taskState
  const scratch = taskState?.run.scratchArtifactPaths ?? []
  const allowed = taskState?.contract.allowedWritePaths ?? []
  const lines = [
    'Agent incomplete: the sub-agent task required file output, but it returned without touching any durable path.',
    `Iterations: ${iterations}; stop_reason=${stopReason ?? 'none'}; elapsed=${elapsedSeconds.toFixed(1)}s.`,
  ]
  if (allowed.length > 0) {
    const sample = allowed.slice(0, 3).map((scope) => `${scope.origin}:${scope.path}`).join(', ')
    const more = allowed.length > 3 ? ` (+${allowed.length - 3} more)` : ''
    lines.push(`Task write scope: ${sample}${more}.`)
  }
  if (scratch.length > 0) {
    const sample = scratch.slice(0, 3).join(', ')
    const more = scratch.length > 3 ? ` (+${scratch.length - 3} more)` : ''
    lines.push(`Scratch artifacts observed but not durable deliverables: ${sample}${more}.`)
  }
  const trimmed = fallbackOutput.trim()
  if (trimmed) {
    const snippet = trimmed.length > 600 ? `${trimmed.slice(0, 600).trimEnd()}...` : trimmed
    lines.push(`Last agent output:\n${snippet}`)
  }
  lines.push('Do not treat this as completed work. Continue locally, or rerun the agent with a narrower prompt and explicit output path.')
  return lines.join('\n\n')
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}


/**
 * Build a meaningful summary when a sub-agent returned without a final text
 * message. Walks the sub-conversation to surface tools used, the last
 * non-empty assistant text (often the agent describing what it did before
 * running out of iterations), and key metrics. Never returns an empty string.
 */
export function summarizeSilentAgent(
  subConv: Conversation,
  iterations: number,
  stopReason: string | null,
  elapsedSeconds: number,
): string {
  const toolCounts = new Map<string, number>()
  const assistantTexts: string[] = []

  for (const turn of subConv.turns) {
    if (turn.role !== 'assistant') continue
    for (const block of turn.content) {
      if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
        const t = (block as { text: string }).text.trim()
        if (t.length > 0) assistantTexts.push(t)
      } else if (block.type === 'tool_use') {
        const name = (block as { name?: string }).name ?? '?'
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
      }
    }
  }

  const parts: string[] = []
  parts.push(
    `(Agent finished without a final message — ${iterations} iteration${iterations === 1 ? '' : 's'}, ` +
    `stop_reason=${stopReason ?? 'none'}, ${elapsedSeconds.toFixed(1)}s.)`,
  )

  if (stopReason === 'max_iterations') {
    parts.push('Agent incomplete: the sub-agent exhausted its iteration budget before producing a final answer. Do not treat this as completed work; resume with a narrower prompt or increase max_iterations.')
  }

  if (toolCounts.size > 0) {
    const toolSummary = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n === 1 ? name : `${name} (${n}x)`))
      .join(', ')
    parts.push(`Tools used: ${toolSummary}.`)
  } else {
    parts.push('No tools were used.')
  }

  if (assistantTexts.length > 0) {
    const last = assistantTexts[assistantTexts.length - 1]!
    const snippet = last.length > 400 ? last.slice(0, 400).trimEnd() + '…' : last
    parts.push(`Last assistant text:\n${snippet}`)
  } else {
    parts.push('The agent produced no assistant text during this run.')
  }

  if (stopReason !== 'max_iterations') {
    parts.push('If the result is genuinely silent-but-useful (e.g. files were written), check side effects directly.')
  }
  return parts.join('\n\n')
}
