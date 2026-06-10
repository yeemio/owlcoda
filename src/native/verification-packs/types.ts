export type VerificationPackId = 'html_deck'

export type VerificationCheckSeverity = 'info' | 'warning' | 'error'

export type VerificationPackStatus = 'passed' | 'failed'

export interface VerificationCheckResult {
  checkId: string
  passed: boolean
  severity: VerificationCheckSeverity
  detail: string
  metadata?: Record<string, unknown>
}

export interface VerificationPackResult {
  packId: VerificationPackId
  status: VerificationPackStatus
  passed: boolean
  artifactPath: string
  checkedAt: string
  checks: VerificationCheckResult[]
}
