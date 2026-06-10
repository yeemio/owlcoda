import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTelemetryEventEnvelope,
  isTelemetryEnvelopeSinkEnabled,
  recordTelemetryEnvelope,
} from '../../src/native/telemetry-envelope.js'
import { checkRouterHealth } from '../../src/preflight.js'

function readEnvelopes(home: string): Array<Record<string, unknown>> {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(home, 'telemetry', `events-${date}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('telemetry envelope sink', () => {
  let tmpHome: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'owlcoda-envsink-'))
    for (const key of ['OWLCODA_HOME', 'OWLCODA_TELEMETRY_EVENTS']) {
      prev[key] = process.env[key]
      delete process.env[key]
    }
    process.env['OWLCODA_HOME'] = tmpHome
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('persists an envelope to the unified events ledger', () => {
    recordTelemetryEnvelope(buildTelemetryEventEnvelope({
      eventType: 'runtime.health_observed',
      surface: 'preflight',
      subject: 'http://127.0.0.1:1',
      origin: 'runtime',
      severity: 'warn',
      decision: 'warn',
      reasonCode: 'missing',
    }))

    const events = readEnvelopes(tmpHome)
    expect(events).toHaveLength(1)
    expect(events[0]!['schemaVersion']).toBe('telemetry.envelope.v1')
    expect(events[0]!['eventType']).toBe('runtime.health_observed')
    expect(events[0]!['origin']).toBe('runtime')
  })

  it('honors the OWLCODA_TELEMETRY_EVENTS off switch', () => {
    process.env['OWLCODA_TELEMETRY_EVENTS'] = '0'
    recordTelemetryEnvelope(buildTelemetryEventEnvelope({
      eventType: 'x', surface: 's', subject: 'sub', origin: 'fitness',
      severity: 'info', decision: 'observe', reasonCode: 'r',
    }))
    expect(readEnvelopes(tmpHome)).toHaveLength(0)
    expect(isTelemetryEnvelopeSinkEnabled({})).toBe(true)
    expect(isTelemetryEnvelopeSinkEnabled({ OWLCODA_TELEMETRY_EVENTS: 'off' })).toBe(false)
  })

  it('checkRouterHealth emits one runtime envelope from a live path, return unchanged', async () => {
    const check = await checkRouterHealth('http://127.0.0.1:1')

    // Behavior-neutral: an unreachable runtime still reports missing.
    expect(check.status).toBe('missing')
    expect(check.name).toBe('Local runtime')

    const events = readEnvelopes(tmpHome)
    const runtimeEvent = events.find(e => e['eventType'] === 'runtime.health_observed')
    expect(runtimeEvent).toBeDefined()
    expect(runtimeEvent!['origin']).toBe('runtime')
    expect(runtimeEvent!['decision']).toBe('warn')
    expect(runtimeEvent!['reasonCode']).toBe('missing')
  })
})
