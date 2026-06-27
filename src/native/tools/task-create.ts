/**
 * OwlCoda Native TaskCreate Tool
 *
 * Creates a new task in the session task list. With an optional
 * `command` and no structured `steps`, the task ALSO spawns a bash child
 * and tracks its lifecycle — but ONLY after the command clears the shared
 * bash risk classifier. With `steps`, command is stored as plan metadata
 * and classifier-gated, but step execution remains model/tool driven.
 *
 * Security model (the reason an earlier `command` implementation was
 * pulled): TaskCreate must NOT become a backdoor around the headless
 * approval policy or the TUI permission prompt. Three independent gates
 * therefore guard every command-bearing call:
 *
 *   1. Headless path  — `decideHeadlessApproval('TaskCreate', ...)` runs
 *      the same `classifyBashCommand` branch as `bash` (see
 *      `headless-approval.ts`). dangerous / unknown / needs_approval
 *      without --auto-approve never reaches `execute()`.
 *   2. TUI path       — `renderTaskCreatePermission` mirrors
 *      `renderBashPermission` so the user sees the same "⚠ rm -rf"
 *      verdict before approving.
 *   3. Direct execute — this function ALSO calls `classifyBashCommand`
 *      and refuses to spawn anything except `safe_readonly`. Even if a
 *      caller bypasses gates 1+2 (e.g. a bug in the conversation loop,
 *      or a future plugin entry point), we still fail closed here.
 *
 * Pure-todo mode (no `command`) preserves the 0.13.30 behaviour: in-memory
 * task created, no spawn, status='pending'. This keeps existing callers
 * that use TaskCreate as a TODO tracker unaffected.
 */

import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'
import type { TaskPathScope } from '../protocol/types.js'
import type { ProjectMapSnapshot, ProjectMapVerificationProfile } from '../protocol/project-map-types.js'
import {
  createTask,
  getTask,
  getTaskJob,
  spawnTaskCommand,
  getCurrentOrNextStep,
  type TaskStepAction,
  type TaskVerificationCheck,
  type TaskVerificationKind,
} from './task-store.js'
import { findUnsafeVerificationCommand } from './task-verification-policy.js'
import { classifyBashCommand, primaryBashRiskReason } from '../bash-risk.js'

/** Input shape for a single step when creating a structured task plan. */
export interface TaskCreateStepInput {
  id?: string
  title: string
  description: string
  action?: TaskStepAction
  expectedArtifacts?: TaskPathScope[]
  verification?: TaskVerificationCheck[]
  /** Project Map verification profile IDs to expand into TaskVerify checks. */
  projectMapVerificationProfileIds?: string[]
}

export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
  /**
   * Optional bash command to spawn for this task. When present the task
   * is gated by the bash risk classifier and runs as a background
   * subprocess; `TaskOutput` will surface stdout/stderr/exitCode once
   * the task reaches a terminal state.
   *
   * Without `command` the task is a pure TODO entry and matches the
   * pre-execution behaviour of TaskCreate.
   */
  command?: string
  /** Optional working directory for `command` (defaults to process.cwd()). */
  cwd?: string
  /** Optional total deadline for command-backed task execution in milliseconds. */
  deadlineMs?: number
  /**
   * Optional structured deliverables for this task plan.
   * Paths that should be produced by completing this task.
   */
  deliverables?: TaskPathScope[]
  /**
   * Optional structured execution steps (Task Execution Mode v1, Slice 1).
   * When provided, creates an executable task plan.
   * Must be a non-empty array; each step requires title and description.
   * Without steps, preserves backward-compatible pure-TODO behavior.
   */
  steps?: TaskCreateStepInput[]
}

export function createTaskCreateTool(): NativeToolDef<TaskCreateInput> {
  return {
    name: 'TaskCreate',
    description:
      'Track a task in the session task list. Without `command`, this is a ' +
      'TODO tracker — tasks record intent and status (pending, in_progress, ' +
      'completed, cancelled, blocked) but do NOT auto-execute. Status only ' +
      'advances when explicitly changed via TaskUpdate. ' +
      'When `command` is given, the task ALSO spawns a bash child running ' +
      'that command — but only if the command classifies as safe_readonly. ' +
      'needs_approval / dangerous / unknown commands are refused: use the ' +
      '`bash` tool for those so the operator can approve them explicitly. ' +
      'For parallel execution of independent work units, use the Agent ' +
      'tool. TaskCreate is appropriate for surfacing planned work to the ' +
      'user, tracking progress, and structuring multi-step reasoning. It is ' +
      'NOT a job scheduler.',
    maturity: 'beta' as const,

    async execute(input: TaskCreateInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const { subject, description, activeForm, metadata, command, cwd, deadlineMs, deliverables, steps } = input

      if (!subject || !description) {
        return {
          output: 'Both subject and description are required.',
          isError: true,
        }
      }

      // Validate steps if provided
      if (steps !== undefined) {
        if (!Array.isArray(steps) || steps.length === 0) {
          return {
            output: 'steps must be a non-empty array.',
            isError: true,
          }
        }
        for (const s of steps) {
          if (!s.title || !s.description) {
            return {
              output: `Each step must have a title and description. Missing in: "${s.title || '(no title)'}"`,
              isError: true,
            }
          }
        }
        // Check for duplicate step IDs
        const explicitIds = steps.filter(s => s.id).map(s => s.id as string)
        const idSet = new Set(explicitIds)
        if (idSet.size !== explicitIds.length) {
          return {
            output: 'Duplicate step IDs are not allowed. Each step id must be unique within the task.',
            isError: true,
          }
        }
      }

      const commandToRun = command === undefined || command === null || command === '' ? undefined : command
      const bashRisk = commandToRun === undefined ? undefined : classifyBashCommand(commandToRun)
      if (bashRisk !== undefined && bashRisk.level !== 'safe_readonly') {
        return refuseCommandByRisk(bashRisk)
      }

      // Steps mode — create structured executable plan. A supplied command
      // is stored as plan metadata, not spawned here. It is still
      // classifier-gated above so every command-bearing TaskCreate call
      // shares the same destructive-command boundary.
      if (steps !== undefined && steps.length > 0) {
        const projectMapVerification = expandProjectMapVerificationProfiles(steps, context?.projectMapSnapshot)
        if (!projectMapVerification.ok) {
          return {
            output: projectMapVerification.reason,
            isError: true,
          }
        }
        for (const step of projectMapVerification.steps) {
          const unsafeVerification = findUnsafeVerificationCommand(step.verification)
          if (unsafeVerification) {
            return {
              output: unsafeVerification.reason,
              isError: true,
            }
          }
        }
        const task = createTask({
          subject,
          description,
          activeForm,
          metadata,
          deliverables,
          steps: projectMapVerification.steps,
          command: commandToRun,
          cwd,
          conversationId: context?.conversationId,
          bashRisk,
        })
        const nextStep = getCurrentOrNextStep(task.id)
        const nextLabel = nextStep ? `\nNext step: ${nextStep.id} ${nextStep.title}` : ''
        const profileLine = projectMapVerification.appliedProfileIds.length > 0
          ? `\nProject Map verification profiles: ${projectMapVerification.appliedProfileIds.join(', ')}`
          : ''
        return {
          output:
            `Created executable task plan ${task.id}: "${task.subject}" with ${steps.length} step${steps.length === 1 ? '' : 's'}.${nextLabel}${profileLine}`,
          isError: false,
          metadata: {
            task: {
              id: task.id,
              subject: task.subject,
              stepCount: task.steps?.length ?? 0,
              currentStepId: task.currentStepId ?? null,
              projectMapVerificationProfileIds: projectMapVerification.appliedProfileIds,
            },
          },
        }
      }

      // Pure-todo mode: behave exactly like 0.13.30 when no steps.
      if (commandToRun === undefined) {
        const task = createTask({
          subject,
          description,
          activeForm,
          metadata,
          deliverables,
          conversationId: context?.conversationId,
        })
        return {
          output:
            `Created task ${task.id}: "${task.subject}" ` +
            `(tracker only — not running. Use Agent, bash, write, or edit to execute work.)`,
          isError: false,
          metadata: { task: { id: task.id, subject: task.subject, stepCount: 0, currentStepId: null } },
        }
      }

      const safeBashRisk = bashRisk!
      const task = createTask({
        subject,
        description,
        activeForm,
        metadata,
        command: commandToRun,
        cwd,
        deadlineMs,
        conversationId: context?.conversationId,
        bashRisk: safeBashRisk,
        deliverables,
      })

      spawnTaskCommand(task.id)
      const runningTask = getTask(task.id) ?? task

      return {
        output: `Created task ${task.id}: "${task.subject}" (running: ${commandToRun})`,
        isError: false,
        metadata: {
          task: { id: task.id, subject: task.subject, stepCount: 0, currentStepId: null },
          ...(runningTask.longTaskSnapshot ? { longTaskSnapshot: runningTask.longTaskSnapshot } : {}),
          ...(getTaskJob(runningTask.id) ? { job: getTaskJob(runningTask.id) } : {}),
          command: commandToRun,
          bashRisk: {
            level: safeBashRisk.level,
            reasons: safeBashRisk.reasons,
          },
        },
      }
    },
  }
}

type ProjectMapVerificationExpansion =
  | { ok: true; steps: TaskCreateStepInput[]; appliedProfileIds: string[] }
  | { ok: false; reason: string }

function expandProjectMapVerificationProfiles(
  steps: TaskCreateStepInput[],
  snapshot: ProjectMapSnapshot | undefined,
): ProjectMapVerificationExpansion {
  const allProfileIds = steps.flatMap((step) => step.projectMapVerificationProfileIds ?? [])
  if (allProfileIds.length === 0) {
    return { ok: true, steps, appliedProfileIds: [] }
  }

  if (!snapshot) {
    return {
      ok: false,
      reason: 'Project Map verification profile ids were provided, but no Project Map snapshot is available for this conversation.',
    }
  }

  const profileById = new Map(snapshot.verificationProfiles.map((profile) => [profile.id, profile]))
  const appliedProfileIds: string[] = []
  const resolvedSteps: TaskCreateStepInput[] = []
  for (const step of steps) {
    const profileIds = step.projectMapVerificationProfileIds ?? []
    if (profileIds.length === 0) {
      resolvedSteps.push(step)
      continue
    }

    const verification = [...(step.verification ?? [])]
    const usedCheckIds = new Set(verification.map((check) => check.id))
    for (const profileId of profileIds) {
      const profile = profileById.get(profileId)
      if (!profile) {
        return {
          ok: false,
          reason: `Unknown Project Map verification profile id "${profileId}".`,
        }
      }
      appliedProfileIds.push(profile.id)
      verification.push(...projectMapProfileCommandChecks(profile, usedCheckIds))
      verification.push(...projectMapProfileTaskVerifyChecks(profile, usedCheckIds))
    }

    resolvedSteps.push({
      ...step,
      verification,
    })
  }

  return {
    ok: true,
    steps: resolvedSteps,
    appliedProfileIds: [...new Set(appliedProfileIds)],
  }
}

function projectMapProfileCommandChecks(
  profile: ProjectMapVerificationProfile,
  usedCheckIds: Set<string>,
): TaskVerificationCheck[] {
  return profile.commands
    .map((command) => command.trim())
    .filter((command) => command.length > 0)
    .map((command, index) => {
      const baseId = `project-map-${slugifyCheckId(profile.id)}-${index + 1}`
      const id = uniqueCheckId(baseId, usedCheckIds)
      return {
        id,
        kind: 'command',
        command,
        expectedExitCode: 0,
        reason: `Project Map verification profile ${profile.id}`,
      } satisfies TaskVerificationCheck
    })
}

function projectMapProfileTaskVerifyChecks(
  profile: ProjectMapVerificationProfile,
  usedCheckIds: Set<string>,
): TaskVerificationCheck[] {
  return profile.taskVerifyChecks.flatMap((rawCheck, index) => {
    if (!isRecord(rawCheck)) return []
    const kind = rawCheck['kind']
    if (!isTaskVerificationKind(kind)) return []
    const rawId = typeof rawCheck['id'] === 'string' && rawCheck['id'].trim()
      ? rawCheck['id'].trim()
      : `project-map-${slugifyCheckId(profile.id)}-${slugifyCheckId(kind)}-${index + 1}`
    const id = uniqueCheckId(rawId, usedCheckIds)
    const reason = typeof rawCheck['reason'] === 'string' && rawCheck['reason'].trim()
      ? rawCheck['reason'].trim()
      : `Project Map verification profile ${profile.id}`
    return [{
      ...rawCheck,
      id,
      kind,
      reason,
    } as TaskVerificationCheck]
  })
}

function uniqueCheckId(baseId: string, usedCheckIds: Set<string>): string {
  let id = baseId
  let suffix = 2
  while (usedCheckIds.has(id)) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }
  usedCheckIds.add(id)
  return id
}

function slugifyCheckId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'
}

const TASK_VERIFICATION_KINDS = new Set<TaskVerificationKind>([
  'file_exists',
  'file_contains',
  'artifact_count',
  'verification_pack',
  'run_verdict_gate',
  'http_get',
  'command',
  'none',
])

function isTaskVerificationKind(value: unknown): value is TaskVerificationKind {
  return typeof value === 'string' && TASK_VERIFICATION_KINDS.has(value as TaskVerificationKind)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuseCommandByRisk(bashRisk: ReturnType<typeof classifyBashCommand>): ToolResult {
  const reason = primaryBashRiskReason(bashRisk)
  return {
    output:
      `TaskCreate refused by risk classifier: ${bashRisk.level} ` +
      `(${reason}). Use the bash tool for this command so the ` +
      `operator can approve it explicitly.`,
    isError: true,
    metadata: {
      refused: true,
      bashRisk: {
        level: bashRisk.level,
        reasons: bashRisk.reasons,
        command: bashRisk.command,
      },
    },
  }
}
