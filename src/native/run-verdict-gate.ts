import * as fs from 'node:fs'
import * as path from 'node:path'

export type RunVerdictGateStatus = 'pass' | 'blocked' | 'unknown'
export type RunVerdictEvidenceStatus = 'ok' | 'missing' | 'partial' | 'explicit_missing' | 'unknown'

export interface RunVerdictGateResult {
  status: RunVerdictGateStatus
  verdict?: string
  trustworthy?: boolean
  calibrationPassed?: boolean
  evidenceStatus?: RunVerdictEvidenceStatus
  evidenceCount?: number
  evidenceExpected?: number
  p1Status: 'pass' | 'partial' | 'infra_blocked' | 'unknown'
  p2Status: 'allowed' | 'blocked' | 'unknown'
  reasons: string[]
  nextAction: string
}

export interface RunVerdictGateOptions {
  scorePath?: string
}

export function evaluateRunVerdictGate(value: unknown, options: RunVerdictGateOptions = {}): RunVerdictGateResult {
  if (!value || typeof value !== 'object') {
    return {
      status: 'unknown',
      p1Status: 'unknown',
      p2Status: 'unknown',
      reasons: ['artifact is not an object'],
      nextAction: 'Inspect the run artifact and add a machine-readable verdict before recommending promotion or retraining.',
    }
  }

  const artifact = value as Record<string, unknown>
  const runHealth = objectField(artifact['run_health'])
  const verdict = stringField(artifact['verdict'])
  const normalizedVerdict = verdict?.trim().toUpperCase()
  const trustworthy = booleanField(artifact['owl_score_trustworthy'])
  const calibrationPassed = booleanField(runHealth?.['calibration_passed'])
  const infraFailReason = stringField(runHealth?.['infra_fail_reason'])
  const evidence = evaluateJudgeEvidence(artifact, options)
  const reasons: string[] = []

  if (normalizedVerdict === 'INFRA_FAIL') reasons.push('verdict=INFRA_FAIL')
  if (trustworthy === false) reasons.push('owl_score_trustworthy=false')
  if (calibrationPassed === false) reasons.push('run_health.calibration_passed=false')
  if (infraFailReason) reasons.push(`infra_fail_reason=${infraFailReason}`)
  if (evidence.blocked) reasons.push(evidence.reason)

  if (reasons.length > 0) {
    return {
      status: 'blocked',
      ...(verdict ? { verdict } : {}),
      ...(trustworthy !== undefined ? { trustworthy } : {}),
      ...(calibrationPassed !== undefined ? { calibrationPassed } : {}),
      ...(evidence.status ? { evidenceStatus: evidence.status } : {}),
      ...(evidence.count !== undefined ? { evidenceCount: evidence.count } : {}),
      ...(evidence.expected !== undefined ? { evidenceExpected: evidence.expected } : {}),
      p1Status: 'infra_blocked',
      p2Status: 'blocked',
      reasons,
      nextAction: 'P2 blocked: stabilize judge stability or run a fallback judge probe before any retrain/promotion recommendation.',
    }
  }

  if (!verdict && trustworthy === undefined && calibrationPassed === undefined) {
    return {
      status: 'unknown',
      p1Status: 'unknown',
      p2Status: 'unknown',
      ...(evidence.status ? { evidenceStatus: evidence.status } : {}),
      ...(evidence.count !== undefined ? { evidenceCount: evidence.count } : {}),
      ...(evidence.expected !== undefined ? { evidenceExpected: evidence.expected } : {}),
      reasons: ['artifact has no verdict, owl_score_trustworthy, or run_health.calibration_passed fields'],
      nextAction: 'Add machine-readable run health before treating diagnostic gate counts as promotion evidence.',
    }
  }

  return {
    status: 'pass',
    ...(verdict ? { verdict } : {}),
    ...(trustworthy !== undefined ? { trustworthy } : {}),
    ...(calibrationPassed !== undefined ? { calibrationPassed } : {}),
    ...(evidence.status ? { evidenceStatus: evidence.status } : {}),
    ...(evidence.count !== undefined ? { evidenceCount: evidence.count } : {}),
    ...(evidence.expected !== undefined ? { evidenceExpected: evidence.expected } : {}),
    p1Status: 'pass',
    p2Status: 'allowed',
    reasons: ['machine-readable run verdict does not block downstream promotion'],
    nextAction: 'Downstream recommendations may proceed if all other task-specific gates pass.',
  }
}

export function formatRunVerdictGateResult(result: RunVerdictGateResult): string {
  const verdict = result.verdict ? ` verdict=${result.verdict};` : ''
  return [
    `run_verdict_gate ${result.status};${verdict} P1 ${result.p1Status}; P2 ${result.p2Status}.`,
    `reasons: ${result.reasons.join('; ')}`,
    `next_action: ${result.nextAction}`,
  ].join(' ')
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function evaluateJudgeEvidence(
  artifact: Record<string, unknown>,
  options: RunVerdictGateOptions,
): {
  status?: RunVerdictEvidenceStatus
  count?: number
  expected?: number
  blocked: boolean
  reason: string
} {
  const runHealth = objectField(artifact['run_health'])
  const expected = numberField(runHealth?.['judge_total'])
  if (!expected || expected <= 0) return { blocked: false, reason: '' }

  const evidence = objectField(artifact['evidence'])
  const explicitMissing =
    booleanField(evidence?.['missing_judge_evidence']) === true
    || booleanField(evidence?.['judge_evidence_missing']) === true
    || booleanField(runHealth?.['judge_evidence_missing']) === true
    || stringField(evidence?.['evidence_status']) === 'missing'
  if (explicitMissing) {
    return {
      status: 'explicit_missing',
      count: 0,
      expected,
      blocked: true,
      reason: `judge evidence explicitly marked missing for run_health.judge_total=${expected}`,
    }
  }

  if (!options.scorePath) {
    return {
      status: 'unknown',
      expected,
      blocked: true,
      reason: `judge evidence cannot be verified for run_health.judge_total=${expected} without score path`,
    }
  }

  const runDir = path.dirname(path.resolve(options.scorePath))
  const activeJudgeCount = countFiles(path.join(runDir, 'judge'))
  const archiveCount = countEvidencePath(runDir, stringField(evidence?.['judge_archive']))
  const logCount = countJsonlRecords(resolveEvidencePath(runDir, stringField(evidence?.['judge_attempt_log'])))
  const count = Math.max(activeJudgeCount, archiveCount, logCount)

  if (count >= expected) {
    return { status: 'ok', count, expected, blocked: false, reason: '' }
  }

  const status: RunVerdictEvidenceStatus = count > 0 ? 'partial' : 'missing'
  return {
    status,
    count,
    expected,
    blocked: true,
    reason: `judge evidence ${status}: run_health.judge_total=${expected} but found ${count} evidence record(s)`,
  }
}

function resolveEvidencePath(runDir: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  return path.isAbsolute(value) ? value : path.join(runDir, value)
}

function countEvidencePath(runDir: string, value: string | undefined): number {
  const resolved = resolveEvidencePath(runDir, value)
  if (!resolved) return 0
  return countFiles(resolved)
}

function countJsonlRecords(filePath: string | undefined): number {
  if (!filePath) return 0
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return 0
    return fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .length
  } catch {
    return 0
  }
}

function countFiles(targetPath: string): number {
  try {
    const stat = fs.statSync(targetPath)
    if (stat.isFile()) return 1
    if (!stat.isDirectory()) return 0
    let count = 0
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      count += countFiles(path.join(targetPath, entry.name))
    }
    return count
  } catch {
    return 0
  }
}
