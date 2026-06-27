import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBenchmarkProviderEvalCostLedger,
  getBenchmarkProviderEvalPath,
  readBenchmarkProviderEvalRecords,
  runBenchmarkProviderEvalCase,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval store', () => {
  it('appends provider eval scorecard records to local JSONL when a recordPath is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-provider-eval-store-'))
    const recordPath = join(root, 'benchmark', 'provider-eval.jsonl')

    try {
      await runBenchmarkProviderEvalCase({
        caseId: 'deck-12p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-record-1',
        recordPath,
        generatedAt: '2026-06-26T08:00:00.000Z',
        executor: async (input) => ({
          actual: {
            ...input.expected,
            binaryBuild: 'provider-store-actual',
          },
          usage: {
            inputTokens: 700,
            outputTokens: 300,
            totalTokens: 1000,
            costUsd: 0.18,
            durationMs: 15000,
          },
        }),
      })

      const records = await readBenchmarkProviderEvalRecords({ recordPath })
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        schemaVersion: 1,
        recordedAt: '2026-06-26T08:00:00.000Z',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-record-1',
        caseId: 'deck-12p',
        livePassed: true,
        scorecard: {
          runId: expect.any(String),
          verdict: 'pass',
          antiCheat: 'pass',
        },
        usage: {
          inputTokens: 700,
          outputTokens: 300,
          totalTokens: 1000,
          costUsd: 0.18,
          durationMs: 15000,
        },
        trajectory: {
          localOnly: true,
          redactionMode: 'local_redacted_v0',
          recordCount: expect.any(Number),
        },
      })
      expect(records[0]!.evidenceRefs.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds a provider/model cost ledger from local JSONL records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-provider-eval-ledger-'))
    const recordPath = join(root, 'benchmark', 'provider-eval.jsonl')

    try {
      await runBenchmarkProviderEvalCase({
        caseId: 'deck-12p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'ledger-pass',
        recordPath,
        generatedAt: '2026-06-26T08:10:00.000Z',
        executor: async (input) => ({
          actual: input.expected,
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            costUsd: 0.21,
            durationMs: 12000,
          },
        }),
      })
      await runBenchmarkProviderEvalCase({
        caseId: 'deck-46p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'ledger-fail',
        recordPath,
        generatedAt: '2026-06-26T08:20:00.000Z',
        executor: async () => ({
          error: 'model timed out',
          usage: {
            inputTokens: 2000,
            outputTokens: 0,
            totalTokens: 2000,
            costUsd: 0.09,
            durationMs: 30000,
          },
        }),
      })

      const records = await readBenchmarkProviderEvalRecords({ recordPath })
      const ledger = buildBenchmarkProviderEvalCostLedger(records, {
        generatedAt: '2026-06-26T08:30:00.000Z',
      })

      expect(ledger).toMatchObject({
        schemaVersion: 1,
        generatedAt: '2026-06-26T08:30:00.000Z',
        recordCount: 2,
        itemCount: 1,
        items: [{
          providerId: 'openai',
          modelId: 'gpt-test',
          runCount: 2,
          passedCount: 1,
          failedCount: 1,
          totalInputTokens: 3000,
          totalOutputTokens: 500,
          totalTokens: 3500,
          totalCostUsd: 0.3,
          totalDurationMs: 42000,
          averageDurationMs: 21000,
          costPerPassedRunUsd: 0.3,
        }],
      })
      expect(ledger.summary).toContain('openai/gpt-test')
      expect(ledger.summary).toContain('$0.3000')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses OWLCODA_HOME for the default provider eval path and reads missing stores as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-provider-eval-home-'))
    const previousHome = process.env.OWLCODA_HOME
    process.env.OWLCODA_HOME = root

    try {
      expect(getBenchmarkProviderEvalPath()).toBe(join(root, 'benchmark', 'provider-eval.jsonl'))
      await expect(readBenchmarkProviderEvalRecords()).resolves.toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
