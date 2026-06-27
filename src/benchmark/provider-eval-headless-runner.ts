import { runHeadless, type HeadlessResult } from '../native/headless.js'
import type { OperatingMode } from '../native/modes.js'
import type { BenchmarkProviderEvalExecutorInput } from './provider-eval.js'
import type {
  BenchmarkProviderEvalActualBuilder,
  BenchmarkProviderEvalActualBuilderInput,
} from './provider-eval-default.js'
import {
  buildBenchmarkProviderEvalActualFromHeadless,
  type BenchmarkHeadlessAuditResult,
} from './provider-eval-headless-audit.js'
import type { BenchmarkProviderEvalUsage } from './scorecard-adapter.js'

export interface BenchmarkProviderEvalHeadlessRunnerInput {
  input: BenchmarkProviderEvalExecutorInput
  apiBaseUrl: string
  apiKey: string
  model: string
  prompt: string
  workspaceDir: string
  responseText: string
  usage: BenchmarkProviderEvalUsage
  durationMs: number
  rawResponse: unknown
  mode?: OperatingMode
  maxTokens?: number
  autoApprove?: boolean
  allowTools?: readonly string[]
  denyTools?: readonly string[]
}

export type BenchmarkProviderEvalHeadlessRunner = (
  input: BenchmarkProviderEvalHeadlessRunnerInput
) => Promise<BenchmarkHeadlessAuditResult> | BenchmarkHeadlessAuditResult

export interface CreateBenchmarkHeadlessRunnerActualBuilderOptions {
  apiBaseUrl: string
  apiKey: string
  model?: string
  mode?: OperatingMode
  maxTokens?: number
  autoApprove?: boolean
  allowTools?: readonly string[]
  denyTools?: readonly string[]
  packageVersion?: string
  binaryBuild?: string
  workspaceDir?: string
  runHeadlessAudit?: BenchmarkProviderEvalHeadlessRunner
}

export function createBenchmarkHeadlessRunnerActualBuilder(
  options: CreateBenchmarkHeadlessRunnerActualBuilderOptions,
): BenchmarkProviderEvalActualBuilder {
  const runAudit = options.runHeadlessAudit ?? runBenchmarkProviderEvalHeadlessAudit
  return async (builderInput) => {
    const runnerInput = buildRunnerInput(options, builderInput)
    const audit = await withWorkspaceAllowedRoot(runnerInput.workspaceDir, () => runAudit(runnerInput))
    return buildBenchmarkProviderEvalActualFromHeadless(builderInput.input, audit, {
      packageVersion: options.packageVersion,
      binaryBuild: options.binaryBuild ?? 'headless-runner',
      workspaceDir: options.workspaceDir,
    })
  }
}

export async function runBenchmarkProviderEvalHeadlessAudit(
  input: BenchmarkProviderEvalHeadlessRunnerInput,
): Promise<BenchmarkHeadlessAuditResult> {
  const result = await runHeadless({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    model: input.model,
    prompt: input.prompt,
    json: true,
    mode: input.mode,
    maxTokens: input.maxTokens,
    autoApprove: input.autoApprove,
    allowTools: input.allowTools,
    denyTools: input.denyTools,
  })
  return headlessResultToAudit(result)
}

function buildRunnerInput(
  options: CreateBenchmarkHeadlessRunnerActualBuilderOptions,
  builderInput: BenchmarkProviderEvalActualBuilderInput,
): BenchmarkProviderEvalHeadlessRunnerInput {
  return {
    input: builderInput.input,
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey,
    model: options.model ?? builderInput.input.modelId,
    prompt: builderInput.input.prompt,
    workspaceDir: options.workspaceDir ?? builderInput.input.workspaceDir,
    responseText: builderInput.responseText,
    usage: builderInput.usage,
    durationMs: builderInput.durationMs,
    rawResponse: builderInput.rawResponse,
    mode: options.mode,
    maxTokens: options.maxTokens,
    autoApprove: options.autoApprove,
    allowTools: options.allowTools,
    denyTools: options.denyTools,
  }
}

function headlessResultToAudit(result: HeadlessResult): BenchmarkHeadlessAuditResult {
  return {
    exitCode: result.exitCode,
    text: result.text,
    iterations: result.iterations,
    stopReason: result.stopReason,
    taskStatus: result.taskStatus,
    taskGuardReason: result.taskGuardReason,
    toolCalls: result.toolCalls?.map(call => ({
      tool: call.tool,
      input: call.input,
      output: call.output,
      metadata: call.metadata,
    })),
  }
}

async function withWorkspaceAllowedRoot<T>(
  workspaceDir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env['OWLCODA_ALLOW_FS_ROOTS']
  process.env['OWLCODA_ALLOW_FS_ROOTS'] = mergeAllowedRoot(previous, workspaceDir)
  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    } else {
      process.env['OWLCODA_ALLOW_FS_ROOTS'] = previous
    }
  }
}

function mergeAllowedRoot(previous: string | undefined, workspaceDir: string): string {
  const parts = (previous ?? '').split(':').filter(Boolean)
  if (!parts.includes(workspaceDir)) parts.push(workspaceDir)
  return parts.join(':')
}
