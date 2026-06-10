import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildFidelityTelemetrySummary,
  formatFidelityTelemetryJson,
  formatFidelityReviewPacket,
  formatFidelityTelemetrySummary,
} from '../../src/native/fidelity-telemetry-summary.js'
import type { GateEvent } from '../../src/native/gate-telemetry.js'

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'owlcoda-fidelity-summary-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function writeGateEvents(home: string, events: Array<GateEvent | Record<string, unknown> | string>): void {
  const telemetryDir = join(home, 'telemetry')
  mkdirSync(telemetryDir, { recursive: true })
  const lines = events.map(event => typeof event === 'string' ? event : JSON.stringify(event))
  writeFileSync(join(telemetryDir, 'gate-events-2026-06-01.jsonl'), lines.join('\n'), 'utf8')
}

describe('fidelity telemetry summary', () => {
  it('summarizes claim and compaction fidelity events from telemetry', () => withTempHome((home) => {
    writeGateEvents(home, [
      {
        ts: 100,
        kind: 'fidelity_claim_observed',
        conversationId: 'conv-1',
        iteration: 1,
        lastToolSignatures: ['Read:path:src/native/project-map.ts'],
        claimId: 'claim-1',
        anchorType: 'path',
        target: 'src/native/project-map.ts',
        evidenceOrigin: 'tool_call',
        matched: true,
        model: 'test-model',
        phase: 'final',
      } satisfies GateEvent,
      {
        ts: 200,
        kind: 'fidelity_claim_observed',
        conversationId: 'conv-1',
        iteration: 2,
        lastToolSignatures: [],
        claimId: 'claim-2',
        anchorType: 'path',
        target: 'src/native/nonexistent-ledger.ts',
        evidenceOrigin: 'unknown',
        matched: false,
        model: 'test-model',
        phase: 'final',
      } satisfies GateEvent,
      {
        ts: 300,
        kind: 'fidelity_compaction_fact_observed',
        conversationId: 'conv-1',
        iteration: 3,
        lastToolSignatures: [],
        factType: 'path',
        target: 'src/native/conversation.ts',
        sourceTurnId: 'turn-1',
        beforeHash: 'sha256:abc',
        preserved: true,
        compactionFactReason: 'kept',
        model: 'test-model',
        phase: 'compact',
      } satisfies GateEvent,
      {
        ts: 400,
        kind: 'fidelity_compaction_fact_observed',
        conversationId: 'conv-1',
        iteration: 4,
        lastToolSignatures: [],
        factType: 'command',
        target: 'npm run imaginary:verify',
        sourceTurnId: 'turn-2',
        beforeHash: 'sha256:def',
        preserved: false,
        compactionFactReason: 'dropped',
        model: 'test-model',
        phase: 'compact',
      } satisfies GateEvent,
      {
        ts: 500,
        kind: 'production_gate',
        conversationId: 'conv-1',
        iteration: 5,
        lastToolSignatures: [],
      } satisfies GateEvent,
      '{not-json',
    ])

    const summary = buildFidelityTelemetrySummary({ home, sampleLimit: 4 })
    expect(summary.totalEvents).toBe(4)
    expect(summary.claims.total).toBe(2)
    expect(summary.claims.matched).toBe(1)
    expect(summary.claims.unmatched).toBe(1)
    expect(summary.compactionFacts.total).toBe(2)
    expect(summary.compactionFacts.preserved).toBe(1)
    expect(summary.compactionFacts.dropped).toBe(1)
    expect(summary.malformedLines).toBe(1)
    expect(summary.recent.map(sample => sample.reviewKey)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[a-f0-9]{12}$/),
      ]),
    )
    expect(buildFidelityTelemetrySummary({ home, sampleLimit: 4 }).recent.map(sample => sample.reviewKey))
      .toEqual(summary.recent.map(sample => sample.reviewKey))

    const output = formatFidelityTelemetrySummary(summary)
    expect(output).toContain('Fidelity telemetry')
    expect(output).toContain('shadow-only, read-only')
    expect(output).toContain('Claims: 2 total, 1 matched, 1 unmatched')
    expect(output).toContain('Compaction facts: 2 total, 1 preserved, 1 dropped')
    expect(output).toContain('src/native/nonexistent-ledger.ts')
    expect(output).toContain('npm run imaginary:verify')
    expect(output).toContain('key=')
    expect(output).toContain('origin=unknown')
    expect(output).toContain('reason=dropped')

    const json = JSON.parse(formatFidelityTelemetryJson(summary))
    expect(json.recent[0].reviewKey).toMatch(/^[a-f0-9]{12}$/)

    const packet = JSON.parse(formatFidelityReviewPacket(summary))
    expect(packet.schema).toBe('owlcoda.fidelity.review.v1')
    expect(packet.samples).toHaveLength(4)
    expect(packet.samples[0].reviewKey).toMatch(/^[a-f0-9]{12}$/)
    expect(packet.samples[0].humanLabel).toBeNull()
    expect(packet.samples[0].reviewerNotes).toBe('')
  }))

  it('prints an honest no-events message for missing telemetry', () => withTempHome((home) => {
    const summary = buildFidelityTelemetrySummary({ home })
    expect(summary.totalEvents).toBe(0)

    const output = formatFidelityTelemetrySummary(summary)
    expect(output).toContain('Fidelity telemetry')
    expect(output).toContain('No fidelity telemetry files found')
  }))
})
