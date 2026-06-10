import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatShadowStatus, buildShadowStatus } from '../src/native/shadow-status.js'

describe('formatShadowStatus', () => {
  it('summarizes the routing and microcompact shadow distributions', () => {
    const text = formatShadowStatus({
      routing: { total: 10, byDifficulty: { simple: 4, moderate: 3, hard: 3 }, wouldDiffer: 5, simpleShare: 0.4, wouldDifferShare: 0.5, filesRead: ['x'] },
      microcompact: { samples: 8, totalStrippableTokens: 1200, avgStrippableTokens: 150, totalSupersededReads: 24, totalReads: 40, filesRead: ['x'] },
    })
    expect(text).toContain('10')
    expect(text).toContain('simple 4')
    expect(text).toMatch(/would.?differ.*5/i)
    expect(text).toContain('1200')
    expect(text).toContain('24')
  })

  it('hints at the off-by-default flags when there is no data', () => {
    const text = formatShadowStatus({
      routing: { total: 0, byDifficulty: { simple: 0, moderate: 0, hard: 0 }, wouldDiffer: 0, simpleShare: 0, wouldDifferShare: 0, filesRead: [] },
      microcompact: { samples: 0, totalStrippableTokens: 0, avgStrippableTokens: 0, totalSupersededReads: 0, totalReads: 0, filesRead: [] },
    })
    expect(text).toContain('OWLCODA_ROUTING_SHADOW')
    expect(text).toContain('OWLCODA_MICROCOMPACT_SHADOW')
  })
})

describe('buildShadowStatus', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owlcoda-shadow-status-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads both shadow event types from the unified ledger', () => {
    const tel = join(dir, 'telemetry')
    mkdirSync(tel, { recursive: true })
    const events = [
      { eventType: 'model_routing_shadow', attributes: { difficulty: 'simple', wouldDiffer: true } },
      { eventType: 'microcompact_shadow', attributes: { totalReads: 3, supersededReads: 2, strippableTokens: 100 } },
    ]
    writeFileSync(join(tel, 'events-2026-06-06.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')

    const s = buildShadowStatus({ home: dir })
    expect(s.routing.total).toBe(1)
    expect(s.microcompact.samples).toBe(1)
  })

  it('returns empty summaries when the telemetry dir is missing', () => {
    const s = buildShadowStatus({ home: dir })
    expect(s.routing.total).toBe(0)
    expect(s.microcompact.samples).toBe(0)
  })
})
