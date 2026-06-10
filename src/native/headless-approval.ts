/**
 * Headless approval policy for native runs.
 *
 * Background — issue #1 (private):
 *   Headless `runHeadless()` carried an `autoApprove` flag through CLI
 *   parsing but never installed `onToolApproval` on the conversation
 *   callbacks. Because the conversation loop only enforces a per-tool
 *   approval check when that callback exists, headless mode was effectively
 *   running with implicit auto-approve for every tool — including
 *   `bash`, `write`, `edit`, and `NotebookEdit`.
 *
 *   Interactive native REPL has separate task-scope write approval and
 *   may grow its own per-tool approval surface; headless does not, so
 *   "no callback" must mean "deny unsafe", not "allow everything".
 *
 * Policy rules — small, durable, deny-by-default:
 *   - Safe tools (read, glob, grep, list-mcp-resources, …) always allowed.
 *   - Structured file-mutation tools (write, edit, NotebookEdit) require
 *     `autoApprove: true` plus either an explicit task-contract write path
 *     or a high-confidence workspace-scoped code-change contract. The latter
 *     keeps benchmark/headless coding tasks usable while preserving the
 *     workspace boundary.
 *   - Bash/TaskCreate command execution remains classifier-gated:
 *     `safe_readonly` is allowed; needs_approval/dangerous/unknown are
 *     denied in unattended headless, even with --auto-approve.
 *   - AskUserQuestion is denied in unattended headless. A benchmark or
 *     CI run must produce a machine-readable result, not block on stdin.
 *   - The decision is recorded so `--json` output can show it (visible,
 *     bounded, test-covered per the issue's acceptance bar).
 *
 * P1 update — issue #2 (centralized bash risk classification):
 *   Bash is no longer treated as monolithically unsafe. The shared
 *   `classifyBashCommand()` is consulted; commands that classify as
 *   `safe_readonly` (pwd, ls, cat README.md, git status, rg ...) pass the
 *   gate without --auto-approve. Anything else (`needs_approval`,
 *   `dangerous`, `unknown`) is denied by default — including unknown,
 *   which preserves the P0 fail-closed contract.
 */

/**
 * Tools whose execution can mutate filesystem state, run arbitrary
 * shell, or otherwise have effects beyond reading bytes.
 *
 * Kept as a literal `Set` so the test suite can introspect it and so
 * adding a new mutating tool is one line in one place.
 *
 * Note: this is a SUPERSET of task-state's MUTATING_WRITE_TOOLS because
 * `bash` is not a "write" in task-scope terms but is unmistakably
 * "unsafe" for an unattended headless run.
 */
export const UNSAFE_HEADLESS_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'NotebookEdit',
  'bash',
  'AskUserQuestion',
  // TaskCreate is unsafe ONLY when its optional `command` is set; the
  // pure-todo form (no command) is treated as safe inside the policy
  // function below. Membership here makes the dispatch land in the
  // command-aware branch instead of the safe-tool default.
  'TaskCreate',
])

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { classifyBashCommand, type BashRiskClassification, type BashRiskLevel } from './bash-risk.js'
import { classifyDeliverableContract } from './deliverable-contract.js'
import { evaluateWriteGuard } from './task-state.js'
import type { TaskExecutionState } from './protocol/types.js'

export type HeadlessApprovalDecision =
  | { allowed: true; reason: 'safe-tool' }
  | { allowed: true; reason: 'safe-bash'; toolName: 'bash' | 'TaskCreate'; bashRisk: BashRiskClassification }
  | { allowed: true; reason: 'workspace-test-bash'; toolName: 'bash' | 'TaskCreate'; bashRisk: BashRiskClassification }
  | { allowed: true; reason: 'task-contract-auto-approve'; toolName: string }
  | { allowed: false; reason: 'deny-tool-explicit'; toolName: string }
  | { allowed: false; reason: 'deny-tool-not-allowed'; toolName: string }
  | { allowed: false; reason: 'deny-interactive'; toolName: 'AskUserQuestion' }
  | { allowed: false; reason: 'deny-by-default'; toolName: string; bashRisk?: BashRiskClassification }
  | { allowed: false; reason: 'deny-bash-risk'; toolName: 'bash' | 'TaskCreate'; bashRisk: BashRiskClassification }

export interface HeadlessApprovalRecord {
  toolName: string
  decision: HeadlessApprovalDecision
}

export interface HeadlessApprovalPolicyOptions {
  /** When true, unsafe tools are auto-approved (headless --auto-approve). */
  autoApprove: boolean
  /**
   * Optional per-run tool allowlist. This only narrows the base policy:
   * listed tools still have to pass their normal risk checks.
   */
  allowTools?: readonly string[]
  /** Optional per-run denylist. Deny wins over allow and base policy. */
  denyTools?: readonly string[]
  /**
   * Live task contract accessor. Headless --auto-approve is intentionally
   * narrower than TUI yolo: it can approve file mutations only when the
   * current user task declared explicit writable paths.
   */
  getTaskState?: () => TaskExecutionState | undefined
  /** Optional sink for downstream visibility (JSON output, audit log). */
  onDecision?: (record: HeadlessApprovalRecord) => void
}

/**
 * Build an `onToolApproval` callback that fits ConversationCallbacks.
 *
 * Returns `true` to allow execution, `false` to deny. The conversation
 * loop already turns a `false` into a non-mutating `tool_result` block
 * with `output: 'Tool execution denied by user.'` and
 * `isError: true`, so we don't need to throw or short-circuit the
 * agent loop here — denial is just first-class result data.
 */
export function buildHeadlessApprovalCallback(
  opts: HeadlessApprovalPolicyOptions,
): (toolName: string, input: Record<string, unknown>) => Promise<boolean> {
  return async (toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    const decision = decideHeadlessApproval(toolName, opts.autoApprove, input, opts.getTaskState?.(), {
      allowTools: opts.allowTools,
      denyTools: opts.denyTools,
    })
    opts.onDecision?.({ toolName, decision })
    return decision.allowed
  }
}

/**
 * Decide whether a tool call is permitted under the headless approval
 * policy. Pure: same inputs always produce the same decision.
 *
 * The optional `input` argument is consulted for `bash` so the bash
 * classifier can let safe read-only commands through without
 * `--auto-approve`. Other tools ignore `input`.
 */
export function decideHeadlessApproval(
  toolName: string,
  autoApprove: boolean,
  input?: Record<string, unknown>,
  taskState?: TaskExecutionState,
  toolPolicy?: HeadlessToolFilterPolicy,
): HeadlessApprovalDecision {
  const filterDecision = decideHeadlessToolFilter(toolName, toolPolicy)
  if (filterDecision) return filterDecision

  if (!UNSAFE_HEADLESS_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'safe-tool' }
  }

  if (toolName === 'AskUserQuestion') {
    return { allowed: false, reason: 'deny-interactive', toolName: 'AskUserQuestion' }
  }

  if (toolName === 'bash') {
    const bashRisk = classifyBashCommand(input?.['command'])
    if (bashRisk.level === 'safe_readonly') {
      return { allowed: true, reason: 'safe-bash', toolName: 'bash', bashRisk }
    }
    if (autoApprove && isAllowedWorkspaceTestBash(input?.['command'], taskState)) {
      return { allowed: true, reason: 'workspace-test-bash', toolName: 'bash', bashRisk }
    }
    // needs_approval / dangerous / unknown — fail closed in unattended
    // headless even with --auto-approve. File mutation approval for headless
    // is limited to structured write/edit/NotebookEdit paths declared in the
    // task contract; shell mutation remains too broad to silently permit.
    return { allowed: false, reason: 'deny-bash-risk', toolName: 'bash', bashRisk }
  }

  // TaskCreate mirrors bash exactly when input.command is present —
  // same classifier, same fail-closed rules. When command is absent the
  // call is a pure TODO entry and returns straight to safe-tool, which
  // matches the pre-execution behaviour callers relied on.
  if (toolName === 'TaskCreate') {
    const cmd = input?.['command']
    if (cmd === undefined || cmd === null || cmd === '') {
      return { allowed: true, reason: 'safe-tool' }
    }
    const bashRisk = classifyBashCommand(cmd)
    if (bashRisk.level === 'safe_readonly') {
      return { allowed: true, reason: 'safe-bash', toolName: 'TaskCreate', bashRisk }
    }
    if (autoApprove && isAllowedWorkspaceTestBash(cmd, taskState)) {
      return { allowed: true, reason: 'workspace-test-bash', toolName: 'TaskCreate', bashRisk }
    }
    return { allowed: false, reason: 'deny-bash-risk', toolName: 'TaskCreate', bashRisk }
  }

  if (autoApprove && isAllowedStructuredFileMutation(toolName, input, taskState)) {
    return { allowed: true, reason: 'task-contract-auto-approve', toolName }
  }
  return { allowed: false, reason: 'deny-by-default', toolName }
}

export function describeApprovalPolicy(autoApprove: boolean): string {
  return autoApprove ? 'auto-approve-task-contract-writes' : 'deny-unsafe-without-approval'
}

export interface HeadlessToolFilterPolicy {
  allowTools?: readonly string[]
  denyTools?: readonly string[]
}

export function normalizeHeadlessToolList(tools: readonly string[] | undefined): string[] {
  if (!tools) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tools) {
    for (const part of raw.split(',')) {
      const tool = part.trim()
      if (!tool || seen.has(tool)) continue
      seen.add(tool)
      out.push(tool)
    }
  }
  return out
}

function decideHeadlessToolFilter(
  toolName: string,
  toolPolicy: HeadlessToolFilterPolicy | undefined,
): HeadlessApprovalDecision | null {
  const denyTools = normalizeHeadlessToolList(toolPolicy?.denyTools)
  if (denyTools.includes(toolName)) {
    return { allowed: false, reason: 'deny-tool-explicit', toolName }
  }

  const allowTools = normalizeHeadlessToolList(toolPolicy?.allowTools)
  if (allowTools.length > 0 && !allowTools.includes(toolName)) {
    return { allowed: false, reason: 'deny-tool-not-allowed', toolName }
  }

  return null
}

function isAllowedStructuredFileMutation(
  toolName: string,
  input: Record<string, unknown> | undefined,
  taskState: TaskExecutionState | undefined,
): boolean {
  if (!taskState || !input) return false
  if (taskState.contract.scopeMode === 'explicit_paths') {
    const writableScopes = taskState.contract.allowedWritePaths.filter(
      (scope) => scope.origin !== 'external_reference',
    )
    if (writableScopes.length === 0) return false
    return evaluateWriteGuard(toolName, input, taskState) === null
  }

  if (!isHighConfidenceWorkspaceCodeChange(taskState)) return false
  if (!structuredMutationTargetStaysInWorkspace(toolName, input, taskState.contract.cwd)) {
    return false
  }
  return evaluateWriteGuard(toolName, input, taskState) === null
}

function isHighConfidenceWorkspaceCodeChange(taskState: TaskExecutionState): boolean {
  if (taskState.contract.scopeMode !== 'workspace') return false
  const deliverable = classifyDeliverableContract(`${taskState.contract.objective}\n\n${taskState.contract.sourceText}`)
  return deliverable.mode === 'code_change' && deliverable.confidence === 'high'
}

function isHighConfidenceCodeChange(taskState: TaskExecutionState): boolean {
  const deliverable = classifyDeliverableContract(`${taskState.contract.objective}\n\n${taskState.contract.sourceText}`)
  return deliverable.mode === 'code_change' && deliverable.confidence === 'high'
}

function isAllowedWorkspaceTestBash(
  command: unknown,
  taskState: TaskExecutionState | undefined,
): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  if (!taskState || !isHighConfidenceCodeChange(taskState)) return false

  const workspaceRoot = resolve(taskState.contract.cwd)
  if (isAllowedWorkspacePythonHeredocCommand(command, workspaceRoot)) return true

  let currentDir = workspaceRoot
  let sawAllowedCommand = false

  for (const chunk of splitHeadlessCommand(command)) {
    if (hasMutatingShellRedirect(chunk)) return false

    const cdTarget = parseCdChunk(chunk)
    if (cdTarget !== undefined) {
      if (cdTarget === null) return false
      const nextDir = resolve(currentDir, cdTarget)
      if (!pathStaysInWorkspace(nextDir, workspaceRoot)) return false
      currentDir = nextDir
      continue
    }

    if (isWorkspaceTestCommand(chunk)) {
      sawAllowedCommand = true
      continue
    }

    const risk = classifyBashCommand(chunk)
    if (risk.level === 'dangerous' || risk.touchesNetwork) return false
    if (risk.level === 'safe_readonly') {
      sawAllowedCommand = true
      continue
    }

    return false
  }

  return sawAllowedCommand
}

function isAllowedWorkspacePythonHeredocCommand(command: string, workspaceRoot: string): boolean {
  const heredoc = command.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\r?\n/)
  if (!heredoc || heredoc.index === undefined) return false
  const delimiter = heredoc[2]
  if (!delimiter) return false
  const prefix = command.slice(0, heredoc.index).trim()
  const bodyStart = heredoc.index + heredoc[0].length
  const bodyAndTrailer = command.slice(bodyStart)
  const endPattern = new RegExp(`\\r?\\n${escapeRegExp(delimiter)}[ \\t]*$`)
  const end = bodyAndTrailer.match(endPattern)
  if (!end || end.index === undefined) return false
  const source = bodyAndTrailer.slice(0, end.index)
  if (!isSafeInlinePythonProbe(source)) return false

  let currentDir = workspaceRoot
  let sawPythonStdin = false
  for (const chunk of splitHeadlessCommand(prefix)) {
    const cdTarget = parseCdChunk(chunk)
    if (cdTarget !== undefined) {
      if (cdTarget === null) return false
      const nextDir = resolve(currentDir, cdTarget)
      if (!pathStaysInWorkspace(nextDir, workspaceRoot)) return false
      currentDir = nextDir
      continue
    }
    const tokens = stripLeadingEnvAssignments(tokenizeShellLike(stripFdDuplication(chunk)))
    const head = tokens[0] ?? ''
    if (!isPythonExecutable(head) || tokens[1] !== '-' || tokens.some(isNetworkOrInstallToken)) {
      return false
    }
    sawPythonStdin = true
  }
  return sawPythonStdin
}

function splitHeadlessCommand(command: string): string[] {
  const chunks: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let backtickDepth = 0

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]
    if (!inSingle && !inDouble && parenDepth === 0 && backtickDepth === 0) {
      if (ch === ';') { flush(); continue }
      if (ch === '|' && next !== '|') { flush(); continue }
      if (ch === '|' && next === '|') { flush(); i++; continue }
      if (ch === '&' && next === '&') { flush(); i++; continue }
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) backtickDepth = backtickDepth === 0 ? 1 : 0
    else if (ch === '$' && next === '(' && !inSingle) { parenDepth++; buf += ch; i++; continue }
    else if (ch === ')' && !inSingle && parenDepth > 0) parenDepth--
    buf += ch
  }
  flush()
  return chunks

  function flush(): void {
    const s = buf.trim()
    buf = ''
    if (s) chunks.push(s)
  }
}

function parseCdChunk(chunk: string): string | null | undefined {
  const tokens = tokenizeShellLike(chunk)
  if (tokens[0] !== 'cd') return undefined
  if (tokens.length !== 2 || !tokens[1]) return null
  return tokens[1] ?? ''
}

function isWorkspaceTestCommand(chunk: string): boolean {
  const tokens = stripLeadingEnvAssignments(tokenizeShellLike(stripFdDuplication(chunk)))
  const head = tokens[0]
  if (!head) return false
  if ((head === 'pytest' || head === 'py.test') && !tokens.some(isNetworkOrInstallToken)) {
    return true
  }
  if (isPythonExecutable(head) && isPythonVersionCheck(tokens)) {
    return true
  }
  if (isPythonExecutable(head) && tokens[1] === '-m') {
    const moduleName = tokens[2]
    return (moduleName === 'pytest' || moduleName === 'unittest' || moduleName === 'py_compile' || moduleName === 'compileall') &&
      !tokens.some(isNetworkOrInstallToken)
  }
  if (isPythonExecutable(head) && tokens[1] === '-c') {
    return !tokens.some(isNetworkOrInstallToken) && isSafeInlinePythonProbe(tokens[2] ?? '')
  }
  if (isPythonExecutable(head) && tokens[1]) {
    const script = tokens[1]!
    if (isKnownWorkspaceTestRunner(script)) return !tokens.some(isNetworkOrInstallToken)
    if (isWorkspaceLocalPythonScript(script)) return !tokens.some(isNetworkOrInstallToken)
    if (isDjangoManageTest(tokens)) return !tokens.some(isNetworkOrInstallToken)
  }
  return false
}

function isPythonExecutable(head: string): boolean {
  return /^python(?:\d+(?:\.\d+)?)?$/.test(head)
}

function isPythonVersionCheck(tokens: string[]): boolean {
  return tokens.includes('--version') || tokens.includes('-V')
}

function isKnownWorkspaceTestRunner(script: string): boolean {
  const normalized = script.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized === 'runtests.py' || normalized === 'tests/runtests.py' || normalized.endsWith('/tests/runtests.py')
}

function isWorkspaceLocalPythonScript(script: string): boolean {
  if (!script.endsWith('.py')) return false
  if (script.includes('\0')) return false
  const normalized = script.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) return false
  const base = normalized.split('/').pop() ?? ''
  return base.startsWith('test_') || base.endsWith('_test.py') || normalized.startsWith('tests/') || normalized.includes('/tests/')
}

function isDjangoManageTest(tokens: string[]): boolean {
  const script = tokens[1]?.replace(/\\/g, '/').replace(/^\.\//, '')
  return script === 'manage.py' && tokens[2] === 'test'
}

function isSafeInlinePythonProbe(source: string): boolean {
  if (!source.trim()) return false
  const lowered = source.toLowerCase()
  if (/[&|`$<>]/.test(source)) return false
  for (const needle of [
    'pip',
    'install',
    'download',
    'socket',
    'urllib',
    'requests',
    'http://',
    'https://',
    'subprocess',
    'system(',
    'popen(',
    'spawn',
    'remove(',
    'unlink(',
    'rmdir(',
    'rmtree',
    'rename(',
    'replace(',
    'chmod(',
    'chown(',
    'open(',
    'write_text(',
    'write_bytes(',
  ]) {
    if (lowered.includes(needle)) return false
  }
  return true
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripLeadingEnvAssignments(tokens: string[]): string[] {
  let start = 0
  if (tokens[start] === 'env') start++
  while (start < tokens.length && isShellEnvAssignment(tokens[start]!)) {
    start++
  }
  return tokens.slice(start)
}

function isShellEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function isNetworkOrInstallToken(token: string): boolean {
  return token === 'install' || token === 'download' || token === 'http' ||
    token.startsWith('http://') || token.startsWith('https://')
}

function hasMutatingShellRedirect(chunk: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!
    const next = chunk[i + 1]
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    if ((ch === '>' || ch === '<') && next === '(') continue
    if (ch === '<') continue
    if (ch === '>') {
      if (next === '&') continue
      return true
    }
  }
  return false
}

function stripFdDuplication(chunk: string): string {
  return chunk.replace(/\s+\d*>\s*&\d+\b/g, '')
}

function tokenizeShellLike(chunk: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!
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

function pathStaysInWorkspace(targetPath: string, cwd: string): boolean {
  const target = canonicalizeForBoundary(resolve(targetPath))
  const root = canonicalizeForBoundary(resolve(cwd))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function structuredMutationTargetStaysInWorkspace(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  const rawTarget = typeof input['path'] === 'string'
    ? input['path']
    : typeof input['notebook_path'] === 'string'
      ? input['notebook_path']
      : null
  if (!rawTarget || rawTarget.includes('\0')) return false
  if (toolName === 'NotebookEdit' && typeof input['notebook_path'] !== 'string') return false
  if ((toolName === 'write' || toolName === 'edit') && typeof input['path'] !== 'string') return false

  const target = canonicalizeForBoundary(isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(cwd, rawTarget))
  const root = canonicalizeForBoundary(resolve(cwd))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function canonicalizeForBoundary(path: string): string {
  const resolved = resolve(path)
  if (existsSync(resolved)) {
    return realpathSync(resolved)
  }

  let parent = dirname(resolved)
  const suffixParts: string[] = [relative(parent, resolved)]
  while (parent !== dirname(parent)) {
    if (existsSync(parent)) {
      return resolve(realpathSync(parent), join(...suffixParts.reverse()))
    }
    const next = dirname(parent)
    suffixParts.push(relative(next, parent))
    parent = next
  }
  return resolved
}

/**
 * Stable key into the bash risk taxonomy used for telemetry and JSON
 * serialization, kept here so that headless callers don't have to know
 * the bash-risk module exists.
 */
export type { BashRiskLevel, BashRiskClassification }
