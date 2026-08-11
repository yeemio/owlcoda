import type {
  Conversation,
  ConversationTurn,
  EvidencePersistenceFailure,
  RuntimeEventContract,
  RuntimeEventCheckpointKind,
  RuntimeEventKind,
  RuntimeEventLog,
  RuntimeEventRecord,
  RuntimeFactRefs,
  RuntimeRecoveryCheckpointDisposition,
  RuntimeRecoveryCheckpointKind,
  RuntimeRecoveryCheckpointRecord,
  RuntimeRecoveryLedger,
} from './protocol/types.js'
import {
  mergeRuntimeFactRefs,
  runtimeFactRefsFromPayload,
} from './runtime-facts.js'

const MAX_RUNTIME_EVENTS = 200
const MAX_RESUME_SUFFIX_EVENTS = 12
const MAX_RESUME_UNRESOLVED_CHECKPOINTS = 5
const MAX_RESUME_PAYLOAD_KEYS = 8
const MAX_RESUME_STRING_CHARS = 600
export const RUNTIME_EVENT_LOG_SNAPSHOT_ID = 'runtime_event_log_snapshot'

export const RUNTIME_TRUTH_RESUME_PROMPT_MARKER = '[Runtime truth resume snapshot]'

export interface RuntimeTruthResumeReportValidation {
  satisfied: boolean
  missingReportFields: string[]
}

type RuntimeRecoveryReportSource = 'assistant_text' | 'runtime_synthetic' | 'assistant_text_fallback'
type RuntimeRecoveryReportConfidence = 'high' | 'low'

interface NormalizedRuntimeRecoveryReport {
  schema_version: 1
  kind: 'normalized_runtime_recovery_report'
  checkpoint_id: string
  checkpoint_kind: RuntimeRecoveryCheckpointKind
  report_kind: string
  report_source: RuntimeRecoveryReportSource
  confidence: RuntimeRecoveryReportConfidence
  covered_ids: string[]
  recovery_command?: string
  inspect_commands?: string[]
}

interface RuntimeCheckpointDispositionFact {
  event: RuntimeEventRecord
  checkpointId?: string
  checkpointKind?: RuntimeEventCheckpointKind
  previousDisposition?: string
  disposition?: string
  reason?: string
  inspectCommands?: string[]
  payload?: Record<string, unknown>
}

interface RuntimeTruthResumeReportContract {
  schema_version: 1
  kind: 'runtime_truth_resume_report'
  source: 'runtime_event_log'
  checkpoint_id?: string
  checkpoint_kind?: string
  checkpoint_disposition?: string
  input_history_digest?: string
  context_reason?: string
  window_id?: string
  source_turn_id?: string
  ledger_status?: string
  ignored_stale_transcript: true
  stale_transcript_trusted: false
  suffix_event_kind?: string
  suffix_event_kinds: string[]
  runtime_interventions: Array<Record<string, unknown>>
  runtime_closures: Array<Record<string, unknown>>
  runtime_truth_reports: Array<Record<string, unknown>>
  runtime_recovery_reports: Array<Record<string, unknown>>
  checkpoint_dispositions: Array<Record<string, unknown>>
  event_contract_diagnostics: RuntimeEventContractDiagnostics
  unresolved_checkpoints: Array<Record<string, unknown>>
  next_action: string
}

type RuntimeEventContractDiagnosticStatus =
  | 'contract_valid'
  | 'legacy_replay_compatible'
  | 'malformed_saved_event'

export interface RuntimeEventContractDiagnostic {
  seq: number
  event_id: string
  event_kind: string
  status: RuntimeEventContractDiagnosticStatus
  payload_schema?: string
  validation_errors?: string[]
}

export interface RuntimeEventContractDiagnostics {
  schema_version: 1
  kind: 'runtime_event_contract_diagnostics'
  source: 'runtime_event_log'
  valid_event_count: number
  legacy_event_count: number
  malformed_event_count: number
  events: RuntimeEventContractDiagnostic[]
}

export interface RuntimeInterventionSummary {
  kind: string
  source: 'runtime_event_log'
  event_id: string
  seq: number
  at: string
  action?: string
  tool_use_id?: string
  tool_name?: string
  violation_kind?: string
  checkpoint_id?: string
  checkpoint_kind?: string
  long_task_id?: string
  task_id?: string
  step_id?: string
  agent_id?: string
  report_source?: string
  original_report_source?: string
  compaction_reason?: string
  compaction_method?: string
  fallback_reason?: string
  before_turns?: number
  after_turns?: number
  before_tokens?: number
  after_tokens?: number
  llm_attempted?: boolean
  llm_ms?: number
  llm_compact_failure_count?: number
  context_replacement_checkpoint_id?: string
  plan_kind?: string
  original_tool_count?: number
  executed_tool_count?: number
  deferred_tool_count?: number
  requires_next_response_summary?: boolean
  decision?: string
  stop_reason?: string
  iteration?: number
  touched_path_count?: number
  hard_stop_enabled?: boolean
  would_have_hard_stopped?: boolean
  gate_kind?: string
  prompt_marker?: string
  context_pressure_mode?: string
  context_pressure_threshold?: number
  threshold_percent?: number
  usage_ratio?: number
  usage_percent?: number
  total_tokens?: number
  context_window?: number
  distinct_files_read?: number
  task_write_scope_present?: boolean
  deliverable_mode?: string
  deliverable_confidence?: string
  requires_durable_artifact?: boolean
  schema_failure_key?: string
  missing_fields?: string[]
  prior_failure_count?: number
  current_failure_count?: number
  auto_retry_surface?: string
  suppression_reason?: string
  failure_kind?: string
  failure_phase?: string
  retryable?: boolean
  runtime_retries?: number
  retry_limit?: string
  suppressed_auto_resume_kind?: string
  has_queued_input?: boolean
  task_aborted?: boolean
  clear_epoch_unchanged?: boolean
  recent_retry_kinds?: string[]
  consecutive_truncations?: number
  inject_count?: number
  inject_limit?: number
  response_text_chars?: number
  ignored_tool_count?: number
  requested_status_field?: string
  requested_status?: string
  ledger_status?: string
  wait_strategy?: string
  stop_polling?: boolean
  next_check_command?: string
  reason?: string
}

export function appendRuntimeEvent(
  conversation: Conversation,
  input: {
    kind: RuntimeEventKind
    at?: string
    threadId?: string
    turnId?: string
    runId?: string
    itemId?: string
    checkpointId?: string
    checkpointKind?: RuntimeEventCheckpointKind
    factRefs?: RuntimeFactRefs
    payload?: Record<string, unknown>
  },
): RuntimeEventRecord {
  const at = input.at ?? new Date().toISOString()
  const existing = conversation.options?.runtimeEventLog
  const seq = existing?.nextSeq ?? ((existing?.events.length ?? 0) + 1)
  const factRefs = mergeRuntimeFactRefs(
    runtimeFactRefsFromPayload(input.payload),
    input.factRefs,
    {
      threadId: input.threadId ?? conversation.id,
      turnId: input.turnId,
      runId: input.runId,
      itemId: input.itemId,
      checkpointId: input.checkpointId,
    },
  )
  const eventBase = {
    id: `runtime_event-${seq}`,
    seq,
    kind: input.kind,
    at,
    conversationId: conversation.id,
    ...(factRefs?.threadId ? { threadId: factRefs.threadId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(factRefs?.runId ? { runId: factRefs.runId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    ...(input.checkpointKind ? { checkpointKind: input.checkpointKind } : {}),
    ...(factRefs ? { factRefs } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  }
  const event: RuntimeEventRecord = {
    ...eventBase,
    contract: buildRuntimeEventContract(eventBase),
  }
  const events = [...(existing?.events ?? []), event].slice(-MAX_RUNTIME_EVENTS)
  conversation.options = {
    ...conversation.options,
    runtimeEventLog: {
      schemaVersion: 1,
      updatedAt: at,
      nextSeq: seq + 1,
      events,
    },
  }
  return event
}

export function recordEvidencePersistenceFailureEvent(
  conversation: Conversation,
  failure: EvidencePersistenceFailure,
): RuntimeEventRecord {
  return appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    runId: failure.runId,
    itemId: failure.toolUseId,
    payload: {
      intervention_kind: 'evidence_persistence_failure',
      operation: failure.operation,
      run_id: failure.runId,
      run_dir: failure.runDir,
      output_root: failure.outputRoot,
      tool_use_id: failure.toolUseId,
      tool_name: failure.toolName,
      error: failure.error,
      evidence_completeness: failure.evidenceCompleteness,
      acceptance_impact: failure.acceptanceImpact,
      at: failure.at,
    },
  })
}

export function serializeRuntimeInterventionsFromEvents(
  events: readonly RuntimeEventRecord[] | undefined,
): RuntimeInterventionSummary[] {
  return (events ?? []).flatMap((event): RuntimeInterventionSummary[] => {
    if (event.kind !== 'runtime_intervention') return []
    const payload = objectField(event.payload)
    const interventionKind = stringField(payload?.['intervention_kind'])
    if (!interventionKind) return []
    const summary: RuntimeInterventionSummary = {
      kind: interventionKind,
      source: 'runtime_event_log',
      event_id: event.id,
      seq: event.seq,
      at: event.at,
    }
    addSummaryString(summary, 'action', payload?.['action'])
    addSummaryString(summary, 'tool_use_id', payload?.['tool_use_id'])
    addSummaryString(summary, 'tool_name', payload?.['tool_name'])
    addSummaryString(summary, 'violation_kind', payload?.['violation_kind'])
    addSummaryString(summary, 'checkpoint_id', payload?.['checkpoint_id'] ?? event.checkpointId)
    addSummaryString(summary, 'checkpoint_kind', payload?.['checkpoint_kind'] ?? event.checkpointKind)
    addSummaryString(summary, 'long_task_id', payload?.['long_task_id'])
    addSummaryString(summary, 'task_id', payload?.['task_id'])
    addSummaryString(summary, 'step_id', payload?.['step_id'])
    addSummaryString(summary, 'agent_id', payload?.['agent_id'])
    addSummaryString(summary, 'report_source', payload?.['report_source'])
    addSummaryString(summary, 'original_report_source', payload?.['original_report_source'])
    addSummaryString(summary, 'compaction_reason', payload?.['compaction_reason'])
    addSummaryString(summary, 'compaction_method', payload?.['compaction_method'])
    addSummaryString(summary, 'fallback_reason', payload?.['fallback_reason'])
    addSummaryNumber(summary, 'before_turns', payload?.['before_turns'])
    addSummaryNumber(summary, 'after_turns', payload?.['after_turns'])
    addSummaryNumber(summary, 'before_tokens', payload?.['before_tokens'])
    addSummaryNumber(summary, 'after_tokens', payload?.['after_tokens'])
    addSummaryBoolean(summary, 'llm_attempted', payload?.['llm_attempted'])
    addSummaryNumber(summary, 'llm_ms', payload?.['llm_ms'])
    addSummaryNumber(summary, 'llm_compact_failure_count', payload?.['llm_compact_failure_count'])
    addSummaryString(summary, 'context_replacement_checkpoint_id', payload?.['context_replacement_checkpoint_id'])
    addSummaryString(summary, 'plan_kind', payload?.['plan_kind'])
    addSummaryNumber(summary, 'original_tool_count', payload?.['original_tool_count'])
    addSummaryNumber(summary, 'executed_tool_count', payload?.['executed_tool_count'])
    addSummaryNumber(summary, 'deferred_tool_count', payload?.['deferred_tool_count'])
    addSummaryBoolean(summary, 'requires_next_response_summary', payload?.['requires_next_response_summary'])
    addSummaryString(summary, 'decision', payload?.['decision'])
    addSummaryString(summary, 'stop_reason', payload?.['stop_reason'])
    addSummaryNumber(summary, 'iteration', payload?.['iteration'])
    addSummaryNumber(summary, 'touched_path_count', payload?.['touched_path_count'])
    addSummaryBoolean(summary, 'hard_stop_enabled', payload?.['hard_stop_enabled'])
    addSummaryBoolean(summary, 'would_have_hard_stopped', payload?.['would_have_hard_stopped'])
    addSummaryString(summary, 'gate_kind', payload?.['gate_kind'])
    addSummaryString(summary, 'prompt_marker', payload?.['prompt_marker'])
    addSummaryString(summary, 'context_pressure_mode', payload?.['context_pressure_mode'])
    addSummaryNumber(summary, 'context_pressure_threshold', payload?.['context_pressure_threshold'])
    addSummaryNumber(summary, 'threshold_percent', payload?.['threshold_percent'])
    addSummaryNumber(summary, 'usage_ratio', payload?.['usage_ratio'])
    addSummaryNumber(summary, 'usage_percent', payload?.['usage_percent'])
    addSummaryNumber(summary, 'total_tokens', payload?.['total_tokens'])
    addSummaryNumber(summary, 'context_window', payload?.['context_window'])
    addSummaryNumber(summary, 'distinct_files_read', payload?.['distinct_files_read'])
    addSummaryBoolean(summary, 'task_write_scope_present', payload?.['task_write_scope_present'])
    addSummaryString(summary, 'deliverable_mode', payload?.['deliverable_mode'])
    addSummaryString(summary, 'deliverable_confidence', payload?.['deliverable_confidence'])
    addSummaryBoolean(summary, 'requires_durable_artifact', payload?.['requires_durable_artifact'])
    addSummaryString(summary, 'schema_failure_key', payload?.['schema_failure_key'])
    const missingFields = stringArrayField(payload?.['missing_fields'])
    if (missingFields) summary.missing_fields = missingFields
    addSummaryNumber(summary, 'prior_failure_count', payload?.['prior_failure_count'])
    addSummaryNumber(summary, 'current_failure_count', payload?.['current_failure_count'])
    addSummaryString(summary, 'auto_retry_surface', payload?.['auto_retry_surface'])
    addSummaryString(summary, 'suppression_reason', payload?.['suppression_reason'])
    addSummaryString(summary, 'failure_kind', payload?.['failure_kind'])
    addSummaryString(summary, 'failure_phase', payload?.['failure_phase'])
    addSummaryBoolean(summary, 'retryable', payload?.['retryable'])
    addSummaryNumber(summary, 'runtime_retries', payload?.['runtime_retries'])
    addSummaryString(summary, 'retry_limit', payload?.['retry_limit'])
    addSummaryString(summary, 'suppressed_auto_resume_kind', payload?.['suppressed_auto_resume_kind'])
    addSummaryBoolean(summary, 'has_queued_input', payload?.['has_queued_input'])
    addSummaryBoolean(summary, 'task_aborted', payload?.['task_aborted'])
    addSummaryBoolean(summary, 'clear_epoch_unchanged', payload?.['clear_epoch_unchanged'])
    const recentRetryKinds = stringArrayField(payload?.['recent_retry_kinds'])
    if (recentRetryKinds) summary.recent_retry_kinds = recentRetryKinds
    addSummaryNumber(summary, 'consecutive_truncations', payload?.['consecutive_truncations'])
    addSummaryNumber(summary, 'inject_count', payload?.['inject_count'])
    addSummaryNumber(summary, 'inject_limit', payload?.['inject_limit'])
    addSummaryNumber(summary, 'response_text_chars', payload?.['response_text_chars'])
    addSummaryNumber(summary, 'ignored_tool_count', payload?.['ignored_tool_count'])
    addSummaryString(summary, 'requested_status_field', payload?.['requested_status_field'])
    addSummaryString(summary, 'requested_status', payload?.['requested_status'])
    addSummaryString(summary, 'ledger_status', payload?.['ledger_status'])
    addSummaryString(summary, 'wait_strategy', payload?.['wait_strategy'])
    addSummaryBoolean(summary, 'stop_polling', payload?.['stop_polling'])
    addSummaryString(summary, 'next_check_command', payload?.['next_check_command'])
    addSummaryString(summary, 'reason', payload?.['reason'])
    return [summary]
  })
}

export type RuntimeAutoRetrySuppressionSurface =
  | 'headless_runtime_resume'
  | 'interactive_repl_auto_retry'

export type RuntimeAutoRetrySuppressionReason =
  | 'failure_kind_suppressed'
  | 'retry_limit_exhausted'
  | 'same_kind_retry_window'
  | 'queued_input_present'
  | 'task_aborted'
  | 'clear_epoch_changed'
  | 'non_retryable_failure'

export function recordRuntimeAutoRetrySuppressionEvent(
  conversation: Conversation,
  input: {
    surface: RuntimeAutoRetrySuppressionSurface
    runtimeFailure: {
      kind: string
      phase: string
      retryable: boolean
    }
    suppressionReason: RuntimeAutoRetrySuppressionReason
    runtimeRetries: number
    retryLimit: number
    suppressedAutoResumeKind?: string | null
    hasQueuedInput?: boolean
    taskAborted?: boolean
    clearEpochUnchanged?: boolean
    recentRetryKinds?: readonly string[]
  },
): RuntimeEventRecord {
  const retryLimit = formatRuntimeAutoRetryLimit(input.retryLimit)
  return appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    payload: {
      intervention_kind: 'runtime_auto_retry_suppression',
      action: input.suppressionReason === 'retry_limit_exhausted'
        ? 'stopped_after_retry_limit'
        : 'suppressed_auto_resume',
      auto_retry_surface: input.surface,
      suppression_reason: input.suppressionReason,
      failure_kind: input.runtimeFailure.kind,
      failure_phase: input.runtimeFailure.phase,
      retryable: input.runtimeFailure.retryable,
      runtime_retries: input.runtimeRetries,
      retry_limit: retryLimit,
      ...(input.suppressedAutoResumeKind ? { suppressed_auto_resume_kind: input.suppressedAutoResumeKind } : {}),
      ...(typeof input.hasQueuedInput === 'boolean' ? { has_queued_input: input.hasQueuedInput } : {}),
      ...(typeof input.taskAborted === 'boolean' ? { task_aborted: input.taskAborted } : {}),
      ...(typeof input.clearEpochUnchanged === 'boolean' ? { clear_epoch_unchanged: input.clearEpochUnchanged } : {}),
      ...(input.recentRetryKinds && input.recentRetryKinds.length > 0
        ? { recent_retry_kinds: [...input.recentRetryKinds] }
        : {}),
      reason: formatRuntimeAutoRetrySuppressionReason(input.suppressionReason, {
        kind: input.runtimeFailure.kind,
        runtimeRetries: input.runtimeRetries,
        retryLimit,
      }),
    },
  })
}

export function recordCheckpointInstalledEvent(
  conversation: Conversation,
  checkpoint: RuntimeRecoveryCheckpointRecord,
): RuntimeEventRecord {
  const contextReplacement = contextReplacementInstallMetadata(checkpoint)
  return appendRuntimeEvent(conversation, {
    kind: 'checkpoint_installed',
    at: checkpoint.generatedAt,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.kind,
    payload: {
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      disposition: checkpoint.disposition ?? 'active',
      inspect_commands: checkpoint.inspectCommands,
      ...(contextReplacement ? { context_replacement: contextReplacement } : {}),
    },
  })
}

function contextReplacementInstallMetadata(
  checkpoint: RuntimeRecoveryCheckpointRecord,
): Record<string, unknown> | undefined {
  if (checkpoint.kind !== 'context_replacement_checkpoint') return undefined
  const replacement = objectField(checkpoint.payload['context_replacement'])
  if (!replacement) return undefined
  const replacementHistory = replacement['replacement_history']
  return {
    input_history_digest: replacement['input_history_digest'],
    reason: replacement['reason'],
    window_id: replacement['window_id'],
    source_turn_id: replacement['source_turn_id'],
    ledger_status: replacement['ledger_status'],
    replacement_history_turns: Array.isArray(replacementHistory) ? replacementHistory.length : undefined,
  }
}

export function recordCheckpointResolvedEvent(
  conversation: Conversation,
  checkpoint: RuntimeRecoveryCheckpointRecord,
): RuntimeEventRecord {
  return appendRuntimeEvent(conversation, {
    kind: 'checkpoint_resolved',
    at: checkpoint.dispositionUpdatedAt,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.kind,
    payload: {
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      disposition: checkpoint.disposition ?? 'resolved',
      reason: checkpoint.dispositionReason,
    },
  })
}

export function recordCheckpointDispositionChangedEvent(
  conversation: Conversation,
  previous: RuntimeRecoveryCheckpointRecord,
  checkpoint: RuntimeRecoveryCheckpointRecord,
): RuntimeEventRecord {
  return appendRuntimeEvent(conversation, {
    kind: 'checkpoint_disposition_changed',
    at: checkpoint.dispositionUpdatedAt,
    checkpointId: checkpoint.id,
    checkpointKind: checkpoint.kind,
    payload: {
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      previous_disposition: previous.disposition ?? 'active',
      disposition: checkpoint.disposition ?? 'active',
      reason: checkpoint.dispositionReason,
      inspect_commands: checkpoint.inspectCommands,
    },
  })
}

export function recordRuntimeTruthResumeReportEvent(
  conversation: Conversation,
  input: {
    turnId?: string
    checkpointId: string
    reportSource: 'assistant_text' | 'runtime_synthetic'
    text: string
  },
): RuntimeEventRecord | null {
  const report = parseRuntimeTruthResumeReportContract(input.text)
  if (!report) return null
  const checkpointKind = stringField(report['checkpoint_kind']) === RUNTIME_EVENT_LOG_SNAPSHOT_ID
    ? RUNTIME_EVENT_LOG_SNAPSHOT_ID
    : 'context_replacement_checkpoint'
  return appendRuntimeEvent(conversation, {
    kind: 'runtime_truth_report_recorded',
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    checkpointKind,
    payload: {
      report_kind: stringField(report['kind']) ?? 'unknown',
      report_source: input.reportSource,
      report: compactRuntimeTruthResumeReport(report),
    },
  })
}

export function runtimeTruthResumeCheckpointKindForId(
  checkpointId: string | undefined,
): RuntimeEventCheckpointKind {
  return checkpointId === RUNTIME_EVENT_LOG_SNAPSHOT_ID
    ? RUNTIME_EVENT_LOG_SNAPSHOT_ID
    : 'context_replacement_checkpoint'
}

export function recordRuntimeRecoveryReportEvent(
  conversation: Conversation,
  input: {
    turnId?: string
    checkpointId: string
    checkpointKind: RuntimeRecoveryCheckpointKind
    reportSource: RuntimeRecoveryReportSource
    text: string
  },
): RuntimeEventRecord | null {
  const report = parseRuntimeReportObject(input.text)
  if (!report) return null
  const reportKind = stringField(report['kind']) ?? 'unknown'
  const normalizedReport = normalizeRuntimeRecoveryReport({
    checkpointId: input.checkpointId,
    checkpointKind: input.checkpointKind,
    reportKind,
    reportSource: input.reportSource,
    report,
  })
  return appendRuntimeEvent(conversation, {
    kind: 'runtime_recovery_report_recorded',
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    checkpointKind: input.checkpointKind,
    payload: {
      report_kind: reportKind,
      report_source: input.reportSource,
      normalized_report: normalizedReport,
      report: compactJsonValue(report),
    },
  })
}

export function recordRuntimeRecoveryTextFallbackReportEvent(
  conversation: Conversation,
  input: {
    turnId?: string
    checkpointId: string
    checkpointKind: RuntimeRecoveryCheckpointKind
    reportKind: string
    text: string
    coveredIds?: string[]
    inspectCommands?: string[]
  },
): RuntimeEventRecord {
  const report = {
    schema_version: 1,
    kind: input.reportKind,
    checkpoint_id: input.checkpointId,
    checkpoint_kind: input.checkpointKind,
    confidence: 'low',
    covered_ids: input.coveredIds ?? [],
    inspect_command: input.inspectCommands?.[0],
    inspect_commands: input.inspectCommands ?? [],
    text_excerpt: input.text,
  }
  const normalizedReport = normalizeRuntimeRecoveryReport({
    checkpointId: input.checkpointId,
    checkpointKind: input.checkpointKind,
    reportKind: input.reportKind,
    reportSource: 'assistant_text_fallback',
    report,
    confidence: 'low',
    coveredIds: input.coveredIds,
    inspectCommands: input.inspectCommands,
  })
  return appendRuntimeEvent(conversation, {
    kind: 'runtime_recovery_report_recorded',
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    checkpointKind: input.checkpointKind,
    payload: {
      report_kind: input.reportKind,
      report_source: 'assistant_text_fallback',
      normalized_report: normalizedReport,
      report: compactJsonValue(report),
    },
  })
}

export interface RuntimeTruthReconstruction {
  latestContextReplacement: {
    checkpoint: RuntimeRecoveryCheckpointRecord
    event: RuntimeEventRecord
    replacementHistory: ConversationTurn[]
    suffixEvents: RuntimeEventRecord[]
  } | null
  eventOnlySnapshot: {
    snapshotId: string
    event: RuntimeEventRecord
    suffixEvents: RuntimeEventRecord[]
  } | null
}

export function reconstructRuntimeTruthFromEvents(input: {
  runtimeEventLog?: RuntimeEventLog
  runtimeRecoveryLedger?: RuntimeRecoveryLedger
}): RuntimeTruthReconstruction {
  const events = input.runtimeEventLog?.events ?? []
  const checkpoints = input.runtimeRecoveryLedger?.checkpoints ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.checkpointKind !== 'context_replacement_checkpoint') continue
    if (event.kind !== 'checkpoint_installed' && event.kind !== 'checkpoint_resolved') continue
    const checkpoint = checkpoints.find((item) =>
      item.id === event.checkpointId
      && item.kind === 'context_replacement_checkpoint'
      && isActiveOrResolved(item),
    )
    if (!checkpoint) continue
    return {
      latestContextReplacement: {
        checkpoint,
        event,
        replacementHistory: replacementHistoryFromCheckpoint(checkpoint),
        suffixEvents: events.slice(index + 1),
      },
      eventOnlySnapshot: null,
    }
  }
  const eventOnlyIndex = findEventOnlyResumeEventIndex(events)
  if (eventOnlyIndex >= 0) {
    const event = events[eventOnlyIndex]
    if (event) {
      const suffixStart = Math.max(0, eventOnlyIndex - MAX_RESUME_SUFFIX_EVENTS + 1)
      return {
        latestContextReplacement: null,
        eventOnlySnapshot: {
          snapshotId: RUNTIME_EVENT_LOG_SNAPSHOT_ID,
          event,
          suffixEvents: events.slice(suffixStart),
        },
      }
    }
  }
  return { latestContextReplacement: null, eventOnlySnapshot: null }
}

export function applyRuntimeTruthResumeSnapshot(conversation: Conversation): boolean {
  const reconstruction = reconstructRuntimeTruthFromEvents({
    runtimeEventLog: conversation.options?.runtimeEventLog,
    runtimeRecoveryLedger: conversation.options?.runtimeRecoveryLedger,
  })
  const latest = reconstruction.latestContextReplacement
  const eventOnlySnapshot = reconstruction.eventOnlySnapshot
  const baseTurns = latest?.replacementHistory.length
    ? cloneConversationTurns(latest.replacementHistory)
    : conversation.turns
  const withoutStalePrompt = baseTurns.filter((turn) => !isRuntimeTruthResumePromptTurn(turn))
  const replacedTurns = latest?.replacementHistory.length
    ? true
    : withoutStalePrompt.length !== conversation.turns.length
  conversation.turns = withoutStalePrompt
  if (!latest && !eventOnlySnapshot) return replacedTurns
  const prompt = buildRuntimeTruthResumePrompt(reconstruction, conversation.options?.runtimeRecoveryLedger)
  if (!prompt) return replacedTurns
  const checkpointId = latest?.checkpoint.id ?? eventOnlySnapshot?.snapshotId
  if (!checkpointId) return replacedTurns

  const promptInjectedAt = new Date().toISOString()
  conversation.turns.push({
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    audience: 'runtime',
    timestamp: Date.now(),
  })
  conversation.options = {
    ...conversation.options,
    runtimeTruthResume: {
      checkpointId,
      promptInjectedAt,
      reportGate: 'pending',
    },
  }
  return true
}

export function buildRuntimeTruthResumePrompt(
  reconstruction: RuntimeTruthReconstruction,
  runtimeRecoveryLedger?: RuntimeRecoveryLedger,
): string | null {
  const latest = reconstruction.latestContextReplacement
  const eventOnlySnapshot = reconstruction.eventOnlySnapshot
  if (!latest && !eventOnlySnapshot) return null
  const suffixEvents = latest?.suffixEvents ?? eventOnlySnapshot?.suffixEvents ?? []
  const replacement = latest
    ? objectField(latest.checkpoint.payload['context_replacement'])
    : undefined
  const runtimeInterventions = suffixEvents
    .filter((event) => event.kind === 'runtime_intervention')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
    .map((event) => ({
      seq: event.seq,
      at: event.at,
      turn_id: event.turnId,
      checkpoint_id: event.checkpointId,
      checkpoint_kind: event.checkpointKind,
      payload: compactJsonValue(event.payload),
    }))
  const runtimeClosures = suffixEvents
    .filter((event) => event.kind === 'turn_completed')
    .filter((event) => objectField(event.payload)?.['closure_reason'])
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
    .map((event) => ({
      seq: event.seq,
      at: event.at,
      turn_id: event.turnId,
      stop_reason: stringField(objectField(event.payload)?.['stop_reason']),
      closure_reason: stringField(objectField(event.payload)?.['closure_reason']),
      runtime_truth_resume_checkpoint_id: stringField(objectField(event.payload)?.['runtime_truth_resume_checkpoint_id']),
    }))
  const runtimeCheckpointDispositions = collectRuntimeCheckpointDispositionFacts(suffixEvents)
    .map((fact) => ({
      seq: fact.event.seq,
      at: fact.event.at,
      checkpoint_id: fact.checkpointId,
      checkpoint_kind: fact.checkpointKind,
      previous_disposition: fact.previousDisposition,
      disposition: fact.disposition,
      reason: fact.reason,
      inspect_commands: fact.inspectCommands,
      payload: compactJsonValue(fact.event.payload),
    }))
  const runtimeTruthReports = suffixEvents
    .filter((event) => event.kind === 'runtime_truth_report_recorded')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
    .map((event) => ({
      seq: event.seq,
      at: event.at,
      checkpoint_id: event.checkpointId,
      checkpoint_kind: event.checkpointKind,
      report_source: stringField(objectField(event.payload)?.['report_source']),
      report_kind: stringField(objectField(event.payload)?.['report_kind']),
      report: compactJsonValue(objectField(event.payload)?.['report']),
    }))
  const runtimeRecoveryReports = suffixEvents
    .filter((event) => event.kind === 'runtime_recovery_report_recorded')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
    .map((event) => {
      const payload = objectField(event.payload)
      return {
        seq: event.seq,
        at: event.at,
        checkpoint_id: event.checkpointId,
        checkpoint_kind: event.checkpointKind,
        report_source: stringField(payload?.['report_source']),
        report_kind: stringField(payload?.['report_kind']),
        normalized_report: normalizedRuntimeRecoveryReportFromEvent(event),
        report: compactJsonValue(objectField(payload?.['report'])),
      }
    })
  const unresolved = (runtimeRecoveryLedger?.checkpoints ?? [])
    .filter((checkpoint) =>
      checkpoint.kind !== 'context_replacement_checkpoint'
      && isActiveOrAcknowledged(checkpoint)
    )
    .slice(-MAX_RESUME_UNRESOLVED_CHECKPOINTS)
    .map((checkpoint) => ({
      checkpoint_id: checkpoint.id,
      checkpoint_kind: checkpoint.kind,
      disposition: checkpoint.disposition ?? 'active',
      generated_at: checkpoint.generatedAt,
      inspect_commands: checkpoint.inspectCommands,
      payload: compactJsonValue(checkpoint.payload),
    }))
  const eventContractDiagnostics = buildRuntimeEventContractDiagnostics(suffixEvents)
  const checkpointPayload = latest
    ? {
        checkpoint_id: latest.checkpoint.id,
        checkpoint_kind: latest.checkpoint.kind,
        disposition: latest.checkpoint.disposition ?? 'active',
        generated_at: latest.checkpoint.generatedAt,
        event_kind: latest.event.kind,
        event_seq: latest.event.seq,
        event_at: latest.event.at,
      }
    : {
        checkpoint_id: eventOnlySnapshot?.snapshotId,
        checkpoint_kind: RUNTIME_EVENT_LOG_SNAPSHOT_ID,
        disposition: 'event_only',
        generated_at: eventOnlySnapshot?.event.at,
        event_kind: eventOnlySnapshot?.event.kind,
        event_seq: eventOnlySnapshot?.event.seq,
        event_at: eventOnlySnapshot?.event.at,
      }
  const payload = {
    schema_version: 1,
    kind: 'runtime_truth_resume_snapshot',
    source: 'runtime_event_log',
    checkpoint: checkpointPayload,
    context_replacement: {
      available: Boolean(latest),
      input_history_digest: stringField(replacement?.['input_history_digest']),
      reason: stringField(replacement?.['reason']),
      window_id: stringField(replacement?.['window_id']),
      source_turn_id: stringField(replacement?.['source_turn_id']),
      ledger_status: stringField(replacement?.['ledger_status']),
      replacement_history_turns: latest?.replacementHistory.length ?? 0,
    },
    suffix_events: suffixEvents
      .slice(-MAX_RESUME_SUFFIX_EVENTS)
      .map((event) => ({
        seq: event.seq,
        kind: event.kind,
        at: event.at,
        turn_id: event.turnId,
        item_id: event.itemId,
        checkpoint_id: event.checkpointId,
        checkpoint_kind: event.checkpointKind,
        payload: compactJsonValue(event.payload),
    })),
    runtime_interventions: runtimeInterventions,
    runtime_closures: runtimeClosures,
    runtime_checkpoint_dispositions: runtimeCheckpointDispositions,
    runtime_truth_reports: runtimeTruthReports,
    runtime_recovery_reports: runtimeRecoveryReports,
    event_contract_diagnostics: eventContractDiagnostics,
    unresolved_checkpoints: unresolved,
  }
  return [
    RUNTIME_TRUTH_RESUME_PROMPT_MARKER,
    latest
      ? 'Runtime reconstructed this resume from the saved event log, context replacement checkpoint, and recovery ledger.'
      : 'Runtime reconstructed this resume from saved runtime events and the recovery ledger. No context replacement checkpoint was present.',
    'Use this runtime snapshot as the source of truth; do not infer completion from transcript memory alone.',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'If the user asks for a no-tools resume report, return a JSON object with kind="runtime_truth_resume_report", source="runtime_event_log", checkpoint_id, input_history_digest when present, ignored_stale_transcript=true, unresolved_checkpoints, runtime_interventions, runtime_closures, runtime_recovery_reports, event_contract_diagnostics, checkpoint_dispositions, and next_action.',
    'Prose-only coverage is incomplete; the report must preserve runtime facts as structured fields.',
  ].join('\n')
}

export function buildRuntimeTruthResumeFallbackReport(conversation: Conversation): string | null {
  const runtimeRecoveryLedger = conversation.options?.runtimeRecoveryLedger
  const reconstruction = reconstructRuntimeTruthFromEvents({
    runtimeEventLog: conversation.options?.runtimeEventLog,
    runtimeRecoveryLedger,
  })
  const latest = reconstruction.latestContextReplacement
  const eventOnlySnapshot = reconstruction.eventOnlySnapshot
  const checkpoint = latest?.checkpoint
    ?? runtimeRecoveryLedger?.checkpoints.find((item) =>
      item.id === conversation.options?.runtimeTruthResume?.checkpointId
      && item.kind === 'context_replacement_checkpoint'
      && isActiveOrResolved(item),
    )
  const checkpointId = checkpoint?.id
    ?? conversation.options?.runtimeTruthResume?.checkpointId
    ?? eventOnlySnapshot?.snapshotId
  if (!checkpointId) return null

  const replacement = checkpoint
    ? objectField(checkpoint.payload['context_replacement'])
    : undefined
  const suffixEvents = latest?.suffixEvents ?? eventOnlySnapshot?.suffixEvents ?? []
  const suffixEvent = suffixEvents
    .filter((event) => event.kind !== 'turn_started' && event.kind !== 'turn_completed')
    .at(-1)
    ?? suffixEvents.at(-1)
  const runtimeInterventions = suffixEvents
    .filter((event) => event.kind === 'runtime_intervention')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  const runtimeInterventionKinds = runtimeInterventions
    .map((event) => stringField(objectField(event.payload)?.['intervention_kind']))
    .filter((value): value is string => Boolean(value))
  const runtimeInterventionNextChecks = runtimeInterventions
    .map((event) => stringField(objectField(event.payload)?.['next_check_command']))
    .filter((value): value is string => Boolean(value))
  const runtimeInterventionCheckpointIds = runtimeInterventions
    .map((event) => stringField(objectField(event.payload)?.['checkpoint_id']))
    .filter((value): value is string => Boolean(value))
  const runtimeClosures = suffixEvents
    .filter((event) => event.kind === 'turn_completed')
    .filter((event) => objectField(event.payload)?.['closure_reason'])
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  const runtimeTruthReports = suffixEvents
    .filter((event) => event.kind === 'runtime_truth_report_recorded')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  const runtimeRecoveryReports = suffixEvents
    .filter((event) => event.kind === 'runtime_recovery_report_recorded')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  const unresolved = (runtimeRecoveryLedger?.checkpoints ?? [])
    .filter((item) =>
      item.kind !== 'context_replacement_checkpoint'
      && isActiveOrAcknowledged(item)
    )
    .slice(-MAX_RESUME_UNRESOLVED_CHECKPOINTS)
  const firstUnresolved = unresolved[0]
  const firstInspectCommand = firstUnresolved?.inspectCommands?.[0]
  const checkpointDispositionFacts = collectRuntimeCheckpointDispositionFacts(suffixEvents)
  const firstCheckpointDisposition = checkpointDispositionFacts[0]
  const checkpointDispositionEvents = checkpointDispositionFacts
    .map((fact) => [
      fact.checkpointId ?? 'unknown',
      fact.previousDisposition
        ? `${fact.previousDisposition}->${fact.disposition ?? 'unknown'}`
        : fact.disposition ?? 'unknown',
    ].join(':'))
    .join(', ')
  const nextAction = firstInspectCommand
    ? `inspect ${firstInspectCommand}`
    : 'continue from the runtime truth snapshot without trusting transcript-only completion claims'
  const eventContractDiagnostics = buildRuntimeEventContractDiagnostics(suffixEvents)
  const reportContract: RuntimeTruthResumeReportContract = {
    schema_version: 1,
    kind: 'runtime_truth_resume_report',
    source: 'runtime_event_log',
    checkpoint_id: checkpointId,
    checkpoint_kind: checkpoint?.kind ?? RUNTIME_EVENT_LOG_SNAPSHOT_ID,
    checkpoint_disposition: checkpoint?.disposition ?? 'unknown',
    input_history_digest: stringField(replacement?.['input_history_digest']) ?? 'unknown',
    context_reason: stringField(replacement?.['reason']) ?? 'unknown',
    window_id: stringField(replacement?.['window_id']) ?? 'unknown',
    source_turn_id: stringField(replacement?.['source_turn_id']) ?? 'unknown',
    ledger_status: stringField(replacement?.['ledger_status']) ?? 'unknown',
    ignored_stale_transcript: true,
    stale_transcript_trusted: false,
    suffix_event_kind: suffixEvent?.kind ?? 'none',
    suffix_event_kinds: suffixEvents.map((event) => event.kind),
    runtime_interventions: runtimeInterventions.map((event) => {
      const payload = objectField(event.payload)
      return {
        seq: event.seq,
        intervention_kind: stringField(payload?.['intervention_kind']),
        next_check_command: stringField(payload?.['next_check_command']),
        checkpoint_id: stringField(payload?.['checkpoint_id']),
        payload: compactJsonValue(event.payload),
      }
    }),
    runtime_closures: runtimeClosures.map((event) => {
      const payload = objectField(event.payload)
      return {
        seq: event.seq,
        stop_reason: stringField(payload?.['stop_reason']),
        closure_reason: stringField(payload?.['closure_reason']),
        runtime_truth_resume_checkpoint_id: stringField(payload?.['runtime_truth_resume_checkpoint_id']),
      }
    }),
    runtime_truth_reports: runtimeTruthReports.map((event) => {
      const payload = objectField(event.payload)
      return {
        seq: event.seq,
        checkpoint_id: event.checkpointId,
        report_source: stringField(payload?.['report_source']),
        report_kind: stringField(payload?.['report_kind']),
        report: compactJsonValue(payload?.['report']),
      }
    }),
    runtime_recovery_reports: runtimeRecoveryReports.map((event) => {
      const payload = objectField(event.payload)
      return {
        seq: event.seq,
        checkpoint_id: event.checkpointId,
        checkpoint_kind: event.checkpointKind,
        report_source: stringField(payload?.['report_source']),
        report_kind: stringField(payload?.['report_kind']),
        normalized_report: normalizedRuntimeRecoveryReportFromEvent(event),
        report: compactJsonValue(payload?.['report']),
      }
    }),
    checkpoint_dispositions: checkpointDispositionFacts.map((fact) => ({
      seq: fact.event.seq,
      checkpoint_id: fact.checkpointId,
      checkpoint_kind: fact.checkpointKind,
      previous_disposition: fact.previousDisposition,
      disposition: fact.disposition,
      reason: fact.reason,
      inspect_commands: fact.inspectCommands,
    })),
    event_contract_diagnostics: eventContractDiagnostics,
    unresolved_checkpoints: unresolved.map((item) => ({
      checkpoint_id: item.id,
      checkpoint_kind: item.kind,
      disposition: item.disposition ?? 'active',
      inspect_command: item.inspectCommands?.[0],
      inspect_commands: item.inspectCommands,
    })),
    next_action: nextAction,
  }

  return [
    'Runtime truth resume report',
    '```json',
    JSON.stringify(reportContract, null, 2),
    '```',
    '',
    'source_truth: runtime_event_log',
    `checkpoint_id: ${checkpointId}`,
    `checkpoint_kind: ${checkpoint?.kind ?? RUNTIME_EVENT_LOG_SNAPSHOT_ID}`,
    `checkpoint_disposition: ${checkpoint?.disposition ?? 'unknown'}`,
    `input_history_digest: ${stringField(replacement?.['input_history_digest']) ?? 'unknown'}`,
    `context_reason: ${stringField(replacement?.['reason']) ?? 'unknown'}`,
    `window_id: ${stringField(replacement?.['window_id']) ?? 'unknown'}`,
    `source_turn_id: ${stringField(replacement?.['source_turn_id']) ?? 'unknown'}`,
    `ledger_status: ${stringField(replacement?.['ledger_status']) ?? 'unknown'}`,
    `suffix_event_kind: ${suffixEvent?.kind ?? 'none'}`,
    `suffix_event_kinds: ${suffixEvents.map((event) => event.kind).join(', ') || 'none'}`,
    `suffix_event_seq: ${suffixEvent?.seq ?? 'none'}`,
    `runtime_intervention_kinds: ${runtimeInterventionKinds.join(', ') || 'none'}`,
    `runtime_intervention_next_check_commands: ${runtimeInterventionNextChecks.join(' | ') || 'none'}`,
    `runtime_intervention_checkpoint_ids: ${runtimeInterventionCheckpointIds.join(', ') || 'none'}`,
    `runtime_recovery_report_kinds: ${runtimeRecoveryReports
      .map((event) => stringField(objectField(event.payload)?.['report_kind']))
      .filter((value): value is string => Boolean(value))
      .join(', ') || 'none'}`,
    `checkpoint_disposition_id: ${firstCheckpointDisposition?.checkpointId ?? 'none'}`,
    `checkpoint_disposition_kind: ${firstCheckpointDisposition?.checkpointKind ?? 'none'}`,
    `previous_checkpoint_disposition: ${firstCheckpointDisposition?.previousDisposition ?? 'none'}`,
    `checkpoint_disposition: ${firstCheckpointDisposition?.disposition ?? 'none'}`,
    `checkpoint_disposition_reason: ${firstCheckpointDisposition?.reason ?? 'none'}`,
    `checkpoint_disposition_events: ${checkpointDispositionEvents || 'none'}`,
    `event_contract_diagnostics: valid=${eventContractDiagnostics.valid_event_count}, legacy=${eventContractDiagnostics.legacy_event_count}, malformed=${eventContractDiagnostics.malformed_event_count}`,
    `unresolved_checkpoint_id: ${firstUnresolved?.id ?? 'none'}`,
    `unresolved_checkpoint_kind: ${firstUnresolved?.kind ?? 'none'}`,
    `inspect_command: ${firstInspectCommand ?? 'none'}`,
    'stale transcript completion claim: not trusted; the runtime snapshot is authoritative.',
    `next_action: ${nextAction}`,
  ].join('\n')
}

export function validateRuntimeTruthResumeReport(
  conversation: Conversation,
  text: string,
): RuntimeTruthResumeReportValidation {
  const normalized = normalizeReportText(text)
  const missingReportFields: string[] = []
  const runtimeRecoveryLedger = conversation.options?.runtimeRecoveryLedger
  const reconstruction = reconstructRuntimeTruthFromEvents({
    runtimeEventLog: conversation.options?.runtimeEventLog,
    runtimeRecoveryLedger,
  })
  const latest = reconstruction.latestContextReplacement
  const eventOnlySnapshot = reconstruction.eventOnlySnapshot
  const checkpoint = latest?.checkpoint
    ?? runtimeRecoveryLedger?.checkpoints.find((item) =>
      item.id === conversation.options?.runtimeTruthResume?.checkpointId
      && item.kind === 'context_replacement_checkpoint'
      && isActiveOrResolved(item),
    )
  const checkpointId = checkpoint?.id
    ?? conversation.options?.runtimeTruthResume?.checkpointId
    ?? eventOnlySnapshot?.snapshotId

  const requiresStructuredReport = Boolean(latest || eventOnlySnapshot)
  const structuredReport = requiresStructuredReport
    ? parseRuntimeTruthResumeReportContract(text)
    : undefined
  if (requiresStructuredReport) {
    if (!structuredReport) {
      missingReportFields.push('runtime_truth_report_schema')
    }
    requireStructuredReportString(
      structuredReport,
      'kind',
      'runtime_truth_resume_report',
      'runtime_truth_report_kind',
      missingReportFields,
    )
    requireStructuredReportString(
      structuredReport,
      'source',
      'runtime_event_log',
      'runtime_truth_source',
      missingReportFields,
    )
    requireStructuredReportString(
      structuredReport,
      'checkpoint_id',
      checkpointId,
      `checkpoint:${checkpointId}`,
      missingReportFields,
    )
    requireStructuredStaleTranscriptTrust(structuredReport, missingReportFields)
  }

  requireReportValue(normalized, checkpointId, `checkpoint:${checkpointId}`, missingReportFields)
  if (!mentionsRuntimeTruthSource(normalized)) {
    missingReportFields.push('runtime_truth_source')
  }

  const replacement = checkpoint
    ? objectField(checkpoint.payload['context_replacement'])
    : undefined
  const inputHistoryDigest = stringField(replacement?.['input_history_digest'])
  requireReportValue(
    normalized,
    inputHistoryDigest,
    `input_history_digest:${inputHistoryDigest}`,
    missingReportFields,
  )
  if (requiresStructuredReport) {
    requireStructuredReportString(
      structuredReport,
      'input_history_digest',
      inputHistoryDigest,
      `input_history_digest:${inputHistoryDigest}`,
      missingReportFields,
    )
  }

  const unresolved = (runtimeRecoveryLedger?.checkpoints ?? [])
    .filter((item) =>
      item.kind !== 'context_replacement_checkpoint'
      && isActiveOrAcknowledged(item)
    )
    .slice(-MAX_RESUME_UNRESOLVED_CHECKPOINTS)
  for (const checkpoint of unresolved) {
    requireReportValue(
      normalized,
      checkpoint.id,
      `unresolved_checkpoint:${checkpoint.id}`,
      missingReportFields,
    )
    if (requiresStructuredReport && structuredReport) {
      const structuredCheckpoint = findStructuredCheckpoint(
        structuredReport,
        'unresolved_checkpoints',
        checkpoint.id,
      )
      if (!structuredCheckpoint) {
        missingReportFields.push(`unresolved_checkpoint:${checkpoint.id}`)
      }
      const inspectCommand = checkpoint.inspectCommands?.[0]
      requireStructuredCheckpointInspectCommand(
        structuredCheckpoint,
        inspectCommand,
        `inspect_command:${inspectCommand}`,
        missingReportFields,
      )
    }
    const inspectCommand = checkpoint.inspectCommands?.[0]
    requireReportValue(
      normalized,
      inspectCommand,
      `inspect_command:${inspectCommand}`,
      missingReportFields,
    )
  }

  const suffixEvents = latest?.suffixEvents ?? eventOnlySnapshot?.suffixEvents ?? []
  const runtimeInterventions = suffixEvents
    .filter((event) => event.kind === 'runtime_intervention')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  for (const event of runtimeInterventions) {
    const payload = objectField(event.payload)
    const interventionKind = stringField(payload?.['intervention_kind'])
    requireReportValue(
      normalized,
      interventionKind,
      `runtime_intervention:${interventionKind}`,
      missingReportFields,
    )
    if (requiresStructuredReport && structuredReport) {
      const structuredIntervention = findStructuredRuntimeIntervention(
        structuredReport,
        interventionKind,
      )
      if (!structuredIntervention) {
        missingReportFields.push(`runtime_intervention:${interventionKind}`)
      }
      const nextCheckCommand = stringField(payload?.['next_check_command'])
      requireStructuredReportString(
        structuredIntervention,
        'next_check_command',
        nextCheckCommand,
        `runtime_intervention_next_check:${nextCheckCommand}`,
        missingReportFields,
      )
      const interventionCheckpointId = stringField(payload?.['checkpoint_id'])
      requireStructuredReportString(
        structuredIntervention,
        'checkpoint_id',
        interventionCheckpointId,
        `runtime_intervention_checkpoint:${interventionCheckpointId}`,
        missingReportFields,
      )
    }
    const nextCheckCommand = stringField(payload?.['next_check_command'])
    requireReportValue(
      normalized,
      nextCheckCommand,
      `runtime_intervention_next_check:${nextCheckCommand}`,
      missingReportFields,
    )
    const interventionCheckpointId = stringField(payload?.['checkpoint_id'])
    requireReportValue(
      normalized,
      interventionCheckpointId,
      `runtime_intervention_checkpoint:${interventionCheckpointId}`,
      missingReportFields,
    )
  }

  const runtimeClosures = suffixEvents
    .filter((event) => event.kind === 'turn_completed')
    .filter((event) => objectField(event.payload)?.['closure_reason'])
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  for (const event of runtimeClosures) {
    const payload = objectField(event.payload)
    const closureReason = stringField(payload?.['closure_reason'])
    requireReportValue(
      normalized,
      closureReason,
      `runtime_closure:${closureReason}`,
      missingReportFields,
    )
    if (requiresStructuredReport && structuredReport) {
      const structuredClosure = findStructuredRuntimeClosure(structuredReport, closureReason)
      if (!structuredClosure) {
        missingReportFields.push(`runtime_closure:${closureReason}`)
      }
      const runtimeTruthResumeCheckpointId = stringField(payload?.['runtime_truth_resume_checkpoint_id'])
      requireStructuredReportString(
        structuredClosure,
        'runtime_truth_resume_checkpoint_id',
        runtimeTruthResumeCheckpointId,
        `runtime_closure_checkpoint:${runtimeTruthResumeCheckpointId}`,
        missingReportFields,
      )
    }
  }

  const runtimeRecoveryReports = suffixEvents
    .filter((event) => event.kind === 'runtime_recovery_report_recorded')
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
  for (const event of runtimeRecoveryReports) {
    const payload = objectField(event.payload)
    const reportKind = stringField(payload?.['report_kind'])
    requireReportValue(
      normalized,
      reportKind,
      `runtime_recovery_report:${reportKind}`,
      missingReportFields,
    )
    requireReportValue(
      normalized,
      event.checkpointId,
      `runtime_recovery_report_checkpoint:${event.checkpointId}`,
      missingReportFields,
    )
    const recoveryCommand = firstRuntimeRecoveryReportCommand(normalizedRuntimeRecoveryReportFromEvent(event))
      ?? firstRuntimeRecoveryReportCommand(objectField(payload?.['report']))
    requireReportValue(
      normalized,
      recoveryCommand,
      `runtime_recovery_report_recovery_command:${recoveryCommand}`,
      missingReportFields,
    )
    if (requiresStructuredReport && structuredReport) {
      const structuredRecoveryReport = findStructuredRuntimeRecoveryReport(
        structuredReport,
        reportKind,
        event.checkpointId,
      )
      if (!structuredRecoveryReport) {
        addMissingReportField(missingReportFields, `runtime_recovery_report:${reportKind}`)
        addMissingReportField(
          missingReportFields,
          `runtime_recovery_report_checkpoint:${event.checkpointId}`,
        )
        addMissingReportField(
          missingReportFields,
          `runtime_recovery_report_recovery_command:${recoveryCommand}`,
        )
        continue
      }
      requireStructuredReportString(
        structuredRecoveryReport,
        'checkpoint_id',
        event.checkpointId,
        `runtime_recovery_report_checkpoint:${event.checkpointId}`,
        missingReportFields,
      )
      requireStructuredReportString(
        structuredRecoveryReport,
        'report_kind',
        reportKind,
        `runtime_recovery_report:${reportKind}`,
        missingReportFields,
      )
      if (
        recoveryCommand
        && !structuredValueContainsString(structuredRecoveryReport, recoveryCommand)
      ) {
        missingReportFields.push(`runtime_recovery_report_recovery_command:${recoveryCommand}`)
      }
    }
  }

  const runtimeCheckpointDispositions = collectRuntimeCheckpointDispositionFacts(suffixEvents)
  for (const fact of runtimeCheckpointDispositions) {
    requireReportValue(
      normalized,
      fact.checkpointId,
      `checkpoint_disposition_id:${fact.checkpointId}`,
      missingReportFields,
    )
    requireReportValue(
      normalized,
      fact.disposition,
      `checkpoint_disposition:${fact.checkpointId}:${fact.disposition}`,
      missingReportFields,
    )
    requireReportValue(
      normalized,
      fact.previousDisposition,
      `checkpoint_previous_disposition:${fact.checkpointId}:${fact.previousDisposition}`,
      missingReportFields,
    )
    requireReportValue(
      normalized,
      fact.reason,
      `checkpoint_disposition_reason:${fact.checkpointId}`,
      missingReportFields,
    )
    if (requiresStructuredReport && structuredReport) {
      const structuredDisposition = findStructuredCheckpoint(
        structuredReport,
        'checkpoint_dispositions',
        fact.checkpointId,
      )
      if (!structuredDisposition) {
        missingReportFields.push(`checkpoint_disposition_id:${fact.checkpointId}`)
      }
      requireStructuredReportString(
        structuredDisposition,
        'disposition',
        fact.disposition,
        `checkpoint_disposition:${fact.checkpointId}:${fact.disposition}`,
        missingReportFields,
      )
      requireStructuredReportString(
        structuredDisposition,
        'previous_disposition',
        fact.previousDisposition,
        `checkpoint_previous_disposition:${fact.checkpointId}:${fact.previousDisposition}`,
        missingReportFields,
      )
      requireStructuredReportString(
        structuredDisposition,
        'reason',
        fact.reason,
        `checkpoint_disposition_reason:${fact.checkpointId}`,
        missingReportFields,
      )
    }
  }

  return {
    satisfied: missingReportFields.length === 0,
    missingReportFields,
  }
}

function isActiveOrResolved(checkpoint: RuntimeRecoveryCheckpointRecord): boolean {
  const disposition = checkpoint.disposition ?? 'active'
  return disposition === 'active' || disposition === 'resolved'
}

function findEventOnlyResumeEventIndex(events: readonly RuntimeEventRecord[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && isEventOnlyResumeEvent(event)) return index
  }
  return -1
}

function isEventOnlyResumeEvent(event: RuntimeEventRecord): boolean {
  if (event.kind === 'runtime_intervention') return true
  if (event.kind === 'runtime_recovery_report_recorded') return true
  if (event.kind === 'runtime_truth_report_recorded') return true
  if (
    event.kind === 'checkpoint_installed'
    || event.kind === 'checkpoint_resolved'
    || event.kind === 'checkpoint_disposition_changed'
  ) {
    return event.checkpointKind !== 'context_replacement_checkpoint'
  }
  if (event.kind === 'turn_completed') {
    return Boolean(objectField(event.payload)?.['closure_reason'])
  }
  return false
}

function isActiveOrAcknowledged(checkpoint: RuntimeRecoveryCheckpointRecord): boolean {
  const disposition = checkpoint.disposition ?? 'active'
  return disposition === 'active' || disposition === 'acknowledged'
}

function replacementHistoryFromCheckpoint(checkpoint: RuntimeRecoveryCheckpointRecord): ConversationTurn[] {
  const container = objectField(checkpoint.payload['context_replacement'])
  const history = container?.['replacement_history']
  return Array.isArray(history) ? history as ConversationTurn[] : []
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function addSummaryString(
  summary: RuntimeInterventionSummary,
  key: keyof RuntimeInterventionSummary,
  value: unknown,
): void {
  const text = stringField(value)
  if (text) {
    ;(summary as unknown as Record<string, unknown>)[key] = text
  }
}

function addSummaryNumber(
  summary: RuntimeInterventionSummary,
  key: keyof RuntimeInterventionSummary,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    ;(summary as unknown as Record<string, unknown>)[key] = value
  }
}

function addSummaryBoolean(
  summary: RuntimeInterventionSummary,
  key: keyof RuntimeInterventionSummary,
  value: unknown,
): void {
  if (typeof value === 'boolean') {
    ;(summary as unknown as Record<string, unknown>)[key] = value
  }
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length ? items : undefined
}

function formatRuntimeAutoRetryLimit(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : 'unlimited'
}

function formatRuntimeAutoRetrySuppressionReason(
  reason: RuntimeAutoRetrySuppressionReason,
  input: {
    kind: string
    runtimeRetries: number
    retryLimit: string
  },
): string {
  switch (reason) {
    case 'failure_kind_suppressed':
      return `Automatic runtime resume suppressed for ${input.kind}.`
    case 'retry_limit_exhausted':
      return `Runtime resume retries exhausted (${input.runtimeRetries}/${input.retryLimit}).`
    case 'same_kind_retry_window':
      return `Automatic runtime resume suppressed after repeated ${input.kind} failures.`
    case 'queued_input_present':
      return 'Automatic runtime resume suppressed because queued user input is waiting.'
    case 'task_aborted':
      return 'Automatic runtime resume suppressed because the active task was aborted.'
    case 'clear_epoch_changed':
      return 'Automatic runtime resume suppressed because the conversation was cleared during the turn.'
    case 'non_retryable_failure':
      return 'Automatic runtime resume suppressed because the failure is not retryable.'
  }
}

function normalizeRuntimeRecoveryReport(input: {
  checkpointId: string
  checkpointKind: RuntimeRecoveryCheckpointKind
  reportKind: string
  reportSource: RuntimeRecoveryReportSource
  report: Record<string, unknown>
  confidence?: RuntimeRecoveryReportConfidence
  coveredIds?: string[]
  inspectCommands?: string[]
}): NormalizedRuntimeRecoveryReport {
  const confidence = input.confidence
    ?? runtimeRecoveryReportConfidence(input.report)
    ?? (input.reportSource === 'assistant_text_fallback' ? 'low' : 'high')
  const coveredIds = uniqueStrings([
    ...(input.coveredIds ?? []),
    ...runtimeRecoveryReportCoveredIds(input.report),
  ])
  const inspectCommands = uniqueStrings([
    ...(input.inspectCommands ?? []),
    ...runtimeRecoveryReportCommands(input.report),
  ])
  const normalized: NormalizedRuntimeRecoveryReport = {
    schema_version: 1,
    kind: 'normalized_runtime_recovery_report',
    checkpoint_id: input.checkpointId,
    checkpoint_kind: input.checkpointKind,
    report_kind: input.reportKind,
    report_source: input.reportSource,
    confidence,
    covered_ids: coveredIds,
  }
  const recoveryCommand = inspectCommands[0]
  if (recoveryCommand) normalized.recovery_command = recoveryCommand
  if (inspectCommands.length > 0) normalized.inspect_commands = inspectCommands
  return normalized
}

function normalizedRuntimeRecoveryReportFromEvent(
  event: RuntimeEventRecord,
): NormalizedRuntimeRecoveryReport | undefined {
  if (event.kind !== 'runtime_recovery_report_recorded') return undefined
  const payload = objectField(event.payload)
  const existing = objectField(payload?.['normalized_report'])
  if (isNormalizedRuntimeRecoveryReport(existing)) {
    return existing as unknown as NormalizedRuntimeRecoveryReport
  }
  const report = objectField(payload?.['report'])
  if (!report) return undefined
  const checkpointId = event.checkpointId
    ?? stringField(report['checkpoint_id'])
    ?? stringField(report['checkpointId'])
  const checkpointKind = runtimeRecoveryCheckpointKindFromString(event.checkpointKind)
    ?? runtimeRecoveryCheckpointKindFromString(stringField(report['checkpoint_kind']) ?? stringField(report['checkpointKind']))
  const reportSource = runtimeRecoveryReportSourceFromString(stringField(payload?.['report_source']))
  if (!checkpointId || !checkpointKind || !reportSource) return undefined
  return normalizeRuntimeRecoveryReport({
    checkpointId,
    checkpointKind,
    reportKind: stringField(payload?.['report_kind']) ?? stringField(report['kind']) ?? 'unknown',
    reportSource,
    report,
  })
}

function isNormalizedRuntimeRecoveryReport(
  value: Record<string, unknown> | undefined,
): value is NormalizedRuntimeRecoveryReport & Record<string, unknown> {
  return value?.['schema_version'] === 1
    && value['kind'] === 'normalized_runtime_recovery_report'
    && typeof value['checkpoint_id'] === 'string'
    && typeof value['checkpoint_kind'] === 'string'
    && typeof value['report_kind'] === 'string'
    && typeof value['report_source'] === 'string'
    && typeof value['confidence'] === 'string'
    && Array.isArray(value['covered_ids'])
}

function runtimeRecoveryReportSourceFromString(value: string | undefined): RuntimeRecoveryReportSource | undefined {
  if (value === 'assistant_text' || value === 'runtime_synthetic' || value === 'assistant_text_fallback') {
    return value
  }
  return undefined
}

function runtimeRecoveryCheckpointKindFromString(
  value: string | undefined,
): RuntimeRecoveryCheckpointKind | undefined {
  if (
    value === 'long_task_checkpoint'
    || value === 'blocked_task_checkpoint'
    || value === 'child_run_synthesis_checkpoint'
    || value === 'long_task_synthesis_checkpoint'
    || value === 'long_task_replacement_checkpoint'
    || value === 'context_replacement_checkpoint'
    || value === 'verification_repair_checkpoint'
    || value === 'loop_intercept_closeout_checkpoint'
  ) {
    return value
  }
  return undefined
}

function runtimeRecoveryReportConfidence(
  report: Record<string, unknown>,
): RuntimeRecoveryReportConfidence | undefined {
  const confidence = stringField(report['confidence'])
  return confidence === 'high' || confidence === 'low' ? confidence : undefined
}

function runtimeRecoveryReportCoveredIds(report: Record<string, unknown>): string[] {
  const ids: string[] = []
  addRuntimeReportIdArray(ids, report['covered_ids'])
  addRuntimeReportId(ids, stringField(report['long_task_id']) ?? stringField(report['longTaskId']))
  const flattenedTaskId = stringField(report['task_id']) ?? stringField(report['taskId'])
  if (flattenedTaskId?.includes(':')) addRuntimeReportId(ids, flattenedTaskId)
  addRuntimeReportId(ids, stringField(report['agent_id']) ?? stringField(report['agentId']))

  for (const item of objectArrayField(report['long_tasks'])) {
    addRuntimeReportId(ids, stringField(item['long_task_id']) ?? stringField(item['longTaskId']))
  }
  for (const item of objectArrayField(report['children'])) {
    addRuntimeReportId(ids, stringField(item['agent_id']) ?? stringField(item['agentId']))
  }

  const blockedTask = objectField(report['blocked_task'])
  addRuntimeReportId(ids, stringField(blockedTask?.['task_id']) ?? stringField(blockedTask?.['taskId']))
  addRuntimeReportId(ids, stringField(blockedTask?.['step_id']) ?? stringField(blockedTask?.['stepId']))

  const verificationRepair = objectField(report['verification_repair'])
  addRuntimeReportId(ids, stringField(verificationRepair?.['task_id']) ?? stringField(verificationRepair?.['taskId']))
  addRuntimeReportId(ids, stringField(verificationRepair?.['step_id']) ?? stringField(verificationRepair?.['stepId']))
  for (const item of objectArrayField(verificationRepair?.['failed_checks'])) {
    addRuntimeReportId(ids, stringField(item['check_id']) ?? stringField(item['checkId']))
  }

  const replacement = objectField(report['replacement'])
  addRuntimeReportId(
    ids,
    stringField(replacement?.['original_long_task_id']) ?? stringField(replacement?.['originalLongTaskId']),
  )
  addRuntimeReportId(
    ids,
    stringField(replacement?.['replacement_long_task_id']) ?? stringField(replacement?.['replacementLongTaskId']),
  )
  addRuntimeReportId(
    ids,
    stringField(replacement?.['replacement_task_id']) ?? stringField(replacement?.['replacementTaskId']),
  )

  return uniqueStrings(ids)
}

const RUNTIME_RECOVERY_REPORT_COMMAND_KEYS = [
  'recovery_command',
  'inspect_command',
  'output_command',
  'verify_command',
  'next_verify_command',
  'next_check_command',
]

function runtimeRecoveryReportCommands(value: unknown, depth = 0): string[] {
  if (depth > 4) return []
  const object = objectField(value)
  if (!object) return []
  const commands: string[] = []
  for (const key of RUNTIME_RECOVERY_REPORT_COMMAND_KEYS) {
    addRuntimeReportId(commands, stringField(object[key]))
  }
  const commandArray = stringArrayField(object['inspect_commands'])
  if (commandArray) commands.push(...commandArray)
  for (const nested of Object.values(object)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        commands.push(...runtimeRecoveryReportCommands(item, depth + 1))
      }
      continue
    }
    if (objectField(nested)) {
      commands.push(...runtimeRecoveryReportCommands(nested, depth + 1))
    }
  }
  return uniqueStrings(commands)
}

function addRuntimeReportId(ids: string[], value: string | undefined): void {
  if (!value) return
  ids.push(value)
}

function addRuntimeReportIdArray(ids: string[], value: unknown): void {
  const items = stringArrayField(value)
  if (!items) return
  ids.push(...items)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

export function buildRuntimeEventContractDiagnostics(
  events: RuntimeEventRecord[],
  options?: { limit?: number | null },
): RuntimeEventContractDiagnostics {
  const diagnosticEvents = options?.limit === null
    ? events
    : events.slice(-(options?.limit ?? MAX_RESUME_SUFFIX_EVENTS))
  const diagnostics = diagnosticEvents
    .map((event) => diagnoseRuntimeEventContractForReplay(event))
  return {
    schema_version: 1,
    kind: 'runtime_event_contract_diagnostics',
    source: 'runtime_event_log',
    valid_event_count: diagnostics.filter((item) => item.status === 'contract_valid').length,
    legacy_event_count: diagnostics.filter((item) => item.status === 'legacy_replay_compatible').length,
    malformed_event_count: diagnostics.filter((item) => item.status === 'malformed_saved_event').length,
    events: diagnostics,
  }
}

function diagnoseRuntimeEventContractForReplay(event: RuntimeEventRecord): RuntimeEventContractDiagnostic {
  const validationErrors = event.contract
    ? validateRuntimeEventContractForReplay(event)
    : validateLegacyRuntimeEventForReplay(event)
  const status: RuntimeEventContractDiagnosticStatus = validationErrors.length > 0
    ? 'malformed_saved_event'
    : event.contract
      ? 'contract_valid'
      : 'legacy_replay_compatible'
  return {
    seq: event.seq,
    event_id: event.id,
    event_kind: String(event.kind),
    status,
    payload_schema: event.contract?.payload_schema
      ?? legacyRuntimeEventPayloadSchema(event),
    ...(validationErrors.length > 0 ? { validation_errors: validationErrors } : {}),
  }
}

function validateRuntimeEventContractForReplay(event: RuntimeEventRecord): string[] {
  const errors: string[] = []
  const contract = event.contract
  if (!contract) return ['contract']
  if (contract.schema_version !== 1) errors.push('contract.schema_version')
  if (contract.kind !== 'runtime_event_contract') errors.push('contract.kind')
  if (contract.event_kind !== event.kind) errors.push('contract.event_kind:mismatch')
  if (contract.payload_schema !== `${event.kind}.v1`) errors.push('contract.payload_schema:mismatch')
  if (contract.validation_status !== 'valid') errors.push('contract.validation_status')
  errors.push(...validateRuntimeEventRecord(event))
  return uniqueStrings(errors)
}

function validateLegacyRuntimeEventForReplay(event: RuntimeEventRecord): string[] {
  const errors = validateRuntimeEventEnvelope(event)
  if (errors.length > 0) return errors
  switch (event.kind) {
    case 'checkpoint_installed':
    case 'checkpoint_resolved':
    case 'checkpoint_disposition_changed':
      requireCheckpointAnchor(errors, event)
      break
    case 'runtime_recovery_report_recorded':
      requireCheckpointAnchor(errors, event)
      if (!normalizedRuntimeRecoveryReportFromEvent(event)) {
        errors.push('payload.normalized_report:legacy_unavailable')
      }
      break
    case 'runtime_truth_report_recorded':
      requireCheckpointAnchor(errors, event)
      break
    case 'runtime_intervention':
      requirePayloadObject(errors, objectField(event.payload))
      requirePayloadString(errors, objectField(event.payload), 'intervention_kind')
      break
    case 'turn_started':
    case 'turn_completed':
    case 'item_started':
    case 'item_completed':
      break
  }
  return uniqueStrings(errors)
}

function validateRuntimeEventEnvelope(event: RuntimeEventRecord): string[] {
  const errors: string[] = []
  requireEventString(errors, event.id, 'id')
  if (typeof event.seq !== 'number') errors.push('seq')
  requireEventString(errors, event.kind, 'kind')
  if (!isRuntimeEventKind(event.kind)) errors.push('kind:unknown')
  requireEventString(errors, event.at, 'at')
  requireEventString(errors, event.conversationId, 'conversationId')
  return uniqueStrings(errors)
}

function legacyRuntimeEventPayloadSchema(event: RuntimeEventRecord): string {
  if (event.kind === 'runtime_recovery_report_recorded' && normalizedRuntimeRecoveryReportFromEvent(event)) {
    return 'runtime_recovery_report_recorded.legacy-normalized.v1'
  }
  return `${event.kind}.legacy.v1`
}

function isRuntimeEventKind(value: unknown): value is RuntimeEventKind {
  return value === 'turn_started'
    || value === 'item_started'
    || value === 'item_completed'
    || value === 'checkpoint_installed'
    || value === 'checkpoint_disposition_changed'
    || value === 'checkpoint_resolved'
    || value === 'runtime_intervention'
    || value === 'runtime_truth_report_recorded'
    || value === 'runtime_recovery_report_recorded'
    || value === 'turn_completed'
}

function buildRuntimeEventContract(event: Omit<RuntimeEventRecord, 'contract'>): RuntimeEventContract {
  const errors = validateRuntimeEventRecord(event)
  if (errors.length > 0) {
    throw new Error(`Invalid runtime event ${event.kind} payload: ${errors.join(', ')}`)
  }
  return {
    schema_version: 1,
    kind: 'runtime_event_contract',
    event_kind: event.kind,
    payload_schema: `${event.kind}.v1`,
    validation_status: 'valid',
  }
}

function validateRuntimeEventRecord(event: Omit<RuntimeEventRecord, 'contract'>): string[] {
  const errors: string[] = []
  const payload = objectField(event.payload)
  switch (event.kind) {
    case 'turn_started':
      requireEventString(errors, event.turnId, 'turnId')
      break
    case 'turn_completed':
      requireEventString(errors, event.turnId, 'turnId')
      requirePayloadObject(errors, payload)
      requirePayloadNumber(errors, payload, 'iterations')
      requirePayloadNumber(errors, payload, 'request_count')
      requirePayloadNumber(errors, payload, 'input_tokens')
      requirePayloadNumber(errors, payload, 'output_tokens')
      requirePayloadNumber(errors, payload, 'assistant_response_count')
      requirePayloadNumber(errors, payload, 'assistant_text_chars')
      requirePayloadNumber(errors, payload, 'final_text_chars')
      requirePayloadNumber(errors, payload, 'tool_use_count')
      requirePayloadNumber(errors, payload, 'executed_tool_count')
      requirePayloadNumber(errors, payload, 'empty_response_count')
      break
    case 'item_started':
      requireEventString(errors, event.turnId, 'turnId')
      requireEventString(errors, event.itemId, 'itemId')
      requirePayloadObject(errors, payload)
      requirePayloadString(errors, payload, 'tool_name')
      break
    case 'item_completed':
      requireEventString(errors, event.turnId, 'turnId')
      requireEventString(errors, event.itemId, 'itemId')
      requirePayloadObject(errors, payload)
      requirePayloadString(errors, payload, 'tool_name')
      if (payload && typeof payload['is_error'] !== 'boolean') {
        errors.push('payload.is_error')
      }
      break
    case 'checkpoint_installed':
      requireCheckpointEvent(errors, event, payload)
      requirePayloadString(errors, payload, 'disposition')
      if (event.checkpointKind === 'context_replacement_checkpoint') {
        requireContextReplacementInstallPayload(errors, payload)
      }
      break
    case 'checkpoint_resolved':
      requireCheckpointEvent(errors, event, payload)
      requirePayloadString(errors, payload, 'disposition')
      break
    case 'checkpoint_disposition_changed':
      requireCheckpointEvent(errors, event, payload)
      requirePayloadString(errors, payload, 'previous_disposition')
      requirePayloadString(errors, payload, 'disposition')
      break
    case 'runtime_truth_report_recorded':
      requireCheckpointAnchor(errors, event)
      requirePayloadObject(errors, payload)
      if (
        event.checkpointKind !== 'context_replacement_checkpoint'
        && event.checkpointKind !== RUNTIME_EVENT_LOG_SNAPSHOT_ID
      ) {
        errors.push('checkpointKind:runtime_truth_resume_anchor')
      }
      requirePayloadString(errors, payload, 'report_kind')
      requireRuntimeReportSource(errors, payload, false)
      requirePayloadObjectField(errors, payload, 'report')
      break
    case 'runtime_recovery_report_recorded':
      requireCheckpointAnchor(errors, event)
      requirePayloadObject(errors, payload)
      requirePayloadString(errors, payload, 'report_kind')
      requireRuntimeReportSource(errors, payload, true)
      requirePayloadObjectField(errors, payload, 'report')
      requireNormalizedRecoveryReport(errors, event, payload)
      break
    case 'runtime_intervention':
      requirePayloadObject(errors, payload)
      requirePayloadString(errors, payload, 'intervention_kind')
      break
  }
  return uniqueStrings(errors)
}

function requireCheckpointAnchor(
  errors: string[],
  event: Omit<RuntimeEventRecord, 'contract'>,
): void {
  requireEventString(errors, event.checkpointId, 'checkpointId')
  requireEventString(errors, event.checkpointKind, 'checkpointKind')
}

function requireCheckpointEvent(
  errors: string[],
  event: Omit<RuntimeEventRecord, 'contract'>,
  payload: Record<string, unknown> | undefined,
): void {
  requireEventString(errors, event.checkpointId, 'checkpointId')
  requireEventString(errors, event.checkpointKind, 'checkpointKind')
  requirePayloadObject(errors, payload)
  requirePayloadString(errors, payload, 'checkpoint_id')
  requirePayloadString(errors, payload, 'checkpoint_kind')
  if (payload && event.checkpointId && payload['checkpoint_id'] !== event.checkpointId) {
    errors.push('payload.checkpoint_id:mismatch')
  }
  if (payload && event.checkpointKind && payload['checkpoint_kind'] !== event.checkpointKind) {
    errors.push('payload.checkpoint_kind:mismatch')
  }
}

function requireRuntimeReportSource(
  errors: string[],
  payload: Record<string, unknown> | undefined,
  allowFallback: boolean,
): void {
  const source = stringField(payload?.['report_source'])
  const valid = source === 'assistant_text'
    || source === 'runtime_synthetic'
    || (allowFallback && source === 'assistant_text_fallback')
  if (!valid) {
    errors.push('payload.report_source')
  }
}

function requireNormalizedRecoveryReport(
  errors: string[],
  event: Omit<RuntimeEventRecord, 'contract'>,
  payload: Record<string, unknown> | undefined,
): void {
  const normalizedReport = objectField(payload?.['normalized_report'])
  if (!isNormalizedRuntimeRecoveryReport(normalizedReport)) {
    errors.push('payload.normalized_report')
    return
  }
  if (normalizedReport['checkpoint_id'] !== event.checkpointId) {
    errors.push('payload.normalized_report.checkpoint_id:mismatch')
  }
  if (normalizedReport['checkpoint_kind'] !== event.checkpointKind) {
    errors.push('payload.normalized_report.checkpoint_kind:mismatch')
  }
  if (normalizedReport['report_kind'] !== payload?.['report_kind']) {
    errors.push('payload.normalized_report.report_kind:mismatch')
  }
  if (normalizedReport['report_source'] !== payload?.['report_source']) {
    errors.push('payload.normalized_report.report_source:mismatch')
  }
}

function requireEventString(errors: string[], value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(label)
  }
}

function requirePayloadObject(errors: string[], payload: Record<string, unknown> | undefined): void {
  if (!payload) {
    errors.push('payload')
  }
}

function requirePayloadString(
  errors: string[],
  payload: Record<string, unknown> | undefined,
  key: string,
): void {
  if (!payload || typeof payload[key] !== 'string' || String(payload[key]).length === 0) {
    errors.push(`payload.${key}`)
  }
}

function requirePayloadObjectField(
  errors: string[],
  payload: Record<string, unknown> | undefined,
  key: string,
): void {
  if (!objectField(payload?.[key])) {
    errors.push(`payload.${key}`)
  }
}

function requirePayloadNumber(
  errors: string[],
  payload: Record<string, unknown> | undefined,
  key: string,
): void {
  if (!payload || typeof payload[key] !== 'number') {
    errors.push(`payload.${key}`)
  }
}

function requireContextReplacementInstallPayload(
  errors: string[],
  payload: Record<string, unknown> | undefined,
): void {
  const contextReplacement = objectField(payload?.['context_replacement'])
  if (!contextReplacement) {
    errors.push('payload.context_replacement')
    return
  }
  requirePayloadString(errors, contextReplacement, 'input_history_digest')
  requirePayloadString(errors, contextReplacement, 'reason')
  requirePayloadString(errors, contextReplacement, 'window_id')
  requirePayloadString(errors, contextReplacement, 'source_turn_id')
  requirePayloadString(errors, contextReplacement, 'ledger_status')
  requirePayloadNumber(errors, contextReplacement, 'replacement_history_turns')
}

function dispositionFromRuntimeEventKind(kind: RuntimeEventKind): RuntimeRecoveryCheckpointDisposition | undefined {
  return kind === 'checkpoint_resolved' ? 'resolved' : undefined
}

function collectRuntimeCheckpointDispositionFacts(events: RuntimeEventRecord[]): RuntimeCheckpointDispositionFact[] {
  return events
    .filter((event) =>
      event.kind === 'checkpoint_disposition_changed'
      || event.kind === 'checkpoint_resolved'
    )
    .slice(-MAX_RESUME_SUFFIX_EVENTS)
    .map((event) => {
      const payload = objectField(event.payload)
      return {
        event,
        checkpointId: event.checkpointId ?? stringField(payload?.['checkpoint_id']),
        checkpointKind: event.checkpointKind,
        previousDisposition: stringField(payload?.['previous_disposition']),
        disposition: stringField(payload?.['disposition']) ?? dispositionFromRuntimeEventKind(event.kind),
        reason: stringField(payload?.['reason']),
        inspectCommands: stringArrayField(payload?.['inspect_commands']),
        payload,
      }
    })
}

function normalizeReportText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function requireReportValue(
  normalizedReportText: string,
  value: string | undefined,
  missingLabel: string,
  missingReportFields: string[],
): void {
  if (!value) return
  if (!normalizedReportText.includes(normalizeReportText(value))) {
    missingReportFields.push(missingLabel)
  }
}

function addMissingReportField(missingReportFields: string[], missingLabel: string | undefined): void {
  if (!missingLabel || missingLabel.endsWith(':undefined')) return
  if (!missingReportFields.includes(missingLabel)) {
    missingReportFields.push(missingLabel)
  }
}

function parseRuntimeTruthResumeReportContract(text: string): Record<string, unknown> | undefined {
  return parseRuntimeReportObject(text)
}

export function parseRuntimeReportObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = []
  const fencedJson = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fencedJson?.[1]) candidates.push(fencedJson[1].trim())
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)
  const firstJsonObject = extractFirstJsonObject(trimmed)
  if (firstJsonObject && firstJsonObject !== trimmed) candidates.push(firstJsonObject)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const object = objectField(parsed)
      if (object) return object
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaping = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

function objectArrayField(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(objectField(item)),
  )
}

function requireStructuredReportString(
  report: Record<string, unknown> | undefined,
  key: string,
  expected: string | undefined,
  missingLabel: string,
  missingReportFields: string[],
): void {
  if (!expected || !report) return
  if (stringField(report[key]) !== expected) {
    missingReportFields.push(missingLabel)
  }
}

function requireStructuredStaleTranscriptTrust(
  report: Record<string, unknown> | undefined,
  missingReportFields: string[],
): void {
  if (!report) return
  const ignored = report['ignored_stale_transcript'] === true
  const trustedFalse = report['stale_transcript_trusted'] === false
  if (!ignored && !trustedFalse) {
    missingReportFields.push('stale_transcript_trust')
  }
}

function findStructuredCheckpoint(
  report: Record<string, unknown> | undefined,
  arrayKey: string,
  checkpointId: string | undefined,
): Record<string, unknown> | undefined {
  if (!report || !checkpointId) return undefined
  return objectArrayField(report[arrayKey])
    .find((item) => stringField(item['checkpoint_id']) === checkpointId)
}

function requireStructuredCheckpointInspectCommand(
  checkpoint: Record<string, unknown> | undefined,
  inspectCommand: string | undefined,
  missingLabel: string,
  missingReportFields: string[],
): void {
  if (!inspectCommand || !checkpoint) return
  const primary = stringField(checkpoint['inspect_command'])
  const commands = stringArrayField(checkpoint['inspect_commands']) ?? []
  if (primary !== inspectCommand && !commands.includes(inspectCommand)) {
    missingReportFields.push(missingLabel)
  }
}

function findStructuredRuntimeIntervention(
  report: Record<string, unknown> | undefined,
  interventionKind: string | undefined,
): Record<string, unknown> | undefined {
  if (!report || !interventionKind) return undefined
  return objectArrayField(report['runtime_interventions'])
    .find((item) => stringField(item['intervention_kind']) === interventionKind)
}

function findStructuredRuntimeClosure(
  report: Record<string, unknown> | undefined,
  closureReason: string | undefined,
): Record<string, unknown> | undefined {
  if (!report || !closureReason) return undefined
  return objectArrayField(report['runtime_closures'])
    .find((item) => stringField(item['closure_reason']) === closureReason)
}

function findStructuredRuntimeRecoveryReport(
  report: Record<string, unknown> | undefined,
  reportKind: string | undefined,
  checkpointId: string | undefined,
): Record<string, unknown> | undefined {
  if (!report || !reportKind || !checkpointId) return undefined
  return objectArrayField(report['runtime_recovery_reports'])
    .find((item) =>
      stringField(item['report_kind']) === reportKind
      && stringField(item['checkpoint_id']) === checkpointId
    )
}

function firstRuntimeRecoveryReportCommand(report: unknown): string | undefined {
  const object = objectField(report)
  if (!object) return undefined
  return runtimeRecoveryReportCommands(object)[0]
}

function structuredValueContainsString(value: unknown, expected: string): boolean {
  return normalizeReportText(JSON.stringify(value ?? null)).includes(normalizeReportText(expected))
}

function mentionsRuntimeTruthSource(normalizedReportText: string): boolean {
  return [
    'runtime truth',
    'runtime snapshot',
    'runtime_event_log',
    'runtime-owned',
    'stale transcript',
    'not trusted',
  ].some((needle) => normalizedReportText.includes(needle))
}

function cloneConversationTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return JSON.parse(JSON.stringify(turns)) as ConversationTurn[]
}

export function isRuntimeTruthResumePromptTurn(turn: ConversationTurn): boolean {
  return turn.role === 'user'
    && turn.content.some((block) =>
      block.type === 'text'
      && 'text' in block
      && typeof block.text === 'string'
      && block.text.includes(RUNTIME_TRUTH_RESUME_PROMPT_MARKER),
    )
}

function compactJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value.length > MAX_RESUME_STRING_CHARS
      ? `${value.slice(0, MAX_RESUME_STRING_CHARS)}…`
      : value
  }
  if (typeof value !== 'object') return value
  if (depth >= 3) return '[object]'
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => compactJsonValue(item, depth + 1))
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_RESUME_PAYLOAD_KEYS)
  return Object.fromEntries(entries.map(([key, item]) => [key, compactJsonValue(item, depth + 1)]))
}

function compactRuntimeTruthResumeReport(report: Record<string, unknown>): unknown {
  const compacted = compactJsonValue(report)
  const compactedObject = objectField(compacted)
  const diagnostics = report['event_contract_diagnostics']
  if (!compactedObject || diagnostics === undefined) return compacted
  return {
    ...compactedObject,
    event_contract_diagnostics: compactJsonValue(diagnostics),
  }
}
