import { classifyBashCommand, primaryBashRiskReason } from '../bash-risk.js'
import type { TaskVerificationCheck } from './task-store.js'

export interface VerificationPolicyViolation {
  checkId: string
  reason: string
}

export function findUnsafeVerificationCommand(checks: TaskVerificationCheck[] | undefined): VerificationPolicyViolation | null {
  if (!checks) return null
  for (const check of checks) {
    if (check.kind !== 'command') continue
    const command = check.command?.trim()
    if (!command) continue
    const risk = classifyBashCommand(command)
    if (risk.level !== 'safe_readonly') {
      return {
        checkId: check.id,
        reason: `Unsafe TaskVerify command check "${check.id}": command classified as ${risk.level} (${primaryBashRiskReason(risk)}). TaskVerify command checks must be safe_readonly; use file_exists/file_contains/artifact_count/http_get or a safe_readonly command instead.`,
      }
    }
  }
  return null
}
