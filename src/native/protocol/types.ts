/**
 * OwlCoda Native Protocol Types
 *
 * Conversation-level types built on existing Anthropic protocol types.
 * These power the native conversation loop.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolDef,
  AnthropicToolUseBlock,
} from '../../types.js'
import type { ProposedToolCall, EditNowNudge, PhaseEvent } from './task-permission-types.js'
import type { ProvenanceLedgerData } from './write-provenance-types.js'
import type { ResolvedPermissions } from './permission-rule-types.js'
import type { OperatingModeState } from '../modes.js'
import type { ProjectMapSnapshot } from './project-map-types.js'
import type { ContextWindowConfidence, ContextWindowSource } from '../../model-capabilities.js'

// Re-export for convenience
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicTextBlock,
  AnthropicToolDef,
  AnthropicToolUseBlock,
}

/** A turn in the conversation (user or assistant). */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
  /** Exact model bound to this visible turn. Older sessions may not have it. */
  model?: string
  /** Runtime-only turns remain in provider history but are not user transcript messages. */
  audience?: 'user' | 'runtime'
  /** Timestamp when this turn was added */
  timestamp: number
}

/** Minimal persisted retry hint: enough to treat "继续" as retry on resume
 * without carrying the full runtime failure payload across restarts. */
export interface PendingRetryState {
  attemptCount: number
}

export type RuntimeRecoveryCheckpointKind =
  | 'long_task_checkpoint'
  | 'blocked_task_checkpoint'
  | 'child_run_synthesis_checkpoint'
  | 'long_task_synthesis_checkpoint'
  | 'long_task_replacement_checkpoint'
  | 'context_replacement_checkpoint'
  | 'verification_repair_checkpoint'
  | 'loop_intercept_closeout_checkpoint'

export type RuntimeEventCheckpointKind =
  | RuntimeRecoveryCheckpointKind
  | 'runtime_event_log_snapshot'

export type RuntimeRecoveryCheckpointDisposition =
  | 'active'
  | 'acknowledged'
  | 'resolved'
  | 'superseded'

export interface RunIdentity {
  threadId: string
  turnId?: string
  runId: string
}

export interface RuntimeFactRefs {
  threadId?: string
  turnId?: string
  runId?: string
  workCaseId?: string
  evidenceContextId?: string
  executionRunId?: string
  driverId?: string
  executionId?: string
  attemptId?: string
  driverSessionId?: string
  workspaceRunId?: string
  taskId?: string
  stepId?: string
  jobId?: string
  artifactId?: string
  artifactPath?: string
  workflowReceiptRef?: string
  workflowArtifactRefs?: string[]
  checkpointId?: string
  proofId?: string
  itemId?: string
  coveredIds?: string[]
}

export interface ConversationModelIdentity {
  id?: string
  label?: string
  backendModel?: string
  aliases?: string[]
  provider?: string
  endpoint?: string
  contextWindow?: number
  supportsImages?: boolean
}

export interface ConversationUsageTotals {
  inputTokens: number
  outputTokens: number
  requestCount: number
  startedAt: number | null
}

export interface ConversationContextCapability {
  model: string
  contextWindow: number
  source: ContextWindowSource
  confidence: ContextWindowConfidence
}

export interface RuntimeRecoveryCheckpointRecord {
  id: string
  kind: RuntimeRecoveryCheckpointKind
  generatedAt: string
  conversationId: string
  threadId?: string
  turnId?: string
  runId?: string
  factRefs?: RuntimeFactRefs
  disposition?: RuntimeRecoveryCheckpointDisposition
  dispositionUpdatedAt?: string
  dispositionReason?: string
  payload: Record<string, unknown>
  inspectCommands: string[]
}

export interface RuntimeRecoveryLedger {
  schemaVersion: 1
  updatedAt: string
  lastPromptedAt?: string
  checkpoints: RuntimeRecoveryCheckpointRecord[]
}

export type RuntimeEventKind =
  | 'turn_started'
  | 'item_started'
  | 'item_completed'
  | 'checkpoint_installed'
  | 'checkpoint_disposition_changed'
  | 'checkpoint_resolved'
  | 'runtime_intervention'
  | 'runtime_truth_report_recorded'
  | 'runtime_recovery_report_recorded'
  | 'turn_completed'

export interface RuntimeEventRecord {
  id: string
  seq: number
  kind: RuntimeEventKind
  at: string
  conversationId: string
  threadId?: string
  turnId?: string
  runId?: string
  itemId?: string
  checkpointId?: string
  checkpointKind?: RuntimeEventCheckpointKind
  factRefs?: RuntimeFactRefs
  contract?: RuntimeEventContract
  payload?: Record<string, unknown>
}

export interface RuntimeEventContract {
  schema_version: 1
  kind: 'runtime_event_contract'
  event_kind: RuntimeEventKind
  payload_schema: string
  validation_status: 'valid'
}

export interface RuntimeEventLog {
  schemaVersion: 1
  updatedAt: string
  nextSeq: number
  events: RuntimeEventRecord[]
}

export interface RuntimeTruthResumeState {
  checkpointId: string
  promptInjectedAt: string
  reportGate: 'pending' | 'satisfied' | 'ignored'
}

export type TaskPathScopeKind = 'file' | 'directory'
export type TaskPathScopeOrigin = 'explicit' | 'parent_directory' | 'derived_test' | 'touched' | 'user_approved' | 'user-external' | 'external_reference' | 'run_workspace'
export type TaskRunStatus = 'open' | 'blocked' | 'waiting_user' | 'drifted' | 'completed'

export type EvidencePersistenceOperation = 'todo_mirror' | 'artifact_record'

export interface EvidencePersistenceFailure {
  operation: EvidencePersistenceOperation
  runId: string
  runDir: string
  outputRoot: string
  toolUseId: string
  toolName: string
  error: {
    name: string
    message: string
  }
  evidenceCompleteness: 'incomplete'
  acceptanceImpact: 'blocking'
  at: string
}

export interface TaskPathScope {
  path: string
  kind: TaskPathScopeKind
  origin: TaskPathScopeOrigin
}

/**
 * Confidence in the parsed explicit write scope.
 *   high   — at least one user-external scope (ALLOW phrasing + absolute external path),
 *            OR at least two explicit absolute-path scopes. Parser confidence is strong.
 *   medium — explicit_paths mode, allowedWritePaths non-empty, but only short-name or
 *            single explicit scope. Parser may have misclassified.
 *   low    — explicit_paths mode with empty allowedWritePaths, or workspace mode.
 *            Contract parsing did not yield reliable scope signal.
 */
export type TaskContractScopeConfidence = 'high' | 'medium' | 'low'

export interface TaskContract {
  version: 1
  sourceTurnHash: string
  sourceText: string
  objective: string
  dominantGap: string | null
  cwd: string
  scopeMode: 'workspace' | 'explicit_paths'
  explicitWriteTargets: string[]
  allowedWritePaths: TaskPathScope[]
  touchedPaths: string[]
  initialDirtyPaths?: string[]
  createdPaths?: string[]
  modifiedPaths?: string[]
  createdAt: number
  updatedAt: number
  /**
   * Parser confidence in allowedWritePaths. Used by the fail-open gate:
   * task_no_progress hard-stop only fires when confidence='high'. Medium/low
   * paths record telemetry and continue rather than hard-stopping on potentially
   * mis-parsed scope. Added 0.14.18.
   */
  confidence: TaskContractScopeConfidence
}

export interface TaskRunState {
  status: TaskRunStatus
  iterations: number
  // 0.13.67: monotonic counter incremented once per `markTaskIteration`
  // call. Distinct from `iterations`, which reflects the closure-local
  // iter count of the current `runConversationLoop` invocation and
  // therefore resets to 0 across runtime auto-retries. Loop guards
  // that need to detect "task has had N attempts to make progress"
  // must read `lifetimeIterations` — the closure counter is blind to
  // retry-driven re-entry. Optional for backward-compat with existing
  // serialized session state; treat missing as 0.
  lifetimeIterations?: number
  // 0.13.70 execution_economics_v1: production_gate_v1.
  // One-shot flag — once the runtime has injected the
  // `[Runtime production gate]` nudge for this task, don't fire it
  // again. Reset implicitly when the task changes (new sourceTurnHash
  // via ensureTaskExecutionState rebuilds the run state).
  productionGateFired?: boolean
  // One-shot flag (0.14.54) — fire the demoted no-progress advisory notice +
  // its `task_no_progress_suppressed` shadow telemetry once per task, not on
  // every iteration past the threshold. Reset implicitly when the task changes
  // (new run state via ensureTaskExecutionState).
  noProgressAdvisoryFired?: boolean
  /**
   * Slice 2: at most one EditNowNudge waiting to be injected as a
   * runtime user turn at the top of the next conversation iteration.
   * Set by the abandoned-grant predicate; consumed and cleared by the
   * dispatch loop just before the next model call.
   */
  editNowNudgePending?: EditNowNudge
  /**
   * Slice 2: monotonic list of grant timestamps that have already been
   * edit_now-nudged. Predicate consults this to decide whether to
   * nudge-again or hard-stop. One entry per grant; never cleared inside
   * a turn (the grant only exists once).
   */
  editNowNudgedGrantTs?: number[]
  // Progress-signal v2: bash-like commands may create a concrete scratch
  // artifact (for example `/tmp/gen_ppt.py`) before the command exits with a
  // repairable error. Scratch artifacts are progress signals, not durable
  // deliverables, so they are kept out of `contract.touchedPaths`.
  scratchArtifactPaths?: string[]
  lastArtifactProgressIteration?: number
  currentFocus: string | null
  lastProgressAt: number
  lastGuardReason: string | null
  pendingWriteApproval?: {
    attemptedPaths: string[]
    requestedAt: number
  } | null
  crossRepoBoundaryCheckpoint?: CrossRepoBoundaryCheckpoint | null
  runWorkspace?: {
    runId: string
    outputRoot: string
    runDir: string
    manifestPath: string
    checkpointPath?: string
    artifactsPath?: string
    eventsPath?: string
    createdAt: string
    taskFamily?: string
    deliverableMode?: string
    artifactCount?: number
    lastEventAt?: string
    lastCheckpointAt?: string
  } | null
  evidencePersistenceFailures?: EvidencePersistenceFailure[]
  lastUpdatedAt: number
}

export type CrossRepoBoundaryCheckpointStatus = 'pending' | 'confirmed'

export interface CrossRepoBoundaryDirtySummary {
  count: number
  sample: string[]
  truncated: boolean
}

export interface CrossRepoBoundaryCheckpoint {
  status: CrossRepoBoundaryCheckpointStatus
  currentRepo: string
  promptSource: string
  promptSourceRepo: string | null
  targetRepo: string
  branch: string | null
  dirtyWorktreeSummary: CrossRepoBoundaryDirtySummary | null
  plannedWriteRoots: string[]
  risk: string
  requiredUserConfirmation: string
  installedAt: number
  confirmedAt?: number
}

export interface TaskExecutionState {
  contract: TaskContract
  run: TaskRunState
  /**
   * Slice 1: per-turn record of tool calls the assistant has proposed.
   * Populated by the conversation dispatch loop (shadow recording);
   * consumed by the abandoned-grant predicate (Slice 2) when
   * OWLCODA_GATE_V2=1. Reset between user turns via deriveTaskExecutionState.
   */
  proposedToolCalls: ProposedToolCall[]
  /**
   * Phase-aware runtime Slice 1: append-only shadow event ledger used to
   * derive task phase in later slices. This is recorded but not read by
   * behavior-changing gates yet.
   */
  phaseEvents: PhaseEvent[]
  /**
   * Write-target provenance Slice 0: serializable ledger data only.
   * Runtime helpers live in ../write-provenance.ts and must not be imported
   * into this protocol module.
   */
  provenanceLedger?: ProvenanceLedgerData
  /**
   * PERM-6: settings.json-driven permission rules loaded at task start.
   * Used by the gate to compile per-target synthetic deny / admit records
   * (see permission-rules.ts compileRulesForTarget). Re-derived on every
   * task state derivation so users who edit settings mid-conversation see
   * changes on the next task. Not cloned to subagents — they reload their
   * own settings from the same files (and may have project overrides if
   * launched with a different cwd).
   */
  resolvedPermissions?: ResolvedPermissions
}

/** Runtime options for conversation behavior. */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface ConversationOptions {
  /** Enable extended thinking mode. */
  thinking?: boolean
  /** Session title (user-assigned). */
  title?: string
  /** Per-tool approval list (tool names always approved). */
  alwaysApprove?: Set<string>
  /** Brief response mode — ask the model to be concise. */
  brief?: boolean
  /** Fast mode — prioritize speed over depth. */
  fast?: boolean
  /** Effort level: low, medium, high. */
  effort?: string
  /** Provider-native reasoning effort selected for this conversation. */
  reasoningEffort?: ReasoningEffort
  /** Model identity and declared capabilities captured when the session starts. */
  modelIdentity?: ConversationModelIdentity
  /** Cumulative usage restored across native REPL process boundaries. */
  usageTotals?: ConversationUsageTotals
  /** Model-bound context denominator captured for stable resume rails. */
  contextCapability?: ConversationContextCapability
  /** Internal high/low-water state for rolling context hygiene. */
  contextHygieneActive?: boolean
  /** Vim keybinding mode. */
  vimMode?: boolean
  /** Additional working directories. */
  additionalDirs?: string[]
  /** Persisted retry flag — set whenever the last assistant response failed
   *  pre-first-token, cleared on any other outcome. When present on a resumed
   *  session, "继续 / continue" is treated as "retry last request". */
  pendingRetry?: PendingRetryState
  /** Persistent task contract + runtime state for long-running execution. */
  taskState?: TaskExecutionState
  /** Durable runtime recovery checkpoints for resume-safe long-task state. */
  runtimeRecoveryLedger?: RuntimeRecoveryLedger
  /** Minimal runtime truth event stream used by checkpoint reconstruction. */
  runtimeEventLog?: RuntimeEventLog
  /** Pending runtime-truth resume snapshot grounding state for no-tool reports. */
  runtimeTruthResume?: RuntimeTruthResumeState
  /**
   * Active probe plans registered via the `ProbePlan` tool (0.13.51).
   * The conversation loop scans tool executions to mark each probe
   * `satisfied`, and the runtime injects `[Runtime probe-coverage check]`
   * when a model attempts a final summary while any registered probe
   * is unsatisfied. Plans live for the conversation's lifetime —
   * registering a new one with the same `groupId` replaces.
   */
  probePlans?: ProbePlanState[]
  /**
   * Active operating mode (default-on unless OWLCODA_MODES=0). Read by the mode gate in
   * the dispatch loop; `plan` hard-blocks mutating tool calls. Conversation-
   * visible + mutable (set by /mode, --mode, or settings in Slice C). Absent ⇒
   * treated as `normal`.
   */
  operatingModeState?: OperatingModeState
  /**
   * Project Map / Runtime Harness Slice C: cached read-only project snapshot.
   * Populated when Project Map is enabled (default-on; OWLCODA_PROJECT_MAP=0
   * disables) so repeated iterations do not rescan the project.
   */
  projectMapSnapshot?: ProjectMapSnapshot
  /**
   * Compact prompt-ready rendering derived from `projectMapSnapshot`.
   * The request builder only appends this when Project Map is enabled.
   */
  projectMapPromptSummary?: string
  /**
   * Context-pressure nudge thresholds (0.13.58) that have already
   * fired this session. The conversation loop watches the post-
   * compact usage ratio and injects a `[Runtime context-pressure
   * check]` once when crossing each threshold (e.g. 0.6, 0.85),
   * prompting the model to lead with the key fact, batch tool
   * calls, and bias toward terse replies. Stored as an array (not a
   * Set) so it round-trips cleanly through session JSON
   * persistence.
   */
  contextPressureNudgesFired?: number[]
  /**
   * 0.13.98 Batch B: counter of consecutive LLM-compaction failures in
   * this session. tryCompact disables LLM and goes straight to truncation
   * once this hits MAX_CONSECUTIVE_LLM_COMPACT_FAILURES (3). A successful
   * compact resets it to 0 (not a permanent penalty — just protection
   * against persistent provider trouble during long sessions).
   */
  llmCompactFailureCount?: number
  /**
   * 0.13.98 Batch B: ring buffer of recent compaction events (≤5 entries),
   * used as in-memory telemetry for debugging. Each entry records reason
   * (threshold/hard_limit/context_exceeded/heap_pressure), method
   * (llm_summary/truncation), optional fallbackReason, ms duration, and
   * timestamp. Round-trips through session JSON persistence.
   */
  compactionLog?: CompactionLogEntry[]
}

/** 0.13.98 Batch B: single entry in the compaction telemetry ring buffer.
 *  Stored on `ConversationOptions.compactionLog`. */
export interface CompactionLogEntry {
  reason: 'threshold' | 'hard_limit' | 'context_exceeded' | 'heap_pressure'
  method: 'llm_summary' | 'truncation' | 'no_op'
  fallbackReason?:
    | 'llm_compact_failed'
    | 'llm_compact_disabled_3strikes'
    | 'heap_pressure_skip_llm'
    | 'no_llm_opts'
  /** ms taken by the LLM attempt (omitted for pure-truncation paths). */
  ms?: number
  /** epoch ms when the compaction was attempted. */
  at: number
}

/**
 * What the registered probe expects to see when fired.
 *   - 'success' (default): the tool_use must complete with isError === false.
 *     This is the historical 0.13.51 behavior — covers positive probes
 *     ("the agent must actually emit this write").
 *   - 'intentGuardBlocked': the tool_use must be emitted AND the resulting
 *     tool_result must carry `metadata.intentGuardBlocked === true`. Added
 *     0.13.54 to close the negative-probe escape: under v2.4 hostile QA
 *     both DeepSeek and Kimi pattern-matched "this should be denied" →
 *     skipped emitting A_LEAK → fabricated guard-fire evidence in the
 *     summary. With this enum, runtime probe-coverage check keeps
 *     listing the negative probe as unsatisfied until the agent actually
 *     emits the call and the guard catches it.
 */
export type ProbeExpectedOutcome = 'success' | 'intentGuardBlocked'

export interface ProbePlanProbe {
  /** Stable id, e.g. "A0", "A1" — used in the inject message. */
  id: string
  /** Tool name expected to fire (e.g. "write", "bash"). */
  tool: string
  /**
   * Substring that MUST appear in the input JSON for the probe to be
   * considered satisfied. As of 0.13.53 the matcher walks string-valued
   * leaves directly (escaping-aware), not JSON.stringify substring.
   */
  mustContain: string
  /** Human-readable description (surfaced in the inject message). */
  description: string
  /**
   * What the tool_result must look like for the matcher to count this
   * probe satisfied. Optional; defaults to 'success'. See
   * ProbeExpectedOutcome jsdoc.
   */
  expectedOutcome?: ProbeExpectedOutcome
  /**
   * Set when a tool execution matched the probe. Stays null until the
   * matcher fires; once set, never reset (probes don't un-satisfy).
   * Stored as ISO timestamp string for persistence-friendliness.
   */
  satisfiedAt: string | null
}

export interface ProbePlanState {
  /** User-supplied group label, e.g. "A". */
  groupId: string
  /** Probes registered when the plan was installed. */
  probes: ProbePlanProbe[]
  /** ISO timestamp when this plan was registered. */
  registeredAt: string
}

/** Full conversation state. */
export interface Conversation {
  /** Unique conversation ID */
  id: string
  /** System prompt */
  system: string
  /** Conversation history */
  turns: ConversationTurn[]
  /** Tool definitions available to the model */
  tools: AnthropicToolDef[]
  /** Model to use */
  model: string
  /** Max tokens per response */
  maxTokens: number
  /** Temperature (0-1) */
  temperature?: number
  /** Runtime options (thinking, title, per-tool approval). */
  options?: ConversationOptions
}

/** Result of sending a message (may include tool calls). */
export interface AssistantResponse {
  /** Thinking blocks from the response (extended thinking / chain-of-thought).
   *  Must be stored on the assistant turn so thinking-model providers (e.g.
   *  kimi-for-coding) find reasoning_content on prior tool_call messages when
   *  the history is replayed. Dropping these causes kimi to 400 on the next
   *  continuation with "reasoning_content is missing". */
  thinkingBlocks: import('../../types.js').AnthropicThinkingBlock[]
  /** Text blocks from the response */
  textBlocks: AnthropicTextBlock[]
  /** Tool use blocks from the response */
  toolUseBlocks: AnthropicToolUseBlock[]
  /** Stop reason */
  stopReason: string | null
  /** Token usage */
  usage: { inputTokens: number; outputTokens: number }
  /** Whether the model wants to use tools */
  hasToolUse: boolean
  /** Combined text content */
  text: string
}

/** SSE event from the streaming API */
export interface StreamEvent {
  event: string
  data: string
}

/** Accumulated state during streaming. */
export interface StreamAccumulator {
  /** Concatenated thinking text fragments from every content_block_delta
   *  whose delta.type === 'thinking_delta'. Finalized into a single
   *  AnthropicThinkingBlock so the assistant turn carries reasoning content
   *  forward to future continuations. */
  thinkingParts: string[]
  /** Optional signature from content_block_delta type === 'signature_delta' —
   *  Anthropic models emit this to sign their thinking blocks. Kimi thinking
   *  models don't, so it's optional and may be undefined for cloud paths. */
  thinkingSignature?: string
  textParts: string[]
  toolUseBlocks: Array<{
    id: string
    name: string
    inputJson: string
  }>
  currentToolIndex: number
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  /** True while inside a thinking content block. */
  inThinkingBlock?: boolean
}
