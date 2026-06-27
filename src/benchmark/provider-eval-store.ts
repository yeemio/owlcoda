import { createReadStream } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BenchmarkProviderEvalCaseResult } from './provider-eval.js'
import type {
  BenchmarkLiveRunDiffSummary,
  BenchmarkProviderEvalUsage,
  BenchmarkScorecardOptions,
} from './scorecard-adapter.js'
import type { ScorecardVerdict, AntiCheatStatus } from '../native/scorecard.js'

export interface BenchmarkProviderEvalStoreRecord {
  schemaVersion: 1
  recordedAt: string
  providerId: string
  modelId: string
  evalRunId?: string
  caseId: string
  runId: string
  livePassed: boolean
  hasActualResult: boolean
  error?: string
  usage?: BenchmarkProviderEvalUsage
  diffSummary: BenchmarkLiveRunDiffSummary
  scorecard: {
    runId: string
    overallScore: number
    verdict: ScorecardVerdict
    antiCheat: AntiCheatStatus
  }
  trajectory: {
    recordCount: number
    localOnly: true
    redactionMode: 'local_redacted_v0'
  }
  evidenceRefs: string[]
}

export interface BenchmarkProviderEvalStoreOptions {
  recordPath?: string
}

export interface AppendBenchmarkProviderEvalRecordOptions extends BenchmarkProviderEvalStoreOptions {
  recordedAt?: string
}

export interface AppendBenchmarkProviderEvalRecordResult {
  path: string
  record: BenchmarkProviderEvalStoreRecord
}

export interface ReadBenchmarkProviderEvalRecordsOptions extends BenchmarkProviderEvalStoreOptions {
  limit?: number
}

export interface BenchmarkProviderEvalCostLedgerItem {
  providerId: string
  modelId: string
  runCount: number
  passedCount: number
  failedCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCostUsd: number
  totalDurationMs: number
  averageDurationMs: number
  averageScore: number
  costPerPassedRunUsd: number | null
}

export interface BenchmarkProviderEvalCostLedger {
  schemaVersion: 1
  generatedAt: string
  recordCount: number
  itemCount: number
  totalCostUsd: number
  totalTokens: number
  items: BenchmarkProviderEvalCostLedgerItem[]
  summary: string
}

export function getBenchmarkProviderEvalDir(): string {
  const home = process.env.OWLCODA_HOME ?? join(process.env.HOME ?? homedir(), '.owlcoda')
  return join(home, 'benchmark')
}

export function getBenchmarkProviderEvalPath(): string {
  return join(getBenchmarkProviderEvalDir(), 'provider-eval.jsonl')
}

export function buildBenchmarkProviderEvalStoreRecord(
  result: BenchmarkProviderEvalCaseResult,
  recordedAt: string,
): BenchmarkProviderEvalStoreRecord {
  const packet = result.scorecardPacket
  return {
    schemaVersion: 1,
    recordedAt,
    providerId: packet.providerEval.providerId,
    modelId: packet.providerEval.modelId,
    evalRunId: packet.providerEval.evalRunId,
    caseId: packet.benchmarkCaseId,
    runId: packet.runId,
    livePassed: packet.live.passed,
    hasActualResult: packet.providerEval.hasActualResult,
    error: packet.providerEval.error,
    usage: packet.providerEval.usage,
    diffSummary: packet.live.diffSummary,
    scorecard: {
      runId: packet.scorecard.runId,
      overallScore: packet.scorecard.overallScore,
      verdict: packet.scorecard.verdict,
      antiCheat: packet.scorecard.antiCheat.verdict,
    },
    trajectory: {
      recordCount: packet.trajectory.recordCount,
      localOnly: packet.trajectory.localOnly,
      redactionMode: packet.trajectory.redactionMode,
    },
    evidenceRefs: packet.scorecard.evidenceRefs,
  }
}

export function buildBenchmarkProviderEvalCostLedger(
  records: BenchmarkProviderEvalStoreRecord[],
  options: BenchmarkScorecardOptions = {},
): BenchmarkProviderEvalCostLedger {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const buckets = new Map<string, BenchmarkProviderEvalCostLedgerItem & { scoreSum: number }>()

  for (const record of records) {
    const key = `${record.providerId}\0${record.modelId}`
    const bucket = buckets.get(key) ?? {
      providerId: record.providerId,
      modelId: record.modelId,
      runCount: 0,
      passedCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      averageScore: 0,
      costPerPassedRunUsd: null,
      scoreSum: 0,
    }

    const usage = record.usage ?? {}
    bucket.runCount += 1
    if (record.livePassed) bucket.passedCount += 1
    else bucket.failedCount += 1
    bucket.totalInputTokens += usage.inputTokens ?? 0
    bucket.totalOutputTokens += usage.outputTokens ?? 0
    bucket.totalTokens += usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
    bucket.totalCostUsd = roundCost(bucket.totalCostUsd + (usage.costUsd ?? 0))
    bucket.totalDurationMs += usage.durationMs ?? 0
    bucket.scoreSum += record.scorecard.overallScore

    buckets.set(key, bucket)
  }

  const items = [...buckets.values()]
    .map(({ scoreSum, ...bucket }): BenchmarkProviderEvalCostLedgerItem => ({
      ...bucket,
      totalCostUsd: roundCost(bucket.totalCostUsd),
      averageDurationMs: bucket.runCount > 0 ? Math.round(bucket.totalDurationMs / bucket.runCount) : 0,
      averageScore: bucket.runCount > 0 ? Math.round(scoreSum / bucket.runCount) : 0,
      costPerPassedRunUsd: bucket.passedCount > 0
        ? roundCost(bucket.totalCostUsd / bucket.passedCount)
        : null,
    }))
    .sort((a, b) => `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`))

  const totalCostUsd = roundCost(items.reduce((sum, item) => sum + item.totalCostUsd, 0))
  const totalTokens = items.reduce((sum, item) => sum + item.totalTokens, 0)
  return {
    schemaVersion: 1,
    generatedAt,
    recordCount: records.length,
    itemCount: items.length,
    totalCostUsd,
    totalTokens,
    items,
    summary: formatProviderEvalCostLedgerSummary(items, totalCostUsd, totalTokens),
  }
}

export async function appendBenchmarkProviderEvalRecord(
  result: BenchmarkProviderEvalCaseResult,
  options: AppendBenchmarkProviderEvalRecordOptions = {},
): Promise<AppendBenchmarkProviderEvalRecordResult> {
  const path = options.recordPath ?? getBenchmarkProviderEvalPath()
  const recordedAt = options.recordedAt ?? new Date().toISOString()
  const record = buildBenchmarkProviderEvalStoreRecord(result, recordedAt)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  return { path, record }
}

export async function readBenchmarkProviderEvalRecords(
  options: ReadBenchmarkProviderEvalRecordsOptions = {},
): Promise<BenchmarkProviderEvalStoreRecord[]> {
  const path = options.recordPath ?? getBenchmarkProviderEvalPath()
  try {
    await stat(path)
  } catch {
    return []
  }

  const records: BenchmarkProviderEvalStoreRecord[] = []
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as BenchmarkProviderEvalStoreRecord
      if (parsed?.schemaVersion === 1) records.push(parsed)
    } catch {
      // Ignore malformed lines so one bad write does not hide older evals.
    }
    if (options.limit !== undefined && records.length >= options.limit) {
      rl.close()
      break
    }
  }
  return records
}

function formatProviderEvalCostLedgerSummary(
  items: BenchmarkProviderEvalCostLedgerItem[],
  totalCostUsd: number,
  totalTokens: number,
): string {
  const head = `Benchmark provider eval cost ledger: ${items.length} model buckets, total_cost=$${totalCostUsd.toFixed(4)}, total_tokens=${totalTokens}`
  const rows = items.map(item => [
    `${item.providerId}/${item.modelId}`,
    `${item.passedCount}/${item.runCount} passed`,
    `score=${item.averageScore}`,
    `cost=$${item.totalCostUsd.toFixed(4)}`,
    `tokens=${item.totalTokens}`,
    `duration=${item.totalDurationMs}ms`,
  ].join(' '))
  return [head, ...rows].join('\n')
}

function roundCost(value: number): number {
  return Number(value.toFixed(6))
}
