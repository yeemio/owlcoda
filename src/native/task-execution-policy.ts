/**
 * OwlCoda Task Execution Policy — Slice 4, Task Execution Mode v1
 *
 * Builds conversation-loop nudges for structured task plans.
 *
 * Five nudge kinds:
 *   create_plan        — task looks like it needs a structured plan but none was created
 *   continue_step      — a step is in_progress but no recent progress has been made
 *   verify_step        — a step completed without running TaskVerify
 *   completion_blocked — model claims completion but open required steps remain
 *   edit_now           — granted risky tool has no post-grant evidence yet
 *
 * Rate limit: max MAX_NUDGES_PER_KIND injections per (taskId, kind) pair per
 * conversation run — tracked in a caller-owned NudgeCounter.
 *
 * Suppression:
 *   - read_only_review / text_deliverable deliverables do NOT get create_plan
 *   - user text matching SUPPRESS_PLAN_RE suppresses create_plan
 *   - completion_blocked only fires when detectCompletionClaim() is true
 */

import {
  findNextStep,
  taskHasOpenRequiredSteps,
  getTask,
  type NextStepResult,
} from './tools/task-store.js'
import { detectCompletionClaim } from './task-state.js'
import type { DeliverableContractClassification } from './deliverable-contract.js'
import { RISK_REQUIRES_DURABLE } from './abandoned-grant-predicate.js'
import { isGateV2Enabled } from './gate-v2-flag.js'
import type { DerivedTurnPhase, EditNowNudge, ProposedToolCall } from './protocol/task-permission-types.js'
import type { ProjectMapVerificationProfile } from './protocol/project-map-types.js'
import type { OperatingMode } from './modes.js'

// Max nudges of a given kind per task per conversation run.
export const MAX_NUDGES_PER_KIND = 2

export type NudgeKind = 'create_plan' | 'continue_step' | 'verify_step' | 'completion_blocked' | 'edit_now'

/** Opaque per-conversation counter for nudge rate-limiting. */
export type NudgeCounter = Map<string, number>

export function createNudgeCounter(): NudgeCounter {
  return new Map()
}

function nudgeKey(taskId: string, kind: NudgeKind): string {
  return `${taskId}:${kind}`
}

function nudgeCount(counter: NudgeCounter, taskId: string, kind: NudgeKind): number {
  return counter.get(nudgeKey(taskId, kind)) ?? 0
}

function incrementNudge(counter: NudgeCounter, taskId: string, kind: NudgeKind): void {
  const key = nudgeKey(taskId, kind)
  counter.set(key, (counter.get(key) ?? 0) + 1)
}

export function isNudgeExhausted(counter: NudgeCounter, taskId: string, kind: NudgeKind): boolean {
  return nudgeCount(counter, taskId, kind) >= MAX_NUDGES_PER_KIND
}

// Phrases that signal the user wants analysis/discussion only, not a structured plan.
const SUPPRESS_PLAN_RE =
  /^(?:停|先不做|只分析|只看|只读|只研究|看看就好|不用做|先别做|只是问问|wait|hold\s+on|just\s+(?:analyze|check|look|review|read)|analysis\s+only|no\s+(?:plan|impl|code|change|build))\s*[.!。！]*$/i
// Assistant-side phrases that mean the model has intentionally paused for a
// user decision. These should not be interpreted as "no progress"; injecting a
// create_plan/continue_step nudge here just drags a healthy proposal turn back
// into execution.
const AWAITING_USER_DECISION_RE =
  /(?:等(?:你|你的|您|您的)(?:判断|决定|选择|确认|拍板|裁定|反馈)|等你拍板|(?:由|让)你(?:来)?(?:判断|决定|选择|确认|拍板|裁定)|你(?:来)?(?:选|决定|判断|拍板|裁定)|认、调、还是换|是否(?:继续|采用|调整|按这个方向)|要不要(?:继续|改|换)|which\s+(?:option|direction)|choose\s+(?:one|a direction)|please\s+confirm|waiting\s+for\s+(?:your|the user's)\s+(?:decision|confirmation|call|choice|feedback)|need\s+your\s+(?:decision|confirmation|call|choice|feedback))/i
const MISSING_TASK_PLAN_ID = '__create_task__'

/** Result from buildTaskExecutionNudge — null when no nudge should fire. */
export interface TaskNudgeResult {
  kind: NudgeKind
  taskId: string
  text: string
}

export interface NudgeContext {
  /**
   * The latest assistant message text from this turn.
   */
  assistantText: string

  /**
   * The latest substantive user text (used for create_plan suppression).
   * Can be null if no user message was found.
   */
  latestUserText: string | null

  /**
   * Deliverable contract for the current task (used for create_plan suppression).
   * Pass null if no contract is available.
   */
  deliverable: DeliverableContractClassification | null

  /**
   * The per-conversation nudge counter — caller maintains this across turns.
   */
  counter: NudgeCounter

  /**
   * The current active task ID. When provided, limits search to that task.
   */
  activeTaskId?: string | null

  /**
   * GATE_V2: proposed tool calls recorded for the current active task.
   * Used to suppress create_plan nudges when the assistant has not proposed
   * any risky action that would need durable evidence.
   */
  proposedToolCalls?: ProposedToolCall[]

  /**
   * PHASE_RUNTIME: derived phase for the current turn. When enabled, generic
   * plan/continue pressure should not interrupt verification/report/final
   * phases that already have evidence.
   */
  phaseVerdict?: DerivedTurnPhase

  /**
   * True only while the internal phase-aware runtime flag is enabled.
   */
  phaseRuntimeEnabled?: boolean

  /**
   * Project Map / Runtime Harness Slice E: verification profiles derived from
   * bounded project evidence. These improve nudges only; commands are not
   * executed automatically.
   */
  projectMapVerificationProfiles?: ProjectMapVerificationProfile[]

  /**
   * Explicit conversation operating mode. Plan mode is discussion-only, so
   * runtime task-step nudges must not turn it into execution pressure.
   */
  operatingMode?: OperatingMode
}

/**
 * Evaluate whether a task-step nudge should be injected this turn.
 *
 * Returns null when:
 *   - No open task with steps exists
 *   - The appropriate nudge kind has been exhausted
 *   - The nudge condition is not met
 *
 * When a nudge is returned, the caller MUST call `consumeNudge()` to record the
 * injection before appending the message; otherwise the rate limit won't fire.
 */
export function buildTaskExecutionNudge(ctx: NudgeContext): TaskNudgeResult | null {
  const nextStepResult = findNextStep(ctx.activeTaskId ?? undefined)
  const shortCircuitCreatePlan =
    isGateV2Enabled() && noRiskyProposalsThisTurn(ctx.proposedToolCalls)
  const inPlanMode = ctx.operatingMode === 'plan'
  const awaitingUserDecision = assistantAwaitsUserDecision(ctx.assistantText)
  const suppressGenericPressure =
    inPlanMode || phaseSuppressesGenericTaskStepPressure(ctx) || awaitingUserDecision
  const suppressVerificationPressure = inPlanMode || awaitingUserDecision

  if (!nextStepResult.hasNext) {
    if (
      ctx.deliverable?.shouldCreateTaskPlan
      && !shouldSuppressCreatePlan(ctx)
      && !isNudgeExhausted(ctx.counter, MISSING_TASK_PLAN_ID, 'create_plan')
      && !shortCircuitCreatePlan
      && !suppressGenericPressure
    ) {
      return {
        kind: 'create_plan',
        taskId: MISSING_TASK_PLAN_ID,
        text: buildMissingCreatePlanPrompt(ctx.deliverable.mode, projectMapVerificationCommands(ctx)),
      }
    }
    return null
  }

  const taskId = nextStepResult.taskId
  const task = getTask(taskId)
  if (!task) return null

  // --- completion_blocked: model claims done but open steps remain ---
  // Check this first so it overrides any "continue" nudge on the same turn.
  if (detectCompletionClaim(ctx.assistantText)) {
    if (!isNudgeExhausted(ctx.counter, taskId, 'completion_blocked')) {
      const next = nextStepResult.nextStep!
      return {
        kind: 'completion_blocked',
        taskId,
        text: buildCompletionBlockedPrompt(task.subject, next.id, next.title),
      }
    }
  }

  const step = nextStepResult.nextStep!

  // --- verify_step: step is in_progress and has verification checks but none run ---
  if (
    step.status === 'in_progress'
    && step.verification
    && step.verification.length > 0
    && step.verificationResults.length === 0
  ) {
    if (suppressVerificationPressure) return null
    if (!isNudgeExhausted(ctx.counter, taskId, 'verify_step')) {
      return {
        kind: 'verify_step',
        taskId,
        text: buildVerifyStepPrompt(
          taskId,
          step.id,
          step.title,
          step.verification.length,
          projectMapVerificationCommands(ctx),
        ),
      }
    }
  }

  // --- continue_step: step is in_progress, model didn't make progress ---
  if (step.status === 'in_progress') {
    if (suppressGenericPressure) return null
    if (!isNudgeExhausted(ctx.counter, taskId, 'continue_step')) {
      return {
        kind: 'continue_step',
        taskId,
        text: buildContinueStepPrompt(taskId, task.subject, step.id, step.title, step.description),
      }
    }
  }

  // --- create_plan: task has pending first step (not yet started), no steps in_progress ---
  if (step.status === 'pending') {
    if (shouldSuppressCreatePlan(ctx)) {
      return null
    }
    if (shortCircuitCreatePlan) return null
    if (suppressGenericPressure) return null
    if (!isNudgeExhausted(ctx.counter, taskId, 'create_plan')) {
      return {
        kind: 'create_plan',
        taskId,
        text: buildCreatePlanPrompt(taskId, task.subject, step.id, step.title),
      }
    }
  }

  return null
}

/**
 * Record that a nudge was consumed. Must be called after the caller
 * appends the nudge text to the conversation.
 */
export function consumeNudge(counter: NudgeCounter, taskId: string, kind: NudgeKind): void {
  incrementNudge(counter, taskId, kind)
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function shouldSuppressCreatePlan(ctx: NudgeContext): boolean {
  if (ctx.deliverable) {
    const mode = ctx.deliverable.mode
    if (mode === 'read_only_review' || mode === 'text_deliverable') {
      return true
    }
  }
  return Boolean(ctx.latestUserText && SUPPRESS_PLAN_RE.test(ctx.latestUserText.trim()))
}

function noRiskyProposalsThisTurn(calls: ProposedToolCall[] | undefined): boolean {
  if (!calls || calls.length === 0) return true
  return !calls.some((tc) => RISK_REQUIRES_DURABLE.includes(tc.riskClass))
}

function assistantAwaitsUserDecision(text: string): boolean {
  return AWAITING_USER_DECISION_RE.test(text)
}

function phaseSuppressesGenericTaskStepPressure(ctx: NudgeContext): boolean {
  if (!ctx.phaseRuntimeEnabled || !ctx.phaseVerdict) return false
  if (ctx.phaseVerdict.evidenceCount <= 0) return false
  return ctx.phaseVerdict.phase === 'verify'
    || ctx.phaseVerdict.phase === 'report'
    || ctx.phaseVerdict.phase === 'final'
}

function buildMissingCreatePlanPrompt(mode: string, projectMapCommands: string[] = []): string {
  const lines = [
    '[Runtime task-step]',
    `This ${mode} task needs a structured execution plan before more broad investigation.`,
    'Call TaskCreate with concrete steps and verification checks for the required artifact(s).',
    'Then begin the first step with TaskUpdate(stepStatus="in_progress").',
    'After writing files, use TaskVerify; a passing verification atomically completes the step.',
  ]
  appendProjectMapVerificationLine(lines, projectMapCommands)
  return lines.join('\n')
}

function buildCreatePlanPrompt(taskId: string, subject: string, stepId: string, stepTitle: string): string {
  return [
    '[Runtime task-step]',
    `Task ${taskId} "${subject}" has a structured execution plan.`,
    `Next step: ${stepId} — ${stepTitle}`,
    'Begin the step now. Call TaskUpdate(stepId, stepStatus="in_progress") first, then execute.',
    'Use TaskVerify after writing files; passing checks atomically complete the step.',
  ].join('\n')
}

function buildContinueStepPrompt(
  taskId: string,
  subject: string,
  stepId: string,
  stepTitle: string,
  stepDescription: string,
): string {
  return [
    '[Runtime task-step]',
    `Task ${taskId} "${subject}" step ${stepId} "${stepTitle}" is still in_progress.`,
    `Step goal: ${stepDescription}`,
    'Your last response did not advance this step. Your next response MUST either:',
    '  (a) make a tool call that materially advances the step, OR',
    '  (b) state a concrete blocker and call TaskUpdate(stepStatus="blocked", failureReason="…").',
    'Do NOT produce another planning summary.',
  ].join('\n')
}

function buildVerifyStepPrompt(
  taskId: string,
  stepId: string,
  stepTitle: string,
  checkCount: number,
  projectMapCommands: string[] = [],
): string {
  const lines = [
    '[Runtime task-step]',
    `Task ${taskId} step ${stepId} "${stepTitle}" has ${checkCount} verification check${checkCount === 1 ? '' : 's'} defined but none have been run.`,
    `Call TaskVerify(taskId="${taskId}", stepId="${stepId}"); passing checks atomically complete the step.`,
    'Failed checks keep the step open and must be repaired before re-verification.',
  ]
  appendProjectMapVerificationLine(lines, projectMapCommands)
  return lines.join('\n')
}

function projectMapVerificationCommands(ctx: NudgeContext): string[] {
  const profiles = ctx.projectMapVerificationProfiles ?? []
  const commands = profiles
    .filter((profile) => profile.requiredBeforeDone)
    .flatMap((profile) => profile.commands)
    .filter((command) => command.trim().length > 0)
  return [...new Set(commands)].slice(0, 6)
}

function appendProjectMapVerificationLine(lines: string[], commands: string[]): void {
  if (commands.length === 0) return
  lines.push(
    `Project Map verification: include ${commands.join('; ')} in the TaskVerify plan when relevant; do not auto-run commands unless the task step calls for it.`,
  )
}

function buildCompletionBlockedPrompt(
  subject: string,
  nextStepId: string,
  nextStepTitle: string,
): string {
  return [
    '[Runtime task-step]',
    `You claimed completion but task "${subject}" still has open required steps.`,
    `Next open step: ${nextStepId} — ${nextStepTitle}`,
    'Do NOT declare the task done until all required steps are completed.',
    'Call TaskUpdate or TaskVerify to advance the remaining steps, then conclude.',
  ].join('\n')
}

/**
 * Check whether a task's required steps are all satisfied.
 * Returns true only when every required step is completed.
 * (Convenience wrapper over the store's taskHasOpenRequiredSteps.)
 */
export function allRequiredStepsDone(taskId: string): boolean {
  const task = getTask(taskId)
  if (!task) return true // unknown task → don't block
  return !taskHasOpenRequiredSteps(task)
}

export function buildEditNowNudgePrompt(nudge: EditNowNudge): string {
  return [
    '[Runtime edit_now]',
    `You were granted permission to call ${nudge.tool} at iteration ${nudge.grantIteration}.`,
    `You have run ${nudge.itersSinceGrant} iterations since that grant with no file changes or artifacts produced.`,
    'Call the tool now and produce the change, or explain in the next message why you cannot so the user can intervene.',
  ].join('\n')
}
