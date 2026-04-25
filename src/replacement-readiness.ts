import type { CheckResult } from './doctor.js'

export type ReplacementVerdict = 'replaceable' | 'not_yet_replaceable'

export interface ReplacementReadiness {
  verdict: ReplacementVerdict
  blockers: string[]
  strengths: string[]
}

function findCheck(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find(check => check.name === name)
}

export function assessReplacementReadiness(checks: CheckResult[]): ReplacementReadiness {
  const blockers: string[] = []
  const strengths: string[] = []

  const runtime = findCheck(checks, 'Local runtime') ?? findCheck(checks, 'Router')

  // A healthy local runtime visibility path is required for local model routing
  if (!runtime || runtime.status === 'fail') {
    blockers.push('local runtime not reachable — local model routing unavailable')
  } else if (runtime.status === 'warn') {
    blockers.push('local runtime visibility path is degraded or on deprecated fallback')
  } else {
    strengths.push('local runtime healthy — local model routing operational')
  }

  // Native mode is always available (no external dependencies)
  strengths.push('native REPL ready — 42+ tools, 69+ commands, session persistence')

  // Check if any model backends are healthy
  const modelChecks = checks.filter(c => c.name.startsWith('Model:') || c.name.startsWith('Backend:'))
  const healthyModels = modelChecks.filter(c => c.status === 'pass')
  if (healthyModels.length > 0) {
    strengths.push(`${healthyModels.length} model backend(s) healthy`)
  } else if (modelChecks.length > 0) {
    blockers.push('no model backends responding')
  }

  return {
    verdict: blockers.length === 0 ? 'replaceable' : 'not_yet_replaceable',
    blockers,
    strengths,
  }
}
