import { describe, expect, it } from 'vitest'

import {
  deriveTurnPhase,
  evaluateCompletionClaim,
  shouldInterveneForNoProgress,
} from '../../src/native/phase-runtime.js'
import type { DeliverableContractClassification } from '../../src/native/deliverable-contract.js'
import type {
  PhaseEvent,
  ProposedToolCall,
} from '../../src/native/protocol/task-permission-types.js'
import type { TaskExecutionState } from '../../src/native/protocol/types.js'

function state(args: {
  events?: PhaseEvent[]
  calls?: ProposedToolCall[]
  touchedPaths?: string[]
} = {}): TaskExecutionState {
  return {
    contract: {
      version: 1,
      sourceTurnHash: 'hash',
      sourceText: 'test',
      objective: 'test',
      dominantGap: null,
      cwd: '/tmp/project',
      scopeMode: 'workspace',
      explicitWriteTargets: [],
      allowedWritePaths: [],
      touchedPaths: args.touchedPaths ?? [],
      createdAt: 1,
      updatedAt: 1,
      confidence: 'low',
    },
    run: {
      status: 'open',
      iterations: 0,
      lifetimeIterations: 0,
      currentFocus: null,
      lastProgressAt: 1,
      lastGuardReason: null,
      lastUpdatedAt: 1,
    },
    proposedToolCalls: args.calls ?? [],
    phaseEvents: args.events ?? [],
  }
}

function event(kind: PhaseEvent['kind'], phaseHint?: PhaseEvent['phaseHint'], extra: Partial<PhaseEvent> = {}): PhaseEvent {
  return {
    iter: 1,
    kind,
    ts: 1,
    ...(phaseHint ? { phaseHint } : {}),
    ...extra,
  }
}

function deliverable(mode: DeliverableContractClassification['mode']): DeliverableContractClassification {
  return {
    mode,
    confidence: 'high',
    requiresDurableArtifact: mode === 'code_change' || mode === 'file_artifact_delivery',
    allowsChatFinal: mode === 'read_only_review' || mode === 'text_deliverable' || mode === 'command_job' || mode === 'mixed_unknown',
    shouldCreateTaskPlan: mode === 'code_change' || mode === 'file_artifact_delivery' || mode === 'command_job',
    hardStopOnNoTouchedPaths: mode === 'code_change' || mode === 'file_artifact_delivery',
    reasons: [],
  }
}

describe('deriveTurnPhase', () => {
  it('starts at intake when no phase events exist', () => {
    expect(deriveTurnPhase(state())).toEqual(expect.objectContaining({
      phase: 'intake',
      confidence: 'high',
      reasonCodes: ['no_events'],
    }))
  })

  it('derives exploration from recent read/search-like tool events', () => {
    expect(deriveTurnPhase(state({
      events: [event('tool_completed', 'explore', { tool: 'Read' })],
    }))).toEqual(expect.objectContaining({
      phase: 'explore',
      reasonCodes: ['recent_exploration'],
    }))
  })

  it('derives plan from internal planning tools', () => {
    expect(deriveTurnPhase(state({
      events: [event('tool_completed', 'plan', { tool: 'TaskCreate' })],
    }))).toEqual(expect.objectContaining({
      phase: 'plan',
      reasonCodes: ['recent_plan_activity'],
    }))
  })

  it('derives execute from write evidence', () => {
    expect(deriveTurnPhase(state({
      events: [event('post_grant_evidence', 'execute', { evidenceKind: 'touched_path' })],
    }))).toEqual(expect.objectContaining({
      phase: 'execute',
      confidence: 'high',
      reasonCodes: ['recent_write_evidence'],
    }))
  })

  it('derives verify from verification evidence', () => {
    expect(deriveTurnPhase(state({
      events: [event('verification_evidence', 'verify', { tool: 'DeliveryAudit' })],
    }))).toEqual(expect.objectContaining({
      phase: 'verify',
      confidence: 'high',
      reasonCodes: ['recent_verification_evidence'],
    }))
  })

  it('derives final from a completion claim after evidence', () => {
    expect(deriveTurnPhase(state({
      events: [
        event('post_grant_evidence', 'execute', { evidenceKind: 'touched_path' }),
        event('verification_evidence', 'verify', { tool: 'DeliveryAudit' }),
        event('completion_claim', 'report'),
      ],
    }))).toEqual(expect.objectContaining({
      phase: 'final',
      confidence: 'high',
      reasonCodes: ['completion_claim_after_evidence'],
    }))
  })

  it('derives report from assistant text after exploration in read-only review', () => {
    expect(deriveTurnPhase(state({
      events: [
        event('tool_completed', 'explore', { tool: 'Read' }),
        event('assistant_text', 'report'),
      ],
    }))).toEqual(expect.objectContaining({
      phase: 'report',
      confidence: 'medium',
      reasonCodes: ['report_text_after_exploration'],
    }))
  })

  it('keeps abandoned risky grants in execute until evidence appears', () => {
    const call: ProposedToolCall = {
      tool: 'edit',
      riskClass: 'mutating',
      permissionState: 'granted',
      proposedAtIter: 1,
      grantEvent: { ts: 1, mode: 'user_prompt', iteration: 1 },
      postGrantEvidence: [],
    }
    expect(deriveTurnPhase(state({
      calls: [call],
      events: [event('permission_granted', undefined, { tool: 'edit' })],
    }))).toEqual(expect.objectContaining({
      phase: 'execute',
      confidence: 'medium',
      pendingRiskyGrantCount: 1,
      reasonCodes: ['pending_abandoned_grant'],
    }))
  })

  it('derives blocked when permission was denied', () => {
    expect(deriveTurnPhase(state({
      events: [event('permission_denied', undefined, { tool: 'edit' })],
    }))).toEqual(expect.objectContaining({
      phase: 'blocked',
      confidence: 'high',
      reasonCodes: ['permission_denied'],
    }))
  })
})

describe('shouldInterveneForNoProgress', () => {
  it('suppresses old no-progress hard-stop during verification when evidence exists', () => {
    const phaseVerdict = deriveTurnPhase(state({
      events: [event('verification_evidence', 'verify', { tool: 'DeliveryAudit' })],
    }))

    expect(shouldInterveneForNoProgress({
      oldHardStop: true,
      phaseVerdict,
      abandonedGrantDecision: { fire: false },
    })).toEqual(expect.objectContaining({
      fire: false,
      phaseAllowsContinue: true,
      reason: expect.stringContaining('phase=verify has evidence'),
    }))
  })

  it('suppresses old no-progress hard-stop during final reporting when evidence exists', () => {
    const phaseVerdict = deriveTurnPhase(state({
      events: [
        event('post_grant_evidence', 'execute', { evidenceKind: 'touched_path' }),
        event('completion_claim', 'report'),
      ],
    }))

    expect(shouldInterveneForNoProgress({
      oldHardStop: true,
      phaseVerdict,
      abandonedGrantDecision: { fire: false },
    })).toEqual(expect.objectContaining({
      fire: false,
      phaseAllowsContinue: true,
      reason: expect.stringContaining('phase=final has evidence'),
    }))
  })

  it('preserves abandoned-grant hard-stop during execute phase', () => {
    const phaseVerdict = deriveTurnPhase(state({
      calls: [{
        tool: 'edit',
        riskClass: 'mutating',
        permissionState: 'granted',
        proposedAtIter: 1,
        grantEvent: { ts: 1, mode: 'user_prompt', iteration: 1 },
        startedAtIter: 1,
        completedAtIter: 1,
        postGrantEvidence: [],
      }],
      events: [event('tool_completed', 'execute', { tool: 'edit' })],
    }))

    expect(shouldInterveneForNoProgress({
      oldHardStop: true,
      phaseVerdict,
      abandonedGrantDecision: { fire: true, reason: 'abandoned edit' },
    })).toEqual(expect.objectContaining({
      fire: true,
      phaseAllowsContinue: false,
      reason: 'abandoned edit',
    }))
  })

  it('fails open on low-confidence phase verdicts', () => {
    expect(shouldInterveneForNoProgress({
      oldHardStop: true,
      phaseVerdict: {
        phase: 'report',
        confidence: 'low',
        reasonCodes: ['unknown_mixed_activity'],
        evidenceCount: 0,
        pendingRiskyGrantCount: 0,
      },
      abandonedGrantDecision: { fire: false },
    })).toEqual(expect.objectContaining({
      fire: false,
      phaseAllowsContinue: true,
      reason: 'phase=report/low fail-open',
    }))
  })

  it('falls back to old durable no-progress gate for exploration without evidence', () => {
    const phaseVerdict = deriveTurnPhase(state({
      events: [event('tool_completed', 'explore', { tool: 'Read' })],
    }))

    expect(shouldInterveneForNoProgress({
      oldHardStop: true,
      phaseVerdict,
      abandonedGrantDecision: { fire: false },
    })).toEqual(expect.objectContaining({
      fire: true,
      phaseAllowsContinue: false,
      reason: expect.stringContaining('falls back to old durable no-progress gate'),
    }))
  })
})

describe('evaluateCompletionClaim', () => {
  it('blocks durable completion when legacy accepted but no artifact evidence exists', () => {
    const taskState = state({
      events: [event('completion_claim', 'report')],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: task complete.',
      deliverable: deliverable('file_artifact_delivery'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('no artifact evidence'),
      artifactEvidenceCount: 0,
    }))
  })

  it('accepts durable completion with artifact evidence', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/docs/deck.html'],
      events: [event('completion_claim', 'report')],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: task complete. docs/deck.html was written.',
      deliverable: deliverable('file_artifact_delivery'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      artifactEvidenceCount: 1,
    }))
  })

  it('blocks verification claims when no verification evidence exists', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/src/index.ts'],
      events: [event('post_grant_evidence', 'execute')],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: implementation complete and all tests passed.',
      deliverable: deliverable('code_change'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('claims verification/testing'),
      artifactEvidenceCount: 2,
      verificationEvidenceCount: 0,
    }))
  })

  it('blocks dry-run proof claims when the dry-run did not produce verification evidence', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/gen_l0_identity.py'],
      events: [
        event('post_grant_evidence', 'execute'),
        event('tool_completed', 'execute', { tool: 'bash', detail: 'error' }),
      ],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: Dry-run proves excerpts load clean and QA generation works.',
      deliverable: deliverable('code_change'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('claims verification/testing'),
      verificationEvidenceCount: 0,
    }))
  })

  it('accepts verification claims when verification evidence exists', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/src/index.ts'],
      events: [
        event('post_grant_evidence', 'execute'),
        event('verification_evidence', 'verify', { tool: 'TaskVerify' }),
        event('completion_claim', 'report'),
      ],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: implementation complete and all tests passed.',
      deliverable: deliverable('code_change'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      verificationEvidenceCount: 1,
    }))
  })

  it('blocks runtime-sensitive completion reports without required evidence layers', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/src/native/job-supervisor.ts'],
      events: [
        event('post_grant_evidence', 'execute'),
        event('verification_evidence', 'verify', { tool: 'TaskVerify' }),
        event('completion_claim', 'report'),
      ],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: runtime supervisor bug fixed and tests passed.',
      deliverable: deliverable('code_change'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('runtime-sensitive final report missing evidence layers'),
      verificationEvidenceCount: 1,
    }))
  })

  it('does not treat runtime in a file path as a runtime-sensitive final report subject', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/docs/phase-runtime-report.md'],
      events: [
        event('post_grant_evidence', 'execute'),
        event('verification_evidence', 'verify', { tool: 'TaskVerify' }),
        event('completion_claim', 'report'),
      ],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final report: task complete. docs/phase-runtime-report.md was written and all tests passed.',
      deliverable: deliverable('file_artifact_delivery'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      verificationEvidenceCount: 1,
    }))
  })

  it('accepts runtime-sensitive completion reports with incident/code/verified/not-fixed layers', () => {
    const taskState = state({
      touchedPaths: ['/tmp/project/src/native/job-supervisor.ts'],
      events: [
        event('post_grant_evidence', 'execute'),
        event('verification_evidence', 'verify', { tool: 'TaskVerify' }),
        event('completion_claim', 'report'),
      ],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: [
        'Final report: runtime supervisor fix complete.',
        'Status layers:',
        '- incident_mitigated: no live incident action was needed.',
        '- code_changed: src/native/job-supervisor.ts.',
        '- verified: command `npm test` observed result 10 passed, 0 failed.',
        '- not_fixed: agent/api daemon adapters remain pending.',
        'Changed files: src/native/job-supervisor.ts.',
        'Verification command: npm test.',
        'Observed result: 10 passed, 0 failed.',
        'Remaining risk: agent/api daemon adapters remain pending.',
      ].join('\n'),
      deliverable: deliverable('code_change'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      verificationEvidenceCount: 1,
    }))
  })

  it('accepts chat-final deliverables without artifact evidence', () => {
    const taskState = state({
      events: [event('completion_claim', 'report')],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Final answer: here is the requested review.',
      deliverable: deliverable('read_only_review'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      reason: expect.stringContaining('allows chat final'),
    }))
  })

  it('does not treat settled tool failures as pending grants for chat-final command jobs', () => {
    const taskState = state({
      calls: [{
        tool: 'Bash',
        riskClass: 'external_effect',
        permissionState: 'granted',
        proposedAtIter: 1,
        grantEvent: { ts: 1, mode: 'auto_approve', iteration: 1 },
        startedAtIter: 1,
        completedAtIter: 1,
        postGrantEvidence: [],
      }],
      events: [event('tool_completed', 'execute', { tool: 'Bash', detail: 'error' })],
    })

    expect(evaluateCompletionClaim({
      taskState,
      finalText: 'Done processing tool output',
      deliverable: deliverable('command_job'),
      legacyCompletionAccepted: true,
    })).toEqual(expect.objectContaining({
      status: 'accepted',
      pendingRiskyGrantCount: 0,
    }))
  })
})
