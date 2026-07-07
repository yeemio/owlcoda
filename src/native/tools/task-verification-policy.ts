import {
  classifyBashCommand,
  primaryBashRiskReason,
  type BashRiskClassification,
} from '../bash-risk.js'
import type { TaskVerificationCheck } from './task-store.js'

export interface VerificationPolicyViolation {
  checkId: string
  reason: string
}

export interface TaskVerifyCommandPolicyResult {
  allowed: boolean
  risk: BashRiskClassification
  policy: 'bash-risk' | 'taskverify-readonly-profile'
}

export function findUnsafeVerificationCommand(checks: TaskVerificationCheck[] | undefined): VerificationPolicyViolation | null {
  if (!checks) return null
  for (const check of checks) {
    if (check.kind !== 'command') continue
    const command = check.command?.trim()
    if (!command) continue
    const decision = classifyTaskVerifyCommand(command)
    if (!decision.allowed) {
      return {
        checkId: check.id,
        reason: `Unsafe TaskVerify command check "${check.id}": command classified as ${decision.risk.level} (${primaryBashRiskReason(decision.risk)}). TaskVerify command checks must be safe_readonly; use file_exists/file_contains/artifact_count/http_get or a safe_readonly command instead.`,
      }
    }
  }
  return null
}

export function classifyTaskVerifyCommand(command: string): TaskVerifyCommandPolicyResult {
  const risk = classifyBashCommand(command)
  if (risk.level === 'safe_readonly') {
    return { allowed: true, risk, policy: 'bash-risk' }
  }
  if (risk.level === 'needs_approval' && matchesTaskVerifyReadonlyProfile(command)) {
    return { allowed: true, risk, policy: 'taskverify-readonly-profile' }
  }
  return { allowed: false, risk, policy: 'bash-risk' }
}

function matchesTaskVerifyReadonlyProfile(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || hasShellControlOperator(trimmed) || hasWorkspaceWriteSink(trimmed)) return false
  if (isReadonlyNodeEval(trimmed)) return true
  if (isReadonlyNpxVerification(trimmed)) return true
  return false
}

function hasShellControlOperator(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    if (ch === ';') return true
    if (ch === '`') return true
    if (ch === '$' && next === '(') return true
    if (ch === '|' && next !== '|') return true
    if (ch === '&' && next === '&') return true
  }
  return false
}

function hasWorkspaceWriteSink(command: string): boolean {
  const unquoted = stripQuotedSegments(command)
  return /\btee\b/.test(unquoted)
    || /(?:^|\s)\d?>{1,2}\s*(?!&)(?!\/dev\/null\b)\S+/.test(unquoted)
}

function isReadonlyNodeEval(command: string): boolean {
  if (!/^node\s+-e\s+/.test(command)) return false
  return !/(?:writeFile|appendFile|rmSync|unlink|rmdir|mkdir|rename|copyFile|cpSync|exec(?:File|Sync)?|spawn(?:Sync)?|child_process|fetch\s*\(|require\s*\(\s*['"](?:http|https|net|dgram|child_process)['"]|import\s*\(\s*['"](?:http|https|net|dgram|child_process)['"]|eval\s*\(|Function\s*\()/i.test(command)
}

function isReadonlyNpxVerification(command: string): boolean {
  const tokens = tokenizeShellWords(command)
  let index = 0
  if (tokens[index] !== 'npx') return false
  index++
  while (tokens[index]?.startsWith('-')) {
    const option = tokens[index]!
    if (!['--no-install', '--yes', '-y'].includes(option)) return false
    index++
  }
  const tool = tokens[index]
  if (!tool) return false
  const args = tokens.slice(index + 1)
  if (tool === 'tsc') {
    return args.includes('--version') || args.includes('-v') || args.includes('-V') || args.includes('--noEmit')
  }
  if (tool === 'vitest') {
    return args.includes('run') || args.includes('--run') || args.includes('--version')
  }
  if (tool === 'eslint') {
    return !args.includes('--fix') && !args.some(arg => arg.startsWith('--fix-'))
  }
  return false
}

function tokenizeShellWords(input: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = '' }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

function stripQuotedSegments(input: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === "'" && !inDouble) { inSingle = !inSingle; out += ' '; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; out += ' '; continue }
    out += inSingle || inDouble ? ' ' : ch
  }
  return out
}
