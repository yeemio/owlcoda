import type { ScorecardVerdict, AntiCheatStatus } from '../native/scorecard.js'
import type { BenchmarkScorecardOptions } from './scorecard-adapter.js'
import {
  buildBenchmarkProviderEvalCostLedger,
  type BenchmarkProviderEvalCostLedgerItem,
  type BenchmarkProviderEvalStoreRecord,
} from './provider-eval-store.js'

export type BenchmarkProviderEvalTrainingUse = 'not_collected'

export interface BenchmarkProviderEvalBatchLeaderboardItem {
  providerId: string
  modelId: string
  runCount: number
  passedCount: number
  failedCount: number
  passRate: number
  averageScore: number
  totalTokens: number
  totalCostUsd: number
  averageDurationMs: number
  costPerPassedRunUsd: number | null
  verdict: ScorecardVerdict
}

export interface BenchmarkProviderEvalBatchCaseMatrixItem {
  caseId: string
  providerId: string
  modelId: string
  evalRunId?: string
  recordedAt: string
  passed: boolean
  hasActualResult: boolean
  score: number
  verdict: ScorecardVerdict
  antiCheat: AntiCheatStatus
  totalTokens: number
  costUsd: number
  durationMs: number
  evidenceRefCount: number
  error?: string
}

export interface BenchmarkProviderEvalBatchReport {
  schemaVersion: 1
  generatedAt: string
  recordCount: number
  providerModelCount: number
  caseCount: number
  passedCount: number
  failedCount: number
  localOnly: true
  redactionMode: 'local_redacted_v0'
  trainingUse: BenchmarkProviderEvalTrainingUse
  leaderboard: BenchmarkProviderEvalBatchLeaderboardItem[]
  caseMatrix: BenchmarkProviderEvalBatchCaseMatrixItem[]
  summary: string
}

export function buildBenchmarkProviderEvalBatchReport(
  records: BenchmarkProviderEvalStoreRecord[],
  options: BenchmarkScorecardOptions = {},
): BenchmarkProviderEvalBatchReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const ledger = buildBenchmarkProviderEvalCostLedger(records, { generatedAt })
  const passedCount = records.filter(record => record.livePassed).length
  const failedCount = records.length - passedCount
  const caseIds = new Set(records.map(record => record.caseId))
  const leaderboard = ledger.items
    .map(item => leaderboardItem(item))
    .sort(compareLeaderboardItems)
  const caseMatrix = records
    .map(caseMatrixItem)
    .sort((a, b) =>
      a.caseId.localeCompare(b.caseId)
      || `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`)
      || a.recordedAt.localeCompare(b.recordedAt))

  return {
    schemaVersion: 1,
    generatedAt,
    recordCount: records.length,
    providerModelCount: leaderboard.length,
    caseCount: caseIds.size,
    passedCount,
    failedCount,
    localOnly: true,
    redactionMode: 'local_redacted_v0',
    trainingUse: 'not_collected',
    leaderboard,
    caseMatrix,
    summary: [
      `Benchmark provider eval batch report: ${passedCount}/${records.length} passed`,
      `${leaderboard.length} provider/model buckets`,
      `${caseIds.size} cases`,
      'local_only=true',
      'training_use=not_collected',
    ].join(', '),
  }
}

export function formatBenchmarkProviderEvalBatchReport(
  report: BenchmarkProviderEvalBatchReport,
): string {
  const lines = [
    'Benchmark Provider Eval Batch Report',
    `Generated: ${report.generatedAt}`,
    `Result: ${report.passedCount}/${report.recordCount} passed, provider_models=${report.providerModelCount}, cases=${report.caseCount}, local_only=true, training_use=${report.trainingUse}`,
    '',
    '| Provider/Model | Runs | Passed | Pass rate | Avg score | Tokens | Cost | Avg duration | Verdict |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ]

  for (const item of report.leaderboard) {
    lines.push([
      `${item.providerId}/${item.modelId}`,
      String(item.runCount),
      String(item.passedCount),
      formatPercent(item.passRate),
      String(item.averageScore),
      String(item.totalTokens),
      `$${item.totalCostUsd.toFixed(4)}`,
      `${item.averageDurationMs}ms`,
      item.verdict,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }

  lines.push(
    '',
    '| Case | Provider/Model | Passed | Score | Anti-cheat | Error |',
    '| --- | --- | --- | ---: | --- | --- |',
  )

  for (const item of report.caseMatrix) {
    lines.push([
      item.caseId,
      `${item.providerId}/${item.modelId}`,
      item.passed ? 'pass' : 'fail',
      String(item.score),
      item.antiCheat,
      item.error ?? '',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }

  return lines.join('\n')
}

function leaderboardItem(item: BenchmarkProviderEvalCostLedgerItem): BenchmarkProviderEvalBatchLeaderboardItem {
  return {
    providerId: item.providerId,
    modelId: item.modelId,
    runCount: item.runCount,
    passedCount: item.passedCount,
    failedCount: item.failedCount,
    passRate: item.runCount > 0 ? roundRatio(item.passedCount / item.runCount) : 0,
    averageScore: item.averageScore,
    totalTokens: item.totalTokens,
    totalCostUsd: item.totalCostUsd,
    averageDurationMs: item.averageDurationMs,
    costPerPassedRunUsd: item.costPerPassedRunUsd,
    verdict: leaderboardVerdict(item),
  }
}

function caseMatrixItem(record: BenchmarkProviderEvalStoreRecord): BenchmarkProviderEvalBatchCaseMatrixItem {
  const usage = record.usage ?? {}
  return {
    caseId: record.caseId,
    providerId: record.providerId,
    modelId: record.modelId,
    evalRunId: record.evalRunId,
    recordedAt: record.recordedAt,
    passed: record.livePassed,
    hasActualResult: record.hasActualResult,
    score: record.scorecard.overallScore,
    verdict: record.scorecard.verdict,
    antiCheat: record.scorecard.antiCheat,
    totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    costUsd: usage.costUsd ?? 0,
    durationMs: usage.durationMs ?? 0,
    evidenceRefCount: record.evidenceRefs.length,
    error: record.error,
  }
}

function leaderboardVerdict(item: BenchmarkProviderEvalCostLedgerItem): ScorecardVerdict {
  if (item.runCount === 0 || item.passedCount === 0) return 'fail'
  if (item.failedCount > 0 || item.averageScore < 80) return 'warn'
  return 'pass'
}

function compareLeaderboardItems(
  a: BenchmarkProviderEvalBatchLeaderboardItem,
  b: BenchmarkProviderEvalBatchLeaderboardItem,
): number {
  return b.passRate - a.passRate
    || b.averageScore - a.averageScore
    || a.totalCostUsd - b.totalCostUsd
    || `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`)
}

function roundRatio(value: number): number {
  return Number(value.toFixed(4))
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}
