/**
 * Gate telemetry — structured event logger for production_gate / task_no_progress
 * / tool_loop / write_scope_block fire sites.
 *
 * Provides observability data for v3 calibration decisions:
 *   - Is the confidence threshold (high/medium/low) correctly classifying prompts?
 *   - What is the ALLOW regex false-positive rate?
 *   - Are hard-stop thresholds appropriate?
 *
 * Events are appended as newline-delimited JSON to
 *   ~/.owlcoda/telemetry/gate-events-YYYY-MM-DD.jsonl
 *
 * fs writes are synchronous and fire-and-forget: any I/O error is silently
 * swallowed so telemetry can never interfere with the main conversation loop.
 *
 * 0.14.18
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DeliverableMode, DeliverableConfidence, DeliverableSignalSummary } from './deliverable-contract.js'
import type { ProvenanceKind } from './protocol/write-provenance-types.js'

export const FIDELITY_ANCHOR_TYPES = [
  'path',
  'filename',
  'command',
  'number',
  'commit_hash',
  'tool_target',
  'line_ref',
] as const

export type FidelityAnchorType = (typeof FIDELITY_ANCHOR_TYPES)[number]

export const FIDELITY_EVIDENCE_ORIGINS = [
  'tool_call',
  'project_map',
  'instructions',
  'compaction_summary',
  'retained_turn',
  'unknown',
] as const

export type FidelityEvidenceOrigin = (typeof FIDELITY_EVIDENCE_ORIGINS)[number]

export const FIDELITY_FACT_TYPES = [
  'path',
  'number',
  'command',
  'commit_hash',
  'decision',
] as const

export type FidelityFactType = (typeof FIDELITY_FACT_TYPES)[number]

export const FIDELITY_COMPACTION_FACT_REASONS = [
  'dropped',
  'rephrased',
  'kept',
  'uncertain',
] as const

export type FidelityCompactionFactReason = (typeof FIDELITY_COMPACTION_FACT_REASONS)[number]

export type GateEventKind =
  | 'production_gate'
  | 'task_no_progress_hard'       // actual hard-stop (confidence=high)
  | 'task_no_progress_suppressed' // medium/low fail-open skip
  | 'tool_loop'
  | 'write_scope_block'
  // Slice 2 (Action Permission State Machine)
  | 'gate_predicate_agreement'
  | 'gate_predicate_disagreement'
  | 'abandoned_grant_hard_stop'
  | 'edit_now_nudge_injected'
  // Phase-aware runtime shadow telemetry (no behavior change).
  | 'phase_derived'
  | 'completion_claim_accepted'
  | 'completion_claim_blocked'
  // Write-target provenance gate shadow / enforcement telemetry.
  | 'path_provenance_admit_evidence'
  | 'path_provenance_parent_admit'
  | 'path_provenance_block'
  | 'path_provenance_would_block'
  | 'path_provenance_bash_unparseable'
  | 'path_provenance_probe_override'
  | 'path_provenance_deny_observed'
  | 'path_provenance_deny_block'
  | 'path_provenance_deny_revoked'
  | 'path_provenance_deny_pattern_skipped'
  | 'path_provenance_rule_warning'
  // Sub-agent invocation lifecycle (2026-05-28 Patch 5; ADR-001 first-tier).
  // Emitted once per Agent tool call when the sub-agent settles (success or
  // any failure path). Attribute naming intentionally tracks OpenTelemetry
  // GenAI semantic conventions (`gen_ai.agent.*` / `gen_ai.operation.*`) so
  // a future ADR-001 OTLP exporter can map this directly to an `invoke_agent`
  // span without re-instrumentation. See ARCHITECT-PLAN ADR-001 / KANBAN
  // [SUBAGENT-OUTPUT-CONTRACT].
  | 'agent_invocation'
  // Permission modes gate. Emitted when modes are enabled (default-on).
  | 'mode_gate_block'      // plan blocked a mutating call
  | 'mode_analysis_hint'   // analysis intent softened under modes (legacy guard would have blocked)
  | 'mode_auto_approve'    // auto mode auto-granted a low-risk call without prompting
  // Evidence-ledger fidelity shadow telemetry (observability only).
  | 'fidelity_claim_observed'
  | 'fidelity_compaction_fact_observed'
  // Project Map / Runtime Harness boundary bridge.
  | 'project_map_boundary_block'
  // Project Map default-on readiness — day-0 shadow sampling of the fresh/stale
  // snapshot decision (observability only, no behavior change).
  | 'project_map_snapshot_sampled'

export interface GateEvent {
  ts: number
  kind: GateEventKind
  conversationId: string
  iteration: number
  // Optional: the mode gate can fire outside a structured task (no taskState),
  // so this is omitted in that case rather than fabricated.
  contract?: {
    cwd: string
    scopeMode: string
    confidence: 'high' | 'medium' | 'low'
    allowedWritePathsByOrigin: Record<string, number>
    touchedPathsCount: number
    scratchArtifactPathsCount: number
  }
  lastToolSignatures: string[]
  reason?: string
  // Deliverable Contract v1 fields (Slice 0, 0.14.18+)
  // Note: contract.confidence above is path/write-scope confidence (orthogonal).
  // deliverableConfidence is mode-classification confidence.
  deliverableMode?: DeliverableMode
  deliverableConfidence?: DeliverableConfidence
  requiresDurableArtifact?: boolean
  allowsChatFinal?: boolean
  hardStopOnNoTouchedPaths?: boolean
  deliverableReasons?: string[]
  // Required when deliverableMode === 'mixed_unknown'
  matchedModes?: DeliverableMode[]
  signalSummary?: DeliverableSignalSummary
  // Slice 2 disagreement triage. Required when kind === 'gate_predicate_disagreement'.
  disagreementKind?: 'old_fires_new_silent' | 'new_fires_old_silent'
  // Slice 2 offending tool details for abandoned-grant interventions.
  offendingTool?: string
  itersSinceGrant?: number
  // Phase-aware runtime shadow verdict. Present for kind === 'phase_derived'
  // and opportunistically on related gate events while calibrating.
  phase?: string
  phaseConfidence?: string
  phaseReasons?: string[]
  phaseEvidenceCount?: number
  artifactEvidenceCount?: number
  verificationEvidenceCount?: number
  pendingRiskyGrantCount?: number
  oldGateVerdict?: boolean
  phaseGateVerdict?: boolean
  phaseGateReason?: string
  phaseRuntimeEnabled?: boolean
  wouldHaveHardStopped?: boolean
  hardStopEnabled?: boolean
  // Write-target provenance gate fields. Optional so existing gate emitters
  // don't need churn when this telemetry surface expands.
  turnId?: string
  runId?: string
  toolName?: string
  attemptedPath?: string
  canonicalPath?: string
  isNewFile?: boolean
  ledgerSize?: number
  via?: ProvenanceKind
  authorizingKind?: ProvenanceKind
  pathRecordCount?: number
  availableRecordKinds?: Partial<Record<ProvenanceKind, number>>
  parentPath?: string
  failedCount?: number
  targetCount?: number
  failedToolName?: string
  failedPath?: string
  denyMarker?: string
  denyOriginIteration?: number
  denyOriginalString?: string
  revokeMarker?: string
  revokeOriginalString?: string
  // PERM-7: settings-rule load warnings. Per warning, one event with
  // reason set to the parser's PermissionWarningReason string and source
  // set to the layer (user / project / local).
  ruleWarningReason?: string
  ruleWarningRaw?: string
  ruleWarningSource?: string
  // 2026-05-28 Patch 5: agent_invocation fields. Naming aligned with
  // OpenTelemetry GenAI semconv (gen_ai.agent.* / gen_ai.operation.*) so
  // the future ADR-001 OTLP exporter can map this event to an invoke_agent
  // span by attribute-rename alone (no re-instrumentation).
  agentId?: string
  agentType?: string            // general-purpose | Explore
  agentStatus?: 'success' | 'failed' | 'partial' | 'inferred' | 'cancelled'
  agentFailureCategory?: string // mirrors metadata.failureCategory
  agentStopReason?: string      // end_turn | max_iterations | tool_loop | terminal_tool_failure | ...
  agentIterations?: number
  agentDurationMs?: number
  agentInputTokens?: number
  agentOutputTokens?: number
  agentTouchedPathCount?: number
  /** Small capped path samples for dogfood collision triage; not exhaustive. */
  agentTouchedPaths?: string[]
  agentExpectedArtifactCount?: number
  agentExpectedArtifactPaths?: string[]
  agentParentTaskId?: string | null
  agentParentStepId?: string | null
  // Permission modes gate (Slice D).
  operatingMode?: 'plan' | 'normal' | 'auto' | 'yolo'
  modeRiskClass?: 'safe' | 'internal_state' | 'mutating' | 'destructive' | 'external_effect'
  modeWouldBlockLegacy?: boolean
  // Evidence-ledger fidelity shadow fields. These describe runtime facts
  // available to later audits and never grant authority or block execution.
  claimId?: string
  surface?: string
  anchorType?: FidelityAnchorType
  target?: string
  evidenceOrigin?: FidelityEvidenceOrigin
  matched?: boolean
  ageTurns?: number
  model?: string
  factType?: FidelityFactType
  sourceTurnId?: string
  beforeHash?: string
  afterMatch?: boolean
  preserved?: boolean
  compactionFactReason?: FidelityCompactionFactReason
  // Project Map snapshot shadow sampling (kind 'project_map_snapshot_sampled').
  // Day-0 readiness telemetry: each fresh/stale snapshot decision plus the
  // resulting map's shape, so staleness / false-positive rates can be computed
  // from accumulated samples. Pure observability; never gates execution.
  projectMapWasStale?: boolean
  projectMapFreshnessStatus?: 'fresh' | 'stale' | 'unknown'
  projectMapSourceFileCount?: number
  projectMapWriteBoundaryCount?: number
  projectMapVerificationProfileCount?: number
  projectMapGitHead?: string
  projectMapPackageName?: string
}

function telemetryFilePath(): string {
  const owlcodaHome = process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const dir = join(owlcodaHome, 'telemetry')
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return join(dir, `gate-events-${date}.jsonl`)
}

export function recordGateEvent(event: GateEvent): void {
  try {
    const filePath = telemetryFilePath()
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8')
  } catch {
    // Telemetry must never crash the main process. Swallow all errors silently.
  }
}

/** Shared base for a predicate-comparison event (the old vs new no-progress
 *  hard-stop predicate). The caller supplies the per-turn context. */
export type PredicateComparisonBase = Pick<
  GateEvent,
  | 'ts'
  | 'conversationId'
  | 'iteration'
  | 'contract'
  | 'lastToolSignatures'
  | 'deliverableMode'
  | 'deliverableConfidence'
  | 'requiresDurableArtifact'
  | 'allowsChatFinal'
  | 'hardStopOnNoTouchedPaths'
  | 'deliverableReasons'
>

/**
 * Decide which predicate-comparison event to emit. The disagreement half was
 * always recorded; the AGREEMENT half was missing, which made the GATE_V2
 * cutover criterion read 100% disagreement (a measurement artifact, not a real
 * divergence). Recording both is what makes `disagreement / total` meaningful.
 * Pure — the caller records the returned event.
 */
export function buildPredicateComparisonEvent(
  oldHardStop: boolean,
  newHardStop: boolean,
  base: PredicateComparisonBase,
): GateEvent {
  if (oldHardStop !== newHardStop) {
    return {
      ...base,
      kind: 'gate_predicate_disagreement',
      disagreementKind: oldHardStop ? 'old_fires_new_silent' : 'new_fires_old_silent',
      reason: `task_no_progress: old=${oldHardStop}, new=${newHardStop}`,
    }
  }
  return {
    ...base,
    kind: 'gate_predicate_agreement',
    reason: `task_no_progress: old=new=${oldHardStop}`,
  }
}
