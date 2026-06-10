import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = 'telemetry.envelope.v1' as const

export const TELEMETRY_EVENT_SEVERITIES = [
  'debug',
  'info',
  'warn',
  'error',
] as const

export type TelemetryEventSeverity = (typeof TELEMETRY_EVENT_SEVERITIES)[number]

export const TELEMETRY_EVENT_DECISIONS = [
  'pass',
  'observe',
  'warn',
  'block',
  'fail',
  'skip',
] as const

export type TelemetryEventDecision = (typeof TELEMETRY_EVENT_DECISIONS)[number]

export const TELEMETRY_EVENT_ORIGINS = [
  'runtime',
  'daemon',
  'task',
  'project_map',
  'permission',
  'fitness',
  'admin',
  'unknown',
] as const

export type TelemetryEventOrigin = (typeof TELEMETRY_EVENT_ORIGINS)[number]

export const TELEMETRY_ENVELOPE_REQUIRED_FIELDS = [
  'schemaVersion',
  'eventType',
  'surface',
  'subject',
  'origin',
  'severity',
  'observedAt',
  'decision',
  'reasonCode',
] as const

export interface TelemetryEventEnvelope {
  schemaVersion: typeof TELEMETRY_ENVELOPE_SCHEMA_VERSION
  eventType: string
  surface: string
  subject: string
  origin: TelemetryEventOrigin
  severity: TelemetryEventSeverity
  observedAt: string
  decision: TelemetryEventDecision
  reasonCode: string
  evidenceRef?: string
  attributes?: Record<string, unknown>
}

export interface BuildTelemetryEventEnvelopeInput {
  eventType: string
  surface: string
  subject: string
  origin: TelemetryEventOrigin
  severity: TelemetryEventSeverity
  decision: TelemetryEventDecision
  reasonCode: string
  observedAt?: Date | string | number
  evidenceRef?: string
  attributes?: Record<string, unknown>
}

function normalizeObservedAt(value: Date | string | number | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string') return value
  return new Date().toISOString()
}

export function buildTelemetryEventEnvelope(input: BuildTelemetryEventEnvelopeInput): TelemetryEventEnvelope {
  return {
    schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    eventType: input.eventType,
    surface: input.surface,
    subject: input.subject,
    origin: input.origin,
    severity: input.severity,
    observedAt: normalizeObservedAt(input.observedAt),
    decision: input.decision,
    reasonCode: input.reasonCode,
    ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  }
}

function telemetryEnvelopeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const owlcodaHome = env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return join(owlcodaHome, 'telemetry', `events-${date}.jsonl`)
}

/**
 * Off switch for the unified envelope sink. Default ON; set
 * OWLCODA_TELEMETRY_EVENTS=0 to silence envelope persistence without touching
 * any other telemetry. Mirrors the repo's FALSY-set flag idiom.
 */
export function isTelemetryEnvelopeSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['OWLCODA_TELEMETRY_EVENTS']
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !new Set(['', '0', 'false', 'no', 'off', 'disable', 'disabled']).has(value)
}

/**
 * Persist a telemetry envelope to the unified events ledger
 * (~/.owlcoda/telemetry/events-YYYY-MM-DD.jsonl). This is the envelope's sink —
 * the shared-spine counterpart to gate-telemetry's recordGateEvent. Synchronous
 * and fire-and-forget: every I/O error is swallowed so telemetry can never
 * affect the calling code path.
 */
export function recordTelemetryEnvelope(
  envelope: TelemetryEventEnvelope,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTelemetryEnvelopeSinkEnabled(env)) return
  try {
    const filePath = telemetryEnvelopeFilePath(env)
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(envelope) + '\n', 'utf8')
  } catch {
    // Telemetry must never crash the caller. Swallow all errors silently.
  }
}
