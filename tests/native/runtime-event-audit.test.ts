import { describe, expect, it } from 'vitest'

import {
  auditRuntimeEventSessions,
  runtimeEventAuditHasFailures,
} from '../../src/native/runtime-event-audit.js'
import type { SessionFile } from '../../src/native/session.js'

describe('runtime event audit', () => {
  it('aggregates contract-valid, legacy-compatible, and malformed saved runtime events', () => {
    const report = auditRuntimeEventSessions([{
      version: 1,
      id: 'audit-session',
      model: 'mimo-v2.5-pro',
      system: 'test',
      maxTokens: 4096,
      turns: [],
      createdAt: 1,
      updatedAt: 2,
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T10:00:03.000Z',
        nextSeq: 4,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'runtime_intervention',
          at: '2026-06-19T10:00:00.000Z',
          conversationId: 'audit-session',
          payload: { intervention_kind: 'long_task_wait_policy' },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'runtime_intervention.v1',
            validation_status: 'valid',
          },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_recovery_report_recorded',
          at: '2026-06-19T10:00:01.000Z',
          conversationId: 'audit-session',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            report_kind: 'long_task_checkpoint_report',
            report_source: 'assistant_text',
            report: {
              kind: 'long_task_checkpoint_report',
              checkpoint_id: 'long_task_checkpoint-1',
              checkpoint_kind: 'long_task_checkpoint',
              long_task_id: 'task:audit-legacy',
              inspect_command: 'LongTaskGet longTaskId=task:audit-legacy',
            },
          },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'checkpoint_resolved',
          at: '2026-06-19T10:00:02.000Z',
          conversationId: 'audit-session',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            checkpoint_id: 'long_task_checkpoint-1',
            checkpoint_kind: 'long_task_checkpoint',
          },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'checkpoint_resolved.v1',
            validation_status: 'valid',
          },
        }],
      },
    } satisfies SessionFile])

    expect(report.totals).toEqual({
      event_count: 3,
      contract_valid: 1,
      legacy_replay_compatible: 1,
      malformed_saved_event: 1,
    })
    expect(report.sessions[0]?.status).toBe('failed')
    expect(runtimeEventAuditHasFailures(report)).toBe(true)
  })

  it('treats legacy-compatible sessions as warnings, not release failures', () => {
    const report = auditRuntimeEventSessions([{
      version: 1,
      id: 'legacy-only-session',
      model: 'mimo-v2.5-pro',
      system: 'test',
      maxTokens: 4096,
      turns: [],
      createdAt: 1,
      updatedAt: 2,
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T10:00:01.000Z',
        nextSeq: 2,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'runtime_recovery_report_recorded',
          at: '2026-06-19T10:00:01.000Z',
          conversationId: 'legacy-only-session',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            report_kind: 'long_task_checkpoint_report',
            report_source: 'assistant_text',
            report: {
              kind: 'long_task_checkpoint_report',
              checkpoint_id: 'long_task_checkpoint-1',
              checkpoint_kind: 'long_task_checkpoint',
              long_task_id: 'task:audit-legacy',
              inspect_command: 'LongTaskGet longTaskId=task:audit-legacy',
            },
          },
        }],
      },
    } satisfies SessionFile])

    expect(report.sessions[0]?.status).toBe('warning')
    expect(report.totals.malformed_saved_event).toBe(0)
    expect(runtimeEventAuditHasFailures(report)).toBe(false)
  })

  it('audits malformed saved events even when they are outside the resume suffix window', () => {
    const legacyTail = Array.from({ length: 12 }, (_, index) => ({
      id: `runtime_event-${index + 2}`,
      seq: index + 2,
      kind: 'turn_started',
      at: `2026-06-19T10:00:${String(index + 2).padStart(2, '0')}.000Z`,
      conversationId: 'malformed-outside-suffix-session',
      turnId: `turn-${index + 2}`,
    }))
    const report = auditRuntimeEventSessions([{
      version: 1,
      id: 'malformed-outside-suffix-session',
      model: 'mimo-v2.5-pro',
      system: 'test',
      maxTokens: 4096,
      turns: [],
      createdAt: 1,
      updatedAt: 2,
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T10:00:14.000Z',
        nextSeq: 14,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_resolved',
          at: '2026-06-19T10:00:01.000Z',
          conversationId: 'malformed-outside-suffix-session',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            checkpoint_id: 'long_task_checkpoint-1',
            checkpoint_kind: 'long_task_checkpoint',
          },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'checkpoint_resolved.v1',
            validation_status: 'valid',
          },
        }, ...legacyTail],
      },
    } satisfies SessionFile])

    expect(report.totals).toMatchObject({
      event_count: 13,
      malformed_saved_event: 1,
    })
    expect(report.sessions[0]?.status).toBe('failed')
    expect(runtimeEventAuditHasFailures(report)).toBe(true)
  })
})
