import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBenchmarkEvalPacket, renderBenchmarkTaskPrompt, type BenchmarkEvalPacket } from './eval-policy.js'
import { getBenchmarkCase, runBenchmarkCaseDryRun } from './harness.js'
import {
  benchmarkProviderEvalToLiveResult,
  buildBenchmarkProviderEvalScorecard,
  type BenchmarkProviderEvalObservation,
  type BenchmarkProviderEvalScorecardPacket,
  type BenchmarkProviderEvalUsage,
  type BenchmarkScorecardOptions,
} from './scorecard-adapter.js'
import type {
  BenchmarkCaseFixture,
  BenchmarkCaseId,
  BenchmarkDryRunResult,
} from './types.js'
import type { LiveBenchmarkResult } from './runner.js'
import { appendBenchmarkProviderEvalRecord } from './provider-eval-store.js'

export interface BenchmarkProviderEvalExecutorInput {
  caseId: BenchmarkCaseId
  providerId: string
  modelId: string
  evalRunId?: string
  fixture: BenchmarkCaseFixture
  prompt: string
  evalPacket: BenchmarkEvalPacket
  expected: BenchmarkDryRunResult
  workspaceDir: string
  signal?: AbortSignal
}

export interface BenchmarkProviderEvalExecutorOutput {
  actual?: BenchmarkDryRunResult
  error?: string
  usage?: BenchmarkProviderEvalUsage
}

export type BenchmarkProviderEvalExecutor = (
  input: BenchmarkProviderEvalExecutorInput
) => Promise<BenchmarkProviderEvalExecutorOutput>

export interface RunBenchmarkProviderEvalCaseOptions extends BenchmarkScorecardOptions {
  caseId: BenchmarkCaseId
  providerId: string
  modelId: string
  evalRunId?: string
  packageVersion?: string
  binaryBuild?: string
  workspaceDir?: string
  recordPath?: string
  signal?: AbortSignal
  executor: BenchmarkProviderEvalExecutor
}

export interface BenchmarkProviderEvalCaseResult {
  observation: BenchmarkProviderEvalObservation
  liveResult: LiveBenchmarkResult
  scorecardPacket: BenchmarkProviderEvalScorecardPacket
}

export async function runBenchmarkProviderEvalCase(
  options: RunBenchmarkProviderEvalCaseOptions,
): Promise<BenchmarkProviderEvalCaseResult> {
  const fixture = getBenchmarkCase(options.caseId)
  const expected = runBenchmarkCaseDryRun(options.caseId, {
    packageVersion: options.packageVersion,
    binaryBuild: options.binaryBuild,
  })
  const workspaceDir = options.workspaceDir ?? mkdtempSync(join(tmpdir(), `owlcoda-provider-eval-${options.caseId}-`))
  const ownedWorkspace = options.workspaceDir === undefined
  const prompt = renderBenchmarkTaskPrompt(fixture, workspaceDir)
  const evalPacket = buildBenchmarkEvalPacket(fixture, workspaceDir)

  let actual: BenchmarkDryRunResult | undefined
  let error: string | undefined
  let usage: BenchmarkProviderEvalUsage | undefined
  try {
    const output = await options.executor({
      caseId: options.caseId,
      providerId: options.providerId,
      modelId: options.modelId,
      evalRunId: options.evalRunId,
      fixture,
      prompt,
      evalPacket,
      expected,
      workspaceDir,
      signal: options.signal,
    })
    actual = output.actual
    error = output.error
    usage = output.usage
  } catch (err) {
    error = errorMessage(err)
  } finally {
    if (ownedWorkspace) {
      try { rmSync(workspaceDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  const observation: BenchmarkProviderEvalObservation = {
    caseId: options.caseId,
    providerId: options.providerId,
    modelId: options.modelId,
    evalRunId: options.evalRunId,
    packageVersion: options.packageVersion,
    binaryBuild: options.binaryBuild,
    expected,
    actual,
    error,
    usage,
  }
  const liveResult = benchmarkProviderEvalToLiveResult(observation)
  const scorecardPacket = buildBenchmarkProviderEvalScorecard(observation, {
    generatedAt: options.generatedAt,
  })
  const result: BenchmarkProviderEvalCaseResult = {
    observation,
    liveResult,
    scorecardPacket,
  }
  if (options.recordPath !== undefined) {
    await appendBenchmarkProviderEvalRecord(result, {
      recordPath: options.recordPath,
      recordedAt: options.generatedAt,
    })
  }
  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
