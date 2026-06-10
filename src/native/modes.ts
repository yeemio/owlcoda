/**
 * Explicit operating modes. The gate is default-on; set OWLCODA_MODES=0 to
 * disable it as an escape hatch.
 * See docs/superpowers/specs/2026-05-30-owlcoda-permission-modes-design.md.
 */

import { classifyBashCommand } from './bash-risk.js'
import { classifyPowerShellCommand } from './powershell-risk.js'
import type { RiskClass } from './protocol/task-permission-types.js'

export type OperatingMode = 'plan' | 'normal' | 'auto'

export interface OperatingModeState {
  mode: OperatingMode
}

interface OperatingModeContainer {
  options?: {
    operatingModeState?: OperatingModeState
  }
}

const OPERATING_MODES: OperatingMode[] = ['plan', 'normal', 'auto']
const FALSY = new Set(['0', 'false', 'no', 'off', ''])

/** Default-on after cutover; explicit falsy values disable the mode surface. */
export function isModesEnabled(): boolean {
  const raw = process.env['OWLCODA_MODES']
  if (typeof raw !== 'string') return true
  return !FALSY.has(raw.trim().toLowerCase())
}

export function parseOperatingMode(raw: unknown): OperatingMode | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return (OPERATING_MODES as string[]).includes(value) ? value as OperatingMode : null
}

export function resolveInitialMode(input: {
  flagMode?: unknown
  settingsMode?: unknown
}): OperatingMode {
  return parseOperatingMode(input.flagMode)
    ?? parseOperatingMode(input.settingsMode)
    ?? 'normal'
}

export function ensureOperatingModeState(
  target: OperatingModeContainer,
  initialMode: OperatingMode = 'normal',
): OperatingModeState {
  if (!target.options) target.options = {}
  if (!target.options.operatingModeState) {
    target.options.operatingModeState = { mode: initialMode }
  }
  return target.options.operatingModeState
}

export function initializeOperatingModeState(
  target: OperatingModeContainer,
  initialMode: OperatingMode = 'normal',
): void {
  if (!isModesEnabled()) return
  ensureOperatingModeState(target, initialMode).mode = initialMode
}

/** Tools that always write to disk regardless of input. */
const ALWAYS_MUTATING_TOOLS = new Set(['write', 'edit', 'NotebookEdit'])
/** Tools whose `command` input is bash-classified for mutation. */
const BASH_COMMAND_TOOLS = new Set(['bash', 'TaskCreate'])

export interface ModeGateViolation {
  mode: OperatingMode
  toolName: string
  reason: string
}

function toolMutates(toolName: string, toolInput?: Record<string, unknown>): boolean {
  if (ALWAYS_MUTATING_TOOLS.has(toolName)) return true
  const cmd = toolInput?.['command']
  if (BASH_COMMAND_TOOLS.has(toolName)) {
    return typeof cmd === 'string' && cmd.length > 0
      ? classifyBashCommand(cmd).mutatesFilesystem
      : false
  }
  if (toolName === 'PowerShell') {
    // No command ⇒ fail-closed (treat as mutating) in plan mode.
    return typeof cmd === 'string' && cmd.length > 0
      ? classifyPowerShellCommand(cmd).mutatesFilesystem
      : true
  }
  return false
}

/**
 * Hard gate for explicit operating modes. ONLY `plan` blocks, and only
 * mutating calls. `normal`/`auto` never block here — the downstream gates
 * (provenance, write-scope, permission lifecycle) still run, so this is
 * additive, never a bypass. Pure function.
 */
export function evaluateModeGate(
  mode: OperatingMode,
  toolName: string,
  toolInput?: Record<string, unknown>,
): ModeGateViolation | null {
  if (mode !== 'plan') return null
  if (!toolMutates(toolName, toolInput)) return null
  return {
    mode,
    toolName,
    reason:
      `Refusing ${toolName}: read-only plan mode is active. ` +
      `Switch with /mode normal (or /mode auto) to allow edits.`,
  }
}

/** Risk tiers that `auto` mode silently grants: session state + in-cwd edits
 *  (incl. non-dangerous bash). destructive / external_effect still prompt;
 *  safe never prompts (it has no approval gate). */
const AUTO_APPROVE_RISK = new Set<RiskClass>(['internal_state', 'mutating'])

/**
 * Whether the operating mode should auto-grant an interactive approval prompt.
 * Only `auto` auto-approves, and only the low-risk tiers above. Pure: the four
 * upstream hard gates (mode / intent / provenance-deny / write-scope) have all
 * already run when this is consulted, so `auto` can never bypass deny,
 * provenance, write-scope, or headless policy — it only removes the prompt.
 */
export function evaluateAutoApproval(mode: OperatingMode, riskClass: RiskClass): boolean {
  return mode === 'auto' && AUTO_APPROVE_RISK.has(riskClass)
}
