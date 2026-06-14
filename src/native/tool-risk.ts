// src/native/tool-risk.ts
/**
 * Per-tool risk classification. Single source of truth for "what kind of
 * side effect does this tool produce." Consumed by the abandoned-grant
 * predicate (Slice 2).
 *
 * - `bash` and `TaskCreate(command)` delegate to `classifyBashCommand`
 *   from `bash-risk.ts` (Task S1-4).
 * - `Edit` / `Write` / `NotebookEdit` are path-aware (Task S1-5).
 * - All registered tools must have an explicit classification — see
 *   the exhaustive test in S1-7.
 *
 * Fail-safe: unknown tools default to `mutating` (require permission).
 */

import { isAbsolute, resolve as resolvePath, relative } from 'node:path'

import type { RiskClass } from './protocol/task-permission-types.js'
import { classifyBashCommand } from './bash-risk.js'
import { canonicalToolName } from './tool-defs.js'

const SAFE_TOOLS = new Set<string>([
  // Read-only fs / state-inspection
  'read', 'glob', 'grep',
  // Tool registry inspection
  'ToolSearch',
  // Task store reads
  'TaskGet', 'TaskList', 'TaskOutput',
  // MCP reads
  'ListMcpResources', 'ReadMcpResource',
  // Skill content (loaded, not executed)
  'Skill',
  // LSP queries are read-only in this registration
  'LSP',
  // Audit / preview / verify — all read-only against existing artifacts
  'DeliveryAudit', 'SkillRoutePreview', 'ArtifactVerify', 'ProbePlan',
  // Structured output is a return-shape negotiation, no side effect
  'StructuredOutput',
  // Sleep has no observable side effect (time pass only)
  'Sleep',
])

const INTERNAL_STATE_TOOLS = new Set<string>([
  // Task store mutations
  'TaskUpdate', 'TaskStop', 'TaskVerify',
  // Todo list mutation (session-only)
  'TodoWrite',
  // User-facing dialog (resolves to user reply, no fs effect)
  'AskUserQuestion',
  // Mode flips
  'EnterPlanMode', 'ExitPlanMode',
  // Session config mutation
  'Config',
  // Team coordination — internal state, no fs/network
  'TeamCreate', 'TeamDelete',
  // MCP auth tokens — local credential store
  'McpAuth',
  // Workspace lifecycle — directory management for OwlCoda's own run state
  'RunWorkspace',
  // Runtime harness snapshot — bounded repo scan plus OwlCoda run metadata
  'ProjectMap',
])

const FILE_TOOLS = new Set<string>(['edit', 'write', 'NotebookEdit'])

const EXTERNAL_EFFECT_TOOLS = new Set<string>([
  // Network egress
  'WebFetch', 'WebSearch',
  // Subagent spawn (independent side-effect surface)
  'Task',
  // Future-scheduled side effects
  'RemoteTrigger',
  // Git worktree creation/exit touches sibling directories outside cwd
  'EnterWorktree', 'ExitWorktree',
])

function isInsideCwd(absPath: string, cwd: string = process.cwd()): boolean {
  const resolved = isAbsolute(absPath) ? absPath : resolvePath(cwd, absPath)
  const rel = relative(cwd, resolved)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function pathArgFor(toolName: string, args: Record<string, unknown>): string | undefined {
  const candidate = toolName === 'NotebookEdit' ? args['notebook_path'] : args['file_path']
  return typeof candidate === 'string' ? candidate : undefined
}

function riskFromBashCommand(command: unknown): RiskClass {
  if (typeof command !== 'string' || command.trim() === '') return 'mutating'
  const classification = classifyBashCommand(command)
  // bash-risk levels → tool-risk:
  //   safe_readonly  → 'mutating' (bash is a risky surface even when this
  //                    invocation is read-only — permission is still required)
  //   needs_approval → 'mutating'
  //   dangerous      → 'destructive'
  //   unknown        → 'mutating' (fail-safe)
  return classification.level === 'dangerous' ? 'destructive' : 'mutating'
}

export function classifyToolRisk(
  rawToolName: string,
  args: Record<string, unknown>,
): RiskClass {
  // Canonicalize first: models intermittently emit the wrong case (e.g. "Bash").
  // Without this, "Bash" skips the bash/file/external branches and falls to the
  // `mutating` fail-safe — which `auto` mode auto-approves — so a wrong-case
  // `rm -rf` would bypass the destructive gate. See canonicalToolName.
  const toolName = canonicalToolName(rawToolName)
  if (SAFE_TOOLS.has(toolName)) return 'safe'
  if (INTERNAL_STATE_TOOLS.has(toolName)) return 'internal_state'

  if (toolName === 'bash') {
    return riskFromBashCommand(args['command'])
  }
  if (toolName === 'TaskCreate') {
    const cmd = args['command']
    if (typeof cmd !== 'string' || cmd.trim() === '') return 'internal_state'
    return riskFromBashCommand(cmd)
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = pathArgFor(toolName, args)
    if (path && !isInsideCwd(path)) return 'external_effect'
    return 'mutating'
  }

  if (EXTERNAL_EFFECT_TOOLS.has(toolName)) return 'external_effect'

  return 'mutating' // fail-safe
}
