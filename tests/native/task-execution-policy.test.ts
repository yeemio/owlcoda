/**
 * Task Execution Policy tests — Slice 4, Task Execution Mode v1
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildTaskExecutionNudge,
  consumeNudge,
  createNudgeCounter,
  isNudgeExhausted,
  MAX_NUDGES_PER_KIND,
  allRequiredStepsDone,
  type NudgeContext,
} from '../../src/native/task-execution-policy.js'
import {
  resetTaskStore,
  createTask,
  updateTaskStep,
} from '../../src/native/tools/task-store.js'
import type { DeliverableContractClassification } from '../../src/native/deliverable-contract.js'
import type { DerivedTurnPhase, ProposedToolCall } from '../../src/native/protocol/task-permission-types.js'
import type { ProjectMapVerificationProfile } from '../../src/native/protocol/project-map-types.js'

function makeDeliverable(mode: DeliverableContractClassification['mode']): DeliverableContractClassification {
  return {
    mode,
    confidence: 'high',
    requiresDurableArtifact: mode === 'code_change' || mode === 'file_artifact_delivery',
    allowsChatFinal: mode === 'text_deliverable' || mode === 'read_only_review' || mode === 'mixed_unknown',
    shouldCreateTaskPlan: mode === 'code_change' || mode === 'file_artifact_delivery' || mode === 'command_job',
    hardStopOnNoTouchedPaths: mode === 'code_change',
    reasons: [],
    matchedModes: [mode],
    signalSummary: {
      codeChange: [],
      fileArtifact: [],
      commandJob: [],
      textDeliverable: [],
      readOnlyReview: [],
      pathLike: [],
      explicitArtifactVerb: [],
      artifactTypeOnly: [],
    },
  }
}

// A minimal deliverable classification for code_change (should allow create_plan)
function codeChangeDeliverable(): DeliverableContractClassification {
  return makeDeliverable('code_change')
}

// A read_only_review deliverable (should suppress create_plan)
function readOnlyDeliverable(): DeliverableContractClassification {
  return makeDeliverable('read_only_review')
}

// A text_deliverable classification
function textDeliverable(): DeliverableContractClassification {
  return makeDeliverable('text_deliverable')
}

function makeCtx(overrides: Partial<NudgeContext> = {}): NudgeContext {
  return {
    assistantText: 'Working on the task.',
    latestUserText: null,
    deliverable: codeChangeDeliverable(),
    counter: createNudgeCounter(),
    activeTaskId: null,
    proposedToolCalls: [riskyProposal()],
    ...overrides,
  }
}

function phaseVerdict(
  phase: DerivedTurnPhase['phase'],
  overrides: Partial<DerivedTurnPhase> = {},
): DerivedTurnPhase {
  return {
    phase,
    confidence: 'high',
    reasonCodes: ['recent_verification_evidence'],
    evidenceCount: 1,
    pendingRiskyGrantCount: 0,
    ...overrides,
  }
}

function riskyProposal(): ProposedToolCall {
  return {
    tool: 'edit',
    riskClass: 'mutating',
    permissionState: 'needed',
    proposedAtIter: 1,
    postGrantEvidence: [],
  }
}

function makeTaskWithStep() {
  return createTask({
    subject: 'Build widget',
    description: 'for testing',
    steps: [
      { title: 'Write code', description: 'implement it' },
    ],
  })
}

function makeTaskWithVerificationStep() {
  return createTask({
    subject: 'Verified widget',
    description: 'for testing',
    steps: [
      {
        title: 'Write code',
        description: 'implement it',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/output.html' }],
      },
    ],
  })
}

function projectMapVerificationProfiles(): ProjectMapVerificationProfile[] {
  return [{
    id: 'npm-test',
    appliesTo: 'code_change',
    commands: ['npm test', 'npm run typecheck'],
    taskVerifyChecks: [],
    artifactPacks: [],
    requiredBeforeDone: true,
  }]
}

beforeEach(() => {
  resetTaskStore()
})

describe('createNudgeCounter / isNudgeExhausted / consumeNudge', () => {
  it('starts empty — no kind is exhausted', () => {
    const c = createNudgeCounter()
    expect(isNudgeExhausted(c, 'task-1', 'create_plan')).toBe(false)
  })

  it('becomes exhausted after MAX_NUDGES_PER_KIND consumes', () => {
    const c = createNudgeCounter()
    for (let i = 0; i < MAX_NUDGES_PER_KIND; i++) {
      consumeNudge(c, 'task-1', 'create_plan')
    }
    expect(isNudgeExhausted(c, 'task-1', 'create_plan')).toBe(true)
  })

  it('counters are independent per (taskId, kind)', () => {
    const c = createNudgeCounter()
    consumeNudge(c, 'task-1', 'create_plan')
    expect(isNudgeExhausted(c, 'task-1', 'continue_step')).toBe(false)
    expect(isNudgeExhausted(c, 'task-2', 'create_plan')).toBe(false)
  })
})

describe('buildTaskExecutionNudge — no tasks', () => {
  it('asks durable artifact tasks to create a structured TaskCreate plan when task store is empty', () => {
    const result = buildTaskExecutionNudge(makeCtx())
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('create_plan')
    expect(result!.taskId).toBe('__create_task__')
    expect(result!.text).toContain('Call TaskCreate')
    expect(result!.text).toContain('TaskVerify')
  })

  it('includes Project Map verification commands in missing-plan nudges when provided', () => {
    const result = buildTaskExecutionNudge(makeCtx({
      projectMapVerificationProfiles: projectMapVerificationProfiles(),
    }))

    expect(result).not.toBeNull()
    expect(result!.text).toContain('Project Map verification')
    expect(result!.text).toContain('npm test')
    expect(result!.text).toContain('npm run typecheck')
  })

  it.each([
    ['read_only_review', readOnlyDeliverable()],
    ['text_deliverable', textDeliverable()],
  ])('returns null for %s when task store is empty', (_name, deliverable) => {
    const result = buildTaskExecutionNudge(makeCtx({ deliverable }))
    expect(result).toBeNull()
  })

  it('suppresses missing-plan nudge when the user asked for analysis only', () => {
    const result = buildTaskExecutionNudge(makeCtx({ latestUserText: 'just analyze' }))
    expect(result).toBeNull()
  })

  it('suppresses missing-plan nudge during phase-runtime verification with evidence', () => {
    const result = buildTaskExecutionNudge(makeCtx({
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('verify'),
    }))
    expect(result).toBeNull()
  })

  it('suppresses missing-plan nudge when assistant is waiting for user judgment', () => {
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: '前一条是我的第13章开法建议。等你的判断：认、调、还是换一个切入方向。',
    }))
    expect(result).toBeNull()
  })

  it('suppresses missing-plan nudge in plan mode', () => {
    const result = buildTaskExecutionNudge(makeCtx({ operatingMode: 'plan' }))
    expect(result).toBeNull()
  })
})

describe('buildTaskExecutionNudge — create_plan', () => {
  it('fires create_plan for a pending first step', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx())
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('create_plan')
    expect(result!.taskId).toBe('task-1')
    expect(result!.text).toContain('[Runtime task-step]')
    expect(result!.text).toContain('step-1')
  })

  it('suppressed for read_only_review deliverable', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ deliverable: readOnlyDeliverable() }))
    expect(result).toBeNull()
  })

  it('suppressed for text_deliverable', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ deliverable: textDeliverable() }))
    expect(result).toBeNull()
  })

  it('suppressed when user said 停', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ latestUserText: '停' }))
    expect(result).toBeNull()
  })

  it('suppressed when user said only analyze', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ latestUserText: 'just analyze' }))
    expect(result).toBeNull()
  })

  it('not suppressed for normal user text', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ latestUserText: 'implement the feature' }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('create_plan')
  })

  it('suppresses pending create_plan when assistant asks the user to choose a direction', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: '我给两个方向：A 更克制，B 更外放。你选哪个，我再继续。',
    }))
    expect(result).toBeNull()
  })

  it('suppresses pending create_plan in plan mode', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({ operatingMode: 'plan' }))
    expect(result).toBeNull()
  })

  it('exhausted after MAX_NUDGES_PER_KIND fires', () => {
    makeTaskWithStep()
    const counter = createNudgeCounter()
    for (let i = 0; i < MAX_NUDGES_PER_KIND; i++) {
      consumeNudge(counter, 'task-1', 'create_plan')
    }
    const result = buildTaskExecutionNudge(makeCtx({ counter }))
    expect(result).toBeNull()
  })

  it('suppresses pending create_plan during phase-runtime report with evidence', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('report'),
    }))
    expect(result).toBeNull()
  })
})

describe('buildTaskExecutionNudge — continue_step', () => {
  it('fires continue_step when step is in_progress', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx())
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('continue_step')
    expect(result!.text).toContain('in_progress')
  })

  it('suppresses continue_step when assistant is awaiting user confirmation', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: '这里我建议先停一下。是否继续按这个方向改，等你拍板。',
    }))
    expect(result).toBeNull()
  })

  it('exhausted after MAX_NUDGES_PER_KIND fires', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const counter = createNudgeCounter()
    for (let i = 0; i < MAX_NUDGES_PER_KIND; i++) {
      consumeNudge(counter, 'task-1', 'continue_step')
    }
    const result = buildTaskExecutionNudge(makeCtx({ counter }))
    expect(result).toBeNull()
  })

  it('suppresses continue_step during phase-runtime verification with evidence', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('verify'),
    }))
    expect(result).toBeNull()
  })

  it('suppresses continue_step in plan mode', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({ operatingMode: 'plan' }))
    expect(result).toBeNull()
  })

  it('keeps continue_step before verification evidence exists', () => {
    makeTaskWithStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('verify', { evidenceCount: 0 }),
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('continue_step')
  })
})

describe('buildTaskExecutionNudge — verify_step', () => {
  it('fires verify_step when in_progress step has verification but no results', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx())
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('verify_step')
    expect(result!.text).toContain('TaskVerify')
    expect(result!.text).toContain('atomically complete')
    expect(result!.text).not.toContain('TaskUpdate(stepStatus="completed")')
  })

  it('includes Project Map verification commands in verify_step nudges when provided', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      projectMapVerificationProfiles: projectMapVerificationProfiles(),
    }))

    expect(result).not.toBeNull()
    expect(result!.kind).toBe('verify_step')
    expect(result!.text).toContain('Project Map verification')
    expect(result!.text).toContain('npm test')
    expect(result!.text).toContain('npm run typecheck')
  })

  it('does not fire verify_step when no verification checks defined', () => {
    makeTaskWithStep() // no verification
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx())
    // Should fire continue_step, not verify_step
    expect(result!.kind).toBe('continue_step')
  })

  it('preserves verify_step during phase-runtime verification with evidence', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('verify'),
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('verify_step')
  })

  it('suppresses verify_step when assistant is awaiting user confirmation', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: '我已经列出两个标题方向。等你确认标题后，我再改源文件并验证预览。',
    }))
    expect(result).toBeNull()
  })

  it('suppresses verify_step in plan mode', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx({ operatingMode: 'plan' }))
    expect(result).toBeNull()
  })
})

describe('buildTaskExecutionNudge — completion_blocked', () => {
  it('fires completion_blocked when model claims done but step is still pending', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: 'The task is completed! Everything is done and working.',
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('completion_blocked')
    expect(result!.text).toContain('open required steps')
    expect(result!.text).toContain('step-1')
  })

  it('does not fire completion_blocked when no completion claim in text', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: 'Working on the feature now.',
    }))
    // Should be create_plan, not completion_blocked
    expect(result?.kind).not.toBe('completion_blocked')
  })

  it('exhausted after MAX_NUDGES_PER_KIND fires', () => {
    makeTaskWithStep()
    const counter = createNudgeCounter()
    for (let i = 0; i < MAX_NUDGES_PER_KIND; i++) {
      consumeNudge(counter, 'task-1', 'completion_blocked')
    }
    const result = buildTaskExecutionNudge(makeCtx({
      counter,
      assistantText: 'Done! The task is complete.',
    }))
    // After exhaustion, falls through to create_plan
    expect(result?.kind).not.toBe('completion_blocked')
  })

  it('preserves completion_blocked during phase-runtime final with evidence', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: 'All tests passed! The feature is deployed and shipped.',
      phaseRuntimeEnabled: true,
      phaseVerdict: phaseVerdict('final'),
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('completion_blocked')
  })
})

describe('allRequiredStepsDone', () => {
  it('returns true for unknown task', () => {
    expect(allRequiredStepsDone('task-999')).toBe(true)
  })

  it('returns false when task has open steps', () => {
    makeTaskWithStep()
    expect(allRequiredStepsDone('task-1')).toBe(false)
  })

  it('returns true when all steps are completed', () => {
    makeTaskWithStep()
    // Mark in_progress first, then complete (store rules require it)
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    updateTaskStep('task-1', 'step-1', { status: 'completed' })
    expect(allRequiredStepsDone('task-1')).toBe(true)
  })
})

describe('nudge priority ordering', () => {
  it('completion_blocked takes priority over create_plan on pending step', () => {
    makeTaskWithStep()
    const result = buildTaskExecutionNudge(makeCtx({
      assistantText: 'All tests passed! The feature is deployed and shipped.',
    }))
    expect(result!.kind).toBe('completion_blocked')
  })

  it('verify_step takes priority over continue_step when checks defined but unrun', () => {
    makeTaskWithVerificationStep()
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const result = buildTaskExecutionNudge(makeCtx())
    expect(result!.kind).toBe('verify_step')
  })
})
