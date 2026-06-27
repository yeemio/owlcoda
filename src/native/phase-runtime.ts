/**
 * Phase-aware runtime shadow derivation.
 *
 * This module is intentionally side-effect free. Slice 2 derives the current
 * phase from recorded events but does not change gate decisions yet.
 */

import type { TaskExecutionState } from './protocol/types.js'
import type { DeliverableContractClassification } from './deliverable-contract.js'
import type {
  DerivedTurnPhase,
  PhaseEvent,
  PhaseReasonCode,
  ProposedToolCall,
  RiskClass,
  TurnPhase,
  EditNowNudge,
} from './protocol/task-permission-types.js'

const RISK_REQUIRES_EVIDENCE: ReadonlySet<RiskClass> = new Set([
  'mutating',
  'destructive',
  'external_effect',
])

const RECENT_EVENT_WINDOW = 8

type PhaseStateInput = Pick<TaskExecutionState, 'phaseEvents' | 'proposedToolCalls' | 'contract'>

export function deriveTurnPhase(taskState: PhaseStateInput): DerivedTurnPhase {
  const events = taskState.phaseEvents
  const recent = events.slice(-RECENT_EVENT_WINDOW)
  const last = events.at(-1)
  const reasonCodes: PhaseReasonCode[] = []
  const pendingRiskyGrantCount = countPendingRiskyGrants(taskState.proposedToolCalls)
  const evidenceCount = countEvidence(events, taskState)

  if (!last) {
    return {
      phase: 'intake',
      confidence: 'high',
      reasonCodes: ['no_events'],
      evidenceCount,
      pendingRiskyGrantCount,
    }
  }

  const denied = findLastPhaseEvent(recent, (event) => event.kind === 'permission_denied')
  if (denied) {
    reasonCodes.push('permission_denied')
    return buildResult('blocked', 'high', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  const nudge = findLastPhaseEvent(recent, (event) => event.kind === 'runtime_nudge')
  if (nudge && nudge.detail === 'edit_now' && pendingRiskyGrantCount > 0) {
    reasonCodes.push('runtime_nudge', 'pending_abandoned_grant')
    return buildResult('execute', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (pendingRiskyGrantCount > 0) {
    reasonCodes.push('pending_abandoned_grant')
    return buildResult('execute', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  const hasVerificationEvidence = recent.some((event) => event.kind === 'verification_evidence')
  const hasPostGrantEvidence = recent.some((event) => event.kind === 'post_grant_evidence')
    || taskState.contract.touchedPaths.length > 0

  if (last.kind === 'completion_claim' && evidenceCount > 0) {
    reasonCodes.push('completion_claim_after_evidence')
    return buildResult('final', 'high', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (last.kind === 'assistant_text' && evidenceCount > 0) {
    reasonCodes.push('report_text_after_evidence')
    return buildResult('report', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (hasVerificationEvidence || last.phaseHint === 'verify') {
    reasonCodes.push('recent_verification_evidence')
    return buildResult('verify', hasVerificationEvidence ? 'high' : 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (hasPostGrantEvidence) {
    reasonCodes.push('recent_write_evidence')
    return buildResult('execute', 'high', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (last.kind === 'assistant_text' && recent.some((event) => event.phaseHint === 'explore')) {
    reasonCodes.push('report_text_after_exploration')
    return buildResult('report', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (last.phaseHint === 'plan' || recent.some((event) => event.phaseHint === 'plan')) {
    reasonCodes.push('recent_plan_activity')
    return buildResult('plan', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (last.phaseHint === 'explore' || recent.some((event) => event.phaseHint === 'explore')) {
    reasonCodes.push('recent_exploration')
    return buildResult('explore', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (last.phaseHint === 'execute') {
    reasonCodes.push('recent_execution_activity')
    return buildResult('execute', 'medium', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  if (nudge) {
    reasonCodes.push('runtime_nudge')
    return buildResult('blocked', 'low', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
  }

  reasonCodes.push('unknown_mixed_activity')
  return buildResult('report', 'low', reasonCodes, evidenceCount, pendingRiskyGrantCount, last)
}

export interface AbandonedGrantDecisionLike {
  fire: boolean
  reason?: string
  nudge?: EditNowNudge
}

export interface NoProgressInterventionInput {
  oldHardStop: boolean
  phaseVerdict: DerivedTurnPhase
  abandonedGrantDecision: AbandonedGrantDecisionLike
}

export interface NoProgressInterventionDecision {
  fire: boolean
  reason: string
  nudge?: EditNowNudge
  phaseAllowsContinue: boolean
}

export interface CompletionClaimEvaluationInput {
  taskState: Pick<TaskExecutionState, 'phaseEvents' | 'proposedToolCalls' | 'contract'>
  finalText: string
  deliverable: DeliverableContractClassification
  legacyCompletionAccepted: boolean
  phaseVerdict?: DerivedTurnPhase
}

export interface CompletionClaimEvaluationDecision {
  status: 'accepted' | 'blocked' | 'not_completion'
  reason: string
  artifactEvidenceCount: number
  verificationEvidenceCount: number
  pendingRiskyGrantCount: number
}

export function shouldInterveneForNoProgress(
  input: NoProgressInterventionInput,
): NoProgressInterventionDecision {
  const { oldHardStop, phaseVerdict, abandonedGrantDecision } = input

  if (!oldHardStop) {
    return {
      fire: false,
      reason: 'old durable gate eligibility is false',
      phaseAllowsContinue: true,
    }
  }

  if (phaseVerdict.confidence === 'low') {
    return {
      fire: false,
      reason: `phase=${phaseVerdict.phase}/low fail-open`,
      phaseAllowsContinue: true,
    }
  }

  if (
    (phaseVerdict.phase === 'verify' || phaseVerdict.phase === 'report' || phaseVerdict.phase === 'final')
    && phaseVerdict.evidenceCount > 0
  ) {
    return {
      fire: false,
      reason: `phase=${phaseVerdict.phase} has evidence (${phaseVerdict.evidenceCount})`,
      phaseAllowsContinue: true,
    }
  }

  if (phaseVerdict.phase === 'execute') {
    const decision: NoProgressInterventionDecision = {
      fire: abandonedGrantDecision.fire,
      reason: abandonedGrantDecision.reason ?? 'phase=execute follows abandoned-grant predicate',
      phaseAllowsContinue: !abandonedGrantDecision.fire,
    }
    if (abandonedGrantDecision.nudge !== undefined) decision.nudge = abandonedGrantDecision.nudge
    return decision
  }

  return {
    fire: oldHardStop,
    reason: `phase=${phaseVerdict.phase}/${phaseVerdict.confidence} falls back to old durable no-progress gate`,
    phaseAllowsContinue: false,
  }
}

export function evaluateCompletionClaim(
  input: CompletionClaimEvaluationInput,
): CompletionClaimEvaluationDecision {
  const text = input.finalText.trim()
  const phaseVerdict = input.phaseVerdict ?? deriveTurnPhase(input.taskState)
  const artifactEvidenceCount = countArtifactEvidence(input.taskState)
  const verificationEvidenceCount = countVerificationEvidence(input.taskState.phaseEvents)
  const pendingRiskyGrantCount = countCompletionBlockingRiskyGrants(input.taskState.proposedToolCalls)

  if (!text) {
    return {
      status: 'not_completion',
      reason: 'empty final text',
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  if (!input.legacyCompletionAccepted) {
    return {
      status: 'blocked',
      reason: 'legacy completion check did not accept this final text',
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  if (pendingRiskyGrantCount > 0) {
    return {
      status: 'blocked',
      reason: `pending risky grant count=${pendingRiskyGrantCount}`,
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  if (input.deliverable.allowsChatFinal) {
    return {
      status: 'accepted',
      reason: `deliverable mode ${input.deliverable.mode} allows chat final`,
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  if (input.deliverable.requiresDurableArtifact && artifactEvidenceCount <= 0) {
    return {
      status: 'blocked',
      reason: `durable ${input.deliverable.mode} completion has no artifact evidence`,
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  if (claimsVerification(text) && verificationEvidenceCount <= 0) {
    return {
      status: 'blocked',
      reason: 'final text claims verification/testing without verification evidence',
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  const reportContract = evaluateRuntimeSensitiveFinalReportContract(text)
  if (reportContract.applies && reportContract.missing.length > 0) {
    return {
      status: 'blocked',
      reason: `runtime-sensitive final report missing evidence layers: ${reportContract.missing.join(', ')}`,
      artifactEvidenceCount,
      verificationEvidenceCount,
      pendingRiskyGrantCount,
    }
  }

  return {
    status: 'accepted',
    reason: `phase=${phaseVerdict.phase}/${phaseVerdict.confidence} completion has evidence`,
    artifactEvidenceCount,
    verificationEvidenceCount,
    pendingRiskyGrantCount,
  }
}

function countPendingRiskyGrants(calls: ProposedToolCall[]): number {
  return calls.filter((call) =>
    RISK_REQUIRES_EVIDENCE.has(call.riskClass)
    && call.permissionState === 'granted'
    && call.postGrantEvidence.length === 0
  ).length
}

function countCompletionBlockingRiskyGrants(calls: ProposedToolCall[]): number {
  return calls.filter((call) =>
    RISK_REQUIRES_EVIDENCE.has(call.riskClass)
    && call.permissionState === 'granted'
    && call.completedAtIter === undefined
    && call.postGrantEvidence.length === 0
  ).length
}

function countEvidence(events: PhaseEvent[], taskState: PhaseStateInput): number {
  const eventEvidence = events.filter((event) =>
    event.kind === 'post_grant_evidence' || event.kind === 'verification_evidence'
  ).length
  const toolEvidence = taskState.proposedToolCalls.reduce((sum, call) => sum + call.postGrantEvidence.length, 0)
  return eventEvidence + toolEvidence + taskState.contract.touchedPaths.length
}

function countArtifactEvidence(taskState: Pick<TaskExecutionState, 'phaseEvents' | 'proposedToolCalls' | 'contract'>): number {
  const eventEvidence = taskState.phaseEvents.filter((event) => event.kind === 'post_grant_evidence').length
  const toolEvidence = taskState.proposedToolCalls.reduce((sum, call) => sum + call.postGrantEvidence.length, 0)
  return eventEvidence + toolEvidence + taskState.contract.touchedPaths.length
}

function countVerificationEvidence(events: PhaseEvent[]): number {
  return events.filter((event) => event.kind === 'verification_evidence').length
}

function claimsVerification(text: string): boolean {
  return /\b(?:verified|verification|audit|audited|DeliveryAudit|TaskVerify|tests?\s+(?:pass|passed|green)|all tests pass|0 failed)\b/i.test(text)
    || /\b(?:dry[- ]?run|smoke|sanity|verification|tests?|checks?|audit)\b[^.!?\n]{0,100}\b(?:proves?|proved|confirms?|confirmed|works?|clean|passes?|passed|green|ok)\b/i.test(text)
    || /(?:验证|校验|审计|测试)[^。！？\n]{0,80}(?:通过|完成|确认|全绿)/i.test(text)
}

interface RuntimeSensitiveFinalReportContract {
  applies: boolean
  missing: string[]
}

function evaluateRuntimeSensitiveFinalReportContract(text: string): RuntimeSensitiveFinalReportContract {
  if (!isRuntimeSensitiveCompletion(text)) {
    return { applies: false, missing: [] }
  }

  const missing: string[] = []
  const requiredLayers = [
    ['incident_mitigated', /\bincident[_ -]?mitigated\b|\bincident\b[^.!?\n]{0,80}\b(?:mitigated|none|n\/a|not needed|no live)\b/i],
    ['code_changed', /\bcode[_ -]?changed\b|\bchanged files?\b|\bfiles? changed\b|\bno[- ]?code[- ]?change\b/i],
    ['verified', /\bverified\b|\bverification\b|\btests?\b[^.!?\n]{0,80}\b(?:pass|passed|green|0 failed)\b/i],
    ['not_fixed', /\bnot[_ -]?fixed\b|\bknown (?:gap|defect|issue)\b|\bremain(?:s|ing)? pending\b|\bstill pending\b/i],
  ] as const

  const missingStatusLayers = requiredLayers
    .filter(([, pattern]) => !pattern.test(text))
    .map(([label]) => label)
  if (missingStatusLayers.length > 0) {
    missing.push(`status layers(${missingStatusLayers.join('/')})`)
  }
  if (!/\bchanged files?\b|\bfiles? changed\b|\bno[- ]?code[- ]?change\b|\bno files? changed\b/i.test(text)) {
    missing.push('changed files or no-code-change')
  }
  if (!/\bverification command\b|\bcommands? run\b|\bcommand\b[^.!?\n]{0,80}\b(?:npm|npx|vitest|pytest|pnpm|yarn|cargo|go test)\b|\b(?:npm|npx|vitest|pytest|pnpm|yarn|cargo|go test)\b/i.test(text)) {
    missing.push('verification command')
  }
  if (!/\bobserved result\b|\bresult\b[^.!?\n]{0,80}\b(?:pass|passed|green|0 failed|exit code|ok)\b|\b\d+\s+passed\b|\b0 failed\b/i.test(text)) {
    missing.push('observed result')
  }
  if (!/\bremaining risks?\b|\bresidual risks?\b|\bknown (?:gap|defect|issue)\b|\brisk\b|\bnot[_ -]?fixed\b/i.test(text)) {
    missing.push('remaining risk')
  }

  return { applies: true, missing }
}

function isRuntimeSensitiveCompletion(text: string): boolean {
  return /\b(?:runtime[- ]?(?:supervisor|truth|recovery|lifecycle|gate|bug|fix|state|contract|tool)|long[- ]?tasks?|watchdogs?|supervisors?|jobs?|browser|playwright|chrome|process(?:es)?|pids?|daemon|agents?|subagents?|external tools?|TaskVerify|TaskUpdate|recovery|checkpoint|resume|timeout|deadline)\b/i.test(text)
}

function findLastPhaseEvent(
  events: PhaseEvent[],
  predicate: (event: PhaseEvent) => boolean,
): PhaseEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event && predicate(event)) return event
  }
  return undefined
}

function buildResult(
  phase: TurnPhase,
  confidence: DerivedTurnPhase['confidence'],
  reasonCodes: PhaseReasonCode[],
  evidenceCount: number,
  pendingRiskyGrantCount: number,
  last: PhaseEvent,
): DerivedTurnPhase {
  const result: DerivedTurnPhase = {
    phase,
    confidence,
    reasonCodes,
    evidenceCount,
    pendingRiskyGrantCount,
    lastEventKind: last.kind,
  }
  if (last.tool !== undefined) result.lastTool = last.tool
  return result
}
