/**
 * Recorder helpers for ProposedToolCall lifecycle. Pure types live in
 * src/native/protocol/task-permission-types.ts; this file owns the
 * mutation API consumed by the conversation dispatch loop.
 */

import type {
  ProposedToolCall,
  PermissionState,
  RiskClass,
  GrantEvent,
  PostGrantEvidence,
  DerivedLifecycle,
} from './protocol/task-permission-types.js'

export interface RecordProposalArgs {
  tool: string
  riskClass: RiskClass
  iteration: number
  toolUseId?: string
}

export function recordProposal(
  list: ProposedToolCall[],
  args: RecordProposalArgs,
): ProposedToolCall {
  const initial: PermissionState = args.riskClass === 'safe' ? 'not_needed' : 'needed'
  const entry: ProposedToolCall = {
    tool: args.tool,
    riskClass: args.riskClass,
    permissionState: initial,
    proposedAtIter: args.iteration,
    postGrantEvidence: [],
  }
  if (args.toolUseId !== undefined) entry.toolUseId = args.toolUseId
  list.push(entry)
  return entry
}

export function recordPermissionRequested(tc: ProposedToolCall): void {
  if (tc.permissionState === 'needed') {
    tc.permissionState = 'requested'
  }
}

export interface PermissionGrantArgs {
  mode: GrantEvent['mode']
  iteration: number
}

export function recordPermissionGranted(
  tc: ProposedToolCall,
  args: PermissionGrantArgs,
): void {
  if (tc.permissionState !== 'needed' && tc.permissionState !== 'requested') return
  tc.permissionState = 'granted'
  tc.grantEvent = {
    ts: Date.now(),
    mode: args.mode,
    iteration: args.iteration,
  }
}

export function recordPermissionDenied(tc: ProposedToolCall): void {
  if (tc.permissionState !== 'needed' && tc.permissionState !== 'requested') return
  tc.permissionState = 'denied'
}

export function recordExecutionStart(tc: ProposedToolCall, iteration: number): void {
  if (tc.permissionState !== 'granted' && tc.permissionState !== 'not_needed') return
  tc.startedAtIter = iteration
}

export function recordSettlement(tc: ProposedToolCall, iteration: number): void {
  if (tc.startedAtIter === undefined) return
  tc.completedAtIter = iteration
}

export interface PostGrantEvidenceArgs {
  kind: PostGrantEvidence['kind']
  detail: string
}

export function recordPostGrantEvidence(
  tc: ProposedToolCall,
  args: PostGrantEvidenceArgs,
): void {
  if (tc.permissionState !== 'granted' && tc.permissionState !== 'not_needed') return
  tc.postGrantEvidence.push({
    kind: args.kind,
    detail: args.detail,
    ts: Date.now(),
  })
}

export function derivedLifecycle(tc: ProposedToolCall): DerivedLifecycle {
  if (tc.permissionState === 'denied') return 'denied'
  if (tc.completedAtIter !== undefined) return 'settled'
  if (tc.startedAtIter !== undefined) return 'executing'
  if (tc.permissionState === 'granted') return 'granted_idle'
  if (tc.permissionState === 'requested') return 'awaiting'
  return 'proposed'
}
