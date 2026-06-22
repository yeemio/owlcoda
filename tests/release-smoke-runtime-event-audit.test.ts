import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'owlcoda-release-smoke-event-audit-'))
}

function writeSession(home: string, session: Record<string, unknown>): void {
  const sessionsDir = join(home, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, `${session['id']}.json`), JSON.stringify(session, null, 2))
}

function runReleaseSmokeAudit(home: string): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [
    '--import',
    'tsx',
    'scripts/release-smoke.ts',
    '--case=runtime-event-audit',
    '--json',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OWLCODA_HOME: home,
    },
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function sessionWithRuntimeEvents(
  id: string,
  events: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    version: 1,
    id,
    model: 'mimo-v2.5-pro',
    system: 'test',
    maxTokens: 4096,
    turns: [],
    createdAt: 1,
    updatedAt: 2,
    runtimeEventLog: {
      schemaVersion: 1,
      updatedAt: '2026-06-19T10:00:03.000Z',
      nextSeq: events.length + 1,
      events,
    },
  }
}

describe('release smoke runtime event audit', () => {
  it('fails release smoke when saved runtime events are malformed', () => {
    const home = makeHome()
    try {
      writeSession(home, sessionWithRuntimeEvents('malformed-runtime-event-session', [{
        id: 'runtime_event-1',
        seq: 1,
        kind: 'checkpoint_resolved',
        at: '2026-06-19T10:00:02.000Z',
        conversationId: 'malformed-runtime-event-session',
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
      }]))

      const result = runReleaseSmokeAudit(home)

      expect(result.code).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report).toHaveLength(1)
      expect(report[0]).toMatchObject({
        caseId: 'runtime-event-audit',
        kind: 'runtime-event-audit',
        ranLive: true,
        passed: false,
        audit: {
          totals: {
            malformed_saved_event: 1,
          },
        },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('passes release smoke when runtime events are only legacy-compatible', () => {
    const home = makeHome()
    try {
      writeSession(home, sessionWithRuntimeEvents('legacy-runtime-event-session', [{
        id: 'runtime_event-1',
        seq: 1,
        kind: 'runtime_recovery_report_recorded',
        at: '2026-06-19T10:00:01.000Z',
        conversationId: 'legacy-runtime-event-session',
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
      }]))

      const result = runReleaseSmokeAudit(home)

      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report[0]).toMatchObject({
        caseId: 'runtime-event-audit',
        kind: 'runtime-event-audit',
        ranLive: true,
        passed: true,
        audit: {
          totals: {
            legacy_replay_compatible: 1,
            malformed_saved_event: 0,
          },
        },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('probes current runtime event writers for contract-valid base events', () => {
    const home = makeHome()
    try {
      const result = runReleaseSmokeAudit(home)

      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report[0]).toMatchObject({
        caseId: 'runtime-event-audit',
        kind: 'runtime-event-audit',
        ranLive: true,
        passed: true,
        currentRuntimeContractProbe: {
          passed: true,
          event_count: 11,
          contract_valid: 11,
          legacy_replay_compatible: 0,
          malformed_saved_event: 0,
          event_kinds: [
            'turn_started',
            'assistant_stream_recorded',
            'assistant_response_recorded',
            'assistant_response_disposition_recorded',
            'runtime_intervention',
            'runtime_intervention',
            'runtime_intervention',
            'runtime_intervention',
            'item_started',
            'item_completed',
            'turn_completed',
          ],
        },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('flushes large runtime event audit JSON before exiting', () => {
    const home = makeHome()
    try {
      for (let i = 0; i < 160; i += 1) {
        writeSession(home, sessionWithRuntimeEvents(`legacy-runtime-event-session-${i}`, [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'runtime_recovery_report_recorded',
          at: '2026-06-19T10:00:01.000Z',
          conversationId: `legacy-runtime-event-session-${i}`,
          checkpointId: `long_task_checkpoint-${i}`,
          checkpointKind: 'long_task_checkpoint',
          payload: {
            report_kind: 'long_task_checkpoint_report',
            report_source: 'assistant_text',
            report: {
              kind: 'long_task_checkpoint_report',
              checkpoint_id: `long_task_checkpoint-${i}`,
              checkpoint_kind: 'long_task_checkpoint',
              long_task_id: `task:audit-legacy-${i}`,
              inspect_command: `LongTaskGet longTaskId=task:audit-legacy-${i}`,
            },
          },
        }]))
      }

      const result = runReleaseSmokeAudit(home)

      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report[0]).toMatchObject({
        caseId: 'runtime-event-audit',
        passed: true,
        audit: {
          sessions_scanned: 160,
          totals: {
            legacy_replay_compatible: 160,
            malformed_saved_event: 0,
          },
        },
        currentRuntimeContractProbe: {
          passed: true,
          contract_valid: 11,
        },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
