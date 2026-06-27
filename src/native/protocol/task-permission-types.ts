/**
 * Pure types for the Action Permission State Machine.
 *
 * Lives in `protocol/` because both `protocol/types.ts` (TaskExecutionState)
 * and runtime modules (`tool-risk.ts`, `turn-permission-state.ts`,
 * `abandoned-grant-predicate.ts`) need them. Protocol layer cannot import
 * from runtime layer, so the types live here, not in `turn-permission-state.ts`.
 *
 * Runtime helpers (recordProposal, recordPermissionGranted, ...) live in
 * `src/native/turn-permission-state.ts` and consume these types.
 */

export type RiskClass =
  | 'safe'            // read-only, no permission needed
  | 'safe_readonly_local' // local GET/HEAD health diagnostics, no permission needed
  | 'internal_state'  // mutates OwlCoda session state (tasks, todos, dialogs); not a user-visible artifact
  | 'mutating'        // file/edit/write inside cwd
  | 'destructive'     // shell with deletion / sudo / pipe-to-shell shape
  | 'external_effect' // network / outside-cwd write / subagent spawn

export type PermissionState =
  | 'not_needed'
  | 'needed'
  | 'requested'
  | 'granted'
  | 'denied'

export type ObservedActivity =
  | 'thinking' | 'reading' | 'planning'
  | 'executing' | 'verifying' | 'idle'

export type TurnPhase =
  | 'intake'
  | 'explore'
  | 'plan'
  | 'execute'
  | 'verify'
  | 'report'
  | 'final'
  | 'blocked'

export type PhaseConfidence = 'high' | 'medium' | 'low'

export type PhaseReasonCode =
  | 'no_events'
  | 'recent_exploration'
  | 'recent_plan_activity'
  | 'recent_write_evidence'
  | 'recent_execution_activity'
  | 'recent_verification_evidence'
  | 'completion_claim_after_evidence'
  | 'report_text_after_evidence'
  | 'report_text_after_exploration'
  | 'pending_abandoned_grant'
  | 'permission_denied'
  | 'runtime_nudge'
  | 'unknown_mixed_activity'

export type PhaseEventKind =
  | 'assistant_text'
  | 'tool_proposed'
  | 'permission_requested'
  | 'permission_granted'
  | 'permission_denied'
  | 'tool_started'
  | 'tool_completed'
  | 'post_grant_evidence'
  | 'verification_evidence'
  | 'completion_claim'
  | 'runtime_nudge'

export interface PhaseEvent {
  iter: number
  kind: PhaseEventKind
  ts: number
  tool?: string
  detail?: string
  evidenceKind?: string
  phaseHint?: TurnPhase
  confidence?: PhaseConfidence
}

export interface DerivedTurnPhase {
  phase: TurnPhase
  confidence: PhaseConfidence
  reasonCodes: PhaseReasonCode[]
  evidenceCount: number
  pendingRiskyGrantCount: number
  lastEventKind?: PhaseEventKind
  lastTool?: string
}

export interface GrantEvent {
  ts: number
  mode: 'user_prompt' | 'always_allow' | 'auto_approve' | 'config_allow' | 'batch_allow'
  iteration: number
}

export interface PostGrantEvidence {
  kind: 'touched_path' | 'artifact_write' | 'tool_completion'
  detail: string
  ts: number
}

export interface ProposedToolCall {
  tool: string
  riskClass: RiskClass
  permissionState: PermissionState
  proposedAtIter: number
  grantEvent?: GrantEvent
  startedAtIter?: number
  completedAtIter?: number
  postGrantEvidence: PostGrantEvidence[]
  toolUseId?: string
}

export type DerivedLifecycle =
  | 'proposed'
  | 'awaiting'
  | 'granted_idle'
  | 'executing'
  | 'settled'
  | 'denied'

export interface EditNowNudge {
  tool: string
  grantIteration: number
  itersSinceGrant: number
  grantTs: number
}
