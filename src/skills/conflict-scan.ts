export type ConflictClass =
  | 'bypass-instruction'
  | 'slash-command'
  | 'mode'
  | 'tool-policy'
  | 'prompt-priority'

export interface ConflictFinding {
  class: ConflictClass
  severity: 'reject' | 'warn'
  pattern: string
  match: string
}

/** Class-5 bypass-instruction denylist (promoted from tests/skill-trust-plane.test.ts). */
export const BYPASS_INSTRUCTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'tool-level escalation parameter', pattern: /\bsandbox_permissions\s*=\s*require_escalated\b/i },
  { name: 'raw require_escalated token', pattern: /\brequire_escalated\b/i },
  { name: 'danger-full-access sandbox downgrade', pattern: /--sandbox\s+danger-full-access|\bsandbox_mode\s*=\s*danger-full-access\b/i },
  { name: 'sandbox disabled instruction', pattern: /\bsandbox(?:ing)?\s+disabled\b/i },
  { name: 'rerun with escalated permissions', pattern: /\brerun\b[^\n.]{0,160}\bescalated permissions\b/i },
  { name: 'relax approval policy', pattern: /\brelax the approval policy\b/i },
  { name: 'OwlCoda control-plane rollback env', pattern: /\bOWLCODA_(?:PROJECT_MAP|PROJECT_MAP_SHADOW|TELEMETRY_EVENTS|GATE|GATE_V2|GATE_PROVENANCE|MODES|PERMISSION)[A-Z0-9_]*\s*=\s*(?:0|false|off|disable|disabled)\b/i },
  { name: 'skip verification imperative', pattern: /(?<!do not |don't |never )\bskip (?:verification|verifications|tests|checks)\b/i },
  { name: 'disable runtime controls', pattern: /\b(?:disable|turn off|bypass)\s+(?:modes?|gates?|provenance|verification|write-scope|permission)\b/i },
]

/** Scan skill text for conflicts. Slice 1: class-5 = reject; classes 1-4 reserved (best-effort, added later). */
export function scanForConflicts(text: string): ConflictFinding[] {
  const findings: ConflictFinding[] = []
  for (const { name, pattern } of BYPASS_INSTRUCTION_PATTERNS) {
    const m = text.match(pattern)
    if (m) findings.push({ class: 'bypass-instruction', severity: 'reject', pattern: name, match: m[0] })
  }
  return findings
}

export function hasRejectableConflict(findings: ConflictFinding[]): boolean {
  return findings.some(f => f.severity === 'reject')
}
