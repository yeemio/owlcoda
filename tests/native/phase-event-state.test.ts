import { describe, expect, it } from 'vitest'

import {
  recordAssistantTextPhaseEvent,
  recordCompletionClaimPhaseEvent,
  recordPermissionPhaseEvent,
  recordPhaseEvent,
  recordPostGrantEvidencePhaseEvent,
  recordRuntimeNudgePhaseEvent,
  recordToolPhaseEvent,
  recordVerificationEvidencePhaseEvent,
} from '../../src/native/phase-event-state.js'
import { addUserMessage, createConversation } from '../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'
import type { PhaseEvent } from '../../src/native/protocol/task-permission-types.js'

describe('phase-event-state — append-only shadow ledger', () => {
  it('records a generic phase event without reading it for behavior', () => {
    const state = { phaseEvents: [] as PhaseEvent[] }
    const event = recordPhaseEvent(state, {
      iter: 2,
      kind: 'verification_evidence',
      tool: 'DeliveryAudit',
      detail: 'clean',
      evidenceKind: 'delivery_audit',
      phaseHint: 'verify',
    })

    expect(state.phaseEvents).toHaveLength(1)
    expect(state.phaseEvents[0]).toBe(event)
    expect(event).toEqual(expect.objectContaining({
      iter: 2,
      kind: 'verification_evidence',
      tool: 'DeliveryAudit',
      detail: 'clean',
      evidenceKind: 'delivery_audit',
      phaseHint: 'verify',
    }))
    expect(event.ts).toBeTypeOf('number')
  })

  it('records typed helper events', () => {
    const state = { phaseEvents: [] as PhaseEvent[] }

    recordAssistantTextPhaseEvent(state, 1, 'summary')
    recordToolPhaseEvent(state, 1, 'tool_proposed', 'Read', 'tu_1')
    recordPermissionPhaseEvent(state, 1, 'permission_granted', 'Edit')
    recordPostGrantEvidencePhaseEvent(state, 2, 'touched_path', 'src/foo.ts')
    recordVerificationEvidencePhaseEvent(state, 3, 'TaskVerify', 'ok')
    recordCompletionClaimPhaseEvent(state, 4, 'done')
    recordRuntimeNudgePhaseEvent(state, 5, 'verify_once')

    expect(state.phaseEvents.map((event) => event.kind)).toEqual([
      'assistant_text',
      'tool_proposed',
      'permission_granted',
      'post_grant_evidence',
      'verification_evidence',
      'completion_claim',
      'runtime_nudge',
    ])
    expect(state.phaseEvents[1]?.phaseHint).toBe('explore')
    expect(state.phaseEvents[4]?.phaseHint).toBe('verify')
  })

  it('does not record blank assistant text', () => {
    const state = { phaseEvents: [] as PhaseEvent[] }
    expect(recordAssistantTextPhaseEvent(state, 1, '   ')).toBeNull()
    expect(state.phaseEvents).toEqual([])
  })
})

describe('phase-event-state — task reset semantics', () => {
  it('keeps phase events for the same task and resets them for a new task', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit src/foo.ts')
    const first = ensureTaskExecutionState(conv)
    recordRuntimeNudgePhaseEvent(first, 1, 'edit_now')

    const same = ensureTaskExecutionState(conv)
    expect(same.phaseEvents).toHaveLength(1)

    addUserMessage(conv, 'review src/foo.ts without editing')
    const next = ensureTaskExecutionState(conv)
    expect(next.phaseEvents).toEqual([])
    expect(next.proposedToolCalls).toEqual([])
  })
})

