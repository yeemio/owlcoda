import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_ENVELOPE_REQUIRED_FIELDS,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  buildTelemetryEventEnvelope,
} from '../../src/native/telemetry-envelope.js'

describe('telemetry event envelope', () => {
  it('defines the shared required field set for new telemetry surfaces', () => {
    expect(TELEMETRY_ENVELOPE_REQUIRED_FIELDS).toEqual([
      'schemaVersion',
      'eventType',
      'surface',
      'subject',
      'origin',
      'severity',
      'observedAt',
      'decision',
      'reasonCode',
    ])
  })

  it('builds a stable envelope for observable fitness events', () => {
    const event = buildTelemetryEventEnvelope({
      eventType: 'fitness.runtime.unreachable',
      surface: 'preflight',
      subject: 'http://127.0.0.1:1',
      origin: 'fitness',
      severity: 'warn',
      observedAt: 1_700_000_000_000,
      decision: 'warn',
      reasonCode: 'runtime_unreachable',
      evidenceRef: 'tests/fitness-tier1-fault-injection.test.ts',
      attributes: { gate: 'ci' },
    })

    expect(event).toEqual({
      schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
      eventType: 'fitness.runtime.unreachable',
      surface: 'preflight',
      subject: 'http://127.0.0.1:1',
      origin: 'fitness',
      severity: 'warn',
      observedAt: '2023-11-14T22:13:20.000Z',
      decision: 'warn',
      reasonCode: 'runtime_unreachable',
      evidenceRef: 'tests/fitness-tier1-fault-injection.test.ts',
      attributes: { gate: 'ci' },
    })
  })
})
