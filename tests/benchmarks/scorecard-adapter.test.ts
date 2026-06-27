import { describe, expect, it } from 'vitest'
import {
  buildBenchmarkModelComparisonReport,
  formatBenchmarkModelComparisonReport,
  buildBenchmarkDryRunScorecard,
  buildBenchmarkLiveRunScorecard,
  buildBenchmarkProviderEvalScorecard,
  benchmarkDryRunToRuntimeFacts,
  benchmarkProviderEvalToLiveResult,
  runBenchmarkCaseDryRun,
} from '../../src/benchmark/index.js'
import type { BenchmarkDryRunResult, LiveBenchmarkResult } from '../../src/benchmark/index.js'

describe('benchmark dry-run scorecard adapter', () => {
  it('turns a passing benchmark dry-run into runtime facts, scorecard, and trajectory', () => {
    const result = runBenchmarkCaseDryRun('deck-12p', {
      packageVersion: '0.14.test',
      binaryBuild: 'dry-run-test',
    })

    const facts = benchmarkDryRunToRuntimeFacts(result, {
      generatedAt: '2026-06-26T07:00:00.000Z',
    })
    const packet = buildBenchmarkDryRunScorecard(result, {
      generatedAt: '2026-06-26T07:00:00.000Z',
    })

    expect(facts.runId).toBe('benchmark:deck-12p:0.14.test:dry-run-test')
    expect(facts.threadIds).toEqual(['benchmark-thread:deck-12p'])
    expect(facts.events.map(event => event.kind)).toEqual([
      'turn_started',
      'item_completed',
      'item_completed',
      'turn_completed',
    ])
    expect(facts.artifactIds).toEqual(expect.arrayContaining([
      'benchmark_artifact:deck-12p:0',
      'benchmark_artifact:deck-12p:1',
    ]))

    expect(packet).toMatchObject({
      schemaVersion: 1,
      benchmarkCaseId: 'deck-12p',
      runId: 'benchmark:deck-12p:0.14.test:dry-run-test',
      facts,
      scorecard: {
        scorecardVersion: 1,
        runId: 'benchmark:deck-12p:0.14.test:dry-run-test',
        verdict: 'pass',
        antiCheat: { verdict: 'pass' },
      },
      trajectory: {
        recordCount: 4,
        localOnly: true,
        redactionMode: 'local_redacted_v0',
      },
    })
    expect(packet.scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task_completion', verdict: 'pass' }),
      expect.objectContaining({ id: 'verification', verdict: 'pass' }),
      expect.objectContaining({ id: 'file_discipline', verdict: 'pass' }),
    ]))
    expect(packet.summary).toContain('benchmark_case=deck-12p')
    expect(packet.trajectory.records).toHaveLength(4)
  })

  it('does not let failed benchmark verification produce a passing scorecard', () => {
    const failed: BenchmarkDryRunResult = {
      caseId: 'deck-12p',
      packageVersion: '0.14.test',
      binaryBuild: 'failed-test',
      selectedSkill: 'guizang-ppt-skill',
      timeToFirstWriteMs: 1200,
      readCallsBeforeFirstWrite: 2,
      artifacts: [
        { path: 'deck-12p/deck.html', kind: 'html_deck', exists: false, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'deck-12p.section_count',
          kind: 'html_deck.section_count',
          status: 'failed',
          passed: false,
          expected: 12,
          actual: 3,
          message: 'expected 12 sections, found 3',
        },
      ],
      taskNoProgress: { hard: 1, suppressed: 0 },
      finalStatus: 'failed',
    }

    const packet = buildBenchmarkDryRunScorecard(failed, {
      generatedAt: '2026-06-26T07:10:00.000Z',
    })

    expect(packet.scorecard.verdict).toBe('fail')
    expect(packet.scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task_completion', verdict: 'warn' }),
      expect.objectContaining({ id: 'verification', verdict: 'fail' }),
      expect.objectContaining({ id: 'runtime_stability', verdict: 'warn' }),
    ]))
    expect(packet.scorecard.antiCheat.verdict).toBe('fail')
    expect(packet.facts.checkpointIds).toEqual(['benchmark_no_progress:deck-12p'])
    expect(packet.trajectory.records.length).toBeGreaterThan(0)
  })

  it('builds a model comparison report from benchmark scorecards', () => {
    const passed = runBenchmarkCaseDryRun('deck-12p', {
      packageVersion: '0.14.test',
      binaryBuild: 'comparison-pass',
    })
    const failed: BenchmarkDryRunResult = {
      ...passed,
      binaryBuild: 'comparison-fail',
      finalStatus: 'failed',
      artifacts: [
        { path: 'deck-12p/deck.html', kind: 'html_deck', exists: false, source: 'dry_run' },
      ],
      verification: [
        {
          id: 'deck-12p.section_count',
          kind: 'html_deck.section_count',
          status: 'failed',
          passed: false,
          expected: 12,
          actual: 3,
          message: 'expected 12 sections, found 3',
        },
      ],
      taskNoProgress: { hard: 1, suppressed: 0 },
    }

    const report = buildBenchmarkModelComparisonReport([
      { modelId: 'steady-model', result: passed },
      { modelId: 'drifty-model', result: failed },
    ], {
      generatedAt: '2026-06-26T07:20:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-06-26T07:20:00.000Z',
      itemCount: 2,
      passedCount: 1,
      failedCount: 1,
      averageScore: expect.any(Number),
    })
    expect(report.items).toEqual([
      expect.objectContaining({
        modelId: 'steady-model',
        caseId: 'deck-12p',
        success: true,
        verdict: 'pass',
        antiCheat: 'pass',
        cost: {
          timeToFirstWriteMs: passed.timeToFirstWriteMs,
          readCallsBeforeFirstWrite: passed.readCallsBeforeFirstWrite,
        },
        dimensions: expect.objectContaining({
          verification: expect.objectContaining({ verdict: 'pass' }),
          file_discipline: expect.objectContaining({ verdict: 'pass' }),
        }),
        evidenceConsistency: 'pass',
      }),
      expect.objectContaining({
        modelId: 'drifty-model',
        caseId: 'deck-12p',
        success: false,
        verdict: 'fail',
        antiCheat: 'fail',
        dimensions: expect.objectContaining({
          verification: expect.objectContaining({ verdict: 'fail' }),
          runtime_stability: expect.objectContaining({ verdict: 'warn' }),
        }),
        evidenceConsistency: 'fail',
      }),
    ])

    const formatted = formatBenchmarkModelComparisonReport(report)
    expect(formatted).toContain('Benchmark Model Comparison')
    expect(formatted).toContain('steady-model')
    expect(formatted).toContain('drifty-model')
    expect(formatted).toContain('1/2 passed')
  })

  it('turns live benchmark diff mismatches into scorecard evidence', () => {
    const expected = runBenchmarkCaseDryRun('deck-12p', {
      packageVersion: 'smoke',
      binaryBuild: 'smoke',
    })
    const actual: BenchmarkDryRunResult = {
      ...expected,
      artifacts: [],
      finalStatus: 'passed',
    }
    const live: LiveBenchmarkResult = {
      caseId: 'deck-12p',
      ranLive: true,
      expected,
      actual,
      passed: false,
      diff: {
        artifactMismatches: [{
          path: 'deck-12p/deck.html',
          expected: expected.artifacts[0]!,
        }],
        verificationMismatches: [],
      },
    }

    const packet = buildBenchmarkLiveRunScorecard(live, {
      generatedAt: '2026-06-26T07:30:00.000Z',
    })

    expect(packet).toMatchObject({
      schemaVersion: 1,
      runMode: 'live',
      benchmarkCaseId: 'deck-12p',
      live: {
        ranLive: true,
        passed: false,
        diffSummary: {
          artifactMismatchCount: 1,
          verificationMismatchCount: 0,
          hasFinalStatusMismatch: false,
          hasTaskNoProgressMismatch: false,
          hasTraceMismatch: false,
        },
      },
    })
    expect(packet.facts.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: 'benchmark-live-diff:deck-12p',
        payload: expect.objectContaining({
          tool_name: 'TaskVerify',
          metadata: expect.objectContaining({
            passed: false,
          }),
        }),
      }),
    ]))
    expect(packet.facts.checkpointIds).toEqual(['benchmark_live_diff:deck-12p'])
    expect(packet.scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verification', verdict: 'fail' }),
      expect.objectContaining({ id: 'runtime_stability', verdict: 'warn' }),
    ]))
    expect(packet.scorecard.antiCheat.verdict).toBe('fail')
    expect(packet.trajectory.records.length).toBeGreaterThan(4)
    expect(packet.summary).toContain('live_passed=false')
  })

  it('uses live benchmark pass/fail when building model comparison reports', () => {
    const expected = runBenchmarkCaseDryRun('deck-12p', {
      packageVersion: 'smoke',
      binaryBuild: 'smoke',
    })
    const passingLive: LiveBenchmarkResult = {
      caseId: 'deck-12p',
      ranLive: true,
      expected,
      actual: expected,
      passed: true,
      diff: {
        artifactMismatches: [],
        verificationMismatches: [],
      },
    }
    const failingLive: LiveBenchmarkResult = {
      ...passingLive,
      actual: {
        ...expected,
        artifacts: [],
      },
      passed: false,
      diff: {
        artifactMismatches: [{
          path: 'deck-12p/deck.html',
          expected: expected.artifacts[0]!,
        }],
        verificationMismatches: [],
      },
    }

    const report = buildBenchmarkModelComparisonReport([
      { modelId: 'live-steady', result: passingLive },
      { modelId: 'live-drifty', result: failingLive },
    ], {
      generatedAt: '2026-06-26T07:40:00.000Z',
    })

    expect(report).toMatchObject({
      itemCount: 2,
      passedCount: 1,
      failedCount: 1,
    })
    expect(report.items).toEqual([
      expect.objectContaining({
        modelId: 'live-steady',
        success: true,
        verdict: 'pass',
        evidenceConsistency: 'pass',
      }),
      expect.objectContaining({
        modelId: 'live-drifty',
        success: false,
        verdict: 'fail',
        antiCheat: 'fail',
        evidenceConsistency: 'fail',
      }),
    ])
  })

  it('normalizes provider eval observations into the live scorecard packet', () => {
    const expected = runBenchmarkCaseDryRun('deck-12p', {
      packageVersion: '0.14.test',
      binaryBuild: 'provider-expected',
    })
    const actual: BenchmarkDryRunResult = {
      ...expected,
      binaryBuild: 'provider-actual',
      artifacts: [expected.artifacts[0]!],
    }

    const live = benchmarkProviderEvalToLiveResult({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: 'gpt-test',
      evalRunId: 'eval-run-1',
      expected,
      actual,
    })

    expect(live).toMatchObject({
      caseId: 'deck-12p',
      ranLive: true,
      passed: false,
      diff: {
        artifactMismatches: [
          expect.objectContaining({ path: expected.artifacts[1]!.path }),
        ],
      },
    })

    const packet = buildBenchmarkProviderEvalScorecard({
      caseId: 'deck-12p',
      providerId: 'openai',
      modelId: 'gpt-test',
      evalRunId: 'eval-run-1',
      expected,
      actual,
    }, {
      generatedAt: '2026-06-26T07:50:00.000Z',
    })

    expect(packet).toMatchObject({
      schemaVersion: 1,
      runMode: 'live',
      benchmarkCaseId: 'deck-12p',
      providerEval: {
        providerId: 'openai',
        modelId: 'gpt-test',
        evalRunId: 'eval-run-1',
        hasActualResult: true,
      },
      live: {
        ranLive: true,
        passed: false,
        diffSummary: {
          artifactMismatchCount: 1,
        },
      },
    })
    expect(packet.facts.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'benchmark-live-diff:deck-12p' }),
    ]))
    expect(packet.scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verification', verdict: 'fail' }),
    ]))
  })
})
