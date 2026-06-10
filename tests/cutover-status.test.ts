import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateCutoverCriterion,
  buildCutoverStatus,
  buildAllCutoverStatuses,
  readGateEvents,
  formatCutoverStatus,
  CUTOVER_GATE_SPECS,
} from '../src/native/cutover-status.js'

const DAY = 86_400_000
function ge(kind: string, ts = 0) {
  return { ts, kind, conversationId: 'c', iteration: 0, lastToolSignatures: [] } as any
}

describe('evaluateCutoverCriterion', () => {
  it('count: met when events of the kinds reach the threshold', () => {
    const events = [ge('mode_auto_approve'), ge('mode_auto_approve'), ge('mode_gate_block')]
    const r = evaluateCutoverCriterion(events, {
      id: 'auto', label: 'auto approvals', type: 'count', kinds: ['mode_auto_approve'], threshold: 2,
    })
    expect(r.current).toBe(2)
    expect(r.met).toBe(true)
  })

  it('count: unmet below threshold', () => {
    const r = evaluateCutoverCriterion([ge('mode_auto_approve')], {
      id: 'a', label: '', type: 'count', kinds: ['mode_auto_approve'], threshold: 5,
    })
    expect(r.met).toBe(false)
  })

  it('window_days: met when the event span reaches the day threshold', () => {
    const r = evaluateCutoverCriterion([ge('x', 0), ge('x', 15 * DAY)], {
      id: 'soak', label: '', type: 'window_days', threshold: 14,
    })
    expect(r.current).toBeGreaterThanOrEqual(15)
    expect(r.met).toBe(true)
  })

  it('window_days: unmet when the span is too short', () => {
    const r = evaluateCutoverCriterion([ge('x', 0), ge('x', 3 * DAY)], {
      id: 's', label: '', type: 'window_days', threshold: 14,
    })
    expect(r.met).toBe(false)
  })

  it('rate: met when numerator/denominator is below the threshold', () => {
    const events = Array.from({ length: 98 }, () => ge('gate_predicate_agreement'))
      .concat([ge('gate_predicate_disagreement'), ge('gate_predicate_disagreement')])
    const r = evaluateCutoverCriterion(events, {
      id: 'fp', label: '', type: 'rate',
      numeratorKinds: ['gate_predicate_disagreement'],
      denominatorKinds: ['gate_predicate_agreement', 'gate_predicate_disagreement'],
      threshold: 0.05, comparator: 'lt',
    })
    expect(r.current).toBeCloseTo(0.02)
    expect(r.met).toBe(true)
  })

  it('rate: met is null when there is no denominator data (insufficient)', () => {
    const r = evaluateCutoverCriterion([], {
      id: 'fp', label: '', type: 'rate', numeratorKinds: ['x'], denominatorKinds: ['y'],
      threshold: 0.05, comparator: 'lt',
    })
    expect(r.met).toBeNull()
  })

  it('rate: a single sample is insufficient (met=null, not a spurious pass)', () => {
    const r = evaluateCutoverCriterion([ge('gate_predicate_agreement')], {
      id: 'fp', label: '', type: 'rate',
      numeratorKinds: ['gate_predicate_disagreement'],
      denominatorKinds: ['gate_predicate_agreement', 'gate_predicate_disagreement'],
      threshold: 0.05, comparator: 'lt',
    })
    expect(r.met).toBeNull()
  })

  it('manual: always reports met=null (needs human review)', () => {
    const r = evaluateCutoverCriterion([], { id: 'm', label: '', type: 'manual', note: 'review hints' })
    expect(r.met).toBeNull()
  })
})

describe('buildCutoverStatus', () => {
  const spec = {
    gate: 'demo', envVar: 'OWLCODA_DEMO',
    criteria: [
      { id: 'vol', label: 'volume', type: 'count', kinds: ['mode_auto_approve'], threshold: 2 },
      { id: 'rev', label: 'review', type: 'manual', note: 'inspect hints' },
    ],
  } as any

  it('reports allAutoMet and manualPending', () => {
    const s = buildCutoverStatus([ge('mode_auto_approve'), ge('mode_auto_approve')], spec)
    expect(s.allAutoMet).toBe(true)
    expect(s.manualPending).toBe(1)
    expect(s.criteria).toHaveLength(2)
  })

  it('allAutoMet is false when an auto criterion is unmet', () => {
    expect(buildCutoverStatus([ge('mode_auto_approve')], spec).allAutoMet).toBe(false)
  })

  it("scopes the soak window to the gate's own event kinds, not unrelated gates", () => {
    const gspec = {
      gate: 'g', envVar: 'OWLCODA_G', criteria: [
        { id: 'soak', label: 'soak', type: 'window_days', threshold: 14 },
        { id: 'vol', label: 'vol', type: 'count', kinds: ['gate_predicate_agreement'], threshold: 1 },
      ],
    } as never
    const NOW = Date.parse('2026-06-06T00:00:00Z')
    const events = [
      ge('gate_predicate_agreement', NOW),
      ge('gate_predicate_agreement', NOW - 1 * DAY),
      ge('mode_auto_approve', NOW - 30 * DAY), // unrelated gate's old history
    ]
    const soak = buildCutoverStatus(events, gspec).criteria.find(c => c.id === 'soak')!
    expect(soak.current).toBeLessThan(2) // ~1 day of the gate's own events, not 30
    expect(soak.met).toBe(false)
  })
})

describe('CUTOVER_GATE_SPECS', () => {
  it('defines specs for the stuck gates with an env var and criteria each', () => {
    const gates = CUTOVER_GATE_SPECS.map(s => s.gate)
    expect(gates).toContain('provenance')
    expect(gates).toContain('gate_v2')
    for (const spec of CUTOVER_GATE_SPECS) {
      expect(spec.envVar).toMatch(/^OWLCODA_/)
      expect(spec.criteria.length).toBeGreaterThan(0)
    }
  })

  it('provenance block criterion counts shadow would-blocks, not only enforce blocks', () => {
    const provenance = CUTOVER_GATE_SPECS.find(s => s.gate === 'provenance')!
    const block = provenance.criteria.find(c => c.id === 'block')!
    expect(block.type).toBe('count')
    expect((block as { kinds: string[] }).kinds).toContain('path_provenance_would_block')
  })
})

describe('readGateEvents + buildAllCutoverStatuses', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owlcoda-cutover-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function seed(events: Array<Record<string, unknown>>) {
    const telDir = join(dir, 'telemetry')
    mkdirSync(telDir, { recursive: true })
    writeFileSync(join(telDir, 'events-skip.jsonl'), 'should be ignored\n') // wrong name
    writeFileSync(
      join(telDir, 'gate-events-2026-06-06.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n') + '\nnot json\n',
    )
  }

  it('reads gate-events-*.jsonl, tolerating malformed lines, and skips other files', () => {
    seed([ge('mode_auto_approve'), ge('mode_gate_block')])
    const { events, filesRead } = readGateEvents({ home: dir })
    expect(events).toHaveLength(2)
    expect(filesRead.length).toBe(1)
  })

  it('returns an empty set when the telemetry dir is missing', () => {
    expect(readGateEvents({ home: dir }).events).toHaveLength(0)
  })

  it('filters to a single gate when asked', () => {
    seed([ge('gate_predicate_agreement')])
    const { statuses } = buildAllCutoverStatuses({ home: dir, gate: 'gate_v2' })
    expect(statuses).toHaveLength(1)
    expect(statuses[0]!.gate).toBe('gate_v2')
  })
})

describe('formatCutoverStatus', () => {
  it('renders a header verdict and a marked line per criterion', () => {
    const status = buildCutoverStatus(
      [ge('mode_auto_approve'), ge('mode_auto_approve')],
      { gate: 'demo', envVar: 'OWLCODA_DEMO', criteria: [
        { id: 'vol', label: 'volume', type: 'count', kinds: ['mode_auto_approve'], threshold: 2 },
        { id: 'rev', label: 'review', type: 'manual', note: 'inspect' },
      ] } as any,
    )
    const text = formatCutoverStatus(status)
    expect(text).toContain('demo (OWLCODA_DEMO)')
    expect(text).toContain('✓ volume')
    expect(text).toContain('· review')
  })
})
