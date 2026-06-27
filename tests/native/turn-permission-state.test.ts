import { describe, it, expect } from 'vitest'
import {
  recordProposal,
  recordPermissionRequested,
  recordPermissionGranted,
  recordPermissionDenied,
} from '../../src/native/turn-permission-state.js'
import type { ProposedToolCall, PermissionState } from '../../src/native/protocol/task-permission-types.js'

import {
  recordExecutionStart,
  recordSettlement,
  recordPostGrantEvidence,
} from '../../src/native/turn-permission-state.js'

describe('recordProposal', () => {
  it('creates a ProposedToolCall with permissionState=needed for mutating risk', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, {
      tool: 'edit',
      riskClass: 'mutating',
      iteration: 3,
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toBe(tc)
    expect(tc.tool).toBe('edit')
    expect(tc.riskClass).toBe('mutating')
    expect(tc.permissionState).toBe<PermissionState>('needed')
    expect(tc.proposedAtIter).toBe(3)
    expect(tc.grantEvent).toBeUndefined()
    expect(tc.startedAtIter).toBeUndefined()
    expect(tc.completedAtIter).toBeUndefined()
    expect(tc.postGrantEvidence).toEqual([])
  })

  it('creates a ProposedToolCall with permissionState=not_needed for safe risk', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, {
      tool: 'read',
      riskClass: 'safe',
      iteration: 1,
    })
    expect(tc.permissionState).toBe<PermissionState>('not_needed')
  })

  it('creates a ProposedToolCall with permissionState=not_needed for safe_readonly_local risk', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, {
      tool: 'WebFetch',
      riskClass: 'safe_readonly_local',
      iteration: 1,
    })
    expect(tc.permissionState).toBe<PermissionState>('not_needed')
  })

  it('internal_state still requires permission (needed)', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, {
      tool: 'TaskUpdate',
      riskClass: 'internal_state',
      iteration: 2,
    })
    expect(tc.permissionState).toBe<PermissionState>('needed')
  })

  it('stores toolUseId when provided', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, {
      tool: 'edit',
      riskClass: 'mutating',
      iteration: 1,
      toolUseId: 'tu_1',
    })
    expect(tc.toolUseId).toBe('tu_1')
  })
})

describe('turn-permission-state — permission decisions', () => {
  function fresh(risk: 'mutating' | 'safe' = 'mutating'): ProposedToolCall {
    const list: ProposedToolCall[] = []
    return recordProposal(list, { tool: 'edit', riskClass: risk, iteration: 1 })
  }

  it('needed → requested', () => {
    const tc = fresh()
    recordPermissionRequested(tc)
    expect(tc.permissionState).toBe<PermissionState>('requested')
  })

  it('requested → granted records GrantEvent', () => {
    const tc = fresh()
    recordPermissionRequested(tc)
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 2 })
    expect(tc.permissionState).toBe<PermissionState>('granted')
    expect(tc.grantEvent?.mode).toBe('user_prompt')
    expect(tc.grantEvent?.iteration).toBe(2)
    expect(typeof tc.grantEvent?.ts).toBe('number')
  })

  it('requested → denied (terminal, no grantEvent)', () => {
    const tc = fresh()
    recordPermissionRequested(tc)
    recordPermissionDenied(tc)
    expect(tc.permissionState).toBe<PermissionState>('denied')
    expect(tc.grantEvent).toBeUndefined()
  })

  it('safe tool (not_needed) ignores recordPermissionGranted', () => {
    const tc = fresh('safe')
    recordPermissionGranted(tc, { mode: 'auto_approve', iteration: 1 })
    expect(tc.permissionState).toBe<PermissionState>('not_needed')
    expect(tc.grantEvent).toBeUndefined()
  })

  it('denied is terminal — further granted call is a no-op', () => {
    const tc = fresh()
    recordPermissionDenied(tc)
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 5 })
    expect(tc.permissionState).toBe<PermissionState>('denied')
    expect(tc.grantEvent).toBeUndefined()
  })
})

describe('turn-permission-state — execution lifecycle', () => {
  function granted(iter = 2): ProposedToolCall {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionRequested(tc)
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: iter })
    return tc
  }

  it('recordExecutionStart sets startedAtIter', () => {
    const tc = granted()
    recordExecutionStart(tc, 3)
    expect(tc.startedAtIter).toBe(3)
  })

  it('recordExecutionStart is no-op for denied tool', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionDenied(tc)
    recordExecutionStart(tc, 3)
    expect(tc.startedAtIter).toBeUndefined()
  })

  it('recordExecutionStart works for not_needed (safe) tools', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'read', riskClass: 'safe', iteration: 1 })
    recordExecutionStart(tc, 1)
    expect(tc.startedAtIter).toBe(1)
  })

  it('recordSettlement sets completedAtIter', () => {
    const tc = granted()
    recordExecutionStart(tc, 3)
    recordSettlement(tc, 3)
    expect(tc.completedAtIter).toBe(3)
  })

  it('recordSettlement requires startedAtIter (no-op otherwise)', () => {
    const tc = granted()
    recordSettlement(tc, 3)
    expect(tc.completedAtIter).toBeUndefined()
  })

  it('recordPostGrantEvidence appends touched_path', () => {
    const tc = granted()
    recordExecutionStart(tc, 3)
    recordPostGrantEvidence(tc, { kind: 'touched_path', detail: 'src/foo.ts' })
    expect(tc.postGrantEvidence).toEqual([
      expect.objectContaining({ kind: 'touched_path', detail: 'src/foo.ts' }),
    ])
  })

  it('recordPostGrantEvidence is no-op when denied', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
    recordPermissionDenied(tc)
    recordPostGrantEvidence(tc, { kind: 'touched_path', detail: 'x' })
    expect(tc.postGrantEvidence).toEqual([])
  })

  it('records tool_completion for external_effect tools', () => {
    const list: ProposedToolCall[] = []
    const tc = recordProposal(list, { tool: 'WebFetch', riskClass: 'external_effect', iteration: 1 })
    recordPermissionGranted(tc, { mode: 'auto_approve', iteration: 1 })
    recordExecutionStart(tc, 1)
    recordPostGrantEvidence(tc, { kind: 'tool_completion', detail: 'fetched 4096 bytes' })
    expect(tc.postGrantEvidence[0]?.kind).toBe('tool_completion')
  })
})

import { derivedLifecycle } from '../../src/native/turn-permission-state.js'
import type { DerivedLifecycle } from '../../src/native/protocol/task-permission-types.js'

describe('derivedLifecycle — spec §3.1 table coverage', () => {
  function build(): ProposedToolCall {
    const list: ProposedToolCall[] = []
    return recordProposal(list, { tool: 'edit', riskClass: 'mutating', iteration: 1 })
  }

  it('proposed: just after recordProposal', () => {
    expect(derivedLifecycle(build())).toBe<DerivedLifecycle>('proposed')
  })

  it('awaiting: after recordPermissionRequested', () => {
    const tc = build()
    recordPermissionRequested(tc)
    expect(derivedLifecycle(tc)).toBe<DerivedLifecycle>('awaiting')
  })

  it('granted_idle: granted but never invoked', () => {
    const tc = build()
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 1 })
    expect(derivedLifecycle(tc)).toBe<DerivedLifecycle>('granted_idle')
  })

  it('executing: startedAtIter set, completedAtIter undefined', () => {
    const tc = build()
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 1 })
    recordExecutionStart(tc, 2)
    expect(derivedLifecycle(tc)).toBe<DerivedLifecycle>('executing')
  })

  it('settled: completedAtIter set', () => {
    const tc = build()
    recordPermissionGranted(tc, { mode: 'user_prompt', iteration: 1 })
    recordExecutionStart(tc, 2)
    recordSettlement(tc, 2)
    expect(derivedLifecycle(tc)).toBe<DerivedLifecycle>('settled')
  })

  it('denied: terminal', () => {
    const tc = build()
    recordPermissionDenied(tc)
    expect(derivedLifecycle(tc)).toBe<DerivedLifecycle>('denied')
  })
})
