/**
 * OwlCoda Native Conversation Loop
 *
 * The core agentic loop: send request → parse response → execute tools → repeat.
 * Continues until the model returns end_turn or max iterations reached.
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename as pathBasename, dirname as pathDirname, isAbsolute as pathIsAbsolute, normalize as pathNormalize, resolve as pathResolve } from 'node:path'
import * as v8 from 'node:v8'
import type {
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  Conversation,
  AssistantResponse,
} from './protocol/types.js'
import type { AnthropicMessagesRequest } from './protocol/types.js'
import { computeAdaptiveTimeoutMs } from '../middleware/adaptive-timeout.js'
import { buildAnthropicMessagesUrl } from '../url-normalize.js'
import type { AskUserQuestionOpts, ToolProgressEvent } from './tools/types.js'
import { buildRequest, sanitizeConversationTurns } from './protocol/request.js'
import { consumeStream } from './protocol/stream.js'
import { parseResponse } from './protocol/response.js'
import { ToolDispatcher, type ToolExecutionResult } from './dispatch.js'
import { buildContextBudgetSnapshot, estimateTokens } from './usage.js'
import { tryCompact } from './llm-compact.js'
import {
  buildContextPressurePrompt,
  buildDeliveryCheckPrompt,
  buildMaxTokensContinuationPrompt,
  buildOutputBloatPrompt,
  buildProductionGatePrompt,
  buildTaskContinuePrompt,
  buildTaskRealignPrompt,
  approveTaskWriteScope,
  completionCitesTouchedPaths,
  describeTaskExecutionState,
  detectCompletionClaim,
  evaluateIntentGuard,
  evaluateWriteGuard,
  ensureTaskExecutionState,
  hasRecentArtifactProgress,
  inferUserIntent,
  latestSubstantiveUserText,
  markTaskCompleted,
  markTaskGuardBlocked,
  markTaskIteration,
  markTaskProgress,
  markTaskWaitingUser,
  markTaskWriteScopeBlocked,
} from './task-state.js'
import {
  decideOutputRepetition,
  buildOutputRepetitionEvent,
} from './output-repetition.js'
import { recordTelemetryEnvelope } from './telemetry-envelope.js'
import {
  buildProbeCoverageCheckPrompt,
  findMatchingUnsatisfiedProbe,
  markProbesSatisfied,
  unsatisfiedProbes,
} from './tools/probe-plan.js'
import { predictSchemaFailure } from './tools/tool-schema-error.js'
import { getReadLedgerStats } from './tools/read.js'
import {
  classifyDeliverableContract,
  shouldHardStopOnNoTouchedPaths,
  allowsChatFinal as deliverableAllowsChatFinal,
  type DeliverableContractClassification,
  type DeliverableMode,
  type ManifestHint,
} from './deliverable-contract.js'
import { recordGateEvent, buildPredicateComparisonEvent, type GateEvent } from './gate-telemetry.js'
import { recordMicrocompactShadow } from './microcompact.js'
import { recordClaimFidelityTelemetry } from './evidence-ledger-fidelity.js'
import { isGateV2Enabled } from './gate-v2-flag.js'
import { isModesEnabled, evaluateModeGate, evaluateAutoApproval } from './modes.js'
import {
  hasGrantedRiskyToolAwaitingEvidence,
  shouldHardStopOnAbandonedGrant,
} from './abandoned-grant-predicate.js'
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
import {
  adaptiveConcurrencyKeyFromApiBaseUrl,
  computeRequestRetryDelayMs,
  diagnosticLooksLikeRateLimit,
  isAdaptiveAgentConcurrencyEnabled,
  recordAdaptiveRateLimit,
  recordAdaptiveSuccess,
  requestAutoRetryLimit,
  tryConsumeAdaptiveRetryBudget,
} from './adaptive-concurrency.js'
import {
  buildEditNowNudgePrompt,
  buildTaskExecutionNudge,
  consumeNudge,
  createNudgeCounter,
} from './task-execution-policy.js'
import { decideRepairPolicy } from './repair-policy.js'
import type { VerificationPackResult } from './verification-packs/types.js'
import { classifyToolRisk } from './tool-risk.js'
import {
  recordProposal,
  recordPermissionRequested,
  recordPermissionGranted,
  recordPermissionDenied,
  recordExecutionStart,
  recordSettlement,
  recordPostGrantEvidence,
} from './turn-permission-state.js'
import {
  recordAssistantTextPhaseEvent,
  recordCompletionClaimPhaseEvent,
  recordPermissionPhaseEvent,
  recordPostGrantEvidencePhaseEvent,
  recordRuntimeNudgePhaseEvent,
  recordToolPhaseEvent,
  recordVerificationEvidencePhaseEvent,
} from './phase-event-state.js'
import { deriveTurnPhase, evaluateCompletionClaim, shouldInterveneForNoProgress } from './phase-runtime.js'
import { isPhaseRuntimeEnabled } from './phase-runtime-flag.js'
import type { DerivedTurnPhase } from './protocol/task-permission-types.js'
import {
  admit as admitProvenanceRecord,
  evaluateWriteTargetProvenance,
  extractPathsFromToolResult,
  extractWriteTargets,
  formatProvenanceError,
  isGateProvenanceEnabled,
  size as provenanceLedgerSize,
} from './write-provenance.js'
import { compileRulesForTarget } from './permission-rules.js'
import { homedir } from 'node:os'
import type { ProvenanceRecord, ProvenanceTargetEvaluation } from './protocol/write-provenance-types.js'
import type { ProjectMapSnapshot, ProjectMapVerificationProfile, ProjectMapWriteBoundary } from './protocol/project-map-types.js'
import {
  buildProjectMapPromptSummary,
  buildProjectMapSnapshot,
  isProjectMapEnabled,
  isProjectMapSnapshotStale,
  recordProjectMapSnapshotSample,
} from './project-map.js'

/**
 * PERM-7: emitted-warnings dedup set. Keyed on the ResolvedPermissions
 * object identity so each unique permissions load emits its warnings
 * exactly once, no matter how many tool calls follow. taskState
 * derivation may produce the same object across calls (cached on the
 * task) — WeakSet handles GC naturally when the task state turns over.
 */
const emittedPermissionWarnings = new WeakSet<object>()

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

// Tool-loop guard. Independent of agentic-strict: even in free mode we MUST
// stop the model from infinitely repeating an identical failing tool_use —
// that's pure cost burn with zero progress (e.g. the same missing-param
// Skill call returning the same error 100 times). Default ON; the only way
// to disable is an explicit env opt-out, which we keep available as an
// escape hatch for debugging the detector itself. `OWLCODA_LOOP_GUARD=off`
// (or `=0` / `=false`) → OFF; everything else (unset, empty, anything else)
// → ON. detectToolLoop's thresholds (≥2 same failures, ≥5 same successes)
// already tolerate productive multi-pass workflows; flipping the default
// only kills the pathological case.
function isToolLoopGuardEnabled(): boolean {
  const v = (process.env['OWLCODA_LOOP_GUARD'] ?? '').toLowerCase().trim()
  if (v === 'off' || v === '0' || v === 'false' || v === 'no' || v === 'disabled') return false
  return true
}

// 0.13.55 loop intercept mode. The detector's job didn't change — what
// changes is what we DO when it fires. Modes:
//   - 'soft' (default since 0.13.55): synthesize a tool_result with
//     metadata.loopIntercept=true asking the model to stop, summarize
//     root cause, propose specific patches, and ASK THE USER which to
//     apply. Conversation continues; the next assistant turn is
//     expected to be text. If the model retries the same intent
//     anyway, the second hit on the same intentKey escalates to hard
//     terminate.
//   - 'hard' (legacy 0.13.26-0.13.54): immediate terminal error,
//     stopReason=tool_loop, conversation ends. Preserved as opt-in
//     for tests and operators who want the old "fail fast" semantics
//     while we dogfood soft.
type LoopInterceptMode = 'soft' | 'hard'
function getLoopInterceptMode(): LoopInterceptMode {
  const v = (process.env['OWLCODA_LOOP_INTERCEPT'] ?? '').toLowerCase().trim()
  if (v === 'hard' || v === 'off' || v === '0' || v === 'false') return 'hard'
  return 'soft'
}

function buildLoopInterceptPrompt(
  reason: string,
  attempt: { name: string; intentTarget: string; intentKey: string },
): string {
  return [
    '[Runtime loop intercept]',
    `${reason}.`,
    '',
    `intent: tool=${attempt.name}, target=${attempt.intentTarget}`,
    '',
    'Stop calling tools. Your next reply MUST be plain text — no tool_use ' +
    'blocks. In it:',
    '  1. Summarize the root cause you keep hitting (one or two sentences).',
    '  2. Propose 1-3 specific patches that would fix it (file paths and ' +
    '     a short description of each change, if you can).',
    '  3. ASK THE USER which patch to apply, or whether to abandon the ' +
    '     task entirely.',
    '',
    'Do not retry this intent until the user replies. If you call any tool ' +
    'matching this intent before the user answers, the conversation will ' +
    'be terminated as a hard tool-loop violation.',
  ].join('\n')
}
const AUTO_COMPACT_THRESHOLD = 0.8 // compact at 80% context usage
const AUTO_COMPACT_KEEP_RATIO = 0.5 // keep 50% of turns after compact
// 0.13.62: heap-pressure emergency compact. The token-based auto-
// compact above watches the LLM context window; it does NOT see the
// host process's V8 heap. Long sessions with big inline outputs (each
// turn 30K+ output, many turns) can OOM the Node process before the
// token threshold trips. The 2026-05-07 mionyee dogfood crashed at
// `Ineffective mark-compacts near heap limit` after a deepseek-v4-pro
// session went 1.9M cumulative tokens / 30+ minutes without ever
// triggering token compact (because the per-turn token count stayed
// well under the model's window, but transcript bloat killed the
// host process). New defense: at the start of every iteration, also
// check `v8.getHeapStatistics().heap_size_limit` against current
// `heapUsed`. If we're past `HEAP_PRESSURE_THRESHOLD`, run an
// aggressive compact (keep ratio 0.2 vs 0.5) regardless of token
// state. Knob-able via env if anyone needs to disable.
const HEAP_PRESSURE_THRESHOLD = 0.75
const HEAP_PRESSURE_KEEP_RATIO = 0.2
// 0.13.63 (D): output-bloat detection. When the assistant emits
// >OUTPUT_BLOAT_CHARS chars of inline text for OUTPUT_BLOAT_WINDOW
// consecutive iterations, inject a `[Runtime output-bloat check]`
// nudge ONCE per session. Real-world model output is typically
// 1-3K chars; the kimi-code mionyee dogfood that drove the OOM was
// dumping 30K+ chars per turn. 15K chars is the sweet spot — high
// enough that a legitimate long answer doesn't trip it, low enough
// to catch the runaway-inline-dump pattern early.
const OUTPUT_BLOAT_CHARS = 15_000
const OUTPUT_BLOAT_WINDOW = 3
// 0.13.64: cap on max-tokens continuation nudges per session. After
// MAX_TOKENS_CONTINUATION_LIMIT consecutive injects without a non-
// max_tokens response in between, stop nudging — the model is
// genuinely producing more content than fits in any single response
// and the user needs to either narrow scope or accept file-based
// delivery. The runtime keeps showing `Truncated (max tokens
// reached)` per the existing UI signal, but doesn't keep injecting.
const MAX_TOKENS_CONTINUATION_LIMIT = 2
// 0.14.54: narration-loop is an identity signal, not a no-edit signal.
// Earlier versions treated "write task + 0 touched paths + N text-only replies"
// as a loop, which is the same category mistake as task-no-progress: it infers
// stagnation from absence of writes. Keep only the runtime fact that mature
// harnesses can hard-stop safely: the model emitted the same normalized
// text-only reply N times in a row.
const NARRATION_LOOP_LIMIT = 3
// 0.13.67: task-no-progress hard ceiling. 0.13.66's narration-loop
// detector (NARRATION_LOOP_LIMIT) only fires when the model emits
// 3 *consecutive* text-only end_turn iterations. The 2026-05-07
// deepseek-v4-pro engineering-contract dogfood (second session)
// produced a different failure shape: 8 successful tool_use
// iterations (Read/Search across 30+ files) followed by iter 9
// starting a long text response that 120s-timed-out mid-stream. The
// timeout iter never pushed an assistant turn, so 0.13.66's counter
// never incremented, so it never fired. After auto-retry the same
// thing happened again. Total: 11+ minutes burned with 0 writes.
//
// New detector: `iterationsSinceTaskStart >= TASK_NO_PROGRESS_ITER_LIMIT`
// AND `shouldHardStopOnNoTouchedPaths(deliverable)` AND
// `touchedPaths.length === 0` → hard-stop. Independent of whether iterations are tool_use or
// text-only — the structural signal is "task should have produced
// at least one write by now".
//
// 8 is the interactive default: legitimate "read 6-7 files then write"
// tasks usually land the first write at iter <=7, so the counter resets
// at iter 8. Batch coding benchmarks can need deeper repository
// localization before the first edit; they may raise this through
// OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT without disabling the guard.
function resolveTaskNoProgressIterLimit(): number {
  const raw = process.env['OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT']
  if (raw === undefined || raw === '') return 8
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'unlimited' || lowered === 'infinity' || lowered === 'inf') {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 8
  if (parsed <= 0) return Number.POSITIVE_INFINITY
  return parsed
}
const TASK_NO_PROGRESS_ITER_LIMIT = resolveTaskNoProgressIterLimit()
function isTaskNoProgressHardStopEnabled(): boolean {
  const v = (process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] ?? '').toLowerCase().trim()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'hard'
}
const ARTIFACT_PROGRESS_REPAIR_ITER_WINDOW = 3

// 0.13.70 execution_economics_v1 — production_gate_v1 thresholds.
// Fires earlier than the 0.13.68 no-progress hard-stop and is one-
// shot + advisory (does not break the loop). Conditions to fire:
//   - shouldHardStopOnNoTouchedPaths(deliverable) === true
//   - touchedPaths.length === 0
//   - lifetimeIterations >= PRODUCTION_GATE_ITER_THRESHOLD
//   - distinct files read >= PRODUCTION_GATE_DISTINCT_FILES
//   - !taskState.run.productionGateFired (one-shot per task)
//
// 5/3 chosen so:
//   - Trivial "read one file then write" tasks (1-2 iter) never trip.
//   - Legitimate "explore 6-7 files then write" still gets one
//     advisory before the hard-stop at iter 9.
//   - 3 distinct files is the lower bound for "investigation
//     actually happened" — discriminates from cases where the model
//     is just iterating on the same file or pure narration.
const PRODUCTION_GATE_ITER_THRESHOLD = 5
const PRODUCTION_GATE_DISTINCT_FILES = 3
const TOOL_LOOP_GUARD_WINDOW = 24
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
// Delivery-check injection cap. Each turn can trigger at most this many
// `[Runtime delivery check]` nudges before we let the model conclude
// regardless. 2 is enough for "model claims done → audit → reconcile";
// higher values risk a nag-loop when the model insists on completion
// without running the audit.
const DELIVERY_CHECK_INJECTION_LIMIT = 2
// Probe-coverage injection cap (0.13.51). Same nag-loop logic as
// delivery-check: 2 chances for the model to emit missing probes
// after a coverage-check inject; if it still insists on summarizing
// without firing them, we let it through and the gap shows up in
// the transcript as repeated coverage warnings.
const PROBE_COVERAGE_INJECTION_LIMIT = 2
const ARTIFACT_REPAIR_MAX_ATTEMPTS = 2
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
const PROJECT_MAP_SYNTHESIS_REMAINING_ITERATIONS = 1
const TOOL_ONLY_NUDGE_TEXT = '[System: You have made 3 consecutive tool calls without producing any text output. Before requesting more tools, you MUST first write a text response summarizing what you have found so far and what you plan to do next. Do NOT call any tools in your next response — write text only.]'
const SYNTHESIS_STOP_SEQUENCES = ['\n[TOOL_CALL]', '\n<minimax:tool_call>', '\n<invoke name=', '\n```']
const PSEUDO_TOOL_CALL_RE = /(?:^|\n)\s*(?:\[\/?TOOL_CALL\]|<\s*minimax:tool_call\b|<\s*tool_call\b|<\s*invoke\b)/im
const SYNTHESIS_ESCAPE_RE = /\b(?:let me|i(?:'|’)ll|i will|next(?: step)?|need(?:s)? to|still need(?:s)?|want to)\b[\s,:-]{0,12}(?:read|search|grep|inspect|open|check|look|scan|fetch)\b/i
const WEAK_CONCLUSION_RE = /\b(?:need more evidence|insufficient evidence|unclear|unknown|more investigation|further investigation)\b/i
const PROJECT_MAP_CONTROL_PLANE_TASK_RE = /\b(?:project\s*map|runtime\s+control\s+plane|control-plane)\b/i
const PROJECT_MAP_READ_ONLY_PLANNING_TASK_RE = /\b(?:read[- ]?only|next[- ]?gap|dogfood|acceptance|inspect|plan|planning|summari[sz]e|status|audit)\b/i
// Task-text classifier regexes moved to src/native/task-contract.ts (Slice-E).
const TASK_NO_CHANGE_NEEDED_RE = /\b(?:no (?:changes?|edits?) (?:needed|required)|nothing to change|already (?:correct|implemented|done|up to date)|no fix required)\b|(?:无需修改|不需要改动|不用改|现有实现已满足)/i

interface ToolAttemptSignature {
  name: string
  category: string
  target: string
  intentTarget: string
  intentKey: string
  signature: string
  isError: boolean
  /**
   * Coarse semantic class of a deterministic failure (e.g. 'missing_param',
   * 'not_found', 'invalid_value', 'validation_error'). Set when a tool
   * returns an error whose CAUSE is the input shape rather than the
   * environment. Used by detectToolLoop to identify rotation patterns —
   * a model dodging the same-signature guard by varying the input is
   * still stuck if every variant produces the same FailureCategory.
   * Tools opt in by returning `metadata.failureCategory: string`.
   */
  failureCategory?: string
}

type RuntimeConvergencePhase =
  | 'exploring'
  | 'targeted_check'
  | 'synthesizing'
  | 'project_map_synthesizing'
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

interface ArtifactRepairRuntimePlan {
  blocks: AnthropicTextBlock[]
  notices: string[]
  blockedSignals: string[]
}

interface FinalAnswerContractResult {
  ok: boolean
  reason: string
  normalizedText?: string
}

type ActiveTaskState = NonNullable<NonNullable<Conversation['options']>['taskState']>

function ensureConversationProjectMap(conversation: Conversation, cwd = process.cwd()): void {
  if (!isProjectMapEnabled()) return

  if (!conversation.options) conversation.options = {}
  // Crash isolation (default-on safety): Project Map is enabled by default, so
  // this runs at the start of EVERY conversation and walks an arbitrary repo's
  // filesystem. The inner helpers are individually defensive, but a single
  // unguarded throw here (a malformed workspace, an fs edge case, a future
  // regression in a snapshot dependency) would otherwise abort the whole
  // conversation loop — see conversation-project-map-resilience.test.ts. Wrap
  // the build so any failure degrades to "no Project Map" (best-effort), never
  // breaking the run. Rollback stays OWLCODA_PROJECT_MAP=0.
  try {
    const wasStale = isProjectMapSnapshotStale(conversation.options.projectMapSnapshot, cwd)
    if (wasStale) {
      conversation.options.projectMapSnapshot = buildProjectMapSnapshot(cwd)
    }
    const snapshot = conversation.options.projectMapSnapshot
    if (snapshot) {
      conversation.options.projectMapPromptSummary = buildProjectMapPromptSummary(snapshot)
      recordProjectMapSnapshotSample(snapshot, wasStale, conversation.id, conversation.turns.length)
    }
  } catch {
    // Degrade silently: keep any previously cached snapshot/summary and let the
    // conversation proceed without a fresh Project Map injection.
  }
}

function projectMapVerificationProfilesForNudge(
  conversation: Conversation,
): ProjectMapVerificationProfile[] | undefined {
  if (!isProjectMapEnabled()) return undefined
  return conversation.options?.projectMapSnapshot?.verificationProfiles
}

function evaluateProjectMapBoundaryBlock(
  conversation: Conversation | undefined,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): {
  boundary: ProjectMapWriteBoundary
  targetPath: string
  targetCount: number
  reason: string
} | null {
  if (!conversation || !isProjectMapEnabled()) return null
  const snapshot = conversation.options?.projectMapSnapshot
  if (!snapshot) return null

  const denyBoundaries = snapshot.writeBoundaries.filter((boundary) => boundary.kind === 'deny')
  if (denyBoundaries.length === 0) return null

  const targets = extractWriteTargets(toolName, input, cwd, { homeDir: homedir() })
  for (const target of targets) {
    for (const boundary of denyBoundaries) {
      if (!projectMapBoundaryMatches(boundary, target.path, snapshot.gitRoot ?? snapshot.cwd)) continue
      return {
        boundary,
        targetPath: target.path,
        targetCount: targets.length,
        reason: [
          '[Project Map boundary]',
          `Blocked ${toolName} from writing ${target.path}.`,
          `Boundary: deny ${boundary.path} (${boundary.scope}, origin=${boundary.origin}).`,
          boundary.reason,
        ].join('\n'),
      }
    }
  }

  return null
}

function projectMapBoundaryMatches(boundary: ProjectMapWriteBoundary, targetPath: string, root: string): boolean {
  const boundaryPath = canonicalizeProjectMapBoundaryPath(pathResolve(root, boundary.path))
  const normalizedTarget = pathNormalize(targetPath)
  const normalizedBoundary = pathNormalize(boundaryPath)
  if (boundary.scope === 'file') return normalizedTarget === normalizedBoundary
  if (boundary.scope === 'directory') {
    return normalizedTarget === normalizedBoundary || normalizedTarget.startsWith(`${normalizedBoundary}/`)
  }
  return globLikePathMatches(normalizedBoundary, normalizedTarget)
}

function globLikePathMatches(pattern: string, targetPath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`).test(targetPath)
}

function canonicalizeProjectMapBoundaryPath(boundaryPath: string): string {
  try {
    return realpathSync(boundaryPath)
  } catch {
    try {
      return pathResolve(realpathSync(pathDirname(boundaryPath)), pathBasename(boundaryPath))
    } catch {
      return boundaryPath
    }
  }
}

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
  onAutoCompact?: (info: {
    before: number
    after: number
    threshold: number
    beforeTokens?: number
    afterTokens?: number
    thresholdTokens?: number
    usageRatio?: number
    reason?: 'threshold' | 'hard_limit' | 'provider_limit' | 'heap_pressure' | 'context_exceeded'
    /** 0.13.98 Batch B: how the compaction was actually performed.
     *  'llm_summary' = bounded LLM-summary path succeeded.
     *  'truncation' = fallback (LLM unavailable / failed validation /
     *  3-strike disabled / heap-pressure path that never tries LLM).
     *  'no_op' = nothing to compact (turn count below recent-keep threshold). */
    method?: 'llm_summary' | 'truncation' | 'no_op'
    /** 0.13.98 Batch B: surfaced when method='truncation' to explain why
     *  LLM compact wasn't used or didn't succeed. */
    fallbackReason?:
      | 'llm_compact_failed'
      | 'llm_compact_disabled_3strikes'
      | 'heap_pressure_skip_llm'
      | 'no_llm_opts'
    /** 0.13.98 Batch B: ms taken by the LLM attempt (when one was made). */
    llmMs?: number
  }) => void
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
  /** Per-request timeout in ms (default 180_000 = 3 minutes).
   *  For streaming turns this only bounds waiting for the local
   *  `/v1/messages` response to start; active stream body lifetime is
   *  governed by the proxy's first-token/idle watchdogs. */
  requestTimeoutMs?: number
  /** Fallback models to try when the primary model is exhausted/overloaded. Requires allowCrossModelFallback. */
  fallbackModels?: string[]
  /** Explicit opt-in for cross-model fallback; interactive REPL keeps this off. */
  allowCrossModelFallback?: boolean
  /** 0.13.98 Batch B: model used by auto-compact's LLM-summary path.
   *  Defaults to conversation.model when undefined. Resolved by REPL
   *  from `middleware.compactionModel`. */
  compactionModel?: string
  /** 0.13.98 Batch B: bounded compactor input cap in tokens (default
   *  8000). Resolved by REPL from `middleware.compactionInputMaxTokens`. */
  compactionInputMaxTokens?: number
  /**
   * Working directory for the task execution state. When provided, this is
   * passed to `ensureTaskExecutionState` as the `cwd` so that write-scope
   * path resolution uses the intended workspace root rather than
   * `process.cwd()`. Required when the workspace lives outside the process
   * working directory (e.g. benchmark smoke runs under /tmp).
   */
  cwd?: string
}

export type ConversationRuntimeFailureKind =
  | 'pre_first_token_stream_close'
  | 'post_token_stream_close'
  | 'timeout'
  | 'abort'
  | 'http_error'
  | 'provider_error'
  | 'empty_provider_response'
  /** 0.13.97: per-chunk idle watchdog fired AFTER first-token already
   *  arrived. Distinct from `post_token_stream_close` — there the upstream
   *  socket actually closed; here it's still nominally open but went silent
   *  past `streamIdleTimeoutMs` / `routerTimeoutMs`. Diagnostic carries
   *  partialOutputSeen=true; recovery guidance suggests sending a follow-up
   *  to continue from where partial output left off rather than full retry. */
  | 'stream_idle_timeout'

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
  let deliveryCheckInjections = 0
  let probeCoverageInjections = 0
  // Slice 4: per-conversation nudge counter for structured task-step nudges.
  const taskStepNudgeCounter = createNudgeCounter()
  const totalUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 }
  const toolAttempts: ToolAttemptSignature[] = []
  const artifactRepairAttempts = new Map<string, number>()
  // 0.13.55: intentKeys we've already issued a soft loop-intercept
  // for in this conversation. Second hit on the same key escalates
  // to hard terminate. Empty Set means we're still in soft mode for
  // every intent.
  const interceptedIntents = new Set<string>()
  // 0.13.62 (B): per-conversation schema-failure counter. Keyed by
  // `${toolName}:${sortedMissingFields.join(',')}`. Second occurrence
  // of the same key triggers hard terminate at the dispatcher level,
  // before either tool execution or loop-guard dedupe runs.
  const schemaFailCounts = new Map<string, number>()
  // 0.13.63 (D): rolling window of assistant text-output sizes (in
  // chars) for the most recent iterations. When the last 3 in a row
  // each exceed OUTPUT_BLOAT_CHARS, fire `[Runtime output-bloat check]`
  // ONCE per session.
  const recentOutputSizes: number[] = []
  let outputBloatNudgeFired = false
  // 0.13.64: counter for consecutive max_tokens stop_reasons. Reset
  // whenever a non-max_tokens response comes through. When the model
  // hits the per-response output cap, inject a continuation nudge
  // that tells it to resume rather than restart, AND escalates the
  // wording when ≥2 consecutive truncations happen (in which case
  // re-rendering inline is just going to cap out again).
  let maxTokensContinuationInjectCount = 0
  let consecutiveMaxTokensTruncations = 0
  // 0.14.54: counter for consecutive identical text-only replies. This is a
  // true identity loop signal; it does not care whether a write has happened.
  let narrationLoopCount = 0
  let lastNarrationLoopText: string | null = null
  const convergence = createConvergenceRuntimeState()
  const taskState = ensureTaskExecutionState(conversation, opts.cwd)
  ensureConversationProjectMap(conversation, opts.cwd)

  const taskContractNotice = describeTaskExecutionState(taskState)
  if (taskContractNotice) {
    opts.callbacks?.onNotice?.(taskContractNotice)
  }

  /**
   * Synthesize tool_result blocks for every tool_use block in the last
   * assistant turn that has no matching result in `executedResults`.
   * Returns the list of synthetic fillers (may be empty).
   *
   * Called on any break path that exits the loop AFTER the assistant turn
   * was pushed but BEFORE a user-turn with tool_results was pushed. Without
   * this closure the assistant turn is an orphan: sanitizeConversationTurns
   * strips it on the next request, and the model re-executes the whole batch
   * against the original (untouched) user prompt.
   */
  function closePendingToolUse(
    executedResults: ToolExecutionResult[],
    allToolUseBlocks: AnthropicToolUseBlock[],
    reason: string,
  ): void {
    if (allToolUseBlocks.length === 0) return
    const completedIds = new Set(executedResults.map((r) => r.toolUseId))
    const fillers: ToolExecutionResult[] = []
    for (const block of allToolUseBlocks) {
      if (completedIds.has(block.id)) continue
      fillers.push({
        toolUseId: block.id,
        toolName: block.name,
        result: {
          output: `[loop-guard] ${reason}`,
          isError: true,
          metadata: { loopGuardClosed: true, loopReason: reason },
        },
        durationMs: 0,
      })
    }
    const allResults = [...executedResults, ...fillers]
    if (allResults.length === 0) return
    const resultBlocks = dispatcher.toContentBlocks(allResults)
    const truncated = truncateToolResultBlocks(resultBlocks, TOOL_OUTPUT_MAX_CHARS)
    conversation.turns.push({
      role: 'user',
      content: truncated,
      timestamp: Date.now(),
    })
  }

  while (iterations < maxIterations) {
    // Check for cancellation between iterations
    if (opts.signal?.aborted) break
    iterations++
    markTaskIteration(taskState, {
      iterations,
      currentFocus: convergence.lastGap ?? convergence.dominantHypothesis,
      dominantGap: convergence.lastGap,
    })

    // Slice 2: consume pending edit_now nudge before any model request.
    // The nudge is set by the abandoned-grant predicate after a granted risky
    // action exceeds its evidence budget. Inject it as a runtime user turn and
    // immediately continue so the model sees the nudge on the next request.
    if (isGateV2Enabled() && taskState.run.editNowNudgePending) {
      const pending = taskState.run.editNowNudgePending
      addUserMessage(conversation, buildEditNowNudgePrompt(pending))
      recordRuntimeNudgePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'edit_now')
      const nudgedList = taskState.run.editNowNudgedGrantTs ?? []
      if (!nudgedList.includes(pending.grantTs)) {
        nudgedList.push(pending.grantTs)
      }
      taskState.run.editNowNudgedGrantTs = nudgedList
      delete taskState.run.editNowNudgePending
      recordGateEvent({
        ts: Date.now(),
        kind: 'edit_now_nudge_injected',
        conversationId: conversation.id,
        iteration: taskState.run.lifetimeIterations ?? 0,
        contract: buildGateEventContract(taskState),
        lastToolSignatures: lastNToolSignatures(toolAttempts),
        offendingTool: pending.tool,
        itersSinceGrant: pending.itersSinceGrant,
      })
      continue
    }

    // 0.13.70 execution_economics_v1 — production_gate_v1.
    // Earlier, softer counterpart to 0.13.68's hard-stop. Fires once
    // per task when the model has done genuine investigation
    // (>=PRODUCTION_GATE_ITER_THRESHOLD lifetime iter,
    // >=PRODUCTION_GATE_DISTINCT_FILES distinct file reads) but
    // hasn't produced a deliverable. Injects an advisory user-turn
    // pushing the model from "find information" to "produce." Does
    // NOT break the loop; the 0.13.68 hard-stop below still owns
    // the genuinely-stuck case.
    //
    // Slice 0 (0.14.18+): gate now checks Deliverable Contract v1.
    // Only fires for durable artifact modes (code_change / file_artifact_delivery)
    // with high confidence. read_only_review / text_deliverable / mixed_unknown
    // tasks are NOT gated — they can read many files without producing writes.
    {
      const deliverable = getDeliverableContract(taskState)
      if (
        !taskState.run.productionGateFired
        && taskState.run.status === 'open'
        && shouldHardStopOnNoTouchedPaths(deliverable)
        && taskState.contract.touchedPaths.length === 0
        && (taskState.run.lifetimeIterations ?? 0) >= PRODUCTION_GATE_ITER_THRESHOLD
      ) {
        const { distinctFiles } = getReadLedgerStats(taskState)
        if (distinctFiles >= PRODUCTION_GATE_DISTINCT_FILES) {
          const taskWriteScope = selectTrustedTaskWriteScope(taskState)
          conversation.turns.push({
            role: 'user',
            content: [{
              type: 'text',
              text: buildProductionGatePrompt({
                distinctFilesRead: distinctFiles,
                lifetimeIterations: taskState.run.lifetimeIterations ?? 0,
                taskWriteScope,
              }),
            }],
            timestamp: Date.now(),
          })
          taskState.run.productionGateFired = true
          opts.callbacks?.onNotice?.(
            `Production gate: ${distinctFiles} distinct files read across ` +
            `${taskState.run.lifetimeIterations} iterations under a durable-artifact task ` +
            `(${deliverable.mode}/${deliverable.confidence}) with 0 deliverables — nudging the model to switch to producing.`,
          )
          recordRuntimeNudgePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'production_gate')
          recordGateEvent({
            ts: Date.now(),
            kind: 'production_gate',
            conversationId: conversation.id,
            iteration: taskState.run.lifetimeIterations ?? 0,
            contract: buildGateEventContract(taskState),
            lastToolSignatures: lastNToolSignatures(toolAttempts),
            deliverableMode: deliverable.mode,
            deliverableConfidence: deliverable.confidence,
            requiresDurableArtifact: deliverable.requiresDurableArtifact,
            allowsChatFinal: deliverable.allowsChatFinal,
            hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
            deliverableReasons: deliverable.reasons,
            ...(deliverable.mode === 'mixed_unknown' ? {
              matchedModes: deliverable.matchedModes,
              signalSummary: deliverable.signalSummary,
            } : {}),
          })
        }
      }
    }

    // 0.13.67 task-no-progress hard ceiling. Runs at top of each
    // iteration so timeout/runtime-failure iterations still tick the
    // counter (unlike 0.13.66's narration detector, which only fires
    // on completed assistant turns and missed the 2026-05-07 case
    // where iter 9 timed out mid-stream after 8 successful tool_use
    // iterations).
    //
    // Uses `taskState.run.lifetimeIterations` (monotonic across
    // runtime auto-retries) rather than the closure-local
    // `iterations` (resets to 1 on every retry). The first 0.13.67
    // shipped with closure-`iterations` and was blind to the same
    // dogfood it was meant to fix — the model burned 11 iterations
    // in `taskState.run`, but `runConversationLoop` saw a fresh 1, 2,
    // 3 each retry and never tripped the > 8 guard.
    //
    // 0.14.18 fail-open: hard-stop is gated on contract.confidence.
    // confidence='high' → hard stop as before (user gave explicit
    // ALLOW scope or ≥2 absolute explicit paths, so we have reliable
    // signal that 0 touched paths means genuine no-progress).
    // confidence='medium'|'low' → skip hard-stop, record telemetry,
    // continue. Parser produced "self-confident but potentially wrong"
    // scope from a handoff/description-only prompt; hard-stopping on
    // that wrong scope violates fail-open principle.
    //
    // Slice 0 (Deliverable Contract v1, 0.14.18+): the hard-stop decision
    // is now driven by shouldHardStopOnNoTouchedPaths(deliverable), which
    // returns true only for high-confidence durable artifact modes
    // (code_change / file_artifact_delivery). read_only_review / text_deliverable
    // / mixed_unknown tasks are fail-open regardless of scope confidence.
    // Note: contract.confidence (path/write-scope) and deliverable.confidence
    // (mode-classification) are ORTHOGONAL — both are recorded in telemetry.
    {
      const deliverable = getDeliverableContract(taskState)
      const scopeConfidence = taskState.contract.confidence ?? 'medium'
      const deliverableHardStop = shouldHardStopOnNoTouchedPaths(deliverable)
      const trustedWriteTarget = hasTrustedDurableWriteTarget(taskState)
      const readStats = getReadLedgerStats(taskState)
      const distinctReadInvestigation = readStats.distinctFiles >= PRODUCTION_GATE_DISTINCT_FILES
      const operatingMode = conversation.options?.operatingModeState?.mode ?? 'normal'
      const planModeSuppressesExecutionPressure = operatingMode === 'plan'
      const gateV2 = isGateV2Enabled()
      const phaseRuntime = isPhaseRuntimeEnabled()
      const noProgressHardStopEnabled = isTaskNoProgressHardStopEnabled()
      if (
        (taskState.run.lifetimeIterations ?? 0) > TASK_NO_PROGRESS_ITER_LIMIT
        && taskState.run.status === 'open'
        && taskState.contract.touchedPaths.length === 0
        && !hasRecentArtifactProgress(taskState, ARTIFACT_PROGRESS_REPAIR_ITER_WINDOW)
      ) {
        const oldHardStop = deliverableHardStop && trustedWriteTarget
          && !distinctReadInvestigation
          && !planModeSuppressesExecutionPressure
        const v2Decision = shouldHardStopOnAbandonedGrant(taskState)
        // GATE_V2 replaces the progress predicate, not the outer task
        // eligibility. Durable-contract eligibility still prevents command
        // jobs and diagnostic bash chains from being treated as abandoned
        // file/code delivery attempts.
        const newHardStop = oldHardStop && v2Decision.fire
        const phaseVerdict = deriveTurnPhase(taskState)
        const phaseDecision = shouldInterveneForNoProgress({
          oldHardStop,
          phaseVerdict,
          abandonedGrantDecision: v2Decision,
        })
        const phaseGateVerdict = phaseDecision.fire
        recordGateEvent({
          ts: Date.now(),
          kind: 'phase_derived',
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? 0,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          reason: `phase=${phaseVerdict.phase}/${phaseVerdict.confidence}: ${phaseVerdict.reasonCodes.join(',')}`,
          deliverableMode: deliverable.mode,
          deliverableConfidence: deliverable.confidence,
          requiresDurableArtifact: deliverable.requiresDurableArtifact,
          allowsChatFinal: deliverable.allowsChatFinal,
          hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
          deliverableReasons: deliverable.reasons,
          phase: phaseVerdict.phase,
          phaseConfidence: phaseVerdict.confidence,
          phaseReasons: phaseVerdict.reasonCodes,
          phaseEvidenceCount: phaseVerdict.evidenceCount,
          pendingRiskyGrantCount: phaseVerdict.pendingRiskyGrantCount,
          oldGateVerdict: oldHardStop,
          phaseGateVerdict,
          phaseGateReason: phaseDecision.reason,
          phaseRuntimeEnabled: phaseRuntime,
          operatingMode,
        })
        // Record the old-vs-new predicate comparison every iteration. Both
        // halves matter: emitting only disagreement made the GATE_V2 cutover
        // criterion read 100% disagreement (a measurement artifact). Agreement
        // is the common case, at the same cadence as the phase_derived event
        // above it.
        recordGateEvent(buildPredicateComparisonEvent(oldHardStop, newHardStop, {
          ts: Date.now(),
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? 0,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          deliverableMode: deliverable.mode,
          deliverableConfidence: deliverable.confidence,
          requiresDurableArtifact: deliverable.requiresDurableArtifact,
          allowsChatFinal: deliverable.allowsChatFinal,
          hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
          deliverableReasons: deliverable.reasons,
        }))
        if (oldHardStop && (gateV2 || phaseRuntime) && (gateV2 ? v2Decision.nudge : phaseDecision.nudge)) {
          taskState.run.editNowNudgePending = gateV2 ? v2Decision.nudge : phaseDecision.nudge
        }
        const wouldHaveHardStopped = phaseRuntime ? phaseDecision.fire : gateV2 ? newHardStop : oldHardStop
        const activeHardStop = noProgressHardStopEnabled && wouldHaveHardStopped
        if (activeHardStop) {
          // Deliverable Contract v1: shouldHardStopOnNoTouchedPaths already encodes
          // mode + confidence gating (only true for code_change/high and
          // file_artifact_delivery/high). scope confidence (path/write scope) is recorded
          // in telemetry but does NOT block this gate — it is orthogonal.
          const legacyNoProgressReason =
            `task no-progress hard stop: ${taskState.run.lifetimeIterations} iterations elapsed ` +
            `under a write-requiring task contract (${deliverable.mode}/${deliverable.confidence}) ` +
            `with 0 touched paths.\n` +
            `Why: this task was classified as one that should change files, but nothing has been ` +
            `written or edited yet. Reads, searches and task-tracker calls (TaskCreate/TaskUpdate/` +
            `TaskList) do NOT count as deliverable progress; distinct-file read investigation is ` +
            `handled by the softer production gate, while repeated or zero-signal reading can still ` +
            `exhaust this budget before the first edit. The ` +
            `guard stops the loop so a model can't keep spinning without producing changes.\n` +
            `What to do:\n` +
            `  • If the model is stuck: /retry, /model to switch models, or re-send a prompt naming the ` +
            `exact file path(s) to change.\n` +
            `  • If this task legitimately needs more turns before the first edit (deep code search, many ` +
            `task steps): raise the budget with OWLCODA_TASK_NO_PROGRESS_ITER_LIMIT=20 (or higher) — the ` +
            `guard stays on, it just allows more turns before requiring the first write.`
          const reason = phaseRuntime
            ? phaseVerdict.phase === 'execute' && v2Decision.fire
              ? v2Decision.reason ?? 'task no-progress hard stop: granted risky tool produced no post-grant evidence.'
              : `${legacyNoProgressReason} Phase runtime: ${phaseDecision.reason}.`
            : gateV2
            ? v2Decision.reason ?? 'task no-progress hard stop: granted risky tool produced no post-grant evidence.'
            : legacyNoProgressReason
          opts.callbacks?.onError?.(reason)
          markTaskGuardBlocked(taskState, reason)
          const hardStopKind = (gateV2 && newHardStop)
            || (phaseRuntime && phaseVerdict.phase === 'execute' && v2Decision.fire)
            ? 'abandoned_grant_hard_stop'
            : 'task_no_progress_hard'
          recordGateEvent({
            ts: Date.now(),
            kind: hardStopKind,
            conversationId: conversation.id,
            iteration: taskState.run.lifetimeIterations ?? 0,
            contract: buildGateEventContract(taskState),
            lastToolSignatures: lastNToolSignatures(toolAttempts),
            reason,
            deliverableMode: deliverable.mode,
            deliverableConfidence: deliverable.confidence,
            requiresDurableArtifact: deliverable.requiresDurableArtifact,
            allowsChatFinal: deliverable.allowsChatFinal,
            hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
            deliverableReasons: deliverable.reasons,
            wouldHaveHardStopped,
            hardStopEnabled: noProgressHardStopEnabled,
            operatingMode,
          })
          lastStopReason = 'task_no_progress'
          // Clear the monotonic no-progress budget now that we are stopping the
          // task. lifetimeIterations is shared across user turns within one
          // ActiveTaskState (it deliberately survives in-turn auto-retries —
          // 0.13.67). Leaving it at >8 means the NEXT user turn (e.g. "why did
          // you stop?") inherits the count and re-fires this guard within 1-2
          // iterations, making the task impossible to follow up on. This stop
          // sets no runtimeFailure, so shouldScheduleRuntimeAutoRetry returns
          // false — clearing the budget here only ever grants a fresh allowance
          // to a later user-driven turn, never an automatic re-entry. No
          // post-loop code reads lifetimeIterations on the task_no_progress path.
          taskState.run.lifetimeIterations = 0
          break
        } else {
          // fail-open: deliverable mode allows chat final (read_only, text_deliv, command_job,
          // mixed_unknown) OR deliverable confidence is not high (medium file artifact).
          const suppressReason = gateV2
            ? oldHardStop && v2Decision.nudge
              ? `GATE_V2 edit_now nudge pending for ${v2Decision.nudge.tool}`
              : 'GATE_V2 durable eligibility or granted-risk predicate suppressed hard-stop'
            : phaseRuntime
            ? phaseDecision.reason
            : !noProgressHardStopEnabled && wouldHaveHardStopped
              ? 'default advisory mode: legacy no-progress hard-stop would have fired; identity loop and iteration/cost budgets own hard termination'
            : planModeSuppressesExecutionPressure
              ? 'operating mode=plan suppresses execution-pressure hard-stop'
            : distinctReadInvestigation
              ? `${readStats.distinctFiles} distinct read-ledger files indicate active investigation; production gate owns the produce-now nudge`
            : !deliverableHardStop
              ? `deliverable mode ${deliverable.mode}/${deliverable.confidence} does not require durable artifact`
              : `scope confidence=${scopeConfidence}, trustedWriteTarget=${trustedWriteTarget}: suppressed hard-stop`
          // One-shot per task: fire the advisory + its shadow telemetry once,
          // when the task first crosses the no-progress threshold — not on every
          // subsequent iteration. After demotion this is the default path, so a
          // long read-heavy investigation must not be nagged ~N times, and the
          // would-have-fired cutover signal must count tasks, not iterations.
          // The flag lives on run state → re-arms naturally per task; within a
          // task it stays fired across turns (no re-nag on follow-ups).
          if (!taskState.run.noProgressAdvisoryFired) {
            opts.callbacks?.onNotice?.(
              `task no-progress suppressed (${suppressReason}): ` +
              `${taskState.run.lifetimeIterations} iterations / 0 touched paths. ` +
              `No-progress is advisory by default; identity-loop and budget guards own hard stops.`,
            )
            recordGateEvent({
              ts: Date.now(),
              kind: 'task_no_progress_suppressed',
              conversationId: conversation.id,
              iteration: taskState.run.lifetimeIterations ?? 0,
              contract: buildGateEventContract(taskState),
              lastToolSignatures: lastNToolSignatures(toolAttempts),
              reason: `${suppressReason} at ${taskState.run.lifetimeIterations} iterations`,
              deliverableMode: deliverable.mode,
              deliverableConfidence: deliverable.confidence,
              requiresDurableArtifact: deliverable.requiresDurableArtifact,
              allowsChatFinal: deliverable.allowsChatFinal,
              hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
              deliverableReasons: deliverable.reasons,
              wouldHaveHardStopped,
              hardStopEnabled: noProgressHardStopEnabled,
              operatingMode,
              ...(deliverable.mode === 'mixed_unknown' ? {
                matchedModes: deliverable.matchedModes,
                signalSummary: deliverable.signalSummary,
              } : {}),
            })
            taskState.run.noProgressAdvisoryFired = true
          }
        }
      }
    }

    // 0.13.62 heap-pressure emergency compact (A). Runs BEFORE the
    // token-window compact: the host-process heap can exhaust well
    // before any model context window does. When `heapUsed` crosses
    // 75% of `heap_size_limit`, drop to last 20% of turns. This is
    // OOM defense, not token-budget management.
    const heapRatio = getHeapPressureRatio()
    const heapResult = emergencyHeapCompact(conversation, heapRatio)
    if (heapResult) {
      opts.callbacks?.onNotice?.(
        `Heap pressure compaction: heap ${(heapRatio * 100).toFixed(0)}% used, ` +
        `compacted ${heapResult.before} → ${heapResult.after} turns to prevent OOM.`,
      )
      if (opts.callbacks?.onAutoCompact) {
        opts.callbacks.onAutoCompact({
          before: heapResult.before,
          after: heapResult.after,
          threshold: opts.contextWindow ?? 0,
          beforeTokens: 0,
          afterTokens: 0,
          thresholdTokens: 0,
          usageRatio: heapRatio,
          reason: 'heap_pressure',
        })
      }
    }

    // Auto-compact: if context exceeds threshold, trim older turns.
    // 0.13.98 Batch B: routes through tryCompact which attempts a bounded
    // LLM summary first and falls back to truncation. ONE attempt per
    // trigger — failure does NOT retry, does NOT throw, does NOT pollute
    // transcript (only onAutoCompact callback). Heap-pressure path above
    // (still synchronous truncation) is intentionally not routed here.
    const beforeCompact = conversation.turns.length
    const compactDecision = getAutoCompactDecision(conversation, opts.contextWindow)
    let compacted = false
    if (compactDecision.shouldCompact) {
      // Microcompact shadow (opt-in OWLCODA_MICROCOMPACT_SHADOW, default off):
      // measure the superseded-read strip opportunity at the moment of
      // compaction. Behavior-neutral — it never strips.
      recordMicrocompactShadow(conversation.turns)
      const result = await tryCompact(conversation, {
        reason: 'threshold',
        apiBaseUrl: opts.apiBaseUrl,
        apiKey: opts.apiKey,
        compactionModel: opts.compactionModel,
        inputMaxTokens: opts.compactionInputMaxTokens,
        truncationKeepCount: compactDecision.keepCount,
        fidelityTelemetry: {
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? iterations,
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          model: opts.compactionModel ?? conversation.model,
        },
      })
      compacted = result.method !== 'no_op' && result.before !== result.after
      if (compacted && opts.callbacks?.onAutoCompact) {
        opts.callbacks.onAutoCompact({
          before: result.before,
          after: result.after,
          threshold: opts.contextWindow ?? 0,
          beforeTokens: compactDecision.totalTokens,
          afterTokens: result.afterTokens,
          thresholdTokens: compactDecision.thresholdTokens,
          usageRatio: compactDecision.usageRatio,
          reason: 'threshold',
          method: result.method,
          fallbackReason: result.fallbackReason,
          llmMs: result.llmMs,
        })
      }
      if (compacted) {
        const methodLabel = result.method === 'llm_summary' ? 'LLM summary' : 'truncation'
        opts.callbacks?.onNotice?.(
          `Context compacted (${methodLabel}): ${formatTokenCount(compactDecision.totalTokens)} -> ${formatTokenCount(result.afterTokens)}; kept ${conversation.turns.length}/${beforeCompact} turns (threshold ${formatTokenCount(compactDecision.thresholdTokens)}).`,
        )
      }
    }

    // 0.13.58 context-pressure nudges. When usage crosses a threshold
    // we haven't fired for yet AND we didn't just compact (compaction
    // already lowered the ratio), inject a [Runtime context-pressure
    // check] so the model adopts terse, evidence-led replies before
    // recall starts to fail. Two thresholds: 0.6 (soft) and 0.85
    // (strict). Each fires once per session per threshold; the fired
    // set is persisted on conversation.options for resumed sessions.
    if (!compacted && opts.contextWindow && opts.contextWindow > 0) {
      const usageRatio = compactDecision.usageRatio
      if (!conversation.options) conversation.options = {}
      const fired = new Set(conversation.options.contextPressureNudgesFired ?? [])
      // Sorted ascending; we fire the highest-applicable threshold so
      // a fresh resumed session jumping from 0% to 90% only fires
      // once (the strict one), not twice.
      const thresholds = [0.6, 0.85] as const
      let fireThreshold: number | null = null
      for (const t of thresholds) {
        if (usageRatio >= t && !fired.has(t)) fireThreshold = t
      }
      if (fireThreshold !== null) {
        const totalTokens = compactDecision.totalTokens
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildContextPressurePrompt(fireThreshold, usageRatio, totalTokens, opts.contextWindow),
          }],
          timestamp: Date.now(),
        })
        fired.add(fireThreshold)
        // Mark all thresholds <= the one we fired as also fired —
        // crossing 0.85 implies 0.6 was crossed too; no need to fire
        // soft mode after strict.
        for (const t of thresholds) if (t <= fireThreshold) fired.add(t)
        conversation.options.contextPressureNudgesFired = [...fired].sort()
        opts.callbacks?.onNotice?.(
          `Context pressure (${(fireThreshold * 100).toFixed(0)}%): nudging the model toward ` +
          `terse, evidence-led replies (now ${(usageRatio * 100).toFixed(0)}% of ${formatTokenCount(opts.contextWindow)}).`,
        )
      }
    }

    // 1. Build request with hard budget gate
    let turnPlan = buildTurnRequestPlan(conversation, convergence, taskState)
    let request = turnPlan.request
    const requestTokens = estimateTokens(JSON.stringify(request))
    const hardLimit = opts.contextWindow ?? 0

    // Hard gate: if request exceeds model context window, aggressively compact.
    // 0.13.98 Batch B: first attempt is bounded LLM summary via tryCompact;
    // if still oversized after that ONE attempt, fall back to the original
    // iterative-truncation loop (4 more attempts at progressively-smaller
    // keep ratios). One LLM attempt total — not per iteration.
    if (hardLimit > 0 && requestTokens > hardLimit) {
      // Step 1 (new): one LLM-summary attempt.
      if (conversation.turns.length > 2) {
        const beforeTurns = conversation.turns.length
        const llmResult = await tryCompact(conversation, {
          reason: 'hard_limit',
          apiBaseUrl: opts.apiBaseUrl,
          apiKey: opts.apiKey,
          compactionModel: opts.compactionModel,
          inputMaxTokens: opts.compactionInputMaxTokens,
          truncationKeepCount: Math.max(2, Math.floor(conversation.turns.length * 0.4)),
          fidelityTelemetry: {
            conversationId: conversation.id,
            iteration: taskState.run.lifetimeIterations ?? iterations,
            lastToolSignatures: lastNToolSignatures(toolAttempts),
            model: opts.compactionModel ?? conversation.model,
          },
        })
        turnPlan = buildTurnRequestPlan(conversation, convergence, taskState)
        request = turnPlan.request
        if (llmResult.method !== 'no_op' && llmResult.before !== llmResult.after) {
          opts.callbacks?.onAutoCompact?.({
            before: beforeTurns,
            after: conversation.turns.length,
            threshold: hardLimit,
            beforeTokens: requestTokens,
            afterTokens: estimateTokens(JSON.stringify(request)),
            thresholdTokens: hardLimit,
            usageRatio: hardLimit > 0 ? requestTokens / hardLimit : 0,
            reason: 'hard_limit',
            method: llmResult.method,
            fallbackReason: llmResult.fallbackReason,
            llmMs: llmResult.llmMs,
          })
        }
      }

      // Step 2: if still oversized, fall back to iterative truncation (existing).
      let compactAttempts = 0
      while (estimateTokens(JSON.stringify(request)) > hardLimit && compactAttempts < 5) {
        compactAttempts++
        if (conversation.turns.length <= 2) break
        const beforeTurns = conversation.turns.length
        const keepRatio = Math.max(0.2, 1 - (compactAttempts * 0.2))
        conversation.turns = sanitizeConversationTurns(
          conversation.turns.slice(-Math.max(2, Math.floor(conversation.turns.length * keepRatio))),
        )
        turnPlan = buildTurnRequestPlan(conversation, convergence, taskState)
        request = turnPlan.request
        const newTokens = estimateTokens(JSON.stringify(request))
        opts.callbacks?.onAutoCompact?.({
          before: beforeTurns,
          after: conversation.turns.length,
          threshold: hardLimit,
          beforeTokens: requestTokens,
          afterTokens: newTokens,
          thresholdTokens: hardLimit,
          usageRatio: hardLimit > 0 ? requestTokens / hardLimit : 0,
          reason: 'hard_limit',
          method: 'truncation',
          fallbackReason: 'llm_compact_failed',
        })
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
          // Mark the hard stop — otherwise lastStopReason keeps its previous value
          // (typically 'tool_use'), which headless reports as a silent exit-0 success.
          convergence.phase = 'hard_stop'
          lastStopReason = 'hard_stop'
        }
        break // do NOT send — break out of the conversation loop
      }
      opts.callbacks?.onNotice?.(`Context compacted: ${formatTokenCount(requestTokens)} exceeded ${formatTokenCount(hardLimit)} context window; kept ${conversation.turns.length} turns, continuing.`)
    }

    let response: AssistantResponse

    try {
      response = await sendRequest(request, opts)
    } catch (err: unknown) {
      if (opts.signal?.aborted) break
      const msg = err instanceof Error ? err.message : String(err)

      // Context window exceeded (error code 2013 or similar) — auto-compact and retry.
      // 0.13.98 Batch B: ONE LLM-summary attempt via tryCompact, then fall
      // back to truncation if still over. Same one-shot semantics as the
      // hard_limit path above.
      if (isContextLimitError(msg) && conversation.turns.length > 2) {
        const beforeTurns = conversation.turns.length
        const beforeTokens = estimateTokens(JSON.stringify(request))
        const compactResult = await tryCompact(conversation, {
          reason: 'context_exceeded',
          apiBaseUrl: opts.apiBaseUrl,
          apiKey: opts.apiKey,
          compactionModel: opts.compactionModel,
          inputMaxTokens: opts.compactionInputMaxTokens,
          truncationKeepCount: Math.max(2, Math.floor(conversation.turns.length * 0.5)),
          fidelityTelemetry: {
            conversationId: conversation.id,
            iteration: taskState.run.lifetimeIterations ?? iterations,
            lastToolSignatures: lastNToolSignatures(toolAttempts),
            model: opts.compactionModel ?? conversation.model,
          },
        })
        const afterTokens = estimateTokens(JSON.stringify(buildRequest(conversation, true)))
        opts.callbacks?.onAutoCompact?.({
          before: beforeTurns,
          after: conversation.turns.length,
          threshold: opts.contextWindow ?? 0,
          beforeTokens,
          afterTokens,
          thresholdTokens: opts.contextWindow ?? 0,
          usageRatio: opts.contextWindow && opts.contextWindow > 0 ? beforeTokens / opts.contextWindow : 0,
          reason: 'context_exceeded',
          method: compactResult.method,
          fallbackReason: compactResult.fallbackReason,
          llmMs: compactResult.llmMs,
        })
        const methodLabel = compactResult.method === 'llm_summary' ? 'LLM summary' : 'truncation'
        opts.callbacks?.onNotice?.(`Context limit hit — compacted via ${methodLabel}: ${beforeTurns} → ${conversation.turns.length} turns, retrying.`)
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
      // Undo the iteration count for this non-producing turn. markTaskIteration
      // ran at the top of the while loop before we knew the request would fail.
      // API errors produce no model output; counting them as "producing
      // iterations" causes task-no-progress to fire prematurely when the model
      // is just rate-limited, not stuck.
      if (taskState.run.lifetimeIterations && taskState.run.lifetimeIterations > 0) {
        taskState.run.lifetimeIterations -= 1
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
        recordClaimFidelityTelemetry(settled.response.text, conversation, {
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? iterations,
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          model: conversation.model,
          phase: 'synthesis',
        })
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
          const loopReason = `Model ignored the summary gate ${summaryGateViolations} times in a row. Stopping to avoid a tool loop. Press Ctrl+C earlier if you want to intervene.`
          opts.callbacks?.onError?.(loopReason)
          recordGateEvent({
            ts: Date.now(),
            kind: 'tool_loop',
            conversationId: conversation.id,
            iteration: taskState.run.lifetimeIterations ?? 0,
            contract: buildGateEventContract(taskState),
            lastToolSignatures: lastNToolSignatures(toolAttempts),
            reason: loopReason,
          })
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
    if (!effectiveResponse.hasToolUse && effectiveResponse.text.trim()) {
      recordClaimFidelityTelemetry(effectiveResponse.text, conversation, {
        conversationId: conversation.id,
        iteration: taskState.run.lifetimeIterations ?? iterations,
        lastToolSignatures: lastNToolSignatures(toolAttempts),
        model: conversation.model,
        phase: 'assistant',
      })
    }
    conversation.turns.push({
      role: 'assistant',
      content: assistantContent,
      timestamp: Date.now(),
    })
    recordAssistantTextPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, effectiveResponse.text)

    // 0.13.63 (D): output-bloat tracking. Push current iteration's
    // assistant text size into rolling window; when the last
    // OUTPUT_BLOAT_WINDOW entries are all over OUTPUT_BLOAT_CHARS,
    // and we haven't already fired the nudge this session, inject
    // `[Runtime output-bloat check]` as a user-role message. The
    // model sees it on its next turn.
    {
      const outSize = effectiveResponse.text.length
      recentOutputSizes.push(outSize)
      if (recentOutputSizes.length > OUTPUT_BLOAT_WINDOW) {
        recentOutputSizes.splice(0, recentOutputSizes.length - OUTPUT_BLOAT_WINDOW)
      }
      if (
        !outputBloatNudgeFired
        && recentOutputSizes.length >= OUTPUT_BLOAT_WINDOW
        && recentOutputSizes.every((n) => n >= OUTPUT_BLOAT_CHARS)
      ) {
        outputBloatNudgeFired = true
        const avgChars = Math.floor(
          recentOutputSizes.reduce((s, n) => s + n, 0) / recentOutputSizes.length,
        )
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildOutputBloatPrompt(OUTPUT_BLOAT_WINDOW, avgChars),
          }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(
          `Output bloat (${OUTPUT_BLOAT_WINDOW}× ≥${(OUTPUT_BLOAT_CHARS / 1000).toFixed(0)}K chars): ` +
          `nudging the model to stop re-dumping inline content and emit a tool call or specific question.`,
        )
      }
    }

    // 0.13.64: max-tokens continuation. When the assistant response
    // hit the per-response output cap, the response is partial — the
    // model wanted to keep writing. Inject a `[Runtime max-tokens
    // continuation]` nudge so the model knows to resume from where
    // it left off (and switches to file-based delivery if the
    // pattern is recurring), then `continue` the loop so the model
    // gets another turn to actually do that. Without the explicit
    // continue, the loop's `!hasToolUse` branch below would treat
    // max_tokens as a normal end-of-turn and exit. Reset counters
    // on any non-max_tokens stop reason.
    let maxTokensInjected = false
    if (effectiveResponse.stopReason === 'max_tokens') {
      consecutiveMaxTokensTruncations += 1
      if (maxTokensContinuationInjectCount < MAX_TOKENS_CONTINUATION_LIMIT) {
        maxTokensContinuationInjectCount += 1
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildMaxTokensContinuationPrompt(
              effectiveResponse.text,
              consecutiveMaxTokensTruncations,
            ),
          }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(
          `Max-tokens continuation (${consecutiveMaxTokensTruncations}× truncated, inject ` +
          `${maxTokensContinuationInjectCount}/${MAX_TOKENS_CONTINUATION_LIMIT}): ` +
          `nudging the model to resume from the cut-off point or switch to file-based delivery.`,
        )
        maxTokensInjected = true
      }
    } else {
      // Reset on any non-max_tokens stop reason (end_turn, tool_use,
      // etc) — the chain is broken so future truncations get fresh
      // injects.
      consecutiveMaxTokensTruncations = 0
      maxTokensContinuationInjectCount = 0
    }

    if (maxTokensInjected) {
      // Skip the rest of this iteration's terminal-checks (delivery
      // check, probe coverage, no-tool-use exit) — the inject is in
      // the conversation, the model needs another turn to act on it.
      continue
    }

    // 0.14.54: narration-loop detector is identity-based. It hard-stops only
    // when the model repeats the same normalized text-only reply. Different
    // investigation/status replies are allowed to continue; no-write is not
    // treated as proof of a loop.
    const normalizedNarrationText = !effectiveResponse.hasToolUse
      ? normalizeWhitespace(effectiveResponse.text)
      : ''
    if (normalizedNarrationText) {
      if (lastNarrationLoopText === normalizedNarrationText) {
        narrationLoopCount += 1
      } else {
        lastNarrationLoopText = normalizedNarrationText
        narrationLoopCount = 1
      }
    } else {
      lastNarrationLoopText = null
      narrationLoopCount = 0
    }
    if (narrationLoopCount >= NARRATION_LOOP_LIMIT) {
      const reason =
        `task stuck in narration loop: assistant repeated the same text-only reply ` +
        `${narrationLoopCount} consecutive times without using tools. Use /retry, /model to switch, ` +
        `or send a more specific prompt.`
      opts.callbacks?.onError?.(reason)
      markTaskGuardBlocked(taskState, reason)
      lastStopReason = 'narration_loop'
      break
    }

    // Within-reply output-repetition degeneration guard. Complements the
    // cross-turn narration-loop guard above: that one needs the SAME whole
    // reply across turns; this catches ONE reply that internally spams a line
    // or cycles a few lines dozens of times (the 0.14.59 kimi-code dogfood).
    // decideOutputRepetition only runs detection when a flag opts in, so the
    // default (no flag) path is byte-identical to today.
    const repetitionDecision = decideOutputRepetition(effectiveResponse.text)
    if (repetitionDecision.action !== 'none') {
      recordTelemetryEnvelope(buildOutputRepetitionEvent(repetitionDecision.verdict))
      if (repetitionDecision.action === 'guard') {
        opts.callbacks?.onError?.(repetitionDecision.reason)
        markTaskGuardBlocked(taskState, repetitionDecision.reason)
        lastStopReason = 'output_repetition'
        break
      }
    }

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
      const phaseRuntimeNoTool = isPhaseRuntimeEnabled()
      const phaseVerdictNoTool = phaseRuntimeNoTool ? deriveTurnPhase(taskState) : undefined
      const createPlanNudge = hasOnlyPlanningOrReadAttempts(toolAttempts)
        ? buildTaskExecutionNudge({
          assistantText: effectiveResponse.text,
          latestUserText: latestSubstantiveUserText(conversation) ?? null,
          deliverable: getDeliverableContract(taskState),
          counter: taskStepNudgeCounter,
          activeTaskId: null,
          proposedToolCalls: taskState.proposedToolCalls,
          phaseRuntimeEnabled: phaseRuntimeNoTool,
          operatingMode: conversation.options?.operatingModeState?.mode ?? 'normal',
          projectMapVerificationProfiles: projectMapVerificationProfilesForNudge(conversation),
          ...(phaseVerdictNoTool ? { phaseVerdict: phaseVerdictNoTool } : {}),
        })
        : null
      if (createPlanNudge?.kind === 'create_plan') {
        consumeNudge(taskStepNudgeCounter, createPlanNudge.taskId, createPlanNudge.kind)
        recordRuntimeNudgePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, createPlanNudge.kind)
        conversation.turns.push({
          role: 'user',
          content: [{ type: 'text', text: createPlanNudge.text }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(
          `Task-step nudge (${createPlanNudge.kind}): no structured execution plan is active — nudging the model to create one.`,
        )
        continue
      }
      if (
        turnPlan.mode === 'normal'
        && !phaseSuppressesGenericRuntimeContinue(phaseVerdictNoTool)
        && shouldAutoContinueOpenTask(taskState, effectiveResponse.text, openTaskAutoContinueCount, latestSubstantiveUserText(conversation))
      ) {
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

      // Delivery-claim hook (issue #6, second piece): if the model just
      // emitted a completion claim ("done", "shipped", "tests pass", …)
      // and the working tree shows touched paths, inject a one-shot
      // [Runtime delivery check] nudge urging it to call DeliveryAudit
      // before the loop exits. Skipped when:
      //   - the claim already cites a touched file by basename
      //     (model self-evidenced; nudging would be noise)
      //   - the model already invoked DeliveryAudit since its last
      //     file mutation
      //   - the per-turn cap has fired (avoid nag-loop)
      const hasCompletionClaim = detectCompletionClaim(effectiveResponse.text)
      if (hasCompletionClaim) {
        recordCompletionClaimPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, effectiveResponse.text)
      }
      if (
        deliveryCheckInjections < DELIVERY_CHECK_INJECTION_LIMIT
        && taskState.contract.touchedPaths.length > 0
        && hasCompletionClaim
        && !completionCitesTouchedPaths(effectiveResponse.text, taskState.contract.touchedPaths)
        && !deliveryAuditCalledSinceLastMutation(conversation)
      ) {
        deliveryCheckInjections += 1
        recordRuntimeNudgePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'delivery_check')
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildDeliveryCheckPrompt(taskState, effectiveResponse.text),
          }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(
          `Delivery check: completion claim detected with ${taskState.contract.touchedPaths.length} touched path(s); nudging the model to call DeliveryAudit before concluding (${deliveryCheckInjections}/${DELIVERY_CHECK_INJECTION_LIMIT}).`,
        )
        continue
      }

      // Probe-coverage hook (0.13.51, issue #7): if the model just
      // emitted a final-text response that LOOKS like a group summary
      // (table markdown, P/F verdicts, "结论") AND any registered
      // probe plan has unsatisfied probes, inject a runtime notice
      // listing the missing probes. Closes the prompt-only escape both
      // QA models took (predict-denied → skip the tool call → claim P
      // with no transcript evidence).
      const probeGaps = unsatisfiedProbes(conversation)
      if (
        probeGaps.length > 0
        && probeCoverageInjections < PROBE_COVERAGE_INJECTION_LIMIT
        && looksLikeGroupSummary(effectiveResponse.text)
      ) {
        probeCoverageInjections += 1
        conversation.turns.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildProbeCoverageCheckPrompt(probeGaps),
          }],
          timestamp: Date.now(),
        })
        opts.callbacks?.onNotice?.(
          `Probe coverage check: ${probeGaps.length} unsatisfied probe(s) — nudging the model to emit them before summary (${probeCoverageInjections}/${PROBE_COVERAGE_INJECTION_LIMIT}).`,
        )
        continue
      }
      // Slice 4: task-step nudge (create_plan / continue_step / verify_step /
      // completion_blocked). Fires when a structured TaskCreate plan has open
      // required steps and the model hasn't advanced them this turn.
      // Rate-limited per (taskId, kind) to MAX_NUDGES_PER_KIND per conversation.
      {
        const candidateStepNudge = buildTaskExecutionNudge({
          assistantText: effectiveResponse.text,
          latestUserText: latestSubstantiveUserText(conversation) ?? null,
          deliverable: getDeliverableContract(taskState),
          counter: taskStepNudgeCounter,
          activeTaskId: null,
          proposedToolCalls: taskState.proposedToolCalls,
          phaseRuntimeEnabled: phaseRuntimeNoTool,
          operatingMode: conversation.options?.operatingModeState?.mode ?? 'normal',
          projectMapVerificationProfiles: projectMapVerificationProfilesForNudge(conversation),
          ...(phaseVerdictNoTool ? { phaseVerdict: phaseVerdictNoTool } : {}),
        })
        const stepNudge = candidateStepNudge?.kind === 'create_plan' && !hasOnlyPlanningOrReadAttempts(toolAttempts)
          ? null
          : candidateStepNudge
        if (stepNudge) {
          consumeNudge(taskStepNudgeCounter, stepNudge.taskId, stepNudge.kind)
          recordRuntimeNudgePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, stepNudge.kind)
          conversation.turns.push({
            role: 'user',
            content: [{ type: 'text', text: stepNudge.text }],
            timestamp: Date.now(),
          })
          opts.callbacks?.onNotice?.(
            `Task-step nudge (${stepNudge.kind}): task ${stepNudge.taskId} has open required steps — nudging the model to continue.`,
          )
          continue
        }
      }

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
      // Latest substantive user text feeds the analysis-intent guard
      // (0.13.48) so executeTools can refuse mutating writes when the
      // user only asked for judgment.
      latestSubstantiveUserText(conversation),
      // 0.13.52: pass the conversation so the intent guard can also
      // consult registered ProbePlan probes — a call matching an
      // unsatisfied probe is allowed (registration = explicit consent
      // for that exact shape) even when the latest user intent is
      // analysis.
      conversation,
      // 0.13.55: persisted across turns so the second hit on the same
      // intentKey escalates from soft intercept to hard terminate.
      interceptedIntents,
      // 0.13.62 (B): schema-failure dedup map; second-strike same
      // (tool, missingFields) hard-terminates at dispatcher level.
      schemaFailCounts,
    )

    // 4a. Probe-coverage tracking (0.13.51; 0.13.54: pass tool outcome
    // so negative probes with expectedOutcome='intentGuardBlocked' can
    // be satisfied too). For each executed tool call — including those
    // that returned isError — scan registered probe plans and mark any
    // matching probe satisfied. The probe's expectedOutcome decides
    // whether a given (toolName, input, isError, metadata) tuple
    // counts. Idempotent.
    for (let i = 0; i < toolResults.results.length; i += 1) {
      const result = toolResults.results[i]!
      const block = effectiveResponse.toolUseBlocks[i]
      if (!block) continue
      const outcome = {
        isError: result.result.isError === true,
        metadata: result.result.metadata,
      }
      const newlySatisfied = markProbesSatisfied(
        conversation,
        block.name,
        block.input as Record<string, unknown>,
        outcome,
      )
      if (newlySatisfied.length > 0) {
        opts.callbacks?.onNotice?.(
          `Probe coverage: ${newlySatisfied.join(', ')} satisfied by this turn's tool calls.`,
        )
      }
    }

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
      recordGateEvent({
        ts: Date.now(),
        kind: 'tool_loop',
        conversationId: conversation.id,
        iteration: taskState.run.lifetimeIterations ?? 0,
        contract: buildGateEventContract(taskState),
        lastToolSignatures: lastNToolSignatures(toolAttempts),
        reason: toolResults.loopError,
      })
      lastStopReason = 'tool_loop'
      // Close the protocol: push whatever tool_results we collected, plus
      // synthesized fillers for any tool_use blocks the guard prevented.
      // Without this, the assistant turn is orphaned — sanitize strips it
      // and the model re-executes the blocked tool on the next turn.
      closePendingToolUse(
        toolResults.results,
        effectiveResponse.toolUseBlocks,
        toolResults.loopError,
      )
      break
    }
    openTaskAutoContinueCount = 0

    // 5. Add tool results as user turn — truncate oversized outputs.
    // Soft-mode loop intercept breaks the for-loop in executeTools after
    // synthesizing a result for the intercepted block, leaving subsequent
    // blocks with no result. Fill in synthetic fillers so the protocol is
    // well-formed (every tool_use has a matching tool_result).
    const completedToolIds = new Set(toolResults.results.map((r) => r.toolUseId))
    const softModeFillers: ToolExecutionResult[] = effectiveResponse.toolUseBlocks
      .filter((b) => !completedToolIds.has(b.id))
      .map((b) => ({
        toolUseId: b.id,
        toolName: b.name,
        result: {
          output: '[loop-guard] skipped: earlier block in batch triggered loop intercept',
          isError: true,
          metadata: { loopGuardClosed: true, skippedAfterSoftIntercept: true },
        },
        durationMs: 0,
      }))
    const allToolResults = softModeFillers.length > 0
      ? [...toolResults.results, ...softModeFillers]
      : toolResults.results
    const resultBlocks = dispatcher.toContentBlocks(allToolResults)
    const truncatedBlocks = truncateToolResultBlocks(resultBlocks, TOOL_OUTPUT_MAX_CHARS)
    const artifactRepairPlan = buildArtifactRepairRuntimePlan(allToolResults, artifactRepairAttempts)
    const turnContent = [
      ...truncatedBlocks,
      ...artifactRepairPlan.blocks,
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
    for (const notice of artifactRepairPlan.notices) {
      opts.callbacks?.onNotice?.(notice)
    }
    for (const blocked of artifactRepairPlan.blockedSignals) {
      opts.callbacks?.onError?.(blocked)
    }
    if (toolResults.terminalError) {
      markTaskGuardBlocked(taskState, toolResults.terminalError)
      lastStopReason = 'terminal_tool_failure'
      break
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
    if (shouldForceProjectMapSynthesisBeforeIterationCap(conversation, taskState, convergence, iterations, maxIterations)) {
      convergence.phase = 'project_map_synthesizing'
      opts.callbacks?.onNotice?.(
        'Project Map convergence: ProjectMap evidence is present and this bounded control-plane task is one iteration from the cap; forcing tool-free synthesis.',
      )
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
    const legacyCompletionAccepted = isDurableTaskCompletion(taskState, finalText)
    if (isPhaseRuntimeEnabled()) {
      const deliverable = getDeliverableContract(taskState)
      const phaseVerdict = deriveTurnPhase(taskState)
      const completionDecision = evaluateCompletionClaim({
        taskState,
        finalText,
        deliverable,
        legacyCompletionAccepted,
        phaseVerdict,
      })
      if (completionDecision.status === 'accepted') {
        recordGateEvent({
          ts: Date.now(),
          kind: 'completion_claim_accepted',
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? iterations,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          reason: completionDecision.reason,
          deliverableMode: deliverable.mode,
          deliverableConfidence: deliverable.confidence,
          requiresDurableArtifact: deliverable.requiresDurableArtifact,
          allowsChatFinal: deliverable.allowsChatFinal,
          hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
          deliverableReasons: deliverable.reasons,
          phase: phaseVerdict.phase,
          phaseConfidence: phaseVerdict.confidence,
          phaseReasons: phaseVerdict.reasonCodes,
          phaseEvidenceCount: phaseVerdict.evidenceCount,
          artifactEvidenceCount: completionDecision.artifactEvidenceCount,
          verificationEvidenceCount: completionDecision.verificationEvidenceCount,
          pendingRiskyGrantCount: completionDecision.pendingRiskyGrantCount,
          phaseRuntimeEnabled: true,
        })
        markTaskCompleted(taskState, finalText)
      } else if (completionDecision.status === 'blocked') {
        recordGateEvent({
          ts: Date.now(),
          kind: 'completion_claim_blocked',
          conversationId: conversation.id,
          iteration: taskState.run.lifetimeIterations ?? iterations,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(toolAttempts),
          reason: completionDecision.reason,
          deliverableMode: deliverable.mode,
          deliverableConfidence: deliverable.confidence,
          requiresDurableArtifact: deliverable.requiresDurableArtifact,
          allowsChatFinal: deliverable.allowsChatFinal,
          hardStopOnNoTouchedPaths: deliverable.hardStopOnNoTouchedPaths,
          deliverableReasons: deliverable.reasons,
          phase: phaseVerdict.phase,
          phaseConfidence: phaseVerdict.confidence,
          phaseReasons: phaseVerdict.reasonCodes,
          phaseEvidenceCount: phaseVerdict.evidenceCount,
          artifactEvidenceCount: completionDecision.artifactEvidenceCount,
          verificationEvidenceCount: completionDecision.verificationEvidenceCount,
          pendingRiskyGrantCount: completionDecision.pendingRiskyGrantCount,
          phaseRuntimeEnabled: true,
        })
        markTaskGuardBlocked(taskState, completionDecision.reason)
      } else if (taskState.run.status === 'open') {
        markTaskGuardBlocked(taskState, 'The model stopped at an interim progress update before finishing the requested deliverable.')
      }
    } else if (legacyCompletionAccepted) {
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
  // of the actual error. Runtime stop reasons (hard_stop, task_no_progress,
  // narration_loop, max_iterations) are synthesis decisions, not model no-ops,
  // so the runtime message (already surfaced above via onError) owns the
  // narrative there too — stacking "(No response from <model>)" on a deliberate
  // stop reads as a transport/model failure and buries the actionable guidance.
  return !options.finalText
    && !options.aborted
    && options.runtimeFailure === null
    && options.stopReason !== 'stalled'
    && options.stopReason !== 'tool_loop'
    && options.stopReason !== 'tool_use'
    && options.stopReason !== 'hard_stop'
    && options.stopReason !== 'task_no_progress'
    && options.stopReason !== 'narration_loop'
    && options.stopReason !== 'max_iterations'
    && options.stopReason !== 'terminal_tool_failure'
}

// Empty assistant response with no tool_use / no error is the model's own
// "I'm done" signal (typically stop_reason=end_turn) but with zero useful
// output — Kimi-for-coding has been observed to emit hundreds of these
// HTTP-200-but-empty replies in a row when the conversation drifts. The
// upstream signal is NOT a transport problem: the connection completed,
// the body parsed, the model just produced nothing. Auto-retrying that
// 8 times in a row (the previous behavior under retryable=true +
// kind=provider_error) wastes runtime capacity and produces the smear of
// repeated "Runtime auto-continue: …" rows the user reported.
//
// We keep retryable=true so the user's `/retry` slash command and the
// continuation-phrase shortcut ("继续") still work — those are
// user-driven re-attempts, not loop noise. The auto-continue path
// excludes this kind specifically (see shouldScheduleRuntimeAutoRetry).
//
// Wording: explicitly call out HTTP 200 + empty content so the user
// doesn't read the message as "rate limit" or "network error" and
// chase the wrong layer. The audit log evidence for this failure is
// always 200, not 429/503, so the surface text matches what /audit
// would show.
function createEmptyResponseRuntimeFailure(
  conversation: Pick<Conversation, 'model' | 'turns'>,
  iterations: number,
  stopReason: string | null | undefined,
): ConversationRuntimeFailure {
  return {
    kind: 'empty_provider_response',
    phase: deriveRuntimeFailurePhase(conversation, iterations),
    message: `No response from ${conversation.model}: provider returned HTTP 200 but no content (stop_reason: ${stopReason ?? 'none'}). Use /retry to resend, or /model to switch — auto-continue is suppressed for empty replies because they usually indicate a model stall, not a transport issue.`,
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

  if (convergence.phase === 'project_map_synthesizing') {
    return {
      mode: 'synthesis',
      request: buildProjectMapSynthesisRequest(conversation, convergence, taskState),
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

function buildProjectMapSynthesisRequest(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  taskState: ActiveTaskState,
): AnthropicMessagesRequest {
  const request = buildRequest(conversation, true)
  request.messages = [
    ...request.messages,
    {
      role: 'user',
      content: [{
        type: 'text',
        text: buildProjectMapSynthesisPrompt(conversation, convergence, taskState),
      }],
    },
  ]
  delete request.tools
  request.tool_choice = { type: 'none' }
  request.stream = false
  request.max_tokens = SYNTHESIS_MAX_TOKENS
  request.temperature = conversation.temperature !== undefined
    ? Math.min(conversation.temperature, 0.3)
    : 0.2
  request.stop_sequences = SYNTHESIS_STOP_SEQUENCES
  return request
}

function buildProjectMapSynthesisPrompt(
  conversation: Conversation,
  convergence: ConvergenceRuntimeState,
  taskState: ActiveTaskState,
): string {
  return [
    '[Project Map convergence final-answer]',
    'ProjectMap has already been used and this bounded read-only Runtime Control Plane task is one iteration from the cap.',
    'Use the Project Map snapshot, prior tool results, and current conversation evidence already present above.',
    'Do not ask to read more files, run more tools, or perform more searches.',
    'Keep the full answer under 160 words.',
    'Use one or two short sentences per section.',
    'Do not include file-line citation lists or long bullet lists.',
    'The Next section must end with a period.',
    'Return exactly four sections with these labels and nothing else:',
    'Conclusion:',
    'Evidence:',
    'Uncertainty:',
    'Next:',
    `Task: ${extractLatestUserTask(conversation, taskState)}`,
    `Known uncertainty: ${convergence.lastGap ?? 'State the main remaining uncertainty briefly without reopening exploration.'}`,
    'Respond now using the required final-answer contract only.',
  ].join('\n')
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

function buildArtifactRepairRuntimePlan(
  results: ToolExecutionResult[],
  attemptCounts: Map<string, number>,
): ArtifactRepairRuntimePlan {
  const blocks: AnthropicTextBlock[] = []
  const notices: string[] = []
  const blockedSignals: string[] = []

  for (const result of results) {
    const verification = extractArtifactVerificationResult(result)
    if (!verification) continue

    const key = artifactRepairAttemptKey(verification)
    if (verification.passed) {
      attemptCounts.delete(key)
      continue
    }

    const attemptCount = attemptCounts.get(key) ?? 0
    const decision = decideRepairPolicy({
      verification,
      attemptCount,
      maxAttempts: ARTIFACT_REPAIR_MAX_ATTEMPTS,
    })

    if (decision.action === 'repair' && decision.repairPrompt) {
      const nextAttemptCount = attemptCount + 1
      attemptCounts.set(key, nextAttemptCount)
      blocks.push({
        type: 'text',
        text: buildArtifactRepairPromptBlock(
          decision.repairPrompt,
          decision.artifactPath,
          nextAttemptCount,
          ARTIFACT_REPAIR_MAX_ATTEMPTS,
        ),
      })
      notices.push(
        `Artifact repair: ArtifactVerify failed for ${decision.artifactPath}; ` +
        `injecting repair prompt (${nextAttemptCount}/${ARTIFACT_REPAIR_MAX_ATTEMPTS}).`,
      )
      continue
    }

    if (decision.action === 'blocked') {
      attemptCounts.set(key, attemptCount)
      const blockedText = buildArtifactRepairBlockedBlock({
        artifactPath: decision.artifactPath,
        failedCheckIds: decision.failedCheckIds,
        blockedReason: decision.blockedReason,
        attemptCount,
        maxAttempts: ARTIFACT_REPAIR_MAX_ATTEMPTS,
      })
      blocks.push({ type: 'text', text: blockedText })
      blockedSignals.push(
        `Artifact repair blocked: ArtifactVerify still fails for ${decision.artifactPath} ` +
        `after ${attemptCount}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} repair prompt(s).`,
      )
    }
  }

  return { blocks, notices, blockedSignals }
}

function extractArtifactVerificationResult(result: ToolExecutionResult): VerificationPackResult | null {
  if (result.toolName !== 'ArtifactVerify') return null
  const candidate = result.result.metadata?.['result']
  if (isVerificationPackResult(candidate)) return candidate
  return null
}

function isVerificationPackResult(value: unknown): value is VerificationPackResult {
  if (!isPlainObject(value)) return false
  return value['packId'] === 'html_deck'
    && (value['status'] === 'passed' || value['status'] === 'failed')
    && typeof value['passed'] === 'boolean'
    && typeof value['artifactPath'] === 'string'
    && typeof value['checkedAt'] === 'string'
    && Array.isArray(value['checks'])
    && value['checks'].every(isVerificationCheckResult)
}

function isVerificationCheckResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return typeof value['checkId'] === 'string'
    && typeof value['passed'] === 'boolean'
    && (value['severity'] === 'info' || value['severity'] === 'warning' || value['severity'] === 'error')
    && typeof value['detail'] === 'string'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function artifactRepairAttemptKey(result: VerificationPackResult): string {
  return `${result.packId}:${result.artifactPath}`
}

function buildArtifactRepairPromptBlock(
  repairPrompt: string,
  artifactPath: string,
  attemptCount: number,
  maxAttempts: number,
): string {
  return [
    '[Runtime artifact repair]',
    `ArtifactVerify failed for ${artifactPath}. Repair attempt ${attemptCount}/${maxAttempts}.`,
    repairPrompt,
  ].join('\n')
}

function buildArtifactRepairBlockedBlock(input: {
  artifactPath: string
  failedCheckIds: string[]
  blockedReason?: string
  attemptCount: number
  maxAttempts: number
}): string {
  return [
    '[Runtime artifact repair blocked]',
    `ArtifactVerify still fails for ${input.artifactPath} after ${input.attemptCount}/${input.maxAttempts} repair prompt(s).`,
    `Failed checkIds: ${input.failedCheckIds.length > 0 ? input.failedCheckIds.join(', ') : '(none)'}`,
    input.blockedReason ?? 'Repair attempts exhausted.',
    'Do not keep retrying the same ArtifactVerify call. Reply with a concise blocked status, the remaining failed checks, and the smallest concrete change or user input needed before verification can continue.',
  ].join('\n')
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

function shouldForceProjectMapSynthesisBeforeIterationCap(
  conversation: Conversation,
  taskState: ActiveTaskState,
  convergence: ConvergenceRuntimeState,
  iterations: number,
  maxIterations: number,
): boolean {
  if (!isProjectMapEnabled()) return false
  if (convergence.phase !== 'exploring') return false
  if (!Number.isFinite(maxIterations) || maxIterations <= PROJECT_MAP_SYNTHESIS_REMAINING_ITERATIONS) return false
  if (iterations < maxIterations - PROJECT_MAP_SYNTHESIS_REMAINING_ITERATIONS) return false
  if (taskState.run.status !== 'open') return false
  if (taskState.contract.touchedPaths.length > 0) return false
  if (!conversation.options?.projectMapSnapshot) return false
  if (!hasAssistantToolUse(conversation, 'ProjectMap')) return false
  return isProjectMapReadOnlyPlanningTask(conversation, taskState)
}

function hasAssistantToolUse(conversation: Conversation, toolName: string): boolean {
  return conversation.turns.some((turn) => turn.role === 'assistant' && turn.content.some((block) => (
    block.type === 'tool_use' && block.name === toolName
  )))
}

function isProjectMapReadOnlyPlanningTask(
  conversation: Conversation,
  taskState: ActiveTaskState,
): boolean {
  const taskText = [
    taskState.contract.objective,
    extractLatestUserTask(conversation, taskState),
    latestSubstantiveUserText(conversation) ?? '',
  ].map(normalizeWhitespace).join(' ')
  return PROJECT_MAP_CONTROL_PLANE_TASK_RE.test(taskText)
    && PROJECT_MAP_READ_ONLY_PLANNING_TASK_RE.test(taskText)
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
  // Normalize the base before appending `/v1/messages` so a programmatic
  // caller that passes a `/v1`-suffixed apiBaseUrl (the Ollama footgun
  // `…:11434/v1`) does not POST to `/v1/v1/messages` — which 404s every
  // request and spins the loop to max_iterations with no work done.
  const url = buildAnthropicMessagesUrl(opts.apiBaseUrl)
  const adaptiveKey = adaptiveConcurrencyKeyFromApiBaseUrl(opts.apiBaseUrl)
  const adaptiveRetryEnabled = isAdaptiveAgentConcurrencyEnabled()
  const maxRetries = adaptiveRetryEnabled ? 3 : 1
  let lastError: Error | null = null
  // 0.14.8: REPL client-side timeout must NOT fire before the proxy's
  // own adaptive budget. Pre-0.14.8 the REPL had a hardcoded 180s
  // default that killed the fetch even when the proxy was still
  // serving (e.g. 33K-input deepseek-v4-pro request returned 7.4K
  // tokens of output in 259s, status 200 — but REPL aborted at 180s
  // and surfaced "non-streaming server budget" wording while the
  // proxy continued to completion).
  //
  // 0.14.21: for streaming, that same client wall-clock budget must
  // NOT stay attached to the response body. The proxy already owns
  // stream liveness with first-token + per-chunk idle watchdogs. If
  // the REPL keeps AbortSignal.timeout on the fetch signal, Node can
  // still abort an active body stream after the adaptive wall-clock
  // even though the provider is producing tokens. Keep the budget as
  // a "headers / first response" guard only, then clear it once fetch
  // returns.
  const baseBudgetMs = opts.requestTimeoutMs ?? 180_000
  const adaptiveBudget = computeAdaptiveTimeoutMs({
    baseMs: baseBudgetMs,
    body: request as { system?: unknown; messages?: unknown },
    middleware: undefined,  // use defaults — REPL has no middleware config
  })
  const requestTimeoutMs = adaptiveBudget.timeoutMs + 30_000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let adaptiveSignalRecorded = false
    try {
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      const timeoutController = request.stream ? new AbortController() : null
      const timeoutSignal = request.stream
        ? timeoutController!.signal
        : AbortSignal.timeout(requestTimeoutMs)
      if (request.stream && timeoutController) {
        timeoutTimer = setTimeout(() => {
          timeoutController.abort(new Error(`headers timeout after ${requestTimeoutMs}ms`))
        }, requestTimeoutMs)
        timeoutTimer.unref?.()
      }
      const combinedSignal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(request),
          signal: combinedSignal,
        })
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer)
      }

      if (!res.ok) {
        const body = await res.text()
        const diagnostic = buildRequestDiagnosticFromResponse(res, request.model, body)
        if (diagnosticLooksLikeRateLimit(diagnostic)) {
          recordAdaptiveRateLimit(adaptiveKey)
          adaptiveSignalRecorded = true
        }
        // Retry on 429 (rate limit) and 5xx errors
        const retryLimit = diagnostic ? requestAutoRetryLimitForDiagnostic(diagnostic) : maxRetries
        if (diagnostic && shouldAutoRetryRequestDiagnostic(diagnostic, attempt) && tryConsumeAdaptiveRetryBudget(adaptiveKey)) {
          lastError = new ProviderRequestError(diagnostic)
          const delay = retryDelay(attempt, res.status, diagnostic.detail, res.headers.get('retry-after'))
          opts.callbacks?.onRetry?.({
            error: formatProviderDiagnostic(diagnostic),
            delayMs: delay,
            attempt: attempt + 1,
            maxRetries: retryLimit,
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
          recordAdaptiveSuccess(adaptiveKey)
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
          recordAdaptiveSuccess(adaptiveKey)
          return fallbackResponse
        }
        recordAdaptiveSuccess(adaptiveKey)
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
      const parsed = parseResponse(body)
      recordAdaptiveSuccess(adaptiveKey)
      return parsed
    } catch (err: unknown) {
      const diagnostic = buildRequestDiagnosticFromError(err, request.model, url)
      const msg = diagnostic ? formatProviderDiagnostic(diagnostic, { includeRequestId: true }) : err instanceof Error ? err.message : String(err)
      if (opts.signal?.aborted) {
        throw err
      }
      if (!adaptiveSignalRecorded && diagnosticLooksLikeRateLimit(diagnostic)) {
        recordAdaptiveRateLimit(adaptiveKey)
        adaptiveSignalRecorded = true
      }
      // Retry on connection errors (fetch rejects)
      const retryLimit = diagnostic ? requestAutoRetryLimitForDiagnostic(diagnostic) : maxRetries
      if (attempt < retryLimit && (diagnostic ? shouldAutoRetryRequestDiagnostic(diagnostic, attempt) : isRetryableError(msg)) && tryConsumeAdaptiveRetryBudget(adaptiveKey)) {
        lastError = diagnostic ? new ProviderRequestError(diagnostic) : err instanceof Error ? err : new Error(msg)
        const delay = retryDelay(attempt, diagnostic?.status, diagnostic?.detail)
        opts.callbacks?.onRetry?.({
          error: diagnostic ? formatProviderDiagnostic(diagnostic) : msg,
          delayMs: delay,
          attempt: attempt + 1,
          maxRetries: retryLimit,
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
  // 0.14.8: same adaptive client-side timeout as sendRequest.
  const baseBudgetMs = opts.requestTimeoutMs ?? 180_000
  const adaptiveBudget = computeAdaptiveTimeoutMs({
    baseMs: baseBudgetMs,
    body: request as { system?: unknown; messages?: unknown },
    middleware: undefined,
  })
  const timeoutSignal = AbortSignal.timeout(adaptiveBudget.timeoutMs + 30_000)
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

/** Calculate retry delay with exponential backoff. Rate-limit (429 or
 *  detail-text-inferred) gets longer waits and jitter; Retry-After is honored
 *  as a lower bound when an upstream provides it. */
function retryDelay(attempt: number, status?: number, detail?: string, retryAfterHeader?: string | null): number {
  return computeRequestRetryDelayMs({
    attempt,
    status,
    detail,
    retryAfterHeader,
    adaptive: isAdaptiveAgentConcurrencyEnabled(),
  })
}

function requestAutoRetryLimitForDiagnostic(diagnostic: ProviderRequestDiagnostic): number {
  return requestAutoRetryLimit(diagnostic.retryable, diagnostic.kind)
}

function shouldAutoRetryRequestDiagnostic(diagnostic: ProviderRequestDiagnostic, attempt: number): boolean {
  return attempt < requestAutoRetryLimitForDiagnostic(diagnostic)
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
      retryable: isAdaptiveAgentConcurrencyEnabled(),
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
  // 0.13.97: stream_first_token_timeout (proxy watchdog) ≡ pre_first_token_stream_close
  // semantically. Both mean "user has nothing yet, suggest /model or /retry".
  if (diagnostic.kind === 'stream_first_token_timeout') return 'pre_first_token_stream_close'
  // 0.13.97: stream_idle_timeout is NEW — distinct from post_token_stream_close
  // because the connection didn't actually close (just went silent).
  if (diagnostic.kind === 'stream_idle_timeout') return 'stream_idle_timeout'
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

/**
 * Did the model already invoke DeliveryAudit since its most recent
 * file mutation (write / edit / NotebookEdit)? Used by the delivery-
 * check injector so we don't nag the model for an audit it just ran.
 *
 * Walks the conversation backwards from the tail looking for whichever
 * comes first: a DeliveryAudit tool_use (returns true), or any of the
 * mutating tool_use blocks (returns false). If neither is found, the
 * model has touched paths but never called the audit — return false
 * so the injector fires.
 */
/**
 * Heuristic detector for "the assistant's text reads like a hostile-QA
 * group summary." Matches markdown table headers, P/F verdict columns,
 * Chinese 结论, English "Conclusion:", and the case-id patterns
 * (A0/A1/B0/...). False positives are tolerable — the worst case is a
 * coverage-check inject fires when no probe plan is registered, which
 * unsatisfiedProbes() returns empty for and the hook short-circuits.
 */
function looksLikeGroupSummary(text: string): boolean {
  if (!text || text.length === 0) return false
  if (/\bP\/F\b/.test(text)) return true
  if (/结论\s*[:：]/.test(text)) return true
  if (/^\s*\|\s*#\s*\|/m.test(text)) return true
  if (/Conclusion\s*[:：]/i.test(text)) return true
  // Standalone case-id ladder: e.g. "A0  P/9" or "A1: F" lines
  if (/^\s*[A-Z]\d+\s*[:|\s]\s*[PF](?:\b|\/)/m.test(text)) return true
  return false
}

function deliveryAuditCalledSinceLastMutation(conversation: Conversation): boolean {
  const MUTATING = new Set(['write', 'edit', 'NotebookEdit'])
  for (let i = conversation.turns.length - 1; i >= 0; i -= 1) {
    const turn = conversation.turns[i]
    if (!turn) continue
    if (turn.role !== 'assistant') continue
    for (const block of turn.content) {
      if (block.type !== 'tool_use') continue
      if (block.name === 'DeliveryAudit') return true
      if (MUTATING.has(block.name)) return false
    }
  }
  return false
}

function phaseSuppressesGenericRuntimeContinue(phaseVerdict: DerivedTurnPhase | undefined): boolean {
  if (!phaseVerdict) return false
  if (phaseVerdict.evidenceCount <= 0) return false
  return phaseVerdict.phase === 'verify'
    || phaseVerdict.phase === 'report'
    || phaseVerdict.phase === 'final'
}

function shouldAutoContinueOpenTask(
  taskState: ActiveTaskState,
  text: string,
  autoContinueCount: number,
  latestUserText?: string | null,
): boolean {
  if (taskState.run.status !== 'open') return false
  if (autoContinueCount >= OPEN_TASK_AUTO_CONTINUE_LIMIT) return false

  // Analysis-intent suppression (0.13.48): if the user's most recent
  // substantive message read as analysis-only ("你觉得 / 评估一下 /
  // what do you think"), the auto-continue nudge is exactly the wrong
  // thing — it pushes the agent from "give an opinion" toward
  // "implement an opinion". The Sierac-class failure mode. Pure
  // analysis intent disables continue-while-open; mixed/implementation
  // intent leaves it on.
  if (latestUserText) {
    const intent = inferUserIntent(latestUserText)
    if (intent === 'analysis') return false
  }

  const normalized = normalizeWhitespace(text)
  if (!normalized) return false
  if (looksLikeCompleteTaskReport(taskState, normalized)) return false
  if (looksLikeUserInputOrBlocker(normalized)) return false
  if (isGateV2Enabled()) {
    return shouldHardStopOnNoTouchedPaths(getDeliverableContract(taskState))
      && taskState.contract.scopeMode === 'explicit_paths'
      && taskState.contract.touchedPaths.length === 0
      && hasGrantedRiskyToolAwaitingEvidence(taskState)
  }
  if (
    shouldHardStopOnNoTouchedPaths(getDeliverableContract(taskState))
    && taskState.contract.scopeMode === 'explicit_paths'
    && taskState.contract.touchedPaths.length === 0
  ) {
    return true
  }
  if (looksLikeCompletedTaskText(normalized)) return false
  return looksLikeInterimProgressText(normalized)
}

/** Build the gate-event contract summary from an active task state. */
function buildGateEventContract(taskState: ActiveTaskState): GateEvent['contract'] {
  const byOrigin: Record<string, number> = {}
  for (const scope of taskState.contract.allowedWritePaths) {
    byOrigin[scope.origin] = (byOrigin[scope.origin] ?? 0) + 1
  }
  return {
    cwd: taskState.contract.cwd,
    scopeMode: taskState.contract.scopeMode,
    confidence: taskState.contract.confidence ?? 'medium',
    allowedWritePathsByOrigin: byOrigin,
    touchedPathsCount: taskState.contract.touchedPaths.length,
    scratchArtifactPathsCount: taskState.run.scratchArtifactPaths?.length ?? 0,
  }
}

/** Extract last N tool call signatures from the attempts ring buffer. */
function lastNToolSignatures(toolAttempts: ToolAttemptSignature[], n = 3): string[] {
  return toolAttempts.slice(-n).map(a => `${a.name}:${a.signature}`)
}

function hasOnlyPlanningOrReadAttempts(toolAttempts: ToolAttemptSignature[]): boolean {
  return toolAttempts.every((attempt) =>
    attempt.name === 'read'
    || attempt.name === 'grep'
    || attempt.name === 'glob'
    || attempt.name === 'TodoWrite'
    || attempt.name === 'TaskList'
    || attempt.name === 'TaskGet'
  )
}

/**
 * Derive the Deliverable Contract v1 classification for a task state.
 *
 * Builds the classification from the task's objective + sourceText.
 * This is the Slice 0 entry point for all new gate callsites; it returns
 * a `DeliverableContractClassification` whose wrappers (shouldHardStopOnNoTouchedPaths,
 * allowsChatFinal, etc.) drive gate policy without inline mode checks.
 *
 * Note: `contract.confidence` (path/write-scope confidence, existing field) and
 * `DeliverableConfidence` (mode-classification confidence, this layer) are
 * orthogonal and must not be conflated. Both are recorded separately in telemetry.
 */
/**
 * A3 fix: reads deliverableMode from the RunWorkspace manifest snapshot stored
 * on taskState.run.runWorkspace and passes it as a ManifestHint to the
 * classifier.  The classifier (A1 fix) honours the hint when confidence ≠ 'low'.
 *
 * The runWorkspace snapshot is populated by ensureRunWorkspaceForStructuredTask
 * in task-state.ts whenever a RunWorkspace is auto-created or the model calls
 * RunWorkspace(action='create').  No additional fs.readFileSync is needed here —
 * the in-memory snapshot is the source of truth.
 *
 * Fault tolerance: missing runWorkspace / missing deliverableMode / unknown mode
 * value all silently fall back to text-only classification.
 */
function getDeliverableContract(taskState: ActiveTaskState): DeliverableContractClassification {
  const taskText = normalizeWhitespace(`${taskState.contract.objective} ${taskState.contract.sourceText}`)
  const manifestHint = resolveManifestHint(taskState)
  return classifyDeliverableContract(taskText, manifestHint ? { manifestHint } : undefined)
}

const VALID_DELIVERABLE_MODES: ReadonlySet<string> = new Set<DeliverableMode>([
  'read_only_review',
  'text_deliverable',
  'file_artifact_delivery',
  'code_change',
  'command_job',
  'mixed_unknown',
])

function resolveManifestHint(taskState: ActiveTaskState): ManifestHint | null {
  try {
    const ws = taskState.run.runWorkspace
    if (!ws) return null
    const raw = ws.deliverableMode
    if (typeof raw !== 'string' || !VALID_DELIVERABLE_MODES.has(raw)) return null
    const mode = raw as DeliverableMode
    // Only promote to hint if the mode is meaningful (not mixed_unknown/low signal)
    if (mode === 'mixed_unknown') return null
    return { deliverableMode: mode, confidence: 'high' }
  } catch {
    // Never propagate — manifest hint is advisory only
    return null
  }
}

function selectTrustedTaskWriteScope(taskState: ActiveTaskState): string | null {
  if (taskState.contract.scopeMode !== 'explicit_paths') return null
  const userExternal = taskState.contract.allowedWritePaths.find(scope => scope.origin === 'user-external')
  if (userExternal) return userExternal.path
  const explicit = taskState.contract.allowedWritePaths.find(scope => scope.origin === 'explicit')
  return explicit?.path ?? null
}

function hasTrustedDurableWriteTarget(taskState: ActiveTaskState): boolean {
  return selectTrustedTaskWriteScope(taskState) !== null
}

function isDurableTaskCompletion(taskState: ActiveTaskState, text: string): boolean {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return false
  if (looksLikeCompleteTaskReport(taskState, normalized)) return true
  // Slice 0: use deliverable contract to gate completion. chat-final modes
  // (read_only_review, text_deliverable, command_job, mixed_unknown) can complete
  // in conversation without touched paths.
  if (deliverableAllowsChatFinal(getDeliverableContract(taskState))) return true
  if (taskState.contract.touchedPaths.length > 0) return true
  return TASK_NO_CHANGE_NEEDED_RE.test(normalized)
}

function looksLikeCompleteTaskReport(taskState: ActiveTaskState, text: string): boolean {
  if (!hasCompletionIntent(text)) return false
  const hasInterimMarker = hasStrongInterimMarker(text)

  let evidence = 0
  if (hasCompletionReportFrame(text)) {
    evidence += 1
  }
  if (/\b(?:elapsed|duration|wall[- ]?clock|time spent|runtime)\b[^.!?\n]{0,80}\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|m|s)\b/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?)\b[^.!?\n]{0,80}\b(?:elapsed|duration|wall[- ]?clock|runtime)\b/i.test(text)
    || /(?:耗时|用时|持续|时长)[^。！？\n]{0,80}\d+(?:\.\d+)?\s*(?:秒|分钟|分)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:tools? used|tools? exercised)\b/i.test(text)
    || /(?:使用工具|工具使用)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:checks? performed|new checks? performed|tests? or checks?|coverage verified|verified|audited|analysis confirmed)\b/i.test(text)
    || /(?:检查|验证|审计)[^。！？\n]{0,80}(?:完成|通过|确认)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:checkpoint|checkpoints)\b[^.!?\n]{0,80}\b\d+\s*\/\s*\d+\b/i.test(text)
    || /\b\d+\s*(?:checkpoint|checkpoints)\b/i.test(text)
    || /\b(?:checkpoint list|checkpoints completed)\b/i.test(text)
    || /\b(?:todos?|to[- ]?dos?|checklist)\b[^.!?\n]{0,100}\b(?:done|complete|completed|checked|all)\b/i.test(text)
    || /(?:检查点|checkpoint)[^。！？\n]{0,80}\d+/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:tests?|test files?|vitest|npm test)\b[^.!?\n]{0,120}\b(?:passed|pass|green|0 failed|\d+\s*\/\s*\d+)\b/i.test(text)
    || /\b\d+\s*\/\s*\d+\b[^.!?\n]{0,80}\b(?:passed|pass|tests?)\b/i.test(text)
    || /(?:测试|用例)[^。！？\n]{0,120}(?:通过|passed|0 failed)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:cleanup|cleaned|removed|temp(?:orary)? directory|tmp)\b[^.!?\n]{0,100}\b(?:done|complete|completed|clean|removed|absent|verified)\b/i.test(text)
    || /\b(?:artifacts?|files?|temp(?:orary)? directory)\b[^.!?\n]{0,100}\b(?:removed|deleted|cleaned)\b/i.test(text)
    || /(?:清理|临时目录|tmp)[^。！？\n]{0,100}(?:完成|已清|不存在|删除|验证)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:fallback(?:Used)?|fallback status|fallback)\b[^.!?\n]{0,80}\b(?:false|no|none|not used|unused|未使用|没有)\b/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:files? changed|repo modifications?|repository modifications?|no repo modifications?|no files? changed|not modify repository files)\b/i.test(text)
    || /\b(?:repository state preserved|read[- ]?only|no edits?|no stages?|no stashes?|no changes made|no modifications made|untouched)\b/i.test(text)
    || /(?:文件改动|仓库改动|未修改|没有修改|无修改)/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:terminal rendering|rendering corruption|ansi|pty)\b[^.!?\n]{0,100}\b(?:none|no corruption|not observed|not detected|clean)\b/i.test(text)) {
    evidence += 1
  }
  if (/\b(?:blockers?|remaining risks?|remaining risk|residual risk|open risk|risk)\b/i.test(text)
    || /(?:阻塞|剩余风险|风险)/i.test(text)) {
    evidence += 1
  }
  if (taskState.contract.touchedPaths.length > 0) {
    evidence += 1
  }
  if (TASK_NO_CHANGE_NEEDED_RE.test(text)) {
    evidence += 1
  }

  return evidence >= (hasInterimMarker ? 4 : 3)
}

function hasCompletionIntent(text: string): boolean {
  return /\b(?:task (?:is )?(?:done|complete|completed)|completed|complete|finished|final report|final answer|addendum|all requirements (?:have been )?satisfied|nothing remaining|no remaining work|all set)\b/i.test(text)
    || /(?:任务(?:已)?完成|已完成|完成报告|最终报告|全部完成|无剩余任务|没有剩余任务)/i.test(text)
}

function hasCompletionReportFrame(text: string): boolean {
  return /\b(?:final report|final answer|dogfood (?:task )?addendum|task addendum|addendum)\b/i.test(text)
    || /(?:最终报告|完成报告|补充报告|附录)/i.test(text)
}

function hasStrongInterimMarker(text: string): boolean {
  return /\b(?:next i will|next we will|i(?:'|’)ll (?!now provide (?:the )?final (?:answer|report|addendum))|i will (?!now provide (?:the )?final (?:answer|report|addendum))|we will (?!now provide (?:the )?final (?:answer|report|addendum))|will now (?!provide (?:the )?final (?:answer|report|addendum))|going to|plan to|still need(?:s|ed)? to|need to (?:finish|implement|patch|fix|run)|not yet (?:done|complete|completed|finished|implemented|fixed|run|tested)|todo|to do|current status|in progress)\b/i.test(text)
    || /(?:下一步|接下来(?:我|我们)?(?:会|将)|还需要|仍需|尚未|计划|待办|进行中)/i.test(text)
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
export interface AutoCompactDecision {
  contextWindow: number
  totalTokens: number
  thresholdRatio: number
  thresholdTokens: number
  usageRatio: number
  turnCount: number
  keepCount: number
  shouldCompact: boolean
  reason: 'no_context_window' | 'below_threshold' | 'too_few_turns' | 'threshold'
}

export function getAutoCompactDecision(conversation: Conversation, contextWindow?: number): AutoCompactDecision {
  const window = contextWindow ?? 0
  const turnCount = conversation.turns.length
  const snapshot = buildContextBudgetSnapshot(conversation, window, {
    thresholdRatio: AUTO_COMPACT_THRESHOLD,
  })
  const keepCount = Math.max(2, Math.floor(turnCount * AUTO_COMPACT_KEEP_RATIO))

  if (window <= 0) {
    return {
      contextWindow: window,
      totalTokens: snapshot.usedTokens,
      thresholdRatio: AUTO_COMPACT_THRESHOLD,
      thresholdTokens: 0,
      usageRatio: 0,
      turnCount,
      keepCount,
      shouldCompact: false,
      reason: 'no_context_window',
    }
  }

  if (!snapshot.overThreshold) {
    return {
      contextWindow: window,
      totalTokens: snapshot.usedTokens,
      thresholdRatio: AUTO_COMPACT_THRESHOLD,
      thresholdTokens: snapshot.thresholdTokens,
      usageRatio: snapshot.usageRatio,
      turnCount,
      keepCount,
      shouldCompact: false,
      reason: 'below_threshold',
    }
  }

  if (turnCount <= 2) {
    return {
      contextWindow: window,
      totalTokens: snapshot.usedTokens,
      thresholdRatio: AUTO_COMPACT_THRESHOLD,
      thresholdTokens: snapshot.thresholdTokens,
      usageRatio: snapshot.usageRatio,
      turnCount,
      keepCount,
      shouldCompact: false,
      reason: 'too_few_turns',
    }
  }

  return {
    contextWindow: window,
    totalTokens: snapshot.usedTokens,
    thresholdRatio: AUTO_COMPACT_THRESHOLD,
    thresholdTokens: snapshot.thresholdTokens,
    usageRatio: snapshot.usageRatio,
    turnCount,
    keepCount,
    shouldCompact: true,
    reason: 'threshold',
  }
}

export function autoCompact(conversation: Conversation, contextWindow?: number): boolean {
  const decision = getAutoCompactDecision(conversation, contextWindow)
  if (!decision.shouldCompact) return false

  const keepCount = decision.keepCount
  conversation.turns = sanitizeConversationTurns(conversation.turns.slice(-keepCount))
  return true
}

/**
 * 0.13.62 heap-pressure emergency compact (A).
 *
 * Reads `process.memoryUsage().heapUsed` against
 * `v8.getHeapStatistics().heap_size_limit` (the real V8 heap ceiling,
 * usually ~4GB on 64-bit Node, configurable via `--max-old-space-size`).
 * Returns the current ratio as a number in [0, 1]. When ratio crosses
 * `HEAP_PRESSURE_THRESHOLD`, the conversation loop runs an aggressive
 * compact that's separate from the token-window compact path.
 *
 * Lifted out as a standalone helper (a) so tests can assert behavior
 * by stubbing the limit and (b) so the loop can call it cheaply once
 * per iteration without re-importing v8 each time.
 */
export function getHeapPressureRatio(
  memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
  heapLimit: () => number = () => v8.getHeapStatistics().heap_size_limit,
): number {
  const used = memoryUsage().heapUsed
  const limit = heapLimit()
  if (limit <= 0) return 0
  return used / limit
}

/**
 * 0.13.62: emergency heap compaction. Trims the conversation to the
 * last 20% of turns when heap pressure is high. Returns the new turn
 * count if compaction happened, otherwise null (no-op when below
 * threshold or already small enough).
 *
 * The 20% keep ratio is intentionally aggressive — when the host
 * process is genuinely at OOM risk the cost of dropping context is
 * trivial vs the cost of a hard crash that ends the session.
 */
export function emergencyHeapCompact(
  conversation: Conversation,
  ratio: number,
): { before: number; after: number } | null {
  if (ratio < HEAP_PRESSURE_THRESHOLD) return null
  const before = conversation.turns.length
  if (before <= 4) return null
  const keep = Math.max(2, Math.floor(before * HEAP_PRESSURE_KEEP_RATIO))
  if (keep >= before) return null
  conversation.turns = sanitizeConversationTurns(conversation.turns.slice(-keep))
  return { before, after: conversation.turns.length }
}

function formatTokenCount(tokens: number): string {
  return `${tokens.toLocaleString()} est. tokens`
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

function recordWriteTargetProvenanceEvents(options: {
  check: ReturnType<typeof evaluateWriteTargetProvenance>
  block: AnthropicToolUseBlock
  taskState: ActiveTaskState
  conversationId: string
  attempts: ToolAttemptSignature[]
}): void {
  const { check, block, taskState, conversationId, attempts } = options
  const base = {
    ts: Date.now(),
    conversationId,
    iteration: taskState.run.lifetimeIterations ?? 0,
    contract: buildGateEventContract(taskState),
    lastToolSignatures: lastNToolSignatures(attempts),
    toolName: block.name,
    ledgerSize: provenanceLedgerSize(taskState.provenanceLedger ?? { version: 1, recordsByPath: {} }),
  }

  if (check.bashUnparseable) {
    recordGateEvent({
      ...base,
      kind: 'path_provenance_bash_unparseable',
      attemptedPath: String((block.input as Record<string, unknown>)['command'] ?? ''),
      reason: 'bash command classified as filesystem-mutating but yielded no parsed write targets',
    })
  }

  for (const evaluation of check.evaluations) {
    if (!evaluation.admission.admitted) continue
    const eventKind = evaluation.admission.via === 'parent_listing'
      ? 'path_provenance_parent_admit'
      : 'path_provenance_admit_evidence'
    recordGateEvent({
      ...base,
      kind: eventKind,
      attemptedPath: evaluation.target.path,
      canonicalPath: evaluation.canonical,
      isNewFile: evaluation.isNewFile,
      via: evaluation.admission.via,
      authorizingKind: evaluation.admission.record?.kind,
      pathRecordCount: countAvailableRecords(evaluation.admission.availableRecords?.path),
    })
  }

  if (check.failures.length === 0) return

  const enabled = isGateProvenanceEnabled()
  const firstFailure = check.failures[0]!
  const denyFailure = check.failures.find(f => f.admission.denyActive === true)
  if (enabled && denyFailure) {
    const deny = denyFailure.admission.activeDenyRecord
    recordGateEvent({
      ...base,
      kind: 'path_provenance_deny_block',
      attemptedPath: denyFailure.target.path,
      canonicalPath: denyFailure.canonical,
      isNewFile: denyFailure.isNewFile,
      failedCount: check.failures.length,
      targetCount: check.targets.length,
      denyMarker: deny?.denyMarker,
      denyOriginIteration: deny?.originIteration,
      denyOriginalString: deny?.originalString,
      reason: formatProvenanceError(check.failures, formatterContext(block)),
    })
    return
  }

  recordGateEvent({
    ...base,
    kind: enabled ? 'path_provenance_block' : 'path_provenance_would_block',
    attemptedPath: firstFailure.target.path,
    canonicalPath: firstFailure.canonical,
    isNewFile: firstFailure.isNewFile,
    parentPath: firstFailure.isNewFile ? pathDirname(firstFailure.canonical) : undefined,
    failedCount: check.failures.length,
    targetCount: check.targets.length,
    availableRecordKinds: provenanceRecordKindCounts(firstFailure.admission.availableRecords),
    reason: formatProvenanceError(check.failures, formatterContext(block)),
  })
}

function countAvailableRecords(records: ProvenanceRecord[] | undefined): number {
  return records?.length ?? 0
}

function provenanceRecordKindCounts(
  availableRecords: ProvenanceTargetEvaluation['admission']['availableRecords'],
): GateEvent['availableRecordKinds'] {
  const counts: NonNullable<GateEvent['availableRecordKinds']> = {}
  for (const record of [...(availableRecords?.path ?? []), ...(availableRecords?.parent ?? [])]) {
    counts[record.kind] = (counts[record.kind] ?? 0) + 1
  }
  return counts
}

/**
 * Build the optional context object that `formatProvenanceError` consumes
 * for multi-target diagnostics. For bash tool calls, including the command
 * string lets the formatter render the header line like
 * `Command \`tee a b > c\` writes to 3 paths; ...`. For Write/Edit/etc.,
 * no context is needed and the formatter omits the bash-specific header.
 */
function formatterContext(block: AnthropicToolUseBlock): { command?: string } {
  if (block.name.toLowerCase() === 'bash') {
    const cmd = (block.input as Record<string, unknown>)['command']
    if (typeof cmd === 'string' && cmd.length > 0) return { command: cmd }
  }
  return {}
}

function recordToolResultProvenance(
  taskState: ActiveTaskState,
  block: AnthropicToolUseBlock,
  result: ToolExecutionResult,
): void {
  if (!taskState.provenanceLedger) return
  const ts = Date.now()
  const originIteration = taskState.run.lifetimeIterations ?? 0
  const extractions = extractPathsFromToolResult(
    block.name,
    block.input,
    result.result.output,
    result.result.isError,
    {
      cwd: taskState.contract.cwd,
      ts,
      originIteration,
    },
  )
  for (const extraction of extractions) {
    admitProvenanceRecord(taskState.provenanceLedger, extraction.path, {
      kind: extraction.kind,
      ts,
      originIteration,
      originalString: extraction.originalString,
      toolName: extraction.toolName,
      toolSucceeded: extraction.toolSucceeded,
    })
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
  latestUserText?: string | null,
  conversationForGuard?: Conversation,
  interceptedIntents?: Set<string>,
  schemaFailCounts?: Map<string, number>,
): Promise<{ results: ToolExecutionResult[]; loopError?: string; terminalError?: string }> {
  const results: ToolExecutionResult[] = []
  const userIntent = latestUserText ? inferUserIntent(latestUserText) : 'neutral'

  for (const block of blocks) {
    if (signal?.aborted) break

    // 0.13.62 (B): schema-fail dispatcher-level short-circuit. Pre-
    // flight check using the same checkers the tools themselves use.
    // If THIS call would produce a schema error AND we've already
    // seen the same (toolName, missingFields) shape fail once before
    // in this conversation, hard-terminate immediately. This bypasses
    // the 0.13.55 soft-intercept dedupe path which keys on intentKey
    // — empty input degenerates intentKey to e.g. `write:` and dodges
    // the second-hit escalation. The mionyee dogfood (2026-05-07)
    // showed kimi-code emitting `write({})` 8+ times past the soft
    // intercept; this catches that pattern at attempt 2.
    const schemaForecast = predictSchemaFailure(block.name, block.input as unknown)
    if (schemaForecast && schemaFailCounts) {
      const key = `${block.name}:${[...schemaForecast.missingFields].sort().join(',')}`
      const priorCount = schemaFailCounts.get(key) ?? 0
      if (priorCount >= 1) {
        const reason =
          `task stuck on repeated schema failures: tool ${block.name} called ` +
          `with the same missing required field(s) [${schemaForecast.missingFields.join(', ')}] ` +
          `${priorCount + 1} time(s). Hard-terminating to break the empty-input retry loop.`
        callbacks?.onError?.(reason)
        return { results, loopError: reason }
      }
      schemaFailCounts.set(key, priorCount + 1)
    }

    const nextAttempt = buildToolAttempt(block.name, block.input)
    const loopError = isToolLoopGuardEnabled() ? detectToolLoop(attempts, nextAttempt) : null
    if (loopError) {
      const mode = getLoopInterceptMode()
      const alreadyIntercepted = interceptedIntents?.has(nextAttempt.intentKey) === true
      // 0.13.55: soft intercept. First hit per intentKey synthesizes a
      // tool_result demanding root-cause + patch proposal + user-query
      // (no terminate). Second hit on the same intentKey escalates to
      // the legacy hard-terminate path.
      if (mode === 'soft' && !alreadyIntercepted) {
        interceptedIntents?.add(nextAttempt.intentKey)
        callbacks?.onNotice?.(`Loop intercept (soft): ${loopError}`)
        // Record the attempt so subsequent loop-guard checks see it
        // and so the second-hit hard-terminate can fire.
        recordToolAttempt(attempts, { ...nextAttempt, isError: true })
        results.push({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: buildLoopInterceptPrompt(loopError, nextAttempt),
            isError: true,
            metadata: {
              loopIntercept: true,
              loopReason: loopError,
              intentKey: nextAttempt.intentKey,
            },
          },
          durationMs: 0,
        })
        // Stop processing remaining tool_use blocks this turn — the
        // model needs to respond to the intercept first.
        break
      }
      callbacks?.onError?.(loopError)
      return { results, loopError }
    }

    // Analysis-intent guard (0.13.48; bash + TaskCreate + probe-consent
    // override added 0.13.52; ProbePlan-allowlist mode added 0.13.53):
    // refuse mutating tool calls — write, edit, NotebookEdit, bash-
    // with-mutating-command, TaskCreate-with-mutating-command — when
    // the user's most recent message reads as analysis-only OR when
    // a ProbePlan is registered and the call doesn't match any probe.
    // Calls matching an unsatisfied registered probe are always
    // allowed (registration = explicit consent for that shape).
    // Explicit operating modes (OWLCODA_MODES). The mode gate runs before the
    // intent guard but is additive — it never bypasses the downstream
    // provenance / write-scope / permission gates below.
    const modesOn = isModesEnabled()
    const mode = modesOn
      ? (conversationForGuard?.options?.operatingModeState?.mode ?? 'normal')
      : 'normal'
    if (modesOn) {
      const modeViolation = evaluateModeGate(mode, block.name, block.input)
      if (modeViolation) {
        recordGateEvent({
          ts: Date.now(),
          kind: 'mode_gate_block',
          conversationId: conversationForGuard?.id ?? '',
          iteration: taskState?.run.lifetimeIterations ?? 0,
          contract: taskState ? buildGateEventContract(taskState) : undefined,
          lastToolSignatures: lastNToolSignatures(attempts),
          operatingMode: modeViolation.mode,
          toolName: modeViolation.toolName,
          reason: modeViolation.reason,
        })
        results.push({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: modeViolation.reason,
            isError: true,
            metadata: {
              modeGateBlocked: true,
              mode: modeViolation.mode,
              toolName: modeViolation.toolName,
            },
          },
          durationMs: 0,
        })
        continue
      }
    }

    const hasActiveProbePlan =
      (conversationForGuard?.options?.probePlans?.length ?? 0) > 0
    const intentViolation = evaluateIntentGuard(
      block.name,
      userIntent,
      block.input,
      conversationForGuard
        ? (toolName: string, input: Record<string, unknown>) => {
            const match = findMatchingUnsatisfiedProbe(conversationForGuard, toolName, input)
            return match ? { groupId: match.groupId, probeId: match.probe.id } : null
          }
        : undefined,
      hasActiveProbePlan,
    )
    // Under OWLCODA_MODES the explicit mode is the boundary: an inferred
    // analysis-only intent is softened to an advisory hint (not a block); the
    // ProbePlan allowlist (reasonKind 'probeplan') stays a hard block.
    if (intentViolation && !(modesOn && intentViolation.reasonKind === 'analysis')) {
      results.push({
        toolUseId: block.id,
        toolName: block.name,
        result: {
          output: intentViolation.reason,
          isError: true,
          metadata: {
            intentGuardBlocked: true,
            userIntent: intentViolation.intent,
            toolName: intentViolation.toolName,
          },
        },
        durationMs: 0,
      })
      continue
    }
    // Softened case: under modes an analysis-only intent becomes an advisory
    // hint (the call proceeds). Record the divergence — the legacy guard would
    // have hard-blocked this exact call.
    if (intentViolation && modesOn && intentViolation.reasonKind === 'analysis') {
      recordGateEvent({
        ts: Date.now(),
        kind: 'mode_analysis_hint',
        conversationId: conversationForGuard?.id ?? '',
        iteration: taskState?.run.lifetimeIterations ?? 0,
        contract: taskState ? buildGateEventContract(taskState) : undefined,
        lastToolSignatures: lastNToolSignatures(attempts),
        operatingMode: mode,
        toolName: intentViolation.toolName,
        reason: intentViolation.reason,
        modeWouldBlockLegacy: true,
      })
    }

    const projectMapBoundaryBlock = evaluateProjectMapBoundaryBlock(
      conversationForGuard,
      block.name,
      block.input,
      taskState?.contract.cwd ?? process.cwd(),
    )
    if (projectMapBoundaryBlock) {
      recordGateEvent({
        ts: Date.now(),
        kind: 'project_map_boundary_block',
        conversationId: conversationForGuard?.id ?? '',
        iteration: taskState?.run.lifetimeIterations ?? 0,
        contract: taskState ? buildGateEventContract(taskState) : undefined,
        lastToolSignatures: lastNToolSignatures(attempts),
        toolName: block.name,
        canonicalPath: projectMapBoundaryBlock.targetPath,
        attemptedPath: projectMapBoundaryBlock.boundary.path,
        failedCount: 1,
        targetCount: projectMapBoundaryBlock.targetCount,
        reason: projectMapBoundaryBlock.reason,
      })
      results.push({
        toolUseId: block.id,
        toolName: block.name,
        result: {
          output: projectMapBoundaryBlock.reason,
          isError: true,
          metadata: {
            projectMapBoundaryBlocked: true,
            boundaryKind: projectMapBoundaryBlock.boundary.kind,
            boundaryPath: projectMapBoundaryBlock.boundary.path,
            targetPath: projectMapBoundaryBlock.targetPath,
          },
        },
        durationMs: 0,
      })
      continue
    }

    if (taskState?.provenanceLedger) {
      // PERM-6: weave settings.json rules into the gate decision via a
      // per-call compileRules callback. Only fires when the task has any
      // enforced rule on either side — saves work when settings are empty.
      const rules = taskState.resolvedPermissions
      // PERM-7: emit load-time warnings as telemetry. Dedupe on the
      // resolvedPermissions object identity so we emit once per task
      // derive, not once per tool call. (Same warnings fire for every
      // tool block within the same task otherwise.)
      if (rules && rules.warnings.length > 0 && !emittedPermissionWarnings.has(rules)) {
        emittedPermissionWarnings.add(rules)
        const base = {
          ts: Date.now(),
          conversationId: conversationForGuard?.id ?? '',
          iteration: taskState.run.lifetimeIterations ?? 0,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(attempts),
        }
        for (const warning of rules.warnings) {
          recordGateEvent({
            ...base,
            kind: 'path_provenance_rule_warning',
            ruleWarningReason: warning.reason,
            ruleWarningRaw: warning.raw,
            ruleWarningSource: warning.source,
            reason: warning.message,
          })
        }
      }
      const hasEnforcedRules = rules
        ? rules.deny.some(r => r.enforced) || rules.allow.some(r => r.enforced)
        : false
      const homeDir = homedir()
      const provenanceCheck = evaluateWriteTargetProvenance(
        block.name,
        block.input,
        taskState.provenanceLedger,
        taskState.contract.cwd,
        hasEnforcedRules && rules
          ? {
              homeDir,
              compileRules: (toolName, canonicalPath) =>
                compileRulesForTarget(
                  rules,
                  toolName,
                  canonicalPath,
                  taskState.contract.cwd,
                  homeDir,
                ),
            }
          : undefined,
      )
      recordWriteTargetProvenanceEvents({
        check: provenanceCheck,
        block,
        taskState,
        conversationId: conversationForGuard?.id ?? '',
        attempts,
      })
      if (isGateProvenanceEnabled() && provenanceCheck.failures.length > 0) {
        const message = formatProvenanceError(provenanceCheck.failures, formatterContext(block))
        results.push({
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: message,
            isError: true,
            metadata: {
              writeTargetProvenanceBlocked: true,
              failedCount: provenanceCheck.failures.length,
              targetCount: provenanceCheck.targets.length,
            },
          },
          durationMs: 0,
        })
        continue
      }
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
        recordGateEvent({
          ts: Date.now(),
          kind: 'write_scope_block',
          conversationId: conversationForGuard?.id ?? '',
          iteration: taskState.run.lifetimeIterations ?? 0,
          contract: buildGateEventContract(taskState),
          lastToolSignatures: lastNToolSignatures(attempts),
          reason: guardViolation.message,
        })
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

    // --- Slice 1: shadow-record proposal (only when taskState is present) ---
    const proposedToolCall = taskState
      ? recordProposal(taskState.proposedToolCalls, {
          tool: block.name,
          riskClass: classifyToolRisk(block.name, block.input as Record<string, unknown>),
          iteration: taskState.run.lifetimeIterations ?? 0,
          toolUseId: block.id,
        })
      : null
    if (taskState) {
      recordToolPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'tool_proposed', block.name, block.id)
    }

    // Ask for approval if callback is provided AND the tool requires permission.
    // When proposedToolCall is null (no taskState), fall back to legacy behavior:
    // always consult the approval callback for any tool dispatch.
    const needsApproval = proposedToolCall
      ? proposedToolCall.permissionState === 'needed'
      : true

    // auto mode: silently grant low-risk approvals. This sits AFTER the four
    // hard gates above (mode / intent / provenance-deny / write-scope), so it
    // can only remove the prompt — never bypass a deny.
    const modeRiskClass = classifyToolRisk(block.name, block.input as Record<string, unknown>)
    const autoApproveByMode = evaluateAutoApproval(mode, modeRiskClass)

    if (callbacks?.onToolApproval && needsApproval && !autoApproveByMode) {
      if (proposedToolCall && taskState) {
        recordPermissionRequested(proposedToolCall)
        recordPermissionPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'permission_requested', block.name)
      }
      const approved = await callbacks.onToolApproval(block.name, block.input)
      if (!approved) {
        if (proposedToolCall && taskState) {
          recordPermissionDenied(proposedToolCall)
          recordPermissionPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'permission_denied', block.name)
        }
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
      if (proposedToolCall && taskState) {
        recordPermissionGranted(proposedToolCall, {
          mode: 'user_prompt',
          iteration: taskState.run.lifetimeIterations ?? 0,
        })
        recordPermissionPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'permission_granted', block.name)
      }
    } else if (callbacks?.onToolApproval && needsApproval && autoApproveByMode) {
      // auto mode auto-grant: no prompt. Recorded as auto_approve so the
      // permission lifecycle still advances to 'granted'.
      if (proposedToolCall && taskState) {
        recordPermissionGranted(proposedToolCall, {
          mode: 'auto_approve',
          iteration: taskState.run.lifetimeIterations ?? 0,
        })
        recordPermissionPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'permission_granted', block.name)
      }
      recordGateEvent({
        ts: Date.now(),
        kind: 'mode_auto_approve',
        conversationId: conversationForGuard?.id ?? '',
        iteration: taskState?.run.lifetimeIterations ?? 0,
        contract: taskState ? buildGateEventContract(taskState) : undefined,
        lastToolSignatures: lastNToolSignatures(attempts),
        operatingMode: 'auto',
        toolName: block.name,
        modeRiskClass,
      })
    } else if (proposedToolCall && taskState && proposedToolCall.permissionState === 'needed') {
      // No approval callback → headless/auto path. Treat as auto_approve so
      // the lifecycle progresses to 'granted' and downstream evidence/predicate
      // logic works uniformly across surfaces.
      recordPermissionGranted(proposedToolCall, {
        mode: 'auto_approve',
        iteration: taskState.run.lifetimeIterations ?? 0,
      })
      recordPermissionPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'permission_granted', block.name)
    }

    callbacks?.onToolStart?.(block.name, block.input)

    // --- Slice 1: shadow-record execution start (guarded; taskState may be undefined) ---
    if (proposedToolCall && taskState) {
      recordExecutionStart(proposedToolCall, taskState.run.lifetimeIterations ?? 0)
      recordToolPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'tool_started', block.name, block.id)
    }

    // Build execution context with progress + user-question callbacks
    // bound to this tool's identity. Both are optional: well-behaved
    // tools degrade gracefully when a callback is absent (headless).
    const context: {
      onProgress?: (event: ToolProgressEvent) => void
      signal?: AbortSignal
      taskState?: ActiveTaskState
      projectMapSnapshot?: ProjectMapSnapshot
      askUserQuestion?: (question: string, opts?: AskUserQuestionOpts) => Promise<string>
    } = { signal, taskState, projectMapSnapshot: conversationForGuard?.options?.projectMapSnapshot }
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

    if (taskState) {
      recordToolResultProvenance(taskState, block, result)
    }

    // --- Slice 1: shadow-record settlement + post-grant evidence (guarded) ---
    if (proposedToolCall && taskState) {
      recordSettlement(proposedToolCall, taskState.run.lifetimeIterations ?? 0)
      recordToolPhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'tool_completed', block.name, result.result.isError ? 'error' : 'ok')
      if (!result.result.isError) {
        const filePath = extractToolEvidencePath(block.input as Record<string, unknown>)
        // touchedPaths is stored in canonical absolute form (see task-state's
        // dedupeStrings → canonicalizePath). Resolve the raw file_path against
        // the contract cwd before checking membership so relative paths still
        // match. The evidence detail keeps the raw arg to remain readable.
        const fpAbsolute = typeof filePath === 'string'
          ? (pathIsAbsolute(filePath) ? filePath : pathResolve(taskState.contract.cwd, filePath))
          : null
        const fpCanonical = fpAbsolute === null ? null : canonicalizeToolEvidencePath(fpAbsolute)
        const touched = fpCanonical !== null
          && taskState.contract.touchedPaths.some((p) => p === fpCanonical || p === fpAbsolute || p === filePath)
        if (typeof filePath === 'string' && touched) {
          recordPostGrantEvidence(proposedToolCall, {
            kind: 'touched_path',
            detail: filePath,
          })
          recordPostGrantEvidencePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'touched_path', filePath)
        } else if (proposedToolCall.riskClass === 'external_effect') {
          recordPostGrantEvidence(proposedToolCall, {
            kind: 'tool_completion',
            detail: `${block.name} returned without error`,
          })
          recordPostGrantEvidencePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, 'tool_completion', `${block.name} returned without error`)
        }
        if (block.name === 'DeliveryAudit' || block.name === 'TaskVerify' || block.name === 'ArtifactVerify') {
          recordVerificationEvidencePhaseEvent(taskState, taskState.run.lifetimeIterations ?? 0, block.name, `${block.name} returned without error`)
        }
      }
    }

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
      // failureCategory captures both deterministic failures AND
      // no-progress success patterns (e.g. Skill({list}) returning an empty
      // registry — the call "succeeded" but there is nothing the next
      // run/info call can do). Both feed the loop guard's same-class
      // counter so the model can't dodge the guard by alternating empty
      // success and validation failures.
      //
      // 2026-05-28 sub-agent isolation contract alignment: when a sub-agent
      // returns isolated failure (metadata.subAgentIsolatedFailure=true),
      // skip recording its failureCategory so detectToolLoop's same-class
      // counter does not count it. Rationale: an isolated sub-agent failure
      // is a structured event delivered to the parent LLM for routing
      // (retry/skip/abort), not "the parent is stuck calling the same tool
      // repeatedly". The parent fan-outing N different sub-agents and seeing
      // 3 of them fail is normal hierarchical-orchestrator behaviour, not a
      // loop. The other loop-guard signals (signature + intentKey-based)
      // still fire if the parent actually re-issues the SAME Agent call
      // (same prompt/description) — those keep working because intentKey
      // includes the input shape, so 3 different sub-agent prompts stay
      // distinct from 3 retries of the same prompt.
      const isSubAgentIsolatedFailure =
        result.result.metadata?.['subAgentIsolatedFailure'] === true
      const rawFailureCategory = result.result.metadata?.['failureCategory']
      const failureCategory =
        !isSubAgentIsolatedFailure &&
        typeof rawFailureCategory === 'string' &&
        rawFailureCategory.length > 0
          ? rawFailureCategory
          : undefined
      recordToolAttempt(attempts, {
        ...nextAttempt,
        isError: result.result.isError,
        failureCategory,
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
    if (result.result.metadata?.['terminalToolFailure'] === true) {
      const reason = typeof result.result.metadata['terminalFailureReason'] === 'string'
        ? result.result.metadata['terminalFailureReason']
        : `${block.name} reported a terminal failure.`
      callbacks?.onError?.(reason)
      return { results, terminalError: reason }
    }
  }

  return { results }
}

function extractToolEvidencePath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function canonicalizeToolEvidencePath(pathToCheck: string): string {
  const resolved = pathResolve(pathToCheck)
  try {
    return pathNormalize(realpathSync.native(resolved))
  } catch {
    const parent = pathDirname(resolved)
    if (parent === resolved) return pathNormalize(resolved)
    const canonicalParent = canonicalizeToolEvidencePath(parent)
    return pathNormalize(pathResolve(canonicalParent, pathBasename(resolved)))
  }
}

function buildToolAttempt(
  name: string,
  input: Record<string, unknown>,
  isError = false,
  metadata?: Record<string, unknown>,
): ToolAttemptSignature {
  const category = toolCategory(name)
  const target = toolTarget(name, input)
  const intentTarget = toolIntentTarget(name, input)
  const rawFailureCategory = metadata?.['failureCategory']
  const failureCategory =
    isError && typeof rawFailureCategory === 'string' && rawFailureCategory.length > 0
      ? rawFailureCategory
      : undefined
  return {
    name,
    category,
    failureCategory,
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

  // Progress-signal v2: bash remains exempt from intent/category heuristics,
  // but exact call-level failure dedup is allowed. This matches the real
  // failure we want to catch: the same generated script command returning the
  // same SyntaxError for a third time. Exact signatures include the full
  // command hash, so different diagnostic/smoke commands stay distinct.
  const sameFailures = recent.filter((a) => a.signature === next.signature && a.isError)
  if (sameFailures.length >= 2) {
    const targetLabel = next.target && next.target.length > 0
      ? next.target
      : `tool=${next.name}`
    return `task stuck in tool loop: repeated failing ${next.category} attempts on ${targetLabel}`
  }

  if (next.category !== 'bash') {
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

    const sameIntentFailures = recent.filter((a) => a.intentKey === next.intentKey && a.isError)
    if (sameIntentFailures.length >= 3) {
      const intentLabel = next.intentTarget && next.intentTarget.length > 0
        ? next.intentTarget
        : `tool=${next.name}`
      return `task stuck in tool loop: repeated failing ${next.category} attempts on ${intentLabel}`
    }
  }

  // Semantic-failure guard. The strongest detector: a model varies the
  // input shape across calls so signature / intent never repeats, but
  // every variant produces the SAME failure class as classified by the
  // tool itself (metadata.failureCategory). Three same-class events on
  // the same tool within the window is "no-progress, please stop".
  //
  // Detector runs BEFORE the next tool executes, so we don't yet know
  // next.failureCategory. Instead we look across `recent` (already-executed
  // attempts) for any (toolName, failureCategory) pair whose count >= 3.
  // If found, the LLM has already accumulated three same-class events
  // and the next attempt is forbidden regardless of whether it's the same
  // class or not — the model is clearly stuck.
  //
  // Catches patterns like:
  //   Skill({action:'list'})                   -> skill:registry-empty
  //   Skill({action:'run'})                    -> skill:missing-name
  //   Skill({action:'info'})                   -> skill:missing-name
  //   Skill({action:'run',  name:'a'})         -> skill:not-found
  //   Skill({action:'info', name:'a'})         -> skill:not-found
  //   Skill({action:'list', name:'b'})         -> skill:registry-empty (again)
  // 0.13.40 onward, the Skill tool reports four distinct subcategories
  // (registry-empty, invalid-action, missing-name, not-found) so legitimate
  // negative testing across distinct error paths doesn't aggregate into a
  // single counter — one-of-each is exploration, three-of-the-same is a
  // loop. The detector treats each subcategory independently; a real
  // cycling pattern still trips because the dominant terminal error
  // (usually `skill:not-found`) accumulates as the model retries variants.
  //
  // Same-class events count regardless of isError. A "successful" empty
  // Skill list (isError=false but failureCategory set) is still
  // no-progress and feeds the same counter.
  const failureClassCounts = new Map<string, number>()
  for (const a of recent) {
    if (!a.failureCategory) continue
    const key = `${a.name}:${a.failureCategory}`
    failureClassCounts.set(key, (failureClassCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of failureClassCounts) {
    if (count >= 3) {
      return `task stuck in tool loop: ${count} same-class no-progress events for ${key}`
    }
  }

  // Multi-signature rotation + failure-rate fallback. Both window-based
  // detectors require category coherence to be meaningful: rotation
  // assumes the model is cycling through variants of the same logical
  // operation, and failure-rate assumes the failure population shares a
  // class. Cross-tool windows (e.g. 5 reads + 4 failing bashes) produce
  // false positives where each tool was actually making progress. Run
  // these guards only when the next attempt's category dominates the
  // window, and exclude bash entirely for the reasons documented above.
  if (next.category !== 'bash') {
    const window = [...recent, next]
    const sameCategory = window.filter((a) => a.category === next.category)
    if (sameCategory.length >= 12) {
      const uniqueSignatures = new Set(sameCategory.map((a) => a.signature))
      if (uniqueSignatures.size <= 4 && sameCategory.length >= uniqueSignatures.size * 3) {
        return `task stuck in tool loop: cycling through ${uniqueSignatures.size} ${next.category} signatures (${sameCategory.length} attempts)`
      }
    }

    if (sameCategory.length >= 9) {
      const failureCount = sameCategory.filter((a) => a.isError).length
      if (failureCount * 3 >= sameCategory.length * 2) {
        return `task stuck in tool loop: ${failureCount}/${sameCategory.length} recent ${next.category} attempts failed`
      }
    }
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
      return `${normalizeTargetPath(input['cwd'] ?? process.cwd())}#$${previewWithoutSplittingToken(normalizeWhitespace(String(input['command'] ?? '')), 120)}`
    default:
      return normalizeWhitespace(JSON.stringify(input)).slice(0, 120) || name
  }
}

function previewWithoutSplittingToken(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  while (end < text.length && /\S/.test(text[end]!)) {
    end++
  }
  return text.slice(0, end)
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
    case 'bash':
      return hashToolPayload(
        `cwd:${normalizeTargetPath(input['cwd'] ?? process.cwd())}\ncommand:${normalizeToolPayload(input['command'])}`,
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
    maxTokens: opts.maxTokens ?? resolveDefaultMaxOutputTokens(),
  }
}

/**
 * 0.13.65: per-response output token cap default.
 *
 * Background: 0.13.55-0.13.64 chased symptoms of model responses
 * being too long for one turn — heap pressure, output bloat, max-
 * tokens continuation handling. Then a 2026-05-07 industry survey
 * exposed the upstream cause: owlcoda's default of 4096 was an
 * outlier on the low end. Claude Code uses 32K, Aider 8K-32K per
 * model, opencode 32K. Every model in our supported matrix
 * (Claude 4.x, DeepSeek V4, Kimi K2, GPT-5, Gemini 2.5, Qwen 3)
 * supports ≥16K output natively; many support 32K-128K.
 *
 * 0.13.65 raises the default to 32,768 (matches Claude Code) and
 * exposes `OWLCODA_MAX_OUTPUT_TOKENS` as a per-session override.
 * Callers passing an explicit `opts.maxTokens` still win — the
 * resolver only applies to call sites that previously used the
 * `?? 4096` default.
 *
 * Trade-offs:
 *   - max_tokens is a CAP, not a target. Models stop at EOS; raising
 *     the cap doesn't increase generated tokens for short answers.
 *   - Cost unchanged (billed per actual output token).
 *   - Latency unchanged (cap doesn't add to per-token speed).
 *   - Reasoning models (Sonnet 4.6 / Haiku 4.5 thinking mode) count
 *     thinking tokens against max_tokens. 32K leaves ~16K visible
 *     output even with full thinking budget.
 *   - Models with hard ceilings below 32K (e.g. legacy GPT-4o at
 *     16K) clamp server-side; no client-side branching needed.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768

export function resolveDefaultMaxOutputTokens(): number {
  const raw = (process.env['OWLCODA_MAX_OUTPUT_TOKENS'] ?? '').trim()
  if (raw === '') return DEFAULT_MAX_OUTPUT_TOKENS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_OUTPUT_TOKENS
  }
  return Math.floor(parsed)
}

/** Add a user message to the conversation. */
export function addUserMessage(conversation: Conversation, text: string): void {
  conversation.turns.push({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}
