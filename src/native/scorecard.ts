import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RuntimeEventRecord, RuntimeRecoveryCheckpointRecord } from './protocol/types.js'
import type {
  RuntimeFactsForRun,
  RuntimeFactArtifactLike,
  RuntimeFactJobLike,
  RuntimeFactStructuredOutputLike,
} from './runtime-facts.js'
import type { WorkflowConsumerManifest, WorkflowConsumerState } from './workflow-consumer.js'

export type ScorecardVerdict = 'pass' | 'warn' | 'fail' | 'unknown'
export type AntiCheatStatus = 'pass' | 'warn' | 'fail' | 'unknown'

export interface ScorecardDimension {
  id:
    | 'task_completion'
    | 'verification'
    | 'evidence_grounding'
    | 'file_discipline'
    | 'runtime_stability'
    | 'tool_efficiency'
    | 'token_cost'
    | 'time_cost'
    | 'model_output_artifact'
    | 'workflow_outcome'
  score: number
  verdict: ScorecardVerdict
  evidenceRefs: string[]
  notes: string[]
}

export interface AntiCheatGate {
  id:
    | 'unverified_pass_claim'
    | 'unresolved_checkpoint'
    | 'non_terminal_job'
    | 'missing_artifact_evidence'
    | 'fake_evidence_report'
  status: AntiCheatStatus
  evidenceRefs: string[]
  notes: string[]
}

export interface RunScorecard {
  scorecardVersion: 1
  runId: string
  threadIds: string[]
  turnIds: string[]
  generatedAt: string
  overallScore: number
  verdict: ScorecardVerdict
  dimensions: ScorecardDimension[]
  antiCheat: {
    verdict: AntiCheatStatus
    gates: AntiCheatGate[]
  }
  evidenceRefs: string[]
}

export interface BuildRunScorecardInput {
  facts: RuntimeFactsForRun
  finalText?: string
  generatedAt?: string
}

export interface TrajectoryRecord {
  trajectory_version: 1
  thread_id?: string
  turn_id?: string
  run_id: string
  state: Record<string, unknown>
  action: Record<string, unknown>
  observation: Record<string, unknown>
  reward: {
    score: number
    verdict: ScorecardVerdict
    anti_cheat: AntiCheatStatus
    structured_output?: StructuredOutputTrajectoryReward
    workflow_outcome?: WorkflowOutcomeTrajectoryReward
  }
  next_state: Record<string, unknown>
  evidence_refs: string[]
  redaction: {
    mode: 'local_redacted_v0'
    fields: string[]
  }
}

export interface StructuredOutputTrajectoryReward {
  score: number
  verdict: ScorecardVerdict
  ok: boolean | null
  parsed: boolean | null
  schema_valid: boolean | null
  repair_count: number
  salvage_used: boolean
  fallback_used: boolean
  validation_error_count: number
  policy_violation_count: number
  repair_penalty: number
  salvage_penalty: number
  fallback_penalty: number
  policy_penalty: number
  schema_penalty: number
  consistency_penalty: number
}

export interface WorkflowOutcomeTrajectoryReward {
  score: number
  verdict: ScorecardVerdict
  normalized_state: WorkflowConsumerState | 'unknown'
  acceptance_status: 'pass' | 'fail' | 'unknown'
  final_report_allowed: boolean
  blocker_count: number
  failed_required_steps: number
  skipped_steps: number
  resumed_steps: number
}

export function buildRunScorecard(input: BuildRunScorecardInput): RunScorecard {
  const facts = input.facts
  const finalText = input.finalText ?? ''
  const dimensions: ScorecardDimension[] = [
    scoreTaskCompletion(facts),
    scoreVerification(facts),
    scoreEvidenceGrounding(facts, finalText),
    scoreFileDiscipline(facts, finalText),
    scoreRuntimeStability(facts),
    scoreToolEfficiency(facts),
    scoreTokenCost(facts),
    scoreTimeCost(facts),
    scoreModelOutputArtifacts(facts),
    scoreWorkflowOutcomes(facts),
  ]
  const gates = buildAntiCheatGates(facts, finalText)
  const antiCheatVerdict = worstAntiCheat(gates)
  const dimensionAverage = dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length
  const antiCheatPenalty = antiCheatVerdict === 'fail' ? 25 : antiCheatVerdict === 'warn' ? 10 : 0
  const overallScore = clampScore(Math.round(dimensionAverage * 100 - antiCheatPenalty))
  const evidenceRefs = uniqueStrings([
    ...facts.eventIds,
    ...facts.checkpointRecordIds,
    ...facts.jobIds,
    ...facts.artifactIds,
    ...facts.proofIds,
  ])
  return {
    scorecardVersion: 1,
    runId: facts.runId,
    threadIds: facts.threadIds,
    turnIds: facts.turnIds,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    overallScore,
    verdict: scoreToVerdict(overallScore),
    dimensions,
    antiCheat: {
      verdict: antiCheatVerdict,
      gates,
    },
    evidenceRefs,
  }
}

export function summarizeRunScorecard(scorecard: RunScorecard): string {
  const lines = [
    `Scorecard run=${scorecard.runId} score=${scorecard.overallScore} verdict=${scorecard.verdict} anti_cheat=${scorecard.antiCheat.verdict}`,
    'Dimensions:',
  ]
  for (const dimension of scorecard.dimensions) {
    lines.push(`- ${dimension.id}: ${Math.round(dimension.score * 100)} ${dimension.verdict} (${dimension.notes.join('; ') || 'no notes'})`)
  }
  lines.push('Anti-cheat gates:')
  for (const gate of scorecard.antiCheat.gates) {
    lines.push(`- ${gate.id}: ${gate.status} (${gate.notes.join('; ') || 'no notes'})`)
  }
  return lines.join('\n')
}

export function buildRunTrajectory(facts: RuntimeFactsForRun, scorecard: RunScorecard): TrajectoryRecord[] {
  const events = facts.events.length > 0 ? facts.events : []
  const structuredOutputArtifacts = collectScoredStructuredOutputArtifacts(facts)
  const workflowManifests = collectScoredWorkflowConsumerManifests(facts)
  if (events.length === 0 && structuredOutputArtifacts.length === 0 && workflowManifests.length === 0) {
    return [trajectoryFromObservation({
      facts,
      scorecard,
      action: { type: 'scorecard_snapshot' },
      observation: {
        kind: 'scorecard_generated',
        runId: facts.runId,
        evidenceRefs: scorecard.evidenceRefs,
      },
    })]
  }

  const eventRecords = events.map((event, index) => trajectoryFromObservation({
    facts,
    scorecard,
    event,
    action: actionFromRuntimeEvent(event),
    observation: {
      id: event.id,
      seq: event.seq,
      kind: event.kind,
      at: event.at,
      itemId: event.itemId,
      checkpointId: event.checkpointId,
      checkpointKind: event.checkpointKind,
      factRefs: event.factRefs,
      payload: event.payload,
    },
    state: {
      event_index: index,
      prior_event_count: index,
      checkpoint_count: facts.checkpoints.length,
      job_count: facts.jobs.length,
      artifact_count: facts.artifacts.length,
    },
    nextState: {
      event_index: index + 1,
      observed_event_count: index + 1,
    },
  }))
  const structuredRecords = structuredOutputArtifacts.map((artifact, index) =>
    trajectoryFromStructuredOutputArtifact(facts, scorecard, artifact, events.length + index),
  )
  const workflowRecords = workflowManifests.map((manifest, index) =>
    trajectoryFromWorkflowConsumerManifest(
      facts,
      scorecard,
      manifest,
      events.length + structuredOutputArtifacts.length + index,
    ),
  )
  return [...eventRecords, ...structuredRecords, ...workflowRecords]
}

export function scorecardToJson(scorecard: RunScorecard, pretty = true): string {
  return JSON.stringify(scorecard, null, pretty ? 2 : 0)
}

export function trajectoryToJsonl(records: TrajectoryRecord[]): string {
  return records.map(record => JSON.stringify(record)).join('\n')
}

export async function writeTrajectoryJsonl(path: string, records: TrajectoryRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = trajectoryToJsonl(records)
  await writeFile(path, body ? `${body}\n` : '', 'utf8')
}

function scoreTaskCompletion(facts: RuntimeFactsForRun): ScorecardDimension {
  const completed = facts.events.find(event => event.kind === 'turn_completed')
  if (!completed) return dimension('task_completion', 0.35, 'unknown', [], ['no turn_completed event in runtime facts'])
  const stopReason = stringField(completed.payload?.['stop_reason'])
  if (stopReason === 'end_turn') return dimension('task_completion', 1, 'pass', [completed.id], ['turn completed with end_turn'])
  return dimension('task_completion', 0.45, 'warn', [completed.id], [`turn completed with stop_reason=${stopReason ?? 'unknown'}`])
}

function scoreVerification(facts: RuntimeFactsForRun): ScorecardDimension {
  const verificationEvents = facts.events.filter(isVerificationEvent)
  if (verificationEvents.length === 0) {
    return dimension('verification', 0.3, 'unknown', [], ['no TaskVerify/ArtifactVerify/test evidence found'])
  }
  const assessed = verificationEvents.map(event => assessVerificationEvent(event))
  const failed = assessed.filter(item => item.status === 'fail')
  if (failed.length > 0) {
    return dimension('verification', 0, 'fail', failed.map(item => item.event.id), failed.map(item => item.note))
  }
  const warned = assessed.filter(item => item.status === 'warn')
  if (warned.length > 0) {
    return dimension('verification', 0.65, 'warn', warned.map(item => item.event.id), warned.map(item => item.note))
  }
  return dimension('verification', 1, 'pass', verificationEvents.map(event => event.id), [`${verificationEvents.length} verification event(s) passed`])
}

function scoreEvidenceGrounding(facts: RuntimeFactsForRun, finalText: string): ScorecardDimension {
  if (!finalText.trim()) return dimension('evidence_grounding', 0.4, 'unknown', [], ['no final text provided'])
  const refs = evidenceRefsMentioned(facts, finalText)
  if (refs.length > 0) return dimension('evidence_grounding', 1, 'pass', refs, ['final text references runtime evidence'])
  if (facts.eventIds.length + facts.artifactIds.length + facts.proofIds.length > 0) {
    return dimension('evidence_grounding', 0.5, 'warn', [], ['runtime evidence exists but final text does not reference it'])
  }
  return dimension('evidence_grounding', 0.25, 'unknown', [], ['no runtime evidence available for grounding'])
}

function scoreFileDiscipline(facts: RuntimeFactsForRun, finalText: string): ScorecardDimension {
  const deliveryAudit = assessDeliveryAuditFileEvidence(facts)
  if (deliveryAudit && deliveryAudit.unrelatedResidueCount > 0) {
    return dimension(
      'file_discipline',
      0.45,
      'warn',
      deliveryAudit.eventIds,
      [`DeliveryAudit reported unrelated residue=${deliveryAudit.unrelatedResidueCount}`],
    )
  }
  if (deliveryAudit && deliveryAudit.touchedDeliverableCount > 0) {
    return dimension(
      'file_discipline',
      0.9,
      'pass',
      deliveryAudit.eventIds,
      [`DeliveryAudit recorded touched deliverables=${deliveryAudit.touchedDeliverableCount}`],
    )
  }
  if (facts.artifacts.length > 0) {
    return dimension('file_discipline', 0.85, 'pass', facts.artifactIds, [`${facts.artifacts.length} artifact(s) recorded`])
  }
  if (claimsFileWork(finalText)) {
    return dimension('file_discipline', 0.2, 'warn', [], ['final text claims file/artifact work but no artifact refs are recorded'])
  }
  return dimension('file_discipline', 0.6, 'unknown', [], ['no artifact-producing work detected'])
}

function scoreRuntimeStability(facts: RuntimeFactsForRun): ScorecardDimension {
  const activeCheckpoints = facts.checkpoints.filter(isUnresolvedCheckpoint)
  const activeJobs = facts.jobs.filter(job => !isTerminalJob(job))
  if (activeCheckpoints.length > 0 || activeJobs.length > 0) {
    return dimension('runtime_stability', 0.2, 'warn', [
      ...activeCheckpoints.map(checkpoint => checkpoint.id),
      ...activeJobs.map(job => job.jobId),
    ], [`${activeCheckpoints.length} unresolved checkpoint(s), ${activeJobs.length} non-terminal job(s)`])
  }
  if (facts.checkpoints.length > 0 || facts.jobs.length > 0) {
    return dimension('runtime_stability', 1, 'pass', [
      ...facts.checkpointRecordIds,
      ...facts.jobIds,
    ], ['checkpoints/jobs are terminal or resolved'])
  }
  return dimension('runtime_stability', 0.7, 'unknown', [], ['no long-task recovery evidence needed'])
}

function scoreToolEfficiency(facts: RuntimeFactsForRun): ScorecardDimension {
  const toolEvents = facts.events.filter(event => event.kind === 'item_started' || event.kind === 'item_completed')
  if (toolEvents.length === 0) return dimension('tool_efficiency', 0.7, 'unknown', [], ['no tool events'])
  if (toolEvents.length > 80) return dimension('tool_efficiency', 0.35, 'warn', toolEvents.slice(0, 5).map(event => event.id), [`high tool event count=${toolEvents.length}`])
  return dimension('tool_efficiency', 0.9, 'pass', toolEvents.slice(0, 5).map(event => event.id), [`tool event count=${toolEvents.length}`])
}

function scoreTokenCost(facts: RuntimeFactsForRun): ScorecardDimension {
  const completed = facts.events.find(event => event.kind === 'turn_completed')
  const inputTokens = numberField(completed?.payload?.['input_tokens'])
  const outputTokens = numberField(completed?.payload?.['output_tokens'])
  if (inputTokens === undefined && outputTokens === undefined) {
    return dimension('token_cost', 0.6, 'unknown', [], ['no token accounting in runtime facts'])
  }
  const total = (inputTokens ?? 0) + (outputTokens ?? 0)
  if (total > 500_000) return dimension('token_cost', 0.35, 'warn', completed ? [completed.id] : [], [`high token total=${total}`])
  return dimension('token_cost', 0.9, 'pass', completed ? [completed.id] : [], [`token total=${total}`])
}

function scoreTimeCost(facts: RuntimeFactsForRun): ScorecardDimension {
  const starts = facts.events.filter(event => event.kind === 'turn_started')
  const completed = facts.events.find(event => event.kind === 'turn_completed')
  const start = starts[0]?.at ? Date.parse(starts[0].at) : Number.NaN
  const end = completed?.at ? Date.parse(completed.at) : Number.NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return dimension('time_cost', 0.6, 'unknown', [], ['no complete turn timing evidence'])
  }
  const durationMs = end - start
  if (durationMs > 30 * 60 * 1000) return dimension('time_cost', 0.45, 'warn', completed ? [completed.id] : [], [`long turn duration=${durationMs}ms`])
  return dimension('time_cost', 0.9, 'pass', completed ? [completed.id] : [], [`turn duration=${durationMs}ms`])
}

function scoreModelOutputArtifacts(facts: RuntimeFactsForRun): ScorecardDimension {
  const scored = collectScoredStructuredOutputArtifacts(facts)
  if (scored.length === 0) {
    return dimension('model_output_artifact', 0.7, 'unknown', [], ['no structured output artifacts recorded'])
  }

  const score = Math.min(...scored.map(item => item.reward.score))
  const verdict = worstScorecardVerdict(scored.map(item => item.reward.verdict))
  const notes = uniqueStrings([
    `${scored.length} structured output artifact(s) scored`,
    ...scored.flatMap(item => item.notes),
  ])
  return dimension(
    'model_output_artifact',
    score,
    verdict,
    scored.flatMap(item => item.evidenceRefs),
    notes,
  )
}

function scoreWorkflowOutcomes(facts: RuntimeFactsForRun): ScorecardDimension {
  const scored = collectScoredWorkflowConsumerManifests(facts)
  if (scored.length === 0) {
    return dimension('workflow_outcome', 0.7, 'unknown', [], ['no workflow consumer manifest artifacts recorded'])
  }

  const score = Math.min(...scored.map(item => item.reward.score))
  const verdict = worstScorecardVerdict(scored.map(item => item.reward.verdict))
  const notes = uniqueStrings([
    `${scored.length} workflow consumer manifest artifact(s) scored`,
    ...scored.flatMap(item => item.notes),
  ])
  return dimension(
    'workflow_outcome',
    score,
    verdict,
    scored.flatMap(item => item.evidenceRefs),
    notes,
  )
}

function buildAntiCheatGates(facts: RuntimeFactsForRun, finalText: string): AntiCheatGate[] {
  return [
    gateUnverifiedPassClaim(facts, finalText),
    gateUnresolvedCheckpoint(facts),
    gateNonTerminalJob(facts),
    gateMissingArtifactEvidence(facts, finalText),
    gateFakeEvidenceReport(facts, finalText),
  ]
}

function gateUnverifiedPassClaim(facts: RuntimeFactsForRun, finalText: string): AntiCheatGate {
  if (!claimsVerificationPassed(finalText)) return gate('unverified_pass_claim', 'pass', [], ['no explicit tests-pass claim'])
  const verification = facts.events.filter(isVerificationEvent).map(event => assessVerificationEvent(event))
  if (verification.length > 0 && verification.every(item => item.status === 'pass')) {
    return gate('unverified_pass_claim', 'pass', verification.map(item => item.event.id), ['tests-pass claim has verification evidence'])
  }
  if (verification.some(item => item.status === 'fail' || item.status === 'warn')) {
    return gate(
      'unverified_pass_claim',
      'fail',
      verification.map(item => item.event.id),
      ['final text claims tests/verification passed but verification evidence is not clean'],
    )
  }
  return gate('unverified_pass_claim', 'fail', [], ['final text claims tests/verification passed without verification evidence'])
}

function gateUnresolvedCheckpoint(facts: RuntimeFactsForRun): AntiCheatGate {
  const unresolved = facts.checkpoints.filter(isUnresolvedCheckpoint)
  if (unresolved.length === 0) return gate('unresolved_checkpoint', 'pass', [], ['no unresolved checkpoint'])
  return gate('unresolved_checkpoint', 'fail', unresolved.map(checkpoint => checkpoint.id), [`${unresolved.length} unresolved checkpoint(s)`])
}

function gateNonTerminalJob(facts: RuntimeFactsForRun): AntiCheatGate {
  const nonTerminal = facts.jobs.filter(job => !isTerminalJob(job))
  if (nonTerminal.length === 0) return gate('non_terminal_job', 'pass', [], ['no non-terminal job'])
  return gate('non_terminal_job', 'warn', nonTerminal.map(job => job.jobId), [`${nonTerminal.length} non-terminal job(s)`])
}

function gateMissingArtifactEvidence(facts: RuntimeFactsForRun, finalText: string): AntiCheatGate {
  if (!claimsFileWork(finalText)) return gate('missing_artifact_evidence', 'pass', [], ['no file/artifact delivery claim'])
  if (facts.artifacts.length > 0) return gate('missing_artifact_evidence', 'pass', facts.artifactIds, ['artifact refs recorded'])
  const deliveryAudit = assessDeliveryAuditFileEvidence(facts)
  if (deliveryAudit && deliveryAudit.touchedDeliverableCount > 0) {
    return gate(
      'missing_artifact_evidence',
      deliveryAudit.unrelatedResidueCount > 0 ? 'warn' : 'pass',
      deliveryAudit.eventIds,
      deliveryAudit.unrelatedResidueCount > 0
        ? ['file/artifact delivery claim has DeliveryAudit evidence but unrelated residue remains']
        : ['file/artifact delivery claim has DeliveryAudit touched-file evidence'],
    )
  }
  return gate('missing_artifact_evidence', 'warn', [], ['file/artifact delivery claim has no artifact refs'])
}

function gateFakeEvidenceReport(facts: RuntimeFactsForRun, finalText: string): AntiCheatGate {
  if (!claimsEvidence(finalText)) return gate('fake_evidence_report', 'pass', [], ['no explicit evidence/proof claim'])
  const refs = evidenceRefsMentioned(facts, finalText)
  if (refs.length > 0) return gate('fake_evidence_report', 'pass', refs, ['evidence claim references known evidence'])
  return gate('fake_evidence_report', 'fail', [], ['final text claims evidence/proof but does not reference known runtime evidence'])
}

function trajectoryFromObservation(input: {
  facts: RuntimeFactsForRun
  scorecard: RunScorecard
  event?: RuntimeEventRecord
  action: Record<string, unknown>
  observation: Record<string, unknown>
  state?: Record<string, unknown>
  nextState?: Record<string, unknown>
  reward?: Partial<TrajectoryRecord['reward']>
  evidenceRefs?: string[]
}): TrajectoryRecord {
  const redacted = redactObservation(input.observation)
  return {
    trajectory_version: 1,
    thread_id: input.event?.threadId ?? input.facts.threadIds[0],
    turn_id: input.event?.turnId ?? input.facts.turnIds[0],
    run_id: input.facts.runId,
    state: input.state ?? {
      event_count: input.facts.events.length,
      checkpoint_count: input.facts.checkpoints.length,
      job_count: input.facts.jobs.length,
      artifact_count: input.facts.artifacts.length,
    },
    action: input.action,
    observation: redacted.value,
    reward: {
      score: input.scorecard.overallScore,
      verdict: input.scorecard.verdict,
      anti_cheat: input.scorecard.antiCheat.verdict,
      ...input.reward,
    },
    next_state: input.nextState ?? {
      scorecard_verdict: input.scorecard.verdict,
      anti_cheat: input.scorecard.antiCheat.verdict,
    },
    evidence_refs: input.evidenceRefs ?? (input.event?.id ? [input.event.id] : input.scorecard.evidenceRefs),
    redaction: {
      mode: 'local_redacted_v0',
      fields: redacted.fields,
    },
  }
}

function trajectoryFromStructuredOutputArtifact(
  facts: RuntimeFactsForRun,
  scorecard: RunScorecard,
  artifact: ScoredStructuredOutputArtifact,
  index: number,
): TrajectoryRecord {
  return trajectoryFromObservation({
    facts,
    scorecard,
    action: {
      type: 'structured_output_model_call',
      model: artifact.output.model,
      preset: artifact.output.preset,
      role: artifact.output.role ?? undefined,
      artifact_id: artifact.artifactId,
      attempt_ledger_id: artifact.attemptLedgerId,
      capability_gate_source: stringField(artifact.output.capabilityGate?.['source']),
    },
    observation: {
      kind: 'structured_output_artifact',
      artifactId: artifact.artifactId,
      attemptLedgerId: artifact.attemptLedgerId,
      ok: artifact.output.ok,
      parsed: artifact.output.parsed,
      schemaValid: artifact.output.schemaValid,
      validationErrors: artifact.output.validationErrors,
      repairCount: artifact.output.repairCount,
      salvageUsed: artifact.output.salvageUsed,
      fallbackUsed: artifact.output.fallbackUsed,
      stopReason: artifact.output.stopReason,
      inputTokens: artifact.output.inputTokens,
      outputTokens: artifact.output.outputTokens,
      durationMs: artifact.output.durationMs,
      rawText: artifact.output.rawText,
      rawThinkingText: artifact.output.rawThinkingText,
      artifact: artifact.output.artifact,
    },
    state: {
      structured_output_index: index,
      artifact_count: facts.artifacts.length,
      request: {
        fingerprint: artifact.output.requestFingerprint,
        preset: artifact.output.preset,
        schema_hash: artifact.output.schemaHash,
        policy_hash: artifact.output.policyHash,
      },
      model_capability: artifact.output.capabilityGate,
    },
    nextState: {
      artifact_id: artifact.artifactId,
      attempt_ledger_id: artifact.attemptLedgerId,
      ok: artifact.output.ok,
      schema_valid: artifact.output.schemaValid,
      fallback_used: artifact.output.fallbackUsed,
    },
    reward: {
      structured_output: artifact.reward,
    },
    evidenceRefs: artifact.evidenceRefs,
  })
}

function trajectoryFromWorkflowConsumerManifest(
  facts: RuntimeFactsForRun,
  scorecard: RunScorecard,
  artifact: ScoredWorkflowConsumerManifest,
  index: number,
): TrajectoryRecord {
  const manifest = artifact.manifest
  const blockerCodes = (manifest.finalReportEligibility?.blockers ?? [])
    .map(blocker => blocker.code)
    .filter((code): code is string => Boolean(code))
  return trajectoryFromObservation({
    facts,
    scorecard,
    action: {
      type: 'workflow_run_consumer_manifest',
      run_id: manifest.runId,
      normalized_state: manifest.normalizedState,
      artifact_id: artifact.artifactId,
    },
    observation: {
      kind: 'workflow_consumer_manifest',
      runId: manifest.runId,
      workflowRoot: manifest.workflowRoot,
      normalizedState: manifest.normalizedState,
      acceptanceStatus: manifest.acceptance?.status,
      finalReportAllowed: manifest.finalReportEligibility?.allowed === true,
      blockerCodes,
      requiredCounts: manifest.requiredCounts,
      stepSummary: manifest.stepSummary,
      diagnostics: manifest.diagnostics,
    },
    state: {
      workflow_manifest_index: index,
      artifact_count: facts.artifacts.length,
      required_counts: manifest.requiredCounts,
    },
    nextState: {
      workflow_run_id: manifest.runId,
      normalized_state: manifest.normalizedState,
      final_report_allowed: manifest.finalReportEligibility?.allowed === true,
    },
    reward: {
      workflow_outcome: artifact.reward,
    },
    evidenceRefs: artifact.evidenceRefs,
  })
}

function actionFromRuntimeEvent(event: RuntimeEventRecord): Record<string, unknown> {
  const payload = event.payload ?? {}
  if (event.kind === 'item_started' || event.kind === 'item_completed') {
    return {
      type: 'tool',
      tool_name: payload['tool_name'],
      event_kind: event.kind,
      item_id: event.itemId,
    }
  }
  return {
    type: 'runtime_event',
    event_kind: event.kind,
  }
}

interface StructuredOutputFact {
  artifactId: string
  attemptLedgerId?: string
  artifactRecord: RuntimeFactArtifactLike
  output: RuntimeFactStructuredOutputLike
  evidenceRefs: string[]
}

interface ScoredStructuredOutputArtifact extends StructuredOutputFact {
  reward: StructuredOutputTrajectoryReward
  notes: string[]
}

interface WorkflowConsumerManifestFact {
  artifactId: string
  artifactRecord: RuntimeFactArtifactLike
  manifest: WorkflowConsumerManifest
  evidenceRefs: string[]
}

interface ScoredWorkflowConsumerManifest extends WorkflowConsumerManifestFact {
  reward: WorkflowOutcomeTrajectoryReward
  notes: string[]
}

function collectScoredStructuredOutputArtifacts(facts: RuntimeFactsForRun): ScoredStructuredOutputArtifact[] {
  return collectStructuredOutputArtifacts(facts).map(item => {
    const reward = scoreStructuredOutput(item.output)
    return {
      ...item,
      reward,
      notes: structuredOutputNotes(item, reward),
    }
  })
}

function collectStructuredOutputArtifacts(facts: RuntimeFactsForRun): StructuredOutputFact[] {
  const attempts = facts.artifacts.filter(isStructuredOutputAttemptsRecord)
  const outputs: StructuredOutputFact[] = []
  for (const artifact of facts.artifacts) {
    if (!isStructuredOutputArtifactRecord(artifact)) continue
    const output = loadStructuredOutputArtifact(artifact)
    if (!output) continue
    const attemptLedgerId = findAttemptLedgerId(artifact, output, attempts)
    outputs.push({
      artifactId: artifact.id,
      attemptLedgerId,
      artifactRecord: artifact,
      output,
      evidenceRefs: uniqueStrings([
        artifact.id,
        artifact.factRefs?.artifactId,
        attemptLedgerId,
        ...(artifact.factRefs?.coveredIds ?? []),
      ]),
    })
  }
  return outputs
}

function collectScoredWorkflowConsumerManifests(facts: RuntimeFactsForRun): ScoredWorkflowConsumerManifest[] {
  return collectWorkflowConsumerManifests(facts).map(item => {
    const reward = scoreWorkflowManifest(item.manifest)
    return {
      ...item,
      reward,
      notes: workflowManifestNotes(item, reward),
    }
  })
}

function collectWorkflowConsumerManifests(facts: RuntimeFactsForRun): WorkflowConsumerManifestFact[] {
  const manifests: WorkflowConsumerManifestFact[] = []
  for (const artifact of facts.artifacts) {
    if (!isWorkflowConsumerManifestRecord(artifact)) continue
    const manifest = loadWorkflowConsumerManifest(artifact)
    if (!manifest) continue
    manifests.push({
      artifactId: artifact.id,
      artifactRecord: artifact,
      manifest,
      evidenceRefs: uniqueStrings([
        artifact.id,
        artifact.factRefs?.artifactId,
        ...(artifact.factRefs?.coveredIds ?? []),
      ]),
    })
  }
  return manifests
}

function scoreStructuredOutput(output: RuntimeFactStructuredOutputLike): StructuredOutputTrajectoryReward {
  const repairCount = Math.max(0, output.repairCount ?? 0)
  const validationErrors = output.validationErrors ?? []
  const policyViolationCount = validationErrors.filter(isPolicyViolationError).length
  const ok = typeof output.ok === 'boolean' ? output.ok : null
  const parsed = typeof output.parsed === 'boolean' ? output.parsed : null
  const schemaValid = typeof output.schemaValid === 'boolean' ? output.schemaValid : null
  const salvageUsed = output.salvageUsed === true
  const fallbackUsed = output.fallbackUsed === true
  const artifactPresent = output.artifact !== undefined && output.artifact !== null
  const hasRawText = typeof output.rawText === 'string' && output.rawText.trim().length > 0
  const hasThinkingOnly = !hasRawText && typeof output.rawThinkingText === 'string' && output.rawThinkingText.trim().length > 0

  const repairPenalty = Math.min(0.25, repairCount * 0.08)
  const salvagePenalty = salvageUsed ? 0.18 : 0
  const fallbackPenalty = fallbackUsed || ok === false ? 0.65 : 0
  const policyPenalty = policyViolationCount > 0 ? 0.45 : 0
  const schemaPenalty = schemaValid === false ? 0.35 : parsed === false ? 0.25 : 0
  const consistencyPenalty = !artifactPresent ? 0.5 : hasThinkingOnly ? 0.2 : 0
  const totalPenalty = repairPenalty
    + salvagePenalty
    + fallbackPenalty
    + policyPenalty
    + schemaPenalty
    + consistencyPenalty
  let score = clampUnit(1 - totalPenalty)
  if (fallbackUsed || ok === false) score = Math.min(score, 0.2)
  if (policyViolationCount > 0) score = Math.min(score, 0.35)
  if (schemaValid === false) score = Math.min(score, 0.4)
  if (!artifactPresent) score = Math.min(score, 0.25)

  const verdict: ScorecardVerdict = (fallbackUsed || ok === false || policyViolationCount > 0 || schemaValid === false || !artifactPresent)
    ? 'fail'
    : (repairCount > 0 || salvageUsed || validationErrors.length > 0 || hasThinkingOnly)
        ? 'warn'
        : 'pass'

  return {
    score,
    verdict,
    ok,
    parsed,
    schema_valid: schemaValid,
    repair_count: repairCount,
    salvage_used: salvageUsed,
    fallback_used: fallbackUsed,
    validation_error_count: validationErrors.length,
    policy_violation_count: policyViolationCount,
    repair_penalty: repairPenalty,
    salvage_penalty: salvagePenalty,
    fallback_penalty: fallbackPenalty,
    policy_penalty: policyPenalty,
    schema_penalty: schemaPenalty,
    consistency_penalty: consistencyPenalty,
  }
}

function structuredOutputNotes(item: StructuredOutputFact, reward: StructuredOutputTrajectoryReward): string[] {
  const notes = [
    `${item.artifactId}: model=${item.output.model ?? 'unknown'} preset=${item.output.preset ?? 'unknown'} score=${Math.round(reward.score * 100)} verdict=${reward.verdict}`,
  ]
  if (reward.repair_penalty > 0) notes.push(`${item.artifactId}: repair penalty=${reward.repair_penalty}`)
  if (reward.salvage_penalty > 0) notes.push(`${item.artifactId}: salvage penalty=${reward.salvage_penalty}`)
  if (reward.fallback_penalty > 0) notes.push(`${item.artifactId}: failed fallback penalty=${reward.fallback_penalty}`)
  if (reward.policy_penalty > 0) notes.push(`${item.artifactId}: policy violation penalty=${reward.policy_penalty}`)
  if (reward.schema_penalty > 0) notes.push(`${item.artifactId}: schema/parse penalty=${reward.schema_penalty}`)
  if (reward.consistency_penalty > 0) notes.push(`${item.artifactId}: raw/artifact consistency penalty=${reward.consistency_penalty}`)
  return notes
}

function scoreWorkflowManifest(manifest: WorkflowConsumerManifest): WorkflowOutcomeTrajectoryReward {
  const normalizedState = manifest.normalizedState ?? 'unknown'
  const acceptanceStatus = manifest.acceptance?.status ?? manifest.receipt?.acceptance ?? 'unknown'
  const finalReportAllowed = manifest.finalReportEligibility?.allowed === true
  const blockers = manifest.finalReportEligibility?.blockers ?? []
  const failedRequiredSteps = manifest.requiredCounts?.failed
    ?? manifest.stepSummary?.failed?.filter(step => step.required).length
    ?? 0
  const skippedSteps = manifest.requiredCounts?.skipped ?? manifest.stepSummary?.skipped?.length ?? 0
  const resumedSteps = manifest.stepSummary?.resumed?.length ?? 0

  let score = 1
  let verdict: ScorecardVerdict = 'pass'
  if (normalizedState === 'completed' && acceptanceStatus === 'pass' && finalReportAllowed) {
    score = 1
    verdict = 'pass'
  } else if (
    normalizedState === 'failed'
    || normalizedState === 'fallback'
    || normalizedState === 'unsatisfiable'
    || acceptanceStatus === 'fail'
    || blockers.length > 0
    || failedRequiredSteps > 0
  ) {
    score = 0.2
    verdict = 'fail'
  } else if (
    normalizedState === 'incomplete'
    || normalizedState === 'blocked'
    || normalizedState === 'recoverable'
    || normalizedState === 'retryable'
    || normalizedState === 'skipped'
  ) {
    score = 0.45
    verdict = 'warn'
  } else {
    score = 0.35
    verdict = 'unknown'
  }

  if (!finalReportAllowed && verdict !== 'fail') {
    score = Math.min(score, 0.35)
    verdict = 'warn'
  }
  if (resumedSteps > 0 && verdict === 'pass') {
    score = 0.9
  }

  return {
    score,
    verdict,
    normalized_state: normalizedState,
    acceptance_status: acceptanceStatus,
    final_report_allowed: finalReportAllowed,
    blocker_count: blockers.length,
    failed_required_steps: failedRequiredSteps,
    skipped_steps: skippedSteps,
    resumed_steps: resumedSteps,
  }
}

function workflowManifestNotes(item: WorkflowConsumerManifestFact, reward: WorkflowOutcomeTrajectoryReward): string[] {
  const blockers = item.manifest.finalReportEligibility?.blockers ?? []
  const blockerCodes = blockers
    .map(blocker => blocker.code)
    .filter((code): code is string => Boolean(code))
  return uniqueStrings([
    `${item.artifactId}: run=${item.manifest.runId} state=${reward.normalized_state} acceptance=${reward.acceptance_status} score=${Math.round(reward.score * 100)} verdict=${reward.verdict}`,
    reward.final_report_allowed ? 'final report gate allowed' : 'final report gate blocked',
    ...blockerCodes.map(code => `blocker=${code}`),
  ])
}

function isStructuredOutputArtifactRecord(artifact: RuntimeFactArtifactLike): boolean {
  return artifact.artifactType === 'structured_output_artifact'
    || artifact.structuredOutput?.artifactKind === 'structured_output_artifact'
}

function isStructuredOutputAttemptsRecord(artifact: RuntimeFactArtifactLike): boolean {
  return artifact.artifactType === 'structured_output_attempts'
}

function isWorkflowConsumerManifestRecord(artifact: RuntimeFactArtifactLike): boolean {
  return artifact.artifactType === 'workflow_consumer_manifest'
    || artifact.origin === 'workflow_consumer'
}

function loadStructuredOutputArtifact(artifact: RuntimeFactArtifactLike): RuntimeFactStructuredOutputLike | null {
  if (artifact.structuredOutput) return artifact.structuredOutput
  if (!artifact.path) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifact.path, 'utf8'))
    if (!isRecord(parsed)) return null
    if (parsed['artifactKind'] !== 'structured_output_artifact') return null
    return {
      artifactKind: stringField(parsed['artifactKind']),
      role: nullableStringField(parsed['role']),
      model: stringField(parsed['model']),
      preset: stringField(parsed['preset']),
      requestFingerprint: nullableStringField(parsed['requestFingerprint']),
      schemaHash: nullableStringField(parsed['schemaHash']),
      policyHash: nullableStringField(parsed['policyHash']),
      ok: booleanField(parsed['ok']),
      artifact: parsed['artifact'],
      rawText: typeof parsed['rawText'] === 'string' ? parsed['rawText'] : undefined,
      rawThinkingText: nullableStringField(parsed['rawThinkingText']),
      parsed: booleanField(parsed['parsed']),
      schemaValid: booleanField(parsed['schemaValid']),
      validationErrors: stringArrayField(parsed['validationErrors']),
      repairCount: numberField(parsed['repairCount']),
      salvageUsed: booleanField(parsed['salvageUsed']),
      fallbackUsed: booleanField(parsed['fallbackUsed']),
      stopReason: nullableStringField(parsed['stopReason']),
      inputTokens: nullableNumberField(parsed['inputTokens']),
      outputTokens: nullableNumberField(parsed['outputTokens']),
      durationMs: nullableNumberField(parsed['durationMs']),
      capabilityGate: objectField(parsed['capabilityGate']) ?? null,
      rerun: booleanField(parsed['rerun']),
      parentArtifactId: nullableStringField(parsed['parentArtifactId']),
      rerunOf: nullableStringField(parsed['rerunOf']),
      inputRef: nullableStringField(parsed['inputRef']),
      artifactRef: nullableStringField(parsed['artifactRef']),
    }
  } catch {
    return null
  }
}

function loadWorkflowConsumerManifest(artifact: RuntimeFactArtifactLike): WorkflowConsumerManifest | null {
  const embedded = objectField((artifact as unknown as Record<string, unknown>)['workflowConsumerManifest'])
  if (embedded && embedded['kind'] === 'workflow_consumer_manifest') {
    return embedded as unknown as WorkflowConsumerManifest
  }
  if (!artifact.path) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifact.path, 'utf8'))
    if (!isRecord(parsed)) return null
    if (parsed['kind'] !== 'workflow_consumer_manifest') return null
    if (parsed['schemaVersion'] !== 1) return null
    return parsed as unknown as WorkflowConsumerManifest
  } catch {
    return null
  }
}

function findAttemptLedgerId(
  artifact: RuntimeFactArtifactLike,
  output: RuntimeFactStructuredOutputLike,
  attempts: RuntimeFactArtifactLike[],
): string | undefined {
  const covered = attempts.find(item =>
    item.factRefs?.coveredIds?.includes(artifact.id)
    || item.factRefs?.coveredIds?.includes(artifact.factRefs?.artifactId ?? '')
    || item.id === `${artifact.id}-attempts`,
  )
  if (covered) return covered.id
  const artifactIdFromPayload = stringField(output.artifactKind) === 'structured_output_artifact' ? artifact.id : undefined
  return attempts.find(item => item.id === `${artifactIdFromPayload}-attempts`)?.id
}

function isPolicyViolationError(error: string): boolean {
  return /(?:forbidden|policy|business execution|chain-of-thought|cot|建议买|入串|EV|Kelly|fair odds)/i.test(error)
}

function dimension(
  id: ScorecardDimension['id'],
  score: number,
  verdict: ScorecardVerdict,
  evidenceRefs: string[],
  notes: string[],
): ScorecardDimension {
  return { id, score: clampUnit(score), verdict, evidenceRefs: uniqueStrings(evidenceRefs), notes }
}

function gate(
  id: AntiCheatGate['id'],
  status: AntiCheatStatus,
  evidenceRefs: string[],
  notes: string[],
): AntiCheatGate {
  return { id, status, evidenceRefs: uniqueStrings(evidenceRefs), notes }
}

function isVerificationEvent(event: RuntimeEventRecord): boolean {
  const toolName = stringField(event.payload?.['tool_name'])
  return event.kind === 'item_completed'
    && (toolName === 'TaskVerify' || toolName === 'ArtifactVerify' || toolName === 'DeliveryAudit')
}

function assessVerificationEvent(event: RuntimeEventRecord): {
  event: RuntimeEventRecord
  status: 'pass' | 'warn' | 'fail'
  note: string
} {
  if (event.payload?.['is_error'] === true) {
    return { event, status: 'fail', note: `${toolNameOf(event)} returned is_error=true` }
  }
  const toolName = toolNameOf(event)
  if (toolName === 'TaskVerify') {
    const metadata = objectField(event.payload?.['metadata']) ?? event.payload
    const passed = booleanField(metadata?.['passed'])
    const results = arrayField(metadata?.['results']).map(objectField).filter((item): item is Record<string, unknown> => Boolean(item))
    if (passed === false || results.some(result => booleanField(result['passed']) === false)) {
      return { event, status: 'fail', note: 'TaskVerify metadata.passed=false or contains failed results' }
    }
    if (passed === true || (results.length > 0 && results.every(result => booleanField(result['passed']) === true))) {
      return { event, status: 'pass', note: 'TaskVerify metadata results passed' }
    }
  }
  if (toolName === 'ArtifactVerify') {
    const result = objectField(objectField(event.payload?.['metadata'])?.['result'] ?? event.payload?.['result'])
    const passed = booleanField(result?.['passed'])
    if (passed === false) return { event, status: 'fail', note: 'ArtifactVerify metadata.result.passed=false' }
    if (passed === true) return { event, status: 'pass', note: 'ArtifactVerify metadata.result.passed=true' }
  }
  if (toolName === 'DeliveryAudit') {
    const metadata = objectField(event.payload?.['metadata']) ?? event.payload
    const unsupportedCount = numberField(metadata?.['unsupportedCount']) ?? 0
    const vacuousAssertions = arrayField(metadata?.['vacuousAssertions']).length
    if (unsupportedCount > 0) {
      return { event, status: 'warn', note: `DeliveryAudit reported unsupportedCount=${unsupportedCount}` }
    }
    if (vacuousAssertions > 0) {
      return { event, status: 'warn', note: `DeliveryAudit reported vacuousAssertions=${vacuousAssertions}` }
    }
  }
  return { event, status: 'pass', note: `${toolName ?? 'verification'} completed without error` }
}

function toolNameOf(event: RuntimeEventRecord): string | undefined {
  return stringField(event.payload?.['tool_name'])
}

function assessDeliveryAuditFileEvidence(facts: RuntimeFactsForRun): {
  eventIds: string[]
  touchedDeliverableCount: number
  unrelatedResidueCount: number
} | null {
  const audits = facts.events.filter(event =>
    event.kind === 'item_completed'
    && toolNameOf(event) === 'DeliveryAudit',
  )
  if (audits.length === 0) return null

  let touchedDeliverableCount = 0
  let unrelatedResidueCount = 0
  const eventIds: string[] = []
  for (const event of audits) {
    const metadata = objectField(event.payload?.['metadata']) ?? event.payload
    const buckets = objectField(metadata?.['buckets'])
    if (!buckets) continue
    const trackedModified = arrayField(buckets['trackedModifiedDeliverables']).length
    const newUntracked = arrayField(buckets['newUntrackedDeliverables']).length
    const touched = arrayField(buckets['touchedThisTurn']).length
    const unrelated = arrayField(buckets['unrelatedResidue']).length
    if (trackedModified + newUntracked + touched + unrelated === 0) continue
    eventIds.push(event.id)
    touchedDeliverableCount += trackedModified + newUntracked || touched
    unrelatedResidueCount += unrelated
  }

  if (eventIds.length === 0) return null
  return {
    eventIds: uniqueStrings(eventIds),
    touchedDeliverableCount,
    unrelatedResidueCount,
  }
}

function isUnresolvedCheckpoint(checkpoint: RuntimeRecoveryCheckpointRecord): boolean {
  return checkpoint.disposition === undefined || checkpoint.disposition === 'active'
}

function isTerminalJob(job: RuntimeFactJobLike): boolean {
  const status = stringField((job as unknown as Record<string, unknown>)['status'])
  if (!status) return true
  return ['done', 'completed', 'failed', 'cancelled', 'timeout', 'unrecoverable', 'orphaned'].includes(status)
}

function claimsVerificationPassed(text: string): boolean {
  return /\b(?:tests?\s+(?:pass|passed|green)|verification\s+(?:pass|passed)|TaskVerify\s+(?:pass|passed)|smoke\s+(?:pass|passed)|0 failed)\b/i.test(text)
}

function claimsFileWork(text: string): boolean {
  return /\b(?:created|wrote|generated|updated|modified|artifact|file|diff|patch)\b/i.test(text)
    || /(?:产物|文件|生成|写入|修改)/.test(text)
}

function claimsEvidence(text: string): boolean {
  return /\b(?:evidence|proof|verified|verification|audit)\b/i.test(text)
    || /(?:证据|验证|已验证)/.test(text)
}

function evidenceRefsMentioned(facts: RuntimeFactsForRun, text: string): string[] {
  const refs = uniqueStrings([
    ...facts.eventIds,
    ...facts.checkpointRecordIds,
    ...facts.jobIds,
    ...facts.artifactIds,
    ...facts.proofIds,
    ...facts.artifacts.map((artifact: RuntimeFactArtifactLike) => artifact.id),
  ])
  return refs.filter(ref => ref && text.includes(ref))
}

function worstScorecardVerdict(verdicts: ScorecardVerdict[]): ScorecardVerdict {
  if (verdicts.some(verdict => verdict === 'fail')) return 'fail'
  if (verdicts.some(verdict => verdict === 'warn')) return 'warn'
  if (verdicts.some(verdict => verdict === 'unknown')) return 'unknown'
  return 'pass'
}

function scoreToVerdict(score: number): ScorecardVerdict {
  if (score >= 80) return 'pass'
  if (score >= 55) return 'warn'
  return 'fail'
}

function worstAntiCheat(gates: AntiCheatGate[]): AntiCheatStatus {
  if (gates.some(gate => gate.status === 'fail')) return 'fail'
  if (gates.some(gate => gate.status === 'warn')) return 'warn'
  if (gates.some(gate => gate.status === 'unknown')) return 'unknown'
  return 'pass'
}

function redactObservation(value: unknown, path = ''): { value: Record<string, unknown>; fields: string[] } {
  const fields: string[] = []
  const redacted = redactValue(value, path, fields)
  return {
    value: isRecord(redacted) ? redacted : { value: redacted },
    fields: uniqueStrings(fields),
  }
}

function redactValue(value: unknown, path: string, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${path}[${index}]`, fields))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key
      if (shouldRedactField(key, item)) {
        fields.push(childPath)
        out[key] = typeof item === 'string' ? `[redacted:${item.length} chars]` : '[redacted]'
      } else {
        out[key] = redactValue(item, childPath, fields)
      }
    }
    return out
  }
  if (typeof value === 'string' && value.length > 2_000) {
    fields.push(path || 'value')
    return `[redacted:${value.length} chars]`
  }
  return value
}

function shouldRedactField(key: string, value: unknown): boolean {
  const lowered = key.toLowerCase()
  return typeof value === 'string'
    && (
      lowered === 'data'
      || lowered === 'rawtext'
      || lowered === 'rawthinkingtext'
      || lowered.includes('apikey')
      || lowered.includes('api_key')
      || lowered.includes('token')
      || lowered.includes('authorization')
      || /^data:image\//i.test(value)
      || value.length > 8_000
    )
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null
  return stringField(value)
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullableNumberField(value: unknown): number | null | undefined {
  if (value === null) return null
  return numberField(value)
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArrayField(value: unknown): string[] {
  return arrayField(value).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}
