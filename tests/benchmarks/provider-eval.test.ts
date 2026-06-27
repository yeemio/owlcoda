import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runBenchmarkProviderEvalCase,
  type BenchmarkProviderEvalExecutorInput,
} from '../../src/benchmark/index.js'

describe('benchmark provider eval runner', () => {
  it('runs an injected provider executor and returns the shared scorecard packet', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-provider-eval-'))
    const calls: BenchmarkProviderEvalExecutorInput[] = []

    try {
      const result = await runBenchmarkProviderEvalCase({
        caseId: 'deck-12p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-run-1',
        workspaceDir,
        executor: async (input) => {
          calls.push(input)
          return {
            actual: {
              ...input.expected,
              binaryBuild: 'provider-actual',
            },
          }
        },
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        caseId: 'deck-12p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-run-1',
        workspaceDir,
      })
      expect(calls[0]!.fixture.caseId).toBe('deck-12p')
      expect(calls[0]!.prompt).toContain(workspaceDir)
      expect(calls[0]!.evalPacket.evalHooks.expectedArtifactPaths).toEqual(expect.arrayContaining([
        join(workspaceDir, 'deck.html'),
        join(workspaceDir, 'build-notes.md'),
      ]))

      expect(result.observation).toMatchObject({
        caseId: 'deck-12p',
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-run-1',
      })
      expect(result.liveResult).toMatchObject({
        ranLive: true,
        passed: true,
      })
      expect(result.scorecardPacket).toMatchObject({
        runMode: 'live',
        providerEval: {
          providerId: 'openai',
          modelId: 'gpt-test',
          evalRunId: 'eval-run-1',
          hasActualResult: true,
        },
        live: {
          passed: true,
        },
        scorecard: {
          verdict: 'pass',
          antiCheat: { verdict: 'pass' },
        },
      })
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })

  it('captures provider executor failure as a failed provider scorecard packet', async () => {
    const result = await runBenchmarkProviderEvalCase({
      caseId: 'readonly-review',
      providerId: 'anthropic',
      modelId: 'claude-test',
      evalRunId: 'eval-run-failure',
      executor: async () => {
        throw new Error('provider quota exhausted')
      },
    })

    expect(result.observation).toMatchObject({
      caseId: 'readonly-review',
      providerId: 'anthropic',
      modelId: 'claude-test',
      evalRunId: 'eval-run-failure',
      error: 'provider quota exhausted',
    })
    expect(result.liveResult).toMatchObject({
      ranLive: true,
      passed: false,
      skippedReason: 'provider quota exhausted',
    })
    expect(result.scorecardPacket.providerEval).toMatchObject({
      hasActualResult: false,
      error: 'provider quota exhausted',
    })
    expect(result.scorecardPacket.scorecard.verdict).toBe('fail')
    expect(result.scorecardPacket.facts.checkpointIds).toEqual(['benchmark_live_diff:readonly-review'])
  })

  it('carries provider usage and cost metadata into the shared scorecard packet', async () => {
    const result = await runBenchmarkProviderEvalCase({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: 'gpt-test',
      evalRunId: 'eval-run-cost',
      executor: async (input) => ({
        actual: {
          ...input.expected,
          binaryBuild: 'provider-cost-actual',
        },
        usage: {
          inputTokens: 1200,
          outputTokens: 800,
          totalTokens: 2000,
          costUsd: 0.42,
          durationMs: 34000,
        },
      }),
    })

    expect(result.observation.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 800,
      totalTokens: 2000,
      costUsd: 0.42,
      durationMs: 34000,
    })
    expect(result.scorecardPacket.providerEval.usage).toEqual(result.observation.usage)
  })
})
