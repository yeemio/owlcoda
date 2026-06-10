import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeRoutingShadow,
  buildRoutingShadowSummary,
} from '../src/native/routing-shadow-summary.js'
import { recordRoutingShadow } from '../src/difficulty-router.js'

function ev(difficulty: string, wouldDiffer: boolean, eventType = 'model_routing_shadow') {
  return {
    schemaVersion: 'telemetry.envelope.v1',
    eventType,
    surface: 'http',
    subject: 'big',
    origin: 'runtime',
    severity: 'info',
    observedAt: '2026-06-06T00:00:00.000Z',
    decision: 'observe',
    reasonCode: `difficulty_${difficulty}`,
    attributes: { difficulty, wouldDiffer },
  }
}

describe('summarizeRoutingShadow', () => {
  it('returns zeros for no events', () => {
    const s = summarizeRoutingShadow([])
    expect(s.total).toBe(0)
    expect(s.simpleShare).toBe(0)
    expect(s.wouldDifferShare).toBe(0)
  })

  it('tallies the difficulty distribution', () => {
    const s = summarizeRoutingShadow([
      ev('simple', true), ev('simple', true), ev('moderate', false), ev('hard', false),
    ] as any)
    expect(s.total).toBe(4)
    expect(s.byDifficulty.simple).toBe(2)
    expect(s.byDifficulty.moderate).toBe(1)
    expect(s.byDifficulty.hard).toBe(1)
    expect(s.simpleShare).toBeCloseTo(0.5)
  })

  it('counts how many turns would route differently', () => {
    const s = summarizeRoutingShadow([ev('simple', true), ev('moderate', false)] as any)
    expect(s.wouldDiffer).toBe(1)
    expect(s.wouldDifferShare).toBeCloseTo(0.5)
  })

  it('ignores non-routing envelope events', () => {
    const s = summarizeRoutingShadow([ev('simple', true), ev('simple', true, 'fitness.runtime.unreachable')] as any)
    expect(s.total).toBe(1)
  })
})

describe('buildRoutingShadowSummary (file reader)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owlcoda-routing-shadow-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads model_routing_shadow events from events-*.jsonl under the telemetry dir', () => {
    const telDir = join(dir, 'telemetry')
    mkdirSync(telDir, { recursive: true })
    const lines = [ev('simple', true), ev('hard', false), ev('moderate', false)]
      .map(e => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(join(telDir, 'events-2026-06-06.jsonl'), lines)

    const summary = buildRoutingShadowSummary({ home: dir })
    expect(summary.total).toBe(3)
    expect(summary.byDifficulty.simple).toBe(1)
    expect(summary.filesRead.length).toBe(1)
  })

  it('returns an empty summary when the telemetry dir is missing', () => {
    expect(buildRoutingShadowSummary({ home: dir }).total).toBe(0)
  })

  it('end-to-end: an enabled record is read back by the summary', () => {
    const config = { models: [{ id: 'small', tier: 'fast' }, { id: 'big', tier: 'heavy', default: true }] } as any
    const env = { OWLCODA_HOME: dir, OWLCODA_ROUTING_SHADOW: '1' } as any
    recordRoutingShadow(config, { model: 'big', messages: [{ role: 'user', content: 'yes, continue' }] }, 'big', env)

    const summary = buildRoutingShadowSummary({ home: dir })
    expect(summary.total).toBe(1)
    expect(summary.byDifficulty.simple).toBe(1)
    expect(summary.wouldDiffer).toBe(1) // simple routes to 'small', differs from actual 'big'
  })

  it('records nothing when the shadow is disabled (behavior-neutral default)', () => {
    const config = { models: [{ id: 'small', tier: 'fast' }] } as any
    recordRoutingShadow(config, { messages: [{ role: 'user', content: 'yes' }] }, 'small', { OWLCODA_HOME: dir } as any)
    expect(buildRoutingShadowSummary({ home: dir }).total).toBe(0)
  })
})
