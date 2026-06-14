/**
 * Explicit operating modes. The gate is default-on; set OWLCODA_MODES=0 to
 * disable it as an escape hatch.
 * See docs/superpowers/specs/2026-05-30-owlcoda-permission-modes-design.md.
 */

import { classifyBashCommand } from './bash-risk.js'
import { classifyPowerShellCommand } from './powershell-risk.js'
import type { RiskClass } from './protocol/task-permission-types.js'
import { canonicalToolName } from './tool-defs.js'

export type OperatingMode = 'plan' | 'normal' | 'auto' | 'yolo'

export interface OperatingModeState {
  mode: OperatingMode
}

interface OperatingModeContainer {
  options?: {
    operatingModeState?: OperatingModeState
  }
}

/** The complete mode set, in cycle/menu order. Exported so user-facing copy
 *  (the /mode help line, the invalid-mode error) derives from one source and
 *  can't drop a mode — yolo was missing from those strings while being a fully
 *  valid mode. parseOperatingMode validates against this same list. */
export const OPERATING_MODES: OperatingMode[] = ['plan', 'normal', 'auto', 'yolo']

/**
 * What each operating mode actually DOES — the single source of truth for every
 * surface that explains the modes (the `/mode` command output, help, the picker
 * hint). Full sentences for the command output. Keep in sync with the gate
 * behaviour in evaluateModeGate / evaluateAutoApproval below.
 */
export const MODE_EFFECTS: Record<OperatingMode, string> = {
  plan: 'Read-only: write/edit and mutating bash are refused until you switch back.',
  normal: 'Default gates: mutating tools prompt for approval.',
  auto: 'Low-risk edits and session state auto-approved; destructive/external actions still prompt.',
  yolo: 'Full access: every tool auto-approved, including destructive/external. Hard denies (provenance/write-scope) still apply.',
}

/** Two-or-three-word gloss of each mode, for compact one-line contexts. */
export const MODE_SUMMARIES: Record<OperatingMode, string> = {
  plan: 'read-only',
  normal: 'confirm changes',
  auto: 'auto low-risk',
  yolo: 'auto everything',
}

const FALSY = new Set(['0', 'false', 'no', 'off', ''])

/** "Enable" forms for the supervised-run env escape hatch (OWLCODA_AUTO_APPROVE). */
const AUTO_APPROVE_ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on', 'yolo'])

/**
 * Resolve the initial `autoApprove` mirror for a fresh REPL session. Two
 * independent enable sources, OR'd:
 *   - an explicit `--mode yolo` start — the operating mode is the source of
 *     truth, and yolo means "auto-approve everything", so the mirror must agree
 *     (same invariant setOperatingModeSynced enforces at runtime); and
 *   - the supervised-run env escape hatch OWLCODA_AUTO_APPROVE (1/true/yes/on/yolo).
 *
 * Keeping both here means startup can't desync the mode and its mirror the way
 * `/mode`/`/plan` did before the convergence fix — starting in yolo with the
 * mirror left false made yolo dead until the user re-toggled it.
 */
export function resolveInitialAutoApprove(
  initialMode: OperatingMode | undefined,
  autoApproveEnv: string | undefined,
): boolean {
  if (initialMode === 'yolo') return true
  return AUTO_APPROVE_ENV_TRUTHY.has((autoApproveEnv ?? '').trim().toLowerCase())
}

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

/** Shift+Tab cycle. `yolo` (full access) is deliberately NOT in the casual
 *  cycle — it must be entered explicitly via /yolo or /mode yolo — so cycling
 *  out of yolo lands on normal. */
const MODE_CYCLE: OperatingMode[] = ['normal', 'auto', 'plan']
export function cycleOperatingMode(current: OperatingMode): OperatingMode {
  const i = MODE_CYCLE.indexOf(current)
  if (i === -1) return 'normal'
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!
}

/**
 * Decide whether a keypress is the Shift+Tab mode-cycle and, if so, what the
 * next mode is. Returns null for any other key (so the caller leaves it for the
 * composer). Pure, so the ink-repl wiring has a unit-test seam — the only part
 * that needs a real terminal is whether the terminal emits backtab at all, and
 * parse-keypress already maps "\x1b[Z" → { tab: true, shift: true }.
 */
export function resolveModeCycleKey(
  key: { tab?: boolean; shift?: boolean },
  current: OperatingMode,
): OperatingMode | null {
  if (!(key.tab && key.shift)) return null
  return cycleOperatingMode(current)
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

function toolMutates(rawToolName: string, toolInput?: Record<string, unknown>): boolean {
  // Canonicalize: a wrong-case "Bash" must still be recognized as mutating so
  // read-only plan mode actually refuses it (P2-12 safety sibling).
  const toolName = canonicalToolName(rawToolName)
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
 * `auto` auto-approves only the low-risk tiers above; `yolo` (full access)
 * auto-approves every tier. Pure: the four upstream hard gates (mode / intent /
 * provenance-deny / write-scope) have all already run when this is consulted, so
 * neither `auto` nor `yolo` can bypass deny, provenance, write-scope, or
 * headless policy — they only remove the prompt.
 */
export function evaluateAutoApproval(mode: OperatingMode, riskClass: RiskClass): boolean {
  if (mode === 'yolo') return true
  return mode === 'auto' && AUTO_APPROVE_RISK.has(riskClass)
}
