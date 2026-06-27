import {
  buildRunScorecard,
  buildRunTrajectory,
  summarizeRunScorecard,
  type RunScorecard,
  type ScorecardDimension,
  type ScorecardVerdict,
  type AntiCheatStatus,
  type TrajectoryRecord,
} from '../native/scorecard.js'
import type {
  RuntimeEventRecord,
  RuntimeRecoveryCheckpointRecord,
} from '../native/protocol/types.js'
import type {
  RuntimeFactsForRun,
  RuntimeFactArtifactLike,
} from '../native/runtime-facts.js'
import type { BenchmarkDryRunResult } from './types.js'
import type { BenchmarkCaseId } from './types.js'
import { runBenchmarkCaseDryRun } from './harness.js'
import { diffIsClean, diffResults, type BenchmarkResultDiff, type LiveBenchmarkResult } from './runner.js'

export interface BenchmarkScorecardOptions {
  generatedAt?: string
}

export interface BenchmarkDryRunScorecardPacket {
  schemaVersion: 1
  benchmarkCaseId: string
  runId: string
  facts: RuntimeFactsForRun
  scorecard: RunScorecard
  summary: string
  trajectory: {
    recordCount: number
    localOnly: true
    redactionMode: 'local_redacted_v0'
    records: TrajectoryRecord[]
  }
}

export interface BenchmarkLiveRunDiffSummary {
  artifactMismatchCount: number
  verificationMismatchCount: number
  hasFinalStatusMismatch: boolean
  hasTaskNoProgressMismatch: boolean
  hasTimeToFirstWriteMismatch: boolean
  hasTraceMismatch: boolean
}

export interface BenchmarkLiveRunScorecardPacket extends BenchmarkDryRunScorecardPacket {
  runMode: 'live'
  live: {
    ranLive: boolean
    passed: boolean
    skippedReason?: string
    expectedRunId: string
    actualRunId?: string
    diffSummary: BenchmarkLiveRunDiffSummary
  }
}

export interface BenchmarkProviderEvalObservation {
  caseId: BenchmarkCaseId
  providerId: string
  modelId: string
  evalRunId?: string
  packageVersion?: string
  binaryBuild?: string
  expected?: BenchmarkDryRunResult
  actual?: BenchmarkDryRunResult
  error?: string
  usage?: BenchmarkProviderEvalUsage
}

export interface BenchmarkProviderEvalUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  durationMs?: number
}

export interface BenchmarkProviderEvalScorecardPacket extends BenchmarkLiveRunScorecardPacket {
  providerEval: {
    providerId: string
    modelId: string
    evalRunId?: string
    error?: string
    hasActualResult: boolean
    usage?: BenchmarkProviderEvalUsage
  }
}

export interface BenchmarkModelComparisonInput {
  modelId: string
  result: BenchmarkDryRunResult | LiveBenchmarkResult
}

export interface BenchmarkModelComparisonDimension {
  score: number
  verdict: ScorecardVerdict
  evidenceRefs: string[]
  notes: string[]
}

export interface BenchmarkModelComparisonItem {
  modelId: string
  caseId: string
  runId: string
  finalStatus: BenchmarkDryRunResult['finalStatus']
  success: boolean
  overallScore: number
  verdict: ScorecardVerdict
  antiCheat: AntiCheatStatus
  dimensions: Record<ScorecardDimension['id'], BenchmarkModelComparisonDimension>
  cost: {
    timeToFirstWriteMs: number
    readCallsBeforeFirstWrite: number
  }
  evidenceConsistency: ScorecardVerdict
  evidenceRefs: string[]
}

export interface BenchmarkModelComparisonReport {
  schemaVersion: 1
  generatedAt: string
  itemCount: number
  passedCount: number
  failedCount: number
  averageScore: number
  items: BenchmarkModelComparisonItem[]
  summary: string
}

export function benchmarkDryRunToRuntimeFacts(
  result: BenchmarkDryRunResult,
  options: BenchmarkScorecardOptions = {},
): RuntimeFactsForRun {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const runId = benchmarkRunId(result)
  const threadId = benchmarkThreadId(result)
  const turnId = benchmarkTurnId(result)
  const events = benchmarkDryRunEvents(result, { generatedAt, runId, threadId, turnId })
  const checkpoints = benchmarkDryRunCheckpoints(result, { generatedAt, runId, threadId, turnId })
  const artifacts = benchmarkDryRunArtifacts(result, { runId, threadId, turnId })

  return {
    schemaVersion: 1,
    runId,
    threadIds: [threadId],
    turnIds: [turnId],
    taskIds: [`benchmark-task:${result.caseId}`],
    stepIds: [`benchmark-step:${result.caseId}`],
    jobIds: [],
    artifactIds: artifacts.map(artifact => artifact.id),
    checkpointIds: checkpoints.map(checkpoint => checkpoint.id),
    proofIds: events
      .map(event => event.factRefs?.proofId)
      .filter((proofId): proofId is string => Boolean(proofId)),
    eventIds: events.map(event => event.id),
    checkpointRecordIds: checkpoints.map(checkpoint => checkpoint.id),
    events,
    checkpoints,
    jobs: [],
    artifacts,
  }
}

export function buildBenchmarkDryRunScorecard(
  result: BenchmarkDryRunResult,
  options: BenchmarkScorecardOptions = {},
): BenchmarkDryRunScorecardPacket {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const facts = benchmarkDryRunToRuntimeFacts(result, { generatedAt })
  const scorecard = buildRunScorecard({
    facts,
    finalText: benchmarkDryRunFinalText(result, facts),
    generatedAt,
  })
  const records = buildRunTrajectory(facts, scorecard)
  return {
    schemaVersion: 1,
    benchmarkCaseId: result.caseId,
    runId: facts.runId,
    facts,
    scorecard,
    summary: [
      `Benchmark scorecard benchmark_case=${result.caseId} final_status=${result.finalStatus}`,
      summarizeRunScorecard(scorecard),
    ].join('\n'),
    trajectory: {
      recordCount: records.length,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
      records,
    },
  }
}

export function benchmarkLiveRunToRuntimeFacts(
  result: LiveBenchmarkResult,
  options: BenchmarkScorecardOptions = {},
): RuntimeFactsForRun {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const baseResult = result.actual ?? result.expected
  const facts = benchmarkDryRunToRuntimeFacts(baseResult, { generatedAt })

  if (result.ranLive && result.passed) return facts

  const threadId = facts.threadIds[0] ?? benchmarkThreadId(baseResult)
  const turnId = facts.turnIds[0] ?? benchmarkTurnId(baseResult)
  const runId = facts.runId
  const taskId = facts.taskIds[0] ?? `benchmark-task:${result.caseId}`
  const stepId = facts.stepIds[0] ?? `benchmark-step:${result.caseId}`
  const proofId = `benchmark_proof:${result.caseId}:live_diff`
  const checkpointId = `benchmark_live_diff:${result.caseId}`
  const diffSummary = benchmarkLiveDiffSummary(result.diff)
  const diffResults = benchmarkLiveDiffVerificationResults(result)
  const diffEvent = runtimeEvent(facts.events.length + 1, {
    kind: 'item_completed',
    at: generatedAt,
    threadId,
    turnId,
    runId,
    itemId: `benchmark-live-diff:${result.caseId}`,
    factRefs: {
      threadId,
      turnId,
      runId,
      taskId,
      stepId,
      proofId,
    },
    payload: {
      tool_name: 'TaskVerify',
      is_error: false,
      benchmark_case_id: result.caseId,
      benchmark_mode: 'live',
      metadata: {
        taskId,
        stepId,
        passed: false,
        ranLive: result.ranLive,
        livePassed: result.passed,
        skippedReason: result.skippedReason,
        diffSummary,
        results: diffResults,
      },
    },
  })
  const checkpoint: RuntimeRecoveryCheckpointRecord = {
    id: checkpointId,
    kind: 'blocked_task_checkpoint',
    generatedAt,
    conversationId: threadId,
    threadId,
    turnId,
    runId,
    factRefs: {
      threadId,
      turnId,
      runId,
      taskId,
      stepId,
      checkpointId,
      proofId,
    },
    disposition: 'active',
    payload: {
      schema_version: 1,
      kind: 'benchmark_live_diff_checkpoint',
      benchmark_case_id: result.caseId,
      ran_live: result.ranLive,
      live_passed: result.passed,
      skipped_reason: result.skippedReason,
      diff_summary: diffSummary,
    },
    inspectCommands: [`BenchmarkLiveRun caseId=${result.caseId}`],
  }

  return {
    ...facts,
    checkpointIds: [...facts.checkpointIds, checkpointId],
    proofIds: [...facts.proofIds, proofId],
    eventIds: [...facts.eventIds, diffEvent.id],
    checkpointRecordIds: [...facts.checkpointRecordIds, checkpoint.id],
    events: [...facts.events, diffEvent],
    checkpoints: [...facts.checkpoints, checkpoint],
  }
}

export function buildBenchmarkLiveRunScorecard(
  result: LiveBenchmarkResult,
  options: BenchmarkScorecardOptions = {},
): BenchmarkLiveRunScorecardPacket {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const facts = benchmarkLiveRunToRuntimeFacts(result, { generatedAt })
  const scorecard = buildRunScorecard({
    facts,
    finalText: benchmarkLiveRunFinalText(result, facts),
    generatedAt,
  })
  const records = buildRunTrajectory(facts, scorecard)
  const expectedRunId = benchmarkRunId(result.expected)
  const actualRunId = result.actual ? benchmarkRunId(result.actual) : undefined
  return {
    schemaVersion: 1,
    runMode: 'live',
    benchmarkCaseId: result.caseId,
    runId: facts.runId,
    facts,
    scorecard,
    summary: [
      `Benchmark live scorecard benchmark_case=${result.caseId} ran_live=${result.ranLive} live_passed=${result.passed}`,
      result.skippedReason ? `Skipped: ${result.skippedReason}` : '',
      summarizeRunScorecard(scorecard),
    ].filter(Boolean).join('\n'),
    trajectory: {
      recordCount: records.length,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
      records,
    },
    live: {
      ranLive: result.ranLive,
      passed: result.passed,
      skippedReason: result.skippedReason,
      expectedRunId,
      actualRunId,
      diffSummary: benchmarkLiveDiffSummary(result.diff),
    },
  }
}

export function benchmarkProviderEvalToLiveResult(input: BenchmarkProviderEvalObservation): LiveBenchmarkResult {
  const expected = input.expected ?? runBenchmarkCaseDryRun(input.caseId, {
    packageVersion: input.packageVersion,
    binaryBuild: input.binaryBuild,
  })
  if (!input.actual) {
    return {
      caseId: input.caseId,
      ranLive: true,
      expected,
      passed: false,
      skippedReason: input.error,
    }
  }
  const diff = diffResults(expected, input.actual)
  return {
    caseId: input.caseId,
    ranLive: true,
    expected,
    actual: input.actual,
    diff,
    passed: diffIsClean(diff),
  }
}

export function buildBenchmarkProviderEvalScorecard(
  input: BenchmarkProviderEvalObservation,
  options: BenchmarkScorecardOptions = {},
): BenchmarkProviderEvalScorecardPacket {
  const live = benchmarkProviderEvalToLiveResult(input)
  const packet = buildBenchmarkLiveRunScorecard(live, options)
  return {
    ...packet,
    providerEval: {
      providerId: input.providerId,
      modelId: input.modelId,
      evalRunId: input.evalRunId,
      error: input.error,
      hasActualResult: Boolean(input.actual),
      usage: input.usage,
    },
  }
}

export function buildBenchmarkModelComparisonReport(
  inputs: BenchmarkModelComparisonInput[],
  options: BenchmarkScorecardOptions = {},
): BenchmarkModelComparisonReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const items = inputs.map(input => benchmarkComparisonItem(input, generatedAt))
  const passedCount = items.filter(item => item.success).length
  const failedCount = items.length - passedCount
  const averageScore = items.length > 0
    ? Math.round(items.reduce((sum, item) => sum + item.overallScore, 0) / items.length)
    : 0
  return {
    schemaVersion: 1,
    generatedAt,
    itemCount: items.length,
    passedCount,
    failedCount,
    averageScore,
    items,
    summary: `Benchmark model comparison: ${passedCount}/${items.length} passed, average_score=${averageScore}`,
  }
}

export function formatBenchmarkModelComparisonReport(report: BenchmarkModelComparisonReport): string {
  const lines = [
    'Benchmark Model Comparison',
    `Generated: ${report.generatedAt}`,
    `Result: ${report.passedCount}/${report.itemCount} passed, average score ${report.averageScore}`,
    '',
    '| Model | Case | Success | Score | Verdict | Anti-cheat | Evidence | Time to first write |',
    '| --- | --- | --- | ---: | --- | --- | --- | ---: |',
  ]
  for (const item of report.items) {
    lines.push([
      item.modelId,
      item.caseId,
      item.success ? 'pass' : 'fail',
      String(item.overallScore),
      item.verdict,
      item.antiCheat,
      item.evidenceConsistency,
      `${item.cost.timeToFirstWriteMs}ms`,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  return lines.join('\n')
}

function benchmarkComparisonItem(
  input: BenchmarkModelComparisonInput,
  generatedAt: string,
): BenchmarkModelComparisonItem {
  const packet = isLiveBenchmarkResult(input.result)
    ? buildBenchmarkLiveRunScorecard(input.result, { generatedAt })
    : buildBenchmarkDryRunScorecard(input.result, { generatedAt })
  const sourceResult = isLiveBenchmarkResult(input.result)
    ? (input.result.actual ?? input.result.expected)
    : input.result
  const success = benchmarkResultPassed(input.result)
    && packet.scorecard.verdict === 'pass'
    && packet.scorecard.antiCheat.verdict === 'pass'
  return {
    modelId: input.modelId,
    caseId: sourceResult.caseId,
    runId: packet.runId,
    finalStatus: sourceResult.finalStatus,
    success,
    overallScore: packet.scorecard.overallScore,
    verdict: packet.scorecard.verdict,
    antiCheat: packet.scorecard.antiCheat.verdict,
    dimensions: comparisonDimensions(packet.scorecard.dimensions),
    cost: {
      timeToFirstWriteMs: sourceResult.timeToFirstWriteMs,
      readCallsBeforeFirstWrite: sourceResult.readCallsBeforeFirstWrite,
    },
    evidenceConsistency: evidenceConsistencyVerdict(packet.scorecard, success),
    evidenceRefs: packet.scorecard.evidenceRefs,
  }
}

function benchmarkResultPassed(result: BenchmarkDryRunResult | LiveBenchmarkResult): boolean {
  if (isLiveBenchmarkResult(result)) {
    return result.ranLive && result.passed
  }
  return result.finalStatus === 'passed'
}

function isLiveBenchmarkResult(result: BenchmarkDryRunResult | LiveBenchmarkResult): result is LiveBenchmarkResult {
  return 'ranLive' in result && 'expected' in result
}

function comparisonDimensions(
  dimensions: ScorecardDimension[],
): Record<ScorecardDimension['id'], BenchmarkModelComparisonDimension> {
  const out = {} as Record<ScorecardDimension['id'], BenchmarkModelComparisonDimension>
  for (const dimension of dimensions) {
    out[dimension.id] = {
      score: dimension.score,
      verdict: dimension.verdict,
      evidenceRefs: dimension.evidenceRefs,
      notes: dimension.notes,
    }
  }
  return out
}

function evidenceConsistencyVerdict(scorecard: RunScorecard, success: boolean): ScorecardVerdict {
  const grounding = scorecard.dimensions.find(dimension => dimension.id === 'evidence_grounding')
  if (scorecard.antiCheat.verdict === 'fail') return 'fail'
  if (grounding?.verdict === 'fail') return 'fail'
  if (success && grounding?.verdict === 'pass') return 'pass'
  if (scorecard.antiCheat.verdict === 'warn' || grounding?.verdict === 'warn') return 'warn'
  return success ? 'pass' : 'fail'
}

function benchmarkLiveDiffSummary(diff: BenchmarkResultDiff | undefined): BenchmarkLiveRunDiffSummary {
  return {
    artifactMismatchCount: diff?.artifactMismatches.length ?? 0,
    verificationMismatchCount: diff?.verificationMismatches.length ?? 0,
    hasFinalStatusMismatch: Boolean(diff?.finalStatusMismatch),
    hasTaskNoProgressMismatch: Boolean(diff?.taskNoProgressMismatch),
    hasTimeToFirstWriteMismatch: Boolean(diff?.timeToFirstWriteToleranceExceeded),
    hasTraceMismatch: (diff?.traceMismatches?.length ?? 0) > 0,
  }
}

function benchmarkLiveDiffVerificationResults(result: LiveBenchmarkResult): Array<{
  checkId: string
  passed: boolean
  detail: string
  metadata: Record<string, unknown>
}> {
  const diff = result.diff
  const rows: Array<{
    checkId: string
    passed: boolean
    detail: string
    metadata: Record<string, unknown>
  }> = []

  if (!result.ranLive) {
    rows.push({
      checkId: `${result.caseId}.live.skipped`,
      passed: false,
      detail: result.skippedReason ?? 'live benchmark did not run',
      metadata: { kind: 'benchmark.live.skipped' },
    })
  }
  if (diff?.finalStatusMismatch) {
    rows.push({
      checkId: `${result.caseId}.live.final_status`,
      passed: false,
      detail: `expected finalStatus=${diff.finalStatusMismatch.expected}, actual=${diff.finalStatusMismatch.actual}`,
      metadata: {
        kind: 'benchmark.live.final_status',
        expected: diff.finalStatusMismatch.expected,
        actual: diff.finalStatusMismatch.actual,
      },
    })
  }
  if (diff?.taskNoProgressMismatch) {
    rows.push({
      checkId: `${result.caseId}.live.task_no_progress`,
      passed: false,
      detail: 'task no-progress counters diverged',
      metadata: {
        kind: 'benchmark.live.task_no_progress',
        expected: diff.taskNoProgressMismatch.expected,
        actual: diff.taskNoProgressMismatch.actual,
      },
    })
  }
  for (const mismatch of diff?.artifactMismatches ?? []) {
    rows.push({
      checkId: `${result.caseId}.live.artifact.${mismatch.path}`,
      passed: false,
      detail: `expected artifact missing or mismatched: ${mismatch.path}`,
      metadata: {
        kind: 'benchmark.live.artifact',
        path: mismatch.path,
        expected: mismatch.expected,
        actual: mismatch.actual ?? null,
      },
    })
  }
  for (const mismatch of diff?.verificationMismatches ?? []) {
    rows.push({
      checkId: `${result.caseId}.live.verification.${mismatch.id}`,
      passed: false,
      detail: `verification mismatch: ${mismatch.id}`,
      metadata: {
        kind: 'benchmark.live.verification',
        id: mismatch.id,
        expected: mismatch.expected,
        actual: mismatch.actual ?? null,
      },
    })
  }
  if (diff?.timeToFirstWriteToleranceExceeded) {
    rows.push({
      checkId: `${result.caseId}.live.time_to_first_write`,
      passed: false,
      detail: `time to first write exceeded tolerance=${diff.timeToFirstWriteToleranceExceeded.toleranceMs}ms`,
      metadata: {
        kind: 'benchmark.live.time_to_first_write',
        expected: diff.timeToFirstWriteToleranceExceeded.expected,
        actual: diff.timeToFirstWriteToleranceExceeded.actual,
        toleranceMs: diff.timeToFirstWriteToleranceExceeded.toleranceMs,
      },
    })
  }
  if ((diff?.traceMismatches?.length ?? 0) > 0) {
    rows.push({
      checkId: `${result.caseId}.live.trace`,
      passed: false,
      detail: `tool trace mismatch count=${diff?.traceMismatches?.length ?? 0}`,
      metadata: {
        kind: 'benchmark.live.trace',
        mismatchCount: diff?.traceMismatches?.length ?? 0,
      },
    })
  }

  if (rows.length === 0 && !result.passed) {
    rows.push({
      checkId: `${result.caseId}.live.diff`,
      passed: false,
      detail: 'live benchmark failed without structured diff',
      metadata: { kind: 'benchmark.live.diff' },
    })
  }

  return rows
}

function benchmarkDryRunEvents(
  result: BenchmarkDryRunResult,
  input: {
    generatedAt: string
    runId: string
    threadId: string
    turnId: string
  },
): RuntimeEventRecord[] {
  const { generatedAt, runId, threadId, turnId } = input
  const verificationPassed = result.finalStatus === 'passed' && result.verification.every(item => item.passed)
  const existingArtifacts = result.artifacts.filter(artifact => artifact.exists)
  return [
    runtimeEvent(1, {
      kind: 'turn_started',
      at: generatedAt,
      threadId,
      turnId,
      runId,
      payload: {
        benchmark_case_id: result.caseId,
        package_version: result.packageVersion,
        binary_build: result.binaryBuild,
      },
    }),
    runtimeEvent(2, {
      kind: 'item_completed',
      at: generatedAt,
      threadId,
      turnId,
      runId,
      itemId: `benchmark-verify:${result.caseId}`,
      factRefs: {
        proofId: `benchmark_proof:${result.caseId}:verification`,
      },
      payload: {
        tool_name: 'TaskVerify',
        is_error: false,
        benchmark_case_id: result.caseId,
        metadata: {
          taskId: `benchmark-task:${result.caseId}`,
          stepId: `benchmark-step:${result.caseId}`,
          passed: verificationPassed,
          results: result.verification.map(item => ({
            checkId: item.id,
            passed: item.passed,
            detail: item.message,
            metadata: {
              kind: item.kind,
              status: item.status,
              expected: item.expected,
              actual: item.actual,
            },
          })),
        },
      },
    }),
    runtimeEvent(3, {
      kind: 'item_completed',
      at: generatedAt,
      threadId,
      turnId,
      runId,
      itemId: `benchmark-delivery-audit:${result.caseId}`,
      payload: {
        tool_name: 'DeliveryAudit',
        is_error: false,
        benchmark_case_id: result.caseId,
        metadata: {
          buckets: {
            touchedThisTurn: existingArtifacts.map(artifact => artifact.path),
            trackedModifiedDeliverables: existingArtifacts.map(artifact => artifact.path),
            newUntrackedDeliverables: [],
            unrelatedResidue: [],
            buildArtifacts: [],
          },
          unsupportedCount: result.finalStatus === 'passed' ? 0 : 1,
          vacuousAssertions: [],
        },
      },
    }),
    runtimeEvent(4, {
      kind: 'turn_completed',
      at: generatedAt,
      threadId,
      turnId,
      runId,
      payload: {
        stop_reason: result.finalStatus === 'passed' ? 'end_turn' : result.finalStatus,
        final_status: result.finalStatus,
        iterations: 1,
        request_count: 1,
        input_tokens: 0,
        output_tokens: 0,
        assistant_response_count: 1,
        assistant_text_chars: 0,
        final_text_chars: 0,
        tool_use_count: 2,
        executed_tool_count: 2,
        empty_response_count: 0,
        time_to_first_write_ms: result.timeToFirstWriteMs,
        read_calls_before_first_write: result.readCallsBeforeFirstWrite,
      },
    }),
  ]
}

function benchmarkDryRunCheckpoints(
  result: BenchmarkDryRunResult,
  input: {
    generatedAt: string
    runId: string
    threadId: string
    turnId: string
  },
): RuntimeRecoveryCheckpointRecord[] {
  if (result.taskNoProgress.hard <= 0 && result.finalStatus !== 'blocked') return []
  const checkpointId = `benchmark_no_progress:${result.caseId}`
  return [{
    id: checkpointId,
    kind: 'blocked_task_checkpoint',
    generatedAt: input.generatedAt,
    conversationId: input.threadId,
    threadId: input.threadId,
    turnId: input.turnId,
    runId: input.runId,
    factRefs: {
      threadId: input.threadId,
      turnId: input.turnId,
      runId: input.runId,
      taskId: `benchmark-task:${result.caseId}`,
      stepId: `benchmark-step:${result.caseId}`,
      checkpointId,
    },
    disposition: 'active',
    payload: {
      schema_version: 1,
      kind: 'blocked_task_checkpoint',
      benchmark_case_id: result.caseId,
      final_status: result.finalStatus,
      task_no_progress: { ...result.taskNoProgress },
    },
    inspectCommands: [`BenchmarkDryRun caseId=${result.caseId}`],
  }]
}

function benchmarkDryRunArtifacts(
  result: BenchmarkDryRunResult,
  input: {
    runId: string
    threadId: string
    turnId: string
  },
): RuntimeFactArtifactLike[] {
  return result.artifacts
    .map((artifact, index): RuntimeFactArtifactLike & Record<string, unknown> => ({
      id: `benchmark_artifact:${result.caseId}:${index}`,
      path: artifact.path,
      threadId: input.threadId,
      turnId: input.turnId,
      runId: input.runId,
      taskId: `benchmark-task:${result.caseId}`,
      proofId: `benchmark_proof:${result.caseId}:artifact:${index}`,
      factRefs: {
        threadId: input.threadId,
        turnId: input.turnId,
        runId: input.runId,
        taskId: `benchmark-task:${result.caseId}`,
        artifactId: `benchmark_artifact:${result.caseId}:${index}`,
        artifactPath: artifact.path,
        proofId: `benchmark_proof:${result.caseId}:artifact:${index}`,
      },
      kind: artifact.kind,
      exists: artifact.exists,
      bytes: artifact.bytes,
      source: artifact.source,
      notes: artifact.notes,
    }))
    .filter(artifact => artifact.exists)
}

function runtimeEvent(seq: number, partial: Omit<RuntimeEventRecord, 'id' | 'seq' | 'conversationId'>): RuntimeEventRecord {
  return {
    id: `runtime_event-${seq}`,
    seq,
    conversationId: partial.threadId ?? 'benchmark-thread',
    ...partial,
  }
}

function benchmarkDryRunFinalText(result: BenchmarkDryRunResult, facts: RuntimeFactsForRun): string {
  const verificationRef = facts.eventIds[1] ?? facts.eventIds[0] ?? ''
  const deliveryRef = facts.eventIds[2] ?? ''
  const artifactRefs = facts.artifactIds.join(', ')
  return [
    `Benchmark case ${result.caseId} finalStatus=${result.finalStatus}.`,
    result.finalStatus === 'passed' ? `Verification passed with evidence ${verificationRef}.` : `Verification failed with evidence ${verificationRef}.`,
    deliveryRef ? `Delivery audit evidence ${deliveryRef}.` : '',
    artifactRefs ? `Artifact evidence ${artifactRefs}.` : '',
  ].filter(Boolean).join(' ')
}

function benchmarkLiveRunFinalText(result: LiveBenchmarkResult, facts: RuntimeFactsForRun): string {
  const verificationRef = facts.eventIds[facts.eventIds.length - 1] ?? facts.eventIds[0] ?? ''
  const checkpointRefs = facts.checkpointIds.join(', ')
  const actualStatus = result.actual?.finalStatus ?? result.expected.finalStatus
  return [
    `Live benchmark case ${result.caseId} ranLive=${result.ranLive} livePassed=${result.passed} actualFinalStatus=${actualStatus}.`,
    result.passed
      ? `Verification passed with evidence ${verificationRef}.`
      : `Verification failed with evidence ${verificationRef}.`,
    checkpointRefs ? `Checkpoint evidence ${checkpointRefs}.` : '',
  ].filter(Boolean).join(' ')
}

function benchmarkRunId(result: BenchmarkDryRunResult): string {
  return `benchmark:${result.caseId}:${result.packageVersion}:${result.binaryBuild}`
}

function benchmarkThreadId(result: BenchmarkDryRunResult): string {
  return `benchmark-thread:${result.caseId}`
}

function benchmarkTurnId(result: BenchmarkDryRunResult): string {
  return `benchmark-turn:${result.caseId}`
}
