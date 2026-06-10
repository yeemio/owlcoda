import { VERSION, buildTag } from '../version.js'
import { BENCHMARK_CASE_FIXTURES } from './fixtures.js'
import {
  BENCHMARK_CASE_IDS,
  type BenchmarkCaseFixture,
  type BenchmarkCaseId,
  type BenchmarkDryRunResult,
  type BenchmarkFinalStatus,
  type BenchmarkSchemaValidation,
  type BenchmarkVerificationStatus,
} from './types.js'
import { validateBenchmarkEvalMethodology } from './eval-policy.js'

const FINAL_STATUSES: BenchmarkFinalStatus[] = ['passed', 'failed', 'blocked']
const VERIFICATION_STATUSES: BenchmarkVerificationStatus[] = ['passed', 'failed', 'blocked', 'not_run']

export interface BenchmarkDryRunOptions {
  packageVersion?: string
  binaryBuild?: string
}

export function isBenchmarkCaseId(value: string): value is BenchmarkCaseId {
  return (BENCHMARK_CASE_IDS as readonly string[]).includes(value)
}

export function listBenchmarkCases(): BenchmarkCaseFixture[] {
  return BENCHMARK_CASE_FIXTURES.map(cloneCaseFixture)
}

export function getBenchmarkCase(caseId: BenchmarkCaseId): BenchmarkCaseFixture {
  const found = BENCHMARK_CASE_FIXTURES.find(c => c.caseId === caseId)
  if (!found) throw new Error(`Unknown benchmark case: ${caseId}`)
  return cloneCaseFixture(found)
}

export function runBenchmarkCaseDryRun(caseId: BenchmarkCaseId, opts: BenchmarkDryRunOptions = {}): BenchmarkDryRunResult {
  const fixture = getBenchmarkCase(caseId)
  return {
    caseId,
    packageVersion: opts.packageVersion ?? VERSION,
    binaryBuild: opts.binaryBuild ?? buildTag(),
    selectedSkill: fixture.dryRun.selectedSkill,
    timeToFirstWriteMs: fixture.dryRun.timeToFirstWriteMs,
    readCallsBeforeFirstWrite: fixture.dryRun.readCallsBeforeFirstWrite,
    artifacts: fixture.dryRun.artifacts.map(a => ({ ...a })),
    verification: fixture.dryRun.verification.map(v => ({ ...v })),
    taskNoProgress: { ...fixture.dryRun.taskNoProgress },
    finalStatus: fixture.dryRun.finalStatus,
  }
}

export function runBenchmarkSuiteDryRun(opts: BenchmarkDryRunOptions = {}): BenchmarkDryRunResult[] {
  return BENCHMARK_CASE_IDS.map(caseId => runBenchmarkCaseDryRun(caseId, opts))
}

export function benchmarkResultToJson(result: BenchmarkDryRunResult, pretty = true): string {
  validateBenchmarkResultOrThrow(result)
  return JSON.stringify(result, null, pretty ? 2 : 0)
}

export function validateBenchmarkResultSchema(value: unknown): BenchmarkSchemaValidation {
  const issues: string[] = []

  if (!isRecord(value)) {
    return { ok: false, issues: ['result must be an object'] }
  }

  if (typeof value.caseId !== 'string' || !isBenchmarkCaseId(value.caseId)) {
    issues.push('caseId must be a supported benchmark case id')
  }
  if (typeof value.packageVersion !== 'string' || value.packageVersion.length === 0) {
    issues.push('packageVersion must be a non-empty string')
  }
  if (typeof value.binaryBuild !== 'string' || value.binaryBuild.length === 0) {
    issues.push('binaryBuild must be a non-empty string')
  }
  if (!(value.selectedSkill === null || typeof value.selectedSkill === 'string')) {
    issues.push('selectedSkill must be a string or null')
  }
  if (!isNonNegativeNumber(value.timeToFirstWriteMs)) {
    issues.push('timeToFirstWriteMs must be a non-negative number')
  }
  if (!isNonNegativeInteger(value.readCallsBeforeFirstWrite)) {
    issues.push('readCallsBeforeFirstWrite must be a non-negative integer')
  }
  if (!Array.isArray(value.artifacts)) {
    issues.push('artifacts must be an array')
  } else {
    for (const [idx, artifact] of value.artifacts.entries()) {
      validateArtifact(artifact, `artifacts[${idx}]`, issues)
    }
  }
  if (!Array.isArray(value.verification)) {
    issues.push('verification must be an array')
  } else {
    for (const [idx, verification] of value.verification.entries()) {
      validateVerification(verification, `verification[${idx}]`, issues)
    }
  }
  if (!isRecord(value.taskNoProgress)) {
    issues.push('taskNoProgress must be an object')
  } else {
    if (!isNonNegativeInteger(value.taskNoProgress.hard)) issues.push('taskNoProgress.hard must be a non-negative integer')
    if (!isNonNegativeInteger(value.taskNoProgress.suppressed)) issues.push('taskNoProgress.suppressed must be a non-negative integer')
  }
  if (typeof value.finalStatus !== 'string' || !FINAL_STATUSES.includes(value.finalStatus as BenchmarkFinalStatus)) {
    issues.push('finalStatus must be passed, failed, or blocked')
  }

  return { ok: issues.length === 0, issues }
}

export function validateBenchmarkFixtureMethodology(fixture: BenchmarkCaseFixture): BenchmarkSchemaValidation {
  return validateBenchmarkEvalMethodology(fixture)
}

export function validateBenchmarkResultOrThrow(value: unknown): asserts value is BenchmarkDryRunResult {
  const validation = validateBenchmarkResultSchema(value)
  if (!validation.ok) {
    throw new Error(`Invalid benchmark result: ${validation.issues.join('; ')}`)
  }
}

function validateArtifact(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  if (typeof value.path !== 'string' || value.path.length === 0) issues.push(`${path}.path must be a non-empty string`)
  if (typeof value.kind !== 'string' || value.kind.length === 0) issues.push(`${path}.kind must be a non-empty string`)
  if (typeof value.exists !== 'boolean') issues.push(`${path}.exists must be a boolean`)
  if (value.bytes !== undefined && !isNonNegativeInteger(value.bytes)) issues.push(`${path}.bytes must be a non-negative integer when present`)
}

function validateVerification(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  if (typeof value.id !== 'string' || value.id.length === 0) issues.push(`${path}.id must be a non-empty string`)
  if (typeof value.kind !== 'string' || value.kind.length === 0) issues.push(`${path}.kind must be a non-empty string`)
  if (typeof value.status !== 'string' || !VERIFICATION_STATUSES.includes(value.status as BenchmarkVerificationStatus)) {
    issues.push(`${path}.status must be a supported verification status`)
  }
  if (typeof value.passed !== 'boolean') issues.push(`${path}.passed must be a boolean`)
  if (typeof value.message !== 'string' || value.message.length === 0) issues.push(`${path}.message must be a non-empty string`)
}

function cloneCaseFixture(fixture: BenchmarkCaseFixture): BenchmarkCaseFixture {
  return {
    ...fixture,
    expectedOutputs: [...fixture.expectedOutputs],
    evalPolicy: {
      ...fixture.evalPolicy,
      expectedArtifactPaths: [...fixture.evalPolicy.expectedArtifactPaths],
      auditFields: [...fixture.evalPolicy.auditFields],
      ...(fixture.evalPolicy.sectionPolicy ? { sectionPolicy: { ...fixture.evalPolicy.sectionPolicy } } : {}),
    },
    dryRun: {
      ...fixture.dryRun,
      artifacts: fixture.dryRun.artifacts.map(a => ({ ...a })),
      verification: fixture.dryRun.verification.map(v => ({ ...v })),
      taskNoProgress: { ...fixture.dryRun.taskNoProgress },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}
