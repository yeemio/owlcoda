import type { VerificationCheckResult, VerificationPackResult } from './verification-packs/types.js'

export type RepairPolicyDecisionKind = 'repair' | 'blocked' | 'passed'

export interface RepairPolicyInput {
  verification: VerificationPackResult
  attemptCount: number
  maxAttempts: number
}

export interface RepairPolicyDecision {
  action: RepairPolicyDecisionKind
  artifactPath: string
  failedCheckIds: string[]
  repairPrompt?: string
  blockedReason?: string
}

export function decideRepairPolicy(input: RepairPolicyInput): RepairPolicyDecision {
  const failedChecks = getFailedChecks(input.verification)
  const failedCheckIds = failedChecks.map(check => check.checkId)

  if (input.verification.passed && failedChecks.length === 0) {
    return {
      action: 'passed',
      artifactPath: input.verification.artifactPath,
      failedCheckIds: [],
    }
  }

  if (input.attemptCount >= input.maxAttempts) {
    return {
      action: 'blocked',
      artifactPath: input.verification.artifactPath,
      failedCheckIds,
      blockedReason: `Repair attempts exhausted: attemptCount=${input.attemptCount}, maxAttempts=${input.maxAttempts}`,
    }
  }

  return {
    action: 'repair',
    artifactPath: input.verification.artifactPath,
    failedCheckIds,
    repairPrompt: buildRepairPrompt(input.verification, failedChecks),
  }
}

function getFailedChecks(result: VerificationPackResult): VerificationCheckResult[] {
  return result.checks.filter(check => !check.passed)
}

function buildRepairPrompt(result: VerificationPackResult, failedChecks: VerificationCheckResult[]): string {
  if (result.packId === 'html_deck') {
    return buildHtmlDeckRepairPrompt(result, failedChecks)
  }

  return [
    'Repair the artifact so verification can pass.',
    `Artifact path: ${result.artifactPath}`,
    `Failed checkIds: ${formatCheckIds(failedChecks)}`,
    'Failure details:',
    ...failedChecks.map(formatCheckDetail),
    'After fixing, run ArtifactVerify/TaskVerify again.',
  ].join('\n')
}

function buildHtmlDeckRepairPrompt(result: VerificationPackResult, failedChecks: VerificationCheckResult[]): string {
  return [
    '请修复这个 HTML deck / Please repair this HTML deck.',
    `Artifact path: ${result.artifactPath}`,
    `失败 checkId 列表 / Failed checkIds: ${formatCheckIds(failedChecks)}`,
    '失败 detail 摘要 / Failure detail summary:',
    ...failedChecks.map(formatCheckDetail),
    '修复要求 / Repair requirement: fix the artifact so every failed verification check passes.',
    '修复后再次运行 ArtifactVerify/TaskVerify / After fixing, run ArtifactVerify/TaskVerify again.',
  ].join('\n')
}

function formatCheckIds(failedChecks: VerificationCheckResult[]): string {
  if (failedChecks.length === 0) return '(none)'
  return failedChecks.map(check => check.checkId).join(', ')
}

function formatCheckDetail(check: VerificationCheckResult): string {
  return `- ${check.checkId}: ${summarizeDetail(check.detail)}`
}

function summarizeDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) return normalized
  return `${normalized.slice(0, 237)}...`
}
