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
 *   - Unsafe tools (write, edit, NotebookEdit, bash) require an explicit
 *     `autoApprove: true` in HeadlessOptions. Without it, the policy
 *     denies the call BEFORE execution and surfaces a structured reason.
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
])

import { classifyBashCommand, type BashRiskClassification, type BashRiskLevel } from './bash-risk.js'

export type HeadlessApprovalDecision =
  | { allowed: true; reason: 'safe-tool' }
  | { allowed: true; reason: 'safe-bash'; toolName: 'bash'; bashRisk: BashRiskClassification }
  | { allowed: true; reason: 'auto-approve'; toolName: string; bashRisk?: BashRiskClassification }
  | { allowed: false; reason: 'deny-by-default'; toolName: string; bashRisk?: BashRiskClassification }
  | { allowed: false; reason: 'deny-bash-risk'; toolName: 'bash'; bashRisk: BashRiskClassification }

export interface HeadlessApprovalRecord {
  toolName: string
  decision: HeadlessApprovalDecision
}

export interface HeadlessApprovalPolicyOptions {
  /** When true, unsafe tools are auto-approved (headless --auto-approve). */
  autoApprove: boolean
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
    const decision = decideHeadlessApproval(toolName, opts.autoApprove, input)
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
): HeadlessApprovalDecision {
  if (!UNSAFE_HEADLESS_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'safe-tool' }
  }

  if (toolName === 'bash') {
    const bashRisk = classifyBashCommand(input?.['command'])
    if (bashRisk.level === 'safe_readonly') {
      return { allowed: true, reason: 'safe-bash', toolName: 'bash', bashRisk }
    }
    if (autoApprove) {
      return { allowed: true, reason: 'auto-approve', toolName: 'bash', bashRisk }
    }
    // needs_approval / dangerous / unknown — fail closed.
    return { allowed: false, reason: 'deny-bash-risk', toolName: 'bash', bashRisk }
  }

  if (autoApprove) {
    return { allowed: true, reason: 'auto-approve', toolName }
  }
  return { allowed: false, reason: 'deny-by-default', toolName }
}

export function describeApprovalPolicy(autoApprove: boolean): string {
  return autoApprove ? 'auto-approve-all' : 'deny-unsafe-without-approval'
}

/**
 * Stable key into the bash risk taxonomy used for telemetry and JSON
 * serialization, kept here so that headless callers don't have to know
 * the bash-risk module exists.
 */
export type { BashRiskLevel, BashRiskClassification }
