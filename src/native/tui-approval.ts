/**
 * TUI tool-approval policy.
 *
 * Background — issue #4 (private):
 *   The interactive REPL shortcut `requestToolApproval` allowed any tool
 *   in `~/.owlcoda/permissions.json` (`globalApprove`) to execute without
 *   prompting. That decision was per-tool, not per-command-class — so a
 *   user who once said "always allow bash" silently consented to every
 *   future bash, including `rm -rf /`. The bash classifier already had
 *   the right verdict (`dangerous`) but the TUI gate never consulted it.
 *
 * Policy (mirrors the headless gate, with one carve-out):
 *   - `autoApprove` (env-var yolo) and `batchApproveAllRef` (this turn's
 *     [A] All decision) are explicit, fresh consents — they remain in
 *     force for every tool, dangerous or not. They're per-session/per-
 *     batch, not durable.
 *   - `SAFE_TOOLS` membership is by-construction safe (read, glob, grep,
 *     ToolSearch, …) — bypass.
 *   - The persistent "always allow this tool" memory is honored ONLY
 *     when the call is not a dangerous bash/TaskCreate command. Anything
 *     the classifier flags as `dangerous` falls through to a prompt.
 *   - `needs_approval` and `unknown` levels are NOT treated as dangerous
 *     here on purpose: they already prompt under the default no-allow
 *     state, and a user who flipped on "always allow bash" usually meant
 *     to skip those low-stakes prompts. Only the `dangerous` tier
 *     (rm -rf, force-push, sudo, dd, mkfs, curl|sh) overrides.
 */

import { classifyBashCommand, type BashRiskClassification } from './bash-risk.js'
import { canonicalToolName } from './tool-defs.js'

export interface TuiApprovalInputs {
  /** Tool name from the conversation block. */
  toolName: string
  /** Tool input — `command` is consulted for bash/TaskCreate. */
  input: Record<string, unknown>
  /** Env-var yolo (`OWLCODA_AUTO_APPROVE=1|true|yes|on|yolo`). */
  autoApprove: boolean
  /** True when the user just chose [A] All in the most recent prompt. */
  batchApproveAll: boolean
  /** Persistent "always allow this tool" set, loaded from
   * `~/.owlcoda/permissions.json` and augmented in-session by [A] Always. */
  perToolApprove: ReadonlySet<string>
  /** Tools always treated as safe by construction (read, glob, …). */
  safeTools: ReadonlySet<string>
}

export type TuiApprovalDecision =
  | { action: 'allow'; reason: 'auto-approve' | 'batch-all' | 'safe-tool' | 'persistent-allow' }
  | { action: 'prompt'; reason: 'no-consent' | 'dangerous-override'; bashRisk?: BashRiskClassification }

export function decideTuiToolApproval(opts: TuiApprovalInputs): TuiApprovalDecision {
  // Canonicalize so a wrong-case "Bash" still triggers the dangerous-command
  // detection and matches safe/persistent-allow lanes by canonical name.
  const toolName = canonicalToolName(opts.toolName)
  // Detect a dangerous bash-like command BEFORE the persistent allow check
  // so we can override that one specific lane. Other consent lanes are
  // explicit/fresh and stay in force.
  let bashRisk: BashRiskClassification | undefined
  if (toolName === 'bash' || toolName === 'TaskCreate') {
    const cmd = opts.input?.['command']
    if (typeof cmd === 'string' && cmd.length > 0) {
      bashRisk = classifyBashCommand(cmd)
    }
  }
  const dangerousCommand = bashRisk?.level === 'dangerous'

  if (opts.autoApprove) return { action: 'allow', reason: 'auto-approve' }
  if (opts.batchApproveAll) return { action: 'allow', reason: 'batch-all' }
  if (opts.safeTools.has(toolName)) return { action: 'allow', reason: 'safe-tool' }
  if (opts.perToolApprove.has(toolName) && !dangerousCommand) {
    return { action: 'allow', reason: 'persistent-allow' }
  }

  if (dangerousCommand && opts.perToolApprove.has(toolName)) {
    return { action: 'prompt', reason: 'dangerous-override', bashRisk }
  }
  return { action: 'prompt', reason: 'no-consent', ...(bashRisk ? { bashRisk } : {}) }
}
