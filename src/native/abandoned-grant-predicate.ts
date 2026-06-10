/**
 * Event-derived progress predicates for the action-permission state machine.
 *
 * These helpers stay side-effect free: callers pass the current task state and
 * receive a decision derived from recorded tool proposals, grants, and evidence.
 */

import type { TaskExecutionState } from './protocol/types.js'
import type { EditNowNudge, ProposedToolCall, RiskClass } from './protocol/task-permission-types.js'

export const RISK_REQUIRES_DURABLE: ReadonlyArray<RiskClass> = [
  'mutating',
  'destructive',
  'external_effect',
]

function isRisky(tc: ProposedToolCall): boolean {
  return RISK_REQUIRES_DURABLE.includes(tc.riskClass)
}

export function hasGrantedRiskyToolAwaitingEvidence(
  taskState: TaskExecutionState,
): boolean {
  for (const tc of taskState.proposedToolCalls) {
    if (!isRisky(tc)) continue
    if (tc.permissionState !== 'granted') continue
    if (tc.postGrantEvidence.length > 0) continue
    return true
  }
  return false
}

export const ABANDONED_GRANT_BUDGET = 5

export interface HardStopDecision {
  fire: boolean
  reason?: string
  nudge?: EditNowNudge
  offendingCallToolUseId?: string
}

function editNowAlreadyFiredFor(
  taskState: TaskExecutionState,
  grantTs: number,
): boolean {
  const list = taskState.run.editNowNudgedGrantTs
  return Array.isArray(list) && list.includes(grantTs)
}

export function shouldHardStopOnAbandonedGrant(
  taskState: TaskExecutionState,
): HardStopDecision {
  for (const tc of taskState.proposedToolCalls) {
    if (!isRisky(tc)) continue
    if (tc.permissionState !== 'granted') continue
    if (tc.postGrantEvidence.length > 0) continue
    if (!tc.grantEvent) continue

    const itersSinceGrant = (taskState.run.lifetimeIterations ?? 0) - tc.grantEvent.iteration
    if (itersSinceGrant < ABANDONED_GRANT_BUDGET) continue

    if (!editNowAlreadyFiredFor(taskState, tc.grantEvent.ts)) {
      return {
        fire: false,
        nudge: {
          tool: tc.tool,
          grantIteration: tc.grantEvent.iteration,
          itersSinceGrant,
          grantTs: tc.grantEvent.ts,
        },
      }
    }

    const lifecycle = tc.completedAtIter !== undefined
      ? 'settled with no durable output'
      : tc.startedAtIter !== undefined
        ? 'executing without producing output'
        : 'granted but never invoked'

    const decision: HardStopDecision = {
      fire: true,
      reason:
        `Granted ${tc.tool} (${tc.riskClass}) at iter ${tc.grantEvent.iteration}: ` +
        `${lifecycle}, ${itersSinceGrant} iters elapsed since grant, ` +
        'edit_now_nudge already injected and ignored.',
    }
    if (tc.toolUseId !== undefined) decision.offendingCallToolUseId = tc.toolUseId
    return decision
  }
  return { fire: false }
}
