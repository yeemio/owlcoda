import { describe, expect, it } from 'vitest'
import {
  ABANDONED_GRANT_BUDGET,
  hasGrantedRiskyToolAwaitingEvidence,
  RISK_REQUIRES_DURABLE,
  shouldHardStopOnAbandonedGrant,
} from '../../src/native/abandoned-grant-predicate.js'
import {
  recordExecutionStart,
  recordPermissionDenied,
  recordPermissionGranted,
  recordPostGrantEvidence,
  recordProposal,
} from '../../src/native/turn-permission-state.js'
import type { ProposedToolCall } from '../../src/native/protocol/task-permission-types.js'
import type { TaskExecutionState } from '../../src/native/protocol/types.js'

function mkState(calls: ProposedToolCall[], lifetimeIterations = 5): TaskExecutionState {
  return {
    contract: {
      version: 1,
      sourceTurnHash: 'h',
      cwd: '/',
      objective: '',
      sourceText: '',
      dominantGap: null,
      scopeMode: 'workspace',
      explicitWriteTargets: [],
      allowedWritePaths: [],
      touchedPaths: [],
      createdAt: 0,
      updatedAt: 0,
      confidence: 'medium',
    },
    run: {
      status: 'open',
      iterations: lifetimeIterations,
      lifetimeIterations,
      productionGateFired: false,
      scratchArtifactPaths: [],
      currentFocus: null,
      lastProgressAt: 0,
      lastGuardReason: null,
      pendingWriteApproval: null,
      runWorkspace: null,
      lastUpdatedAt: 0,
    },
    proposedToolCalls: calls,
  }
}

describe('hasGrantedRiskyToolAwaitingEvidence', () => {
  it('returns false when there are no proposed tool calls', () => {
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState([]))).toBe(false)
  })

  it('returns false when only safe tools were proposed', () => {
    const list: ProposedToolCall[] = []
    recordProposal(list, { tool: 'read', riskClass: 'safe', iteration: 1 })
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState(list))).toBe(false)
  })

  it('returns false when only internal_state tools were granted', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'TaskUpdate', riskClass: 'internal_state', iteration: 1 })
    recordPermissionGranted(tc, { mode: 'auto_approve', iteration: 1 })
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState(list))).toBe(false)
  })

  it('returns true when a mutating tool is granted with no evidence', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 1 })
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState(list))).toBe(true)
  })

  it('returns false when granted mutating tool has post-grant evidence', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 1 })
    recordExecutionStart(tc, 1)
    recordPostGrantEvidence(tc, { kind: 'touched_path', detail: 'src/foo.ts' })
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState(list))).toBe(false)
  })

  it('returns false when permission was denied', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionDenied(tc)
    expect(hasGrantedRiskyToolAwaitingEvidence(mkState(list))).toBe(false)
  })

  it('excludes safe and internal_state from durable-risk classes', () => {
    expect(RISK_REQUIRES_DURABLE).not.toContain('safe')
    expect(RISK_REQUIRES_DURABLE).not.toContain('internal_state')
    expect(RISK_REQUIRES_DURABLE).toContain('mutating')
    expect(RISK_REQUIRES_DURABLE).toContain('destructive')
    expect(RISK_REQUIRES_DURABLE).toContain('external_effect')
  })
})

function withNudged(state: TaskExecutionState, grantTs: number): TaskExecutionState {
  state.run.editNowNudgedGrantTs = [...(state.run.editNowNudgedGrantTs ?? []), grantTs]
  return state
}

describe('shouldHardStopOnAbandonedGrant', () => {
  it('uses a five-iteration abandoned-grant budget', () => {
    expect(ABANDONED_GRANT_BUDGET).toBe(5)
  })

  it('does not fire when no risky tool was granted', () => {
    expect(shouldHardStopOnAbandonedGrant(mkState([])).fire).toBe(false)
  })

  it('does not fire when a grant is still inside budget', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 4 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 4 })
    const result = shouldHardStopOnAbandonedGrant(mkState(list, 5))
    expect(result.fire).toBe(false)
    expect(result.nudge).toBeUndefined()
  })

  it('returns an edit_now nudge once budget elapses before hard-stopping', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 0 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 0 })
    const result = shouldHardStopOnAbandonedGrant(mkState(list, 5))
    expect(result.fire).toBe(false)
    expect(result.nudge).toMatchObject({
      tool: 'edit',
      grantIteration: 0,
      itersSinceGrant: 5,
    })
  })

  it('fires with granted-but-never-invoked lifecycle after edit_now was ignored', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 0 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 0 })
    const result = shouldHardStopOnAbandonedGrant(withNudged(mkState(list, 5), tc.grantEvent!.ts))
    expect(result.fire).toBe(true)
    expect(result.reason).toMatch(/granted but never invoked/)
  })

  it('fires with executing-without-output lifecycle after edit_now was ignored', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 0 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 0 })
    recordExecutionStart(tc, 1)
    const result = shouldHardStopOnAbandonedGrant(withNudged(mkState(list, 5), tc.grantEvent!.ts))
    expect(result.fire).toBe(true)
    expect(result.reason).toMatch(/executing without producing output/)
  })

  it('fires with settled-without-output lifecycle after edit_now was ignored', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 0 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 0 })
    recordExecutionStart(tc, 1)
    tc.completedAtIter = 2
    const result = shouldHardStopOnAbandonedGrant(withNudged(mkState(list, 5), tc.grantEvent!.ts))
    expect(result.fire).toBe(true)
    expect(result.reason).toMatch(/settled with no durable output/)
  })
})

describe('F8 — granted but never invoked (predicate-level)', () => {
  it('hard-stops after nudge with the "granted but never invoked" lifecycle string', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 3 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 3 })

    const state = mkState(list, 8)
    const nudge = shouldHardStopOnAbandonedGrant(state)
    expect(nudge.fire).toBe(false)
    expect(nudge.nudge).toBeDefined()
    expect(nudge.nudge?.tool).toBe('edit')

    state.run.editNowNudgedGrantTs = [tc.grantEvent!.ts]
    const hardStop = shouldHardStopOnAbandonedGrant(state)
    expect(hardStop.fire).toBe(true)
    expect(hardStop.reason).toMatch(/granted but never invoked/)
  })
})

describe('F9 — settled with error, no durable output (predicate-level)', () => {
  it('hard-stops after nudge with the "settled with no durable output" lifecycle string', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 3 })
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 3 })
    recordExecutionStart(tc, 4)
    tc.completedAtIter = 4

    const state = mkState(list, 8)
    const nudge = shouldHardStopOnAbandonedGrant(state)
    expect(nudge.fire).toBe(false)
    expect(nudge.nudge).toBeDefined()

    state.run.editNowNudgedGrantTs = [tc.grantEvent!.ts]
    const hardStop = shouldHardStopOnAbandonedGrant(state)
    expect(hardStop.fire).toBe(true)
    expect(hardStop.reason).toMatch(/settled with no durable output/)
  })
})
