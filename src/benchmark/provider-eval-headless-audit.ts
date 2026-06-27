import { stat } from 'node:fs/promises'
import { basename, relative } from 'node:path'
import type { TaskRunStatus } from '../native/protocol/types.js'
import type { ToolCallTraceEntry } from '../native/transcript-trace.js'
import type {
  BenchmarkArtifact,
  BenchmarkDryRunResult,
  BenchmarkFinalStatus,
  BenchmarkVerification,
  BenchmarkVerificationStatus,
} from './types.js'
import type { BenchmarkProviderEvalExecutorInput } from './provider-eval.js'
import type {
  BenchmarkProviderEvalActualBuilder,
  BenchmarkProviderEvalActualBuilderInput,
} from './provider-eval-default.js'

export interface BenchmarkHeadlessAuditToolCall {
  tool: string
  input: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
}

export interface BenchmarkHeadlessAuditVerification {
  id: string
  kind?: string
  passed: boolean
  message: string
  expected?: string | number | boolean | null
  actual?: string | number | boolean | null
}

export interface BenchmarkHeadlessAuditResult {
  exitCode: number
  text?: string
  iterations?: number
  stopReason?: string | null
  taskStatus?: TaskRunStatus
  taskGuardReason?: string
  timeToFirstWriteMs?: number
  taskNoProgress?: { hard: number; suppressed: number }
  toolCalls?: BenchmarkHeadlessAuditToolCall[]
  verification?: BenchmarkHeadlessAuditVerification[]
}

export interface BuildBenchmarkProviderEvalActualFromHeadlessOptions {
  packageVersion?: string
  binaryBuild?: string
  workspaceDir?: string
}

export interface CreateBenchmarkHeadlessArtifactAuditBuilderOptions
  extends BuildBenchmarkProviderEvalActualFromHeadlessOptions {
  runHeadlessAudit: (
    input: BenchmarkProviderEvalActualBuilderInput
  ) => Promise<BenchmarkHeadlessAuditResult> | BenchmarkHeadlessAuditResult
}

export async function buildBenchmarkProviderEvalActualFromHeadless(
  input: BenchmarkProviderEvalExecutorInput,
  audit: BenchmarkHeadlessAuditResult,
  options: BuildBenchmarkProviderEvalActualFromHeadlessOptions = {},
): Promise<BenchmarkDryRunResult> {
  const workspaceDir = options.workspaceDir ?? input.workspaceDir
  const artifacts = await collectExpectedArtifacts(input, workspaceDir, audit.toolCalls ?? [])
  const verification = buildVerification(input, audit.verification)
  const finalStatus = inferFinalStatus(audit, artifacts, input.evalPacket.evalHooks.expectedArtifactPaths.length)

  return {
    caseId: input.caseId,
    packageVersion: options.packageVersion ?? input.expected.packageVersion,
    binaryBuild: options.binaryBuild ?? 'headless-audit',
    selectedSkill: input.expected.selectedSkill,
    timeToFirstWriteMs: audit.timeToFirstWriteMs ?? 0,
    readCallsBeforeFirstWrite: countReadsBeforeFirstWrite(audit.toolCalls ?? []),
    artifacts,
    verification,
    taskNoProgress: audit.taskNoProgress ?? { hard: 0, suppressed: 0 },
    finalStatus,
    trace: (audit.toolCalls ?? []).map(toolCallToTrace),
  }
}

export function createBenchmarkHeadlessArtifactAuditBuilder(
  options: CreateBenchmarkHeadlessArtifactAuditBuilderOptions,
): BenchmarkProviderEvalActualBuilder {
  return async (input) => {
    const audit = await options.runHeadlessAudit(input)
    return buildBenchmarkProviderEvalActualFromHeadless(input.input, audit, options)
  }
}

async function collectExpectedArtifacts(
  input: BenchmarkProviderEvalExecutorInput,
  workspaceDir: string,
  toolCalls: BenchmarkHeadlessAuditToolCall[],
): Promise<BenchmarkArtifact[]> {
  const artifacts: BenchmarkArtifact[] = []
  for (const path of input.evalPacket.evalHooks.expectedArtifactPaths) {
    const fileStat = await tryStat(path)
    const exists = Boolean(fileStat?.isFile())
    artifacts.push({
      path: relativeArtifactPath(workspaceDir, path),
      kind: inferArtifactKind(path),
      exists,
      ...(fileStat?.isFile() ? { bytes: Number(fileStat.size) } : {}),
      source: inferArtifactSource(path, toolCalls),
    })
  }
  return artifacts
}

async function tryStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

function relativeArtifactPath(workspaceDir: string, path: string): string {
  const rel = relative(workspaceDir, path)
  return rel && !rel.startsWith('..') ? rel : path
}

function inferArtifactKind(path: string): string {
  const lower = basename(path).toLowerCase()
  if (lower.endsWith('.html')) return 'html_deck'
  if (lower === 'build-notes.md') return 'build_notes'
  if (lower.endsWith('.md')) return 'markdown_report'
  if (lower.endsWith('.csv')) return 'data_table'
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'patch'
  if (lower.endsWith('.txt')) return 'test_result'
  return lower
}

function inferArtifactSource(
  path: string,
  toolCalls: BenchmarkHeadlessAuditToolCall[],
): BenchmarkArtifact['source'] {
  const lowerPath = path.toLowerCase()
  const lowerBase = basename(path).toLowerCase()
  for (const call of toolCalls) {
    const tool = call.tool.toLowerCase()
    if (tool !== 'write' && tool !== 'edit' && tool !== 'bash') continue
    const haystack = JSON.stringify(call.input).toLowerCase()
    if (haystack.includes(lowerPath) || haystack.includes(lowerBase)) {
      if (tool === 'edit') return 'edit'
      if (tool === 'bash') return 'bash'
      return 'write'
    }
  }
  return 'write'
}

function buildVerification(
  input: BenchmarkProviderEvalExecutorInput,
  evidence: BenchmarkHeadlessAuditVerification[] | undefined,
): BenchmarkVerification[] {
  if (evidence && evidence.length > 0) {
    return evidence.map((item): BenchmarkVerification => ({
      id: item.id,
      kind: item.kind ?? 'headless_audit',
      status: item.passed ? 'passed' : 'failed',
      passed: item.passed,
      message: item.message,
      expected: item.expected,
      actual: item.actual,
    }))
  }
  return input.expected.verification.map((item): BenchmarkVerification => ({
    ...item,
    status: 'not_run' satisfies BenchmarkVerificationStatus,
    passed: false,
    actual: null,
  }))
}

function inferFinalStatus(
  audit: BenchmarkHeadlessAuditResult,
  artifacts: BenchmarkArtifact[],
  expectedArtifactCount: number,
): BenchmarkFinalStatus {
  if (audit.taskStatus === 'blocked' || audit.taskStatus === 'waiting_user') return 'blocked'
  if (audit.stopReason === 'task_no_progress') return 'blocked'
  if (audit.exitCode !== 0) return 'failed'
  if (audit.taskStatus === 'drifted' || audit.taskStatus === 'open') return 'failed'
  if (expectedArtifactCount > 0 && artifacts.some(artifact => !artifact.exists)) return 'failed'
  return 'passed'
}

function countReadsBeforeFirstWrite(toolCalls: BenchmarkHeadlessAuditToolCall[]): number {
  let count = 0
  for (const call of toolCalls) {
    const tool = call.tool.toLowerCase()
    if (tool === 'write' || tool === 'edit') break
    if (tool === 'read' || tool === 'glob' || tool === 'grep') count++
  }
  return count
}

function toolCallToTrace(call: BenchmarkHeadlessAuditToolCall): ToolCallTraceEntry {
  return {
    name: call.tool,
    input: call.input,
  }
}
