import { describe, expect, it } from 'vitest'
import {
  buildBenchmarkProviderEvalBatchReport,
  formatBenchmarkProviderEvalBatchReport,
  type BenchmarkProviderEvalStoreRecord,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval batch report', () => {
  it('builds a local-only model comparison report from provider eval records', () => {
    const records: BenchmarkProviderEvalStoreRecord[] = [
      record({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'deck-12p', passed: true, score: 95, tokens: 1500, costUsd: 0.3, durationMs: 12000 }),
      record({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'readonly-review', passed: true, score: 90, tokens: 800, costUsd: 0.1, durationMs: 8000 }),
      record({ providerId: 'moonshot', modelId: 'kimi-lite', caseId: 'deck-12p', passed: true, score: 88, tokens: 1200, costUsd: 0.04, durationMs: 15000 }),
      record({ providerId: 'moonshot', modelId: 'kimi-lite', caseId: 'readonly-review', passed: false, score: 60, tokens: 900, costUsd: 0.03, durationMs: 22000, error: 'missing verification' }),
    ]

    const report = buildBenchmarkProviderEvalBatchReport(records, {
      generatedAt: '2026-06-26T09:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-06-26T09:00:00.000Z',
      recordCount: 4,
      providerModelCount: 2,
      caseCount: 2,
      passedCount: 3,
      failedCount: 1,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
      trainingUse: 'not_collected',
    })
    expect(report.leaderboard.map(item => `${item.providerId}/${item.modelId}`)).toEqual([
      'openai/gpt-strong',
      'moonshot/kimi-lite',
    ])
    expect(report.leaderboard[0]).toMatchObject({
      runCount: 2,
      passedCount: 2,
      failedCount: 0,
      passRate: 1,
      averageScore: 93,
      totalTokens: 2300,
      totalCostUsd: 0.4,
      averageDurationMs: 10000,
      verdict: 'pass',
    })
    expect(report.leaderboard[1]).toMatchObject({
      runCount: 2,
      passedCount: 1,
      failedCount: 1,
      passRate: 0.5,
      averageScore: 74,
      verdict: 'warn',
    })
    expect(report.caseMatrix).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: 'readonly-review',
        providerId: 'moonshot',
        modelId: 'kimi-lite',
        passed: false,
        score: 60,
        error: 'missing verification',
      }),
    ]))
    expect(report.summary).toContain('3/4 passed')
    expect(report.summary).toContain('local_only=true')
  })

  it('formats the batch report as a readable markdown summary', () => {
    const report = buildBenchmarkProviderEvalBatchReport([
      record({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'deck-12p', passed: true, score: 95, tokens: 1500, costUsd: 0.3, durationMs: 12000 }),
    ], {
      generatedAt: '2026-06-26T09:00:00.000Z',
    })

    const text = formatBenchmarkProviderEvalBatchReport(report)

    expect(text).toContain('Benchmark Provider Eval Batch Report')
    expect(text).toContain('local_only=true')
    expect(text).toContain('| Provider/Model | Runs | Passed | Pass rate | Avg score | Tokens | Cost | Avg duration | Verdict |')
    expect(text).toContain('| openai/gpt-strong | 1 | 1 | 100% | 95 | 1500 | $0.3000 | 12000ms | pass |')
  })
})

function record(input: {
  providerId: string
  modelId: string
  caseId: string
  passed: boolean
  score: number
  tokens: number
  costUsd: number
  durationMs: number
  error?: string
}): BenchmarkProviderEvalStoreRecord {
  return {
    schemaVersion: 1,
    recordedAt: '2026-06-26T08:00:00.000Z',
    providerId: input.providerId,
    modelId: input.modelId,
    caseId: input.caseId,
    runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
    livePassed: input.passed,
    hasActualResult: input.passed,
    error: input.error,
    usage: {
      inputTokens: Math.floor(input.tokens * 0.7),
      outputTokens: Math.ceil(input.tokens * 0.3),
      totalTokens: input.tokens,
      costUsd: input.costUsd,
      durationMs: input.durationMs,
    },
    diffSummary: {
      artifactMismatchCount: input.passed ? 0 : 1,
      verificationMismatchCount: input.passed ? 0 : 1,
      hasFinalStatusMismatch: !input.passed,
      hasTaskNoProgressMismatch: false,
      hasTimeToFirstWriteMismatch: false,
      hasTraceMismatch: false,
    },
    scorecard: {
      runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
      overallScore: input.score,
      verdict: input.passed ? 'pass' : 'fail',
      antiCheat: input.passed ? 'pass' : 'warn',
    },
    trajectory: {
      recordCount: 3,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
    },
    evidenceRefs: [`artifact:${input.caseId}`, `proof:${input.caseId}`],
  }
}
