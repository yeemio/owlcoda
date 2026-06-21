import type { RuntimeEventContractDiagnostics } from './runtime-events.js'
import { buildRuntimeEventContractDiagnostics } from './runtime-events.js'
import type { SessionFile } from './session.js'

export interface RuntimeEventAuditSession {
  id: string
  model: string
  updated_at: number
  event_count: number
  status: 'passed' | 'warning' | 'failed' | 'no_runtime_events'
  diagnostics: RuntimeEventContractDiagnostics
}

export interface RuntimeEventAuditReport {
  schema_version: 1
  kind: 'runtime_event_audit_report'
  sessions_scanned: number
  sessions_with_runtime_events: number
  totals: {
    event_count: number
    contract_valid: number
    legacy_replay_compatible: number
    malformed_saved_event: number
  }
  sessions: RuntimeEventAuditSession[]
}

export function auditRuntimeEventSessions(sessions: SessionFile[]): RuntimeEventAuditReport {
  const sessionReports = sessions.map((session): RuntimeEventAuditSession => {
    const events = session.runtimeEventLog?.events ?? []
    const diagnostics = buildRuntimeEventContractDiagnostics(events, { limit: null })
    return {
      id: session.id,
      model: session.model,
      updated_at: session.updatedAt,
      event_count: events.length,
      status: runtimeEventAuditSessionStatus(events.length, diagnostics),
      diagnostics,
    }
  })
  return {
    schema_version: 1,
    kind: 'runtime_event_audit_report',
    sessions_scanned: sessions.length,
    sessions_with_runtime_events: sessionReports.filter((session) => session.event_count > 0).length,
    totals: {
      event_count: sessionReports.reduce((total, session) => total + session.event_count, 0),
      contract_valid: sessionReports.reduce((total, session) => total + session.diagnostics.valid_event_count, 0),
      legacy_replay_compatible: sessionReports.reduce((total, session) => total + session.diagnostics.legacy_event_count, 0),
      malformed_saved_event: sessionReports.reduce((total, session) => total + session.diagnostics.malformed_event_count, 0),
    },
    sessions: sessionReports,
  }
}

export function runtimeEventAuditHasFailures(report: RuntimeEventAuditReport): boolean {
  return report.totals.malformed_saved_event > 0
}

function runtimeEventAuditSessionStatus(
  eventCount: number,
  diagnostics: RuntimeEventContractDiagnostics,
): RuntimeEventAuditSession['status'] {
  if (eventCount === 0) return 'no_runtime_events'
  if (diagnostics.malformed_event_count > 0) return 'failed'
  if (diagnostics.legacy_event_count > 0) return 'warning'
  return 'passed'
}
